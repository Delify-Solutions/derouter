// The customer SSE mask (spec model-privacy, change customer-leak-fixes): JSON
// grammar tracking, values that never close, overflow recovery, partition
// invariance and cost. Default caps (STREAM_MAX_BUFFER_BYTES unset: 4 MiB).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-customer-leak-sse-"));
process.env.DATA_DIR = tmpDir;
delete process.env.STREAM_MAX_BUFFER_BYTES;

const pm = await import("../src/lib/models/publicModel.js");
const { createJsonPrefixParser, PREFIX } = await import("../src/lib/models/jsonPrefix.js");

after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

const OPTS = {
  publicName: "glm-5",
  ids: pm.hiddenModelIds({ members: ["zai/glm-5.3:pre"], upstream: ["glm-5.3:pre"], publicName: "glm-5" }),
  providers: pm.hiddenProviderIds({ members: ["zai/glm-5.3:pre"], publicName: "glm-5" }),
};
const LEAK = /glm-5\.3|zai|Fireworks|fp_x|gen-\d|msg_bdrk|msg_vrtx|"cost"|is_byok|trafficType/;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Mask `pieces` (strings or byte arrays) one network chunk each; returns per-step releases. */
async function stepwise(pieces) {
  const mask = pm.createSseMaskStream(OPTS);
  const writer = mask.writable.getWriter();
  const reader = mask.readable.getReader();
  const releases = [];
  let pendingRead = null;
  const drain = async () => {
    let text = "";
    for (;;) {
      pendingRead ??= reader.read();
      const next = await Promise.race([pendingRead, new Promise((resolve) => setTimeout(() => resolve(null), 10))]);
      if (!next) break;
      pendingRead = null;
      if (next.done) break;
      text += dec.decode(next.value, { stream: true });
    }
    return text;
  };
  for (const piece of pieces) {
    const written = writer.write(typeof piece === "string" ? enc.encode(piece) : piece);
    releases.push(await drain());
    await written;
  }
  const closing = writer.close();
  let tail = "";
  for (;;) {
    const next = await (pendingRead ?? reader.read());
    pendingRead = null;
    if (next.done) break;
    tail += dec.decode(next.value, { stream: true });
  }
  await closing;
  return { releases, tail };
}

/** The whole masked output for one byte array cut into the given chunks. */
async function maskBytes(bytes, cuts) {
  const chunks = [];
  let at = 0;
  for (const cut of [...cuts, bytes.length]) { chunks.push(bytes.slice(at, cut)); at = cut; }
  const source = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });
  return new Response(source.pipeThrough(pm.createSseMaskStream(OPTS))).text();
}

// Router-generated ids are random per response: compared by shape.
const normalizeIds = (text) => text
  .replace(/chatcmpl-[0-9a-f]{32}/g, "chatcmpl-ROUTER")
  .replace(/msg_[0-9a-f]{32}/g, "msg_ROUTER")
  .replace(/"responseId":"[0-9a-f]{32}"/g, "\"responseId\":\"ROUTER\"");

const openaiChunk = (i, content) => JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", model: "glm-5.3:pre", provider: "Fireworks", system_fingerprint: "fp_x", choices: [{ index: 0, delta: { content }, native_finish_reason: null }] });

// ── The JSON prefix check ───────────────────────────────────────────────────

test("prefix check: escapes and brackets inside strings never count", () => {
  const cases = [
    ['{"c":"a \\" } ] { [ b"', PREFIX.INCOMPLETE],
    ['{"c":"a \\" } ] { [ b"}', PREFIX.COMPLETE],
    ['{"c":"\\\\"}', PREFIX.COMPLETE],
    ['{"c":"\\u00e9\\n"}', PREFIX.COMPLETE],
    ['{"c":"\\x"}', PREFIX.INVALID],
    ['{"c":"\\u00g0"}', PREFIX.INVALID],
    ['[1, -2.5e3, true, false, null, {"a":[]}]', PREFIX.COMPLETE],
    ['{"a":', PREFIX.INCOMPLETE],
    ['{"a":\n{"b":1}', PREFIX.INCOMPLETE],
    ['{"a":\n{"b":1}\n{', PREFIX.INVALID],
    ['{"a":1}\n{', PREFIX.INVALID],
    ['{"a":1,}', PREFIX.INVALID],
    ['{"a" 1}', PREFIX.INVALID],
    ['{"a":tru', PREFIX.INCOMPLETE],
    ['{"a":trux', PREFIX.INVALID],
    ['{"a":"line\nbreak"}', PREFIX.INVALID],
    ["[}", PREFIX.INVALID],
    ['{"a":1}  \n ', PREFIX.COMPLETE],
  ];
  for (const [text, expected] of cases) {
    assert.equal(createJsonPrefixParser().feed(text), expected, JSON.stringify(text));
    // Fed one character at a time, the verdict is the same.
    const parser = createJsonPrefixParser();
    let status;
    for (const ch of text) status = parser.feed(ch);
    assert.equal(status, expected, `char by char: ${JSON.stringify(text)}`);
  }
});

test("a line with escapes and brackets in its strings is released at once, content intact", async () => {
  const content = 'say \\"} ] { [\\" and \\\\ then \\u00e9 😀';
  const line = `data: {"model":"glm-5.3:pre","choices":[{"delta":{"content":"${content}"}}]}\n`;
  const { releases } = await stepwise([line]);
  const event = JSON.parse(releases[0].slice(6));
  assert.equal(event.model, "glm-5");
  assert.equal(event.choices[0].delta.content, JSON.parse(`"${content}"`));
});

test("a value split with escapes and brackets inside strings is joined", async () => {
  const { releases } = await stepwise(['data: {"model":"glm-5.3:pre","c":"x}]\\"",\n', 'data: "d":"{[\\\\"}\n']);
  assert.equal(releases[0], "");
  const event = JSON.parse(releases[1].slice(6));
  assert.deepEqual(event, { model: "glm-5", c: "x}]\"", d: "{[\\" });
});

// ── W1: a line that never closes ────────────────────────────────────────────

test("a data line that never closes does not hold the stream", async () => {
  const valid = Array.from({ length: 25 }, (_, i) => `data: ${openaiChunk(i, `t${i}`)}\n`);
  const { releases, tail } = await stepwise(['data: {"a":\n', ...valid]);
  // `{"a":` + the first valid line is still a possible value; the second valid
  // line makes it impossible: everything held goes out then, and from there on
  // every line leaves in its own step.
  assert.equal(releases[0], "");
  assert.equal(releases[1], "");
  for (let step = 2; step < releases.length; step += 1) assert.ok(releases[step].length > 0, `step ${step} released`);
  const all = releases.join("") + tail;
  const contents = all.split("\n").filter((l) => l.startsWith("data: {\"id\"")).map((l) => JSON.parse(l.slice(6)).choices[0].delta.content);
  assert.deepEqual(contents, valid.map((_, i) => `t${i}`), "all 25 valid events delivered, in order");
  assert.doesNotMatch(all, LEAK);
});

// ── W2: after an overflow ───────────────────────────────────────────────────

const CAP = 4 * 1024 * 1024;

test("after an oversized value, a following text error line is delivered (scrubbed)", async () => {
  const head = 'data: {"model":"glm-5.3:pre","x":"';
  const pieces = [head];
  for (let sent = 0; sent < CAP + 1024; sent += 256 * 1024) pieces.push("a".repeat(256 * 1024));
  pieces.push('"}\n', "data: upstream glm-5.3:pre failed at https://api.zai.example/v1\n", `data: ${openaiChunk(1, "after")}\n`);
  const { releases } = await stepwise(pieces);
  const all = releases.join("");
  assert.equal((all.match(/model_error/g) || []).length, 1);
  assert.match(all, /\ndata: upstream glm-5 failed at\n/);
  assert.match(all, /"content":"after"/);
  assert.doesNotMatch(all, LEAK);
  assert.doesNotMatch(all, /aaaa/);
});

test("after an oversized value, a following multi-line value is delivered whole", async () => {
  const filler = `data: "${"a".repeat(64 * 1024)}",\n`;
  const pieces = ['data: {"model":"glm-5.3:pre","x":[\n'];
  for (let sent = 0; sent < CAP + 1024; sent += filler.length) pieces.push(filler);
  pieces.push('data: "end"]}\n', 'data: {"model":"glm-5.3:pre",\n', 'data: "choices":[{"delta":{"content":"next"}}]}\n');
  const { releases } = await stepwise(pieces);
  const all = releases.join("");
  assert.equal((all.match(/model_error/g) || []).length, 1);
  const last = all.trim().split("\n").at(-1);
  assert.deepEqual(JSON.parse(last.slice(6)), { model: "glm-5", choices: [{ delta: { content: "next" } }] });
  assert.doesNotMatch(all, /aaaa|"end"/);
});

test("a nested line that is valid JSON by itself does not end the drop early (no fragment leaks)", async () => {
  const filler = `data: {"delta":{"content":"${"a".repeat(64 * 1024)}"}},\n`; // valid JSON on its own, plus a comma
  const nested = 'data: {"delta":{"content":"nested"}}\n'; // valid JSON on its own
  const pieces = ['data: {"id":"gen-1","model":"glm-5.3:pre","provider":"zai","choices":[\n'];
  for (let sent = 0; sent < CAP + 1024; sent += filler.length) pieces.push(filler);
  pieces.push(nested, 'data: ],"system_fingerprint":"fp_x","id2":"gen-2"}\n', `data: ${openaiChunk(3, "after")}\n`);
  const { releases } = await stepwise(pieces);
  const all = releases.join("");
  assert.equal((all.match(/model_error/g) || []).length, 1);
  assert.doesNotMatch(all, /nested|aaaa|gen-2|fp_x|zai|provider/);
  assert.match(all, /"content":"after"/);
});

test("broken JSON released through the per-line fallback loses its quoted provider fields", () => {
  const out = pm.maskSseText('data: {"id":"gen-1","model":"glm-5.3:pre","provider":"zai","system_fingerprint":"fp_x","choices":[{"delta":{"content":"x","tool_calls":[{"id":"call_up_1"}]}}],"usage":{"cost":1,"is_byok":false},\ndata: }\n', OPTS);
  assert.doesNotMatch(out, LEAK);
  assert.match(out, /"id":"chatcmpl-[0-9a-f]{32}"/);
  assert.match(out, /"model":"glm-5"/);
  assert.match(out, /"id":"call_up_1"/, "tool-call ids are never touched");
  assert.equal(pm.scrubUpstreamText('"provider":"zai","system_fingerprint":"fp_x","id":"gen-1"', OPTS).includes("zai"), false);
});

test("a bare JSON string as data is upstream text in the chat protocols and is scrubbed", () => {
  assert.equal(pm.maskSseLine('data: "str glm-5.3:pre docs.python.org"', OPTS), 'data: "str glm-5"');
  // It stays one valid JSON string: a trailing URL does not take the closing quote.
  const masked = pm.maskSseLine('data: "see https://api.zai.example/a for \\"glm-5.3:pre\\""', OPTS);
  assert.equal(JSON.parse(masked.slice(6)), 'see for "glm-5"');
  assert.equal(pm.maskSseLine('data: "plain words"', OPTS), 'data: "plain words"', "nothing to scrub: bytes unchanged");
});

// ── W3 / S1: cost ───────────────────────────────────────────────────────────

test("a value spread over 200k lines is masked in well under a second", () => {
  const lines = ["data: [", ...Array.from({ length: 200_000 }, () => "data: 1,"), "data: 1]", ""];
  const started = performance.now();
  const out = pm.maskSseText(lines.join("\n"), OPTS);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1000, `took ${Math.round(elapsed)} ms`);
  assert.equal(JSON.parse(out.split("\n")[0].slice(6)).length, 200_001);
});

test("a 3.5 MiB line arriving in 4 KiB chunks costs linear time", async () => {
  const line = `data: {"model":"glm-5.3:pre","x":"${"a".repeat(3.5 * 1024 * 1024)}"}\n`;
  const bytes = enc.encode(line);
  const cuts = [];
  for (let at = 4096; at < bytes.length; at += 4096) cuts.push(at);
  const started = performance.now();
  const out = await maskBytes(bytes, cuts);
  assert.ok(performance.now() - started < 2000, "no quadratic rescans of the carried line");
  assert.equal(JSON.parse(out.slice(6)).model, "glm-5");
});

// ── S2: partition invariance ────────────────────────────────────────────────

const STREAMS = {
  openai: [0, 1, 2].map((i) => `data: ${openaiChunk(i, `tok${i} see  docs.python.org 😀 \\"q\\"`)}\n\n`).join("")
    + 'data: {"id":"gen-1","object":"chat.completion.chunk","model":"glm-5.3:pre","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":3,"total_tokens":6,"cost":0.1}}\n\ndata: [DONE]\n\n',
  openaiBlankless: [0, 1, 2].map((i) => `data: ${openaiChunk(i, `tok${i} 😀`)}\n`).join("") + ": keepalive\ndata: [DONE]\n",
  openaiMultiline: 'data: {"id":"gen-1","model":"glm-5.3:pre",\ndata: "choices":[{"delta":{"content":"a\\nb"}}]}\n\ndata: [DONE]\n\n',
  claude: 'event: message_start\r\ndata: {"type":"message_start","message":{"id":"msg_bdrk_1","type":"message","model":"glm-5.3:pre","usage":{"input_tokens":5,"output_tokens":1,"service_tier":"standard"}}}\r\n\r\n'
    + 'event: content_block_delta\r\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"héllo 😀 x.com"}}\r\n\r\n'
    + 'event: message_delta\r\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\r\n\r\nevent: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n',
  claudeBlankless: 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_vrtx_1","model":"glm-5.3:pre"}}\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi 😀"}}\nevent: message_stop\ndata: {"type":"message_stop"}\n',
  gemini: [0, 1].map((i) => `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: `part ${i} ü` }] } }], modelVersion: "glm-5.3:pre", responseId: "gen-77", usageMetadata: { promptTokenCount: 2, candidatesTokenCount: i, totalTokenCount: 2 + i, trafficType: "ON_DEMAND" } })}\r\n\r\n`).join(""),
};

for (const [name, text] of Object.entries(STREAMS)) {
  test(`partition fuzz (${name}): identical output for every split point, nothing leaks`, async () => {
    const bytes = enc.encode(text);
    const reference = normalizeIds(await maskBytes(bytes, []));
    assert.doesNotMatch(reference, LEAK);
    for (const line of reference.split(/\r?\n/)) {
      if (line.startsWith("data: {")) JSON.parse(line.slice(6)); // every JSON data line stays valid
    }
    for (let cut = 1; cut < bytes.length; cut += 1) {
      assert.equal(normalizeIds(await maskBytes(bytes, [cut])), reference, `split at byte ${cut}`);
    }
    // Three-way splits on a stride as well.
    for (let a = 1; a < bytes.length; a += 7) {
      const b = Math.min(bytes.length - 1, a + 13);
      if (b > a) assert.equal(normalizeIds(await maskBytes(bytes, [a, b])), reference, `split at ${a},${b}`);
    }
  });
}
