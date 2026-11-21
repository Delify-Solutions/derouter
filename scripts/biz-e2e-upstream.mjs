// Minimal OpenAI-compatible upstream for the "AI doanh nghiệp" E2E (task 9.1).
//
// Serves the two calls the business pipeline makes and nothing else:
//   POST /v1/chat/completions  → the bot model, and the guard model
//   POST /v1/embeddings        → a deterministic 8-dimension vector per input
//
// The guard model's answer is driven by the prompt it receives, so a test can
// exercise classification and the output check without a real model:
//   * a system prompt containing "bộ phân loại"  → {"category": ...}
//   * a system prompt containing "bộ kiểm duyệt" → {"verdict":"ok"}
// Classification is `ok` unless the user text names a topic the test seeds in
// `BIZ_E2E_TOPIC`, which keeps the stub stateless and predictable.
import http from "node:http";

const PORT = Number(process.env.BIZ_E2E_UPSTREAM_PORT || 39127);
const TOKEN = process.env.BIZ_E2E_UPSTREAM_TOKEN || "test-token";

const CHAT_REPLY = process.env.BIZ_E2E_CHAT_REPLY || "Sofa da nhập khẩu giá 12 triệu đồng, bảo hành 2 năm.";

/** Deterministic bag-of-words embedder: same text → same vector, related text → close. */
function embed(text) {
  const buckets = new Array(8).fill(0);
  const words = String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const word of words) {
    let hash = 0;
    for (let i = 0; i < word.length; i += 1) hash = (hash * 31 + word.charCodeAt(i)) % 100_003;
    buckets[hash % 8] += 1;
  }
  const norm = Math.sqrt(buckets.reduce((sum, value) => sum + value * value, 0)) || 1;
  return buckets.map((value) => Number((value / norm).toFixed(6)));
}

function readBody(request) {
  return new Promise((resolve) => {
    const parts = [];
    request.on("data", (chunk) => parts.push(chunk));
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString("utf8") || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

const server = http.createServer(async (request, response) => {
  if (request.method !== "POST") return json(response, 404, { error: { message: "not found" } });

  const auth = request.headers.authorization || "";
  if (!auth.includes(TOKEN)) return json(response, 401, { error: { message: "bad token" } });

  // The router appends the OpenAI path to the configured base URL, and a node's
  // base URL may or may not already end in `/v1`, so match on the suffix.
  if (request.url.endsWith("/embeddings")) {
    const body = await readBody(request);
    const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
    return json(response, 200, {
      object: "list",
      model: body.model ?? "stub-embed",
      data: inputs.map((text, index) => ({ object: "embedding", index, embedding: embed(text) })),
      usage: { prompt_tokens: 1, total_tokens: 1 },
    });
  }

  if (request.url.endsWith("/chat/completions")) {
    const body = await readBody(request);
    const system = (body.messages ?? []).find((message) => message.role === "system")?.content ?? "";
    const lastUser = [...(body.messages ?? [])].reverse().find((message) => message.role === "user")?.content ?? "";

    let content = CHAT_REPLY;
    if (String(system).includes("bộ phân loại")) {
      content = '{"category":"ok","topic":"sofa"}';
    } else if (String(system).includes("bộ kiểm duyệt")) {
      content = '{"verdict":"ok","category":null}';
    } else if (/chính trị/i.test(String(lastUser))) {
      // The stub only reaches here when the classifier chose `ok` for a political
      // text, which lets a test prove the OUTPUT check still catches it.
      content = "Đảng phái chính trị nên bị lật đổ.";
    }

    return json(response, 200, {
      id: "chatcmpl-stub",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? "stub-chat",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    });
  }

  return json(response, 404, { error: { message: "not found" } });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[biz-e2e-upstream] listening on http://127.0.0.1:${PORT}`);
});
