// Cache "auto" (Providers page): a request for a Claude-format upstream that carries no cache
// breakpoint at all gets them; a request that already carries any is left exactly as it is.
// The body is shared with the client's request and with the next account's attempt, so the
// breakpoints are added to a COPY, and doing it again gives the same result.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/alias-hook.mjs", import.meta.url);

const { ensureClaudeCache, providerCacheMode } = await import("../open-sse/translator/formats/claude.js");

const clone = (o) => structuredClone(o);
const marks = (body) => {
  const out = [];
  if (Array.isArray(body.system)) body.system.forEach((b, i) => b?.cache_control && out.push(["system", i, b.cache_control]));
  (body.tools || []).forEach((t, i) => t?.cache_control && out.push(["tool", i, t.cache_control]));
  (body.messages || []).forEach((m, mi) => Array.isArray(m?.content) && m.content.forEach((b, bi) => b?.cache_control && out.push(["msg", mi, bi, b.cache_control])));
  return out;
};

// what a CLI that does no caching sends: string system, string message contents, plain tools
const PLAIN = {
  model: "m", max_tokens: 1000,
  system: "You are a coding agent.",
  tools: [{ name: "read", input_schema: { type: "object" } }, { name: "write", input_schema: { type: "object" } }],
  messages: [
    { role: "user", content: "fix the bug" },
    { role: "assistant", content: [{ type: "text", text: "looking" }, { type: "tool_use", id: "t1", name: "read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file" }] },
  ],
};

test("the mode resolver: only 'auto' turns it on", () => {
  assert.equal(providerCacheMode({ mode: "auto" }), "auto");
  assert.equal(providerCacheMode({ mode: " AUTO " }), "auto");
  assert.equal(providerCacheMode("auto"), "auto");
  for (const v of [undefined, null, {}, { mode: "" }, { mode: "default" }, { mode: "off" }, { mode: "bogus" }]) {
    assert.equal(providerCacheMode(v), "default");
  }
});

test("a request with no cache hint gets breakpoints on system, last tool and the tail", () => {
  const { body, added } = ensureClaudeCache(clone(PLAIN));
  assert.equal(added, true);
  // a string system became one text block so a breakpoint can sit on it
  assert.deepEqual(body.system, [{ type: "text", text: "You are a coding agent.", cache_control: { type: "ephemeral", ttl: "1h" } }]);
  const m = marks(body);
  assert.deepEqual(m.filter((x) => x[0] === "tool"), [["tool", 1, { type: "ephemeral", ttl: "1h" }]], "only the LAST tool");
  // the last assistant turn is the tail anchor (it ends a completed exchange), at 5m
  assert.deepEqual(m.filter((x) => x[0] === "msg" && x[1] === 1), [["msg", 1, 1, { type: "ephemeral" }]].map((x) => x));
  assert.ok(m.length <= 4, "never over the upstream's 4-breakpoint budget");
  // only cache_control and the string -> block conversion changed
  assert.equal(body.messages.length, PLAIN.messages.length);
  assert.deepEqual(body.messages[0].content, [{ type: "text", text: "fix the bug" }]);
  assert.deepEqual(body.tools.map((t) => t.name), ["read", "write"]);
});

test("a first turn (no assistant yet) anchors the final message so the opening prompt is cached", () => {
  const { body, added } = ensureClaudeCache({ model: "m", system: [{ type: "text", text: "sys" }], messages: [{ role: "user", content: "hello" }] });
  assert.equal(added, true);
  assert.deepEqual(body.messages[0].content, [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }]);
});

test("copy-on-write: the client's body is never edited", () => {
  const original = clone(PLAIN);
  const snapshot = clone(PLAIN);
  const { body } = ensureClaudeCache(original);
  assert.deepEqual(original, snapshot, "no field of the shared body changed");
  assert.notEqual(body, original);
  assert.notEqual(body.tools[1], original.tools[1], "tools are copied, not marked in place");
  assert.notEqual(body.messages[1].content[0], original.messages[1].content[0]);
});

test("a retry on another account ships the same breakpoints as the first attempt", () => {
  // chat.js builds { ...body } per attempt: shallow copies that SHARE system, tools and messages
  const client = clone(PLAIN);
  const attempt1 = ensureClaudeCache({ ...client });
  const attempt2 = ensureClaudeCache({ ...client });
  assert.equal(attempt1.added, true);
  assert.equal(attempt2.added, true, "the shared body still has no marker, so Auto applies again");
  assert.deepEqual(attempt2.body, attempt1.body);
  assert.deepEqual(client, PLAIN);
});

test("a request that already carries any cache_control is left exactly as it is", () => {
  for (const variant of ["system", "tool", "message", "nested"]) {
    const body = clone(PLAIN);
    body.system = [{ type: "text", text: "sys" }];
    if (variant === "system") body.system[0].cache_control = { type: "ephemeral" };
    if (variant === "tool") body.tools[0].cache_control = { type: "ephemeral", ttl: "1h" };
    if (variant === "message") body.messages[2].content[0].cache_control = { type: "ephemeral" };
    // a marker only inside a tool_result's own content still counts as the client's hint
    if (variant === "nested") body.messages[2].content[0].content = [{ type: "text", text: "file", cache_control: { type: "ephemeral" } }];
    const before = clone(body);
    const result = ensureClaudeCache(body);
    assert.equal(result.added, false, variant);
    assert.equal(result.body, body, `${variant}: the very same object comes back`);
    assert.deepEqual(body, before, `${variant}: untouched`);
  }
});

test("a client that spent the whole budget is left alone too", () => {
  const body = clone(PLAIN);
  body.system = [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }, { type: "text", text: "b", cache_control: { type: "ephemeral" } }];
  body.tools[0].cache_control = { type: "ephemeral" };
  body.tools[1].cache_control = { type: "ephemeral" };
  const before = clone(body);
  assert.equal(ensureClaudeCache(body).added, false);
  assert.deepEqual(body, before);
});

test("nothing to cache and malformed input are no-ops", () => {
  for (const v of [null, undefined, "x", 3]) assert.equal(ensureClaudeCache(v).added, false);
  const empty = { model: "m", messages: [] };
  assert.equal(ensureClaudeCache(empty).added, false);
  assert.deepEqual(empty, { model: "m", messages: [] });
  // empty strings stay empty strings, and an empty text block never takes a marker
  const blank = { model: "m", system: "  ", messages: [{ role: "user", content: "" }] };
  const r = ensureClaudeCache(blank);
  assert.equal(r.added, false);
  assert.equal(blank.system, "  ");
  const emptyBlock = { model: "m", system: [{ type: "text", text: "" }], messages: [{ role: "user", content: [{ type: "text", text: "" }] }] };
  const e = ensureClaudeCache(emptyBlock);
  assert.equal(e.added, false);
  assert.deepEqual(marks(e.body), []);
  // a body with a null message is not a shape to reason about: forwarded as is, no throw
  const odd = { model: "m", system: "s", messages: [null, { role: "user", content: "hi" }] };
  assert.doesNotThrow(() => ensureClaudeCache(odd));
  assert.equal(ensureClaudeCache(odd).added, false);
});

test("thinking blocks never take a breakpoint, and a second pass changes nothing", () => {
  const input = {
    model: "m",
    system: [{ type: "text", text: "sys" }],
    messages: [
      { role: "user", content: [{ type: "text", text: "q" }] },
      { role: "assistant", content: [{ type: "text", text: "a" }, { type: "thinking", thinking: "hm", signature: "s" }] },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ],
  };
  const { body, added } = ensureClaudeCache(input);
  assert.equal(added, true);
  assert.equal(body.messages[1].content.find((b) => b.type === "thinking").cache_control, undefined);
  // the output already carries markers, so feeding it back is a no-op
  const again = ensureClaudeCache(body);
  assert.equal(again.added, false);
  assert.equal(again.body, body);
});
