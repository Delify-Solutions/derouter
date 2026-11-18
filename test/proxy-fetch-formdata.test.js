// The patched global fetch (open-sse/utils/proxyFetch.js) sends through the npm
// undici, which does not recognise Node's built-in FormData: a multipart upload
// went out as the text "[object FormData]". Telegram answered "there is no photo
// in the request" to every broadcast photo; image uploads through
// imageGenerationCore (Cloudflare AI), the admin STT model ping and the Cloudflare
// worker deploy were hit the same way. sttCore builds the npm undici's own
// FormData and was not affected.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const { proxyAwareFetch, encodeForeignBody } = await import("../open-sse/utils/proxyFetch.js");
const { sendTelegramPhoto } = await import("../src/lib/notify/telegramApi.js");

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("pixels")]);

let server;
let base;
let last = null;
before(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      last = { type: req.headers["content-type"] || "", body: Buffer.concat(chunks) };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, result: { photo: [{ file_id: "small" }, { file_id: "big" }] } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

function form() {
  const fd = new FormData();
  fd.append("chat_id", "42");
  fd.append("photo", new Blob([PNG], { type: "image/png" }), "image.png");
  return fd;
}

function assertMultipart() {
  assert.match(last.type, /^multipart\/form-data; boundary=/);
  const text = last.body.toString("latin1");
  assert.ok(!text.includes("[object FormData]"));
  assert.match(text, /name="chat_id"\r\n\r\n42\r\n/);
  assert.match(text, /name="photo"; filename="image.png"\r\nContent-Type: image\/png\r\n\r\n/);
  assert.ok(last.body.includes(PNG), "the file bytes are in the body");
}

test("the patched global fetch sends a built-in FormData as multipart", async () => {
  assert.equal(globalThis.fetch.name, "patchedFetch", "importing proxyFetch patches the global fetch, as in production");
  const res = await fetch(`${base}/upload`, { method: "POST", body: form() });
  assert.equal(res.status, 200);
  assertMultipart();
});

test("proxyAwareFetch replaces a caller's content-type with the multipart boundary", async () => {
  await proxyAwareFetch(`${base}/upload`, { method: "POST", body: form(), headers: { "Content-Type": "application/json", "X-Keep": "1" } });
  assertMultipart();
});

test("a Telegram photo upload carries the photo through the patched fetch", async () => {
  const sent = await sendTelegramPhoto("TOKEN", "42", { buffer: PNG, type: "image/png" }, "<b>hi</b>", {
    fetchImpl: (url, init) => globalThis.fetch(`${base}/sendPhoto`, init),
  });
  assert.deepEqual(sent, { ok: true, fileId: "big" });
  assertMultipart();
  assert.match(last.body.toString("utf8"), /name="caption"\r\n\r\n<b>hi<\/b>\r\n/);
});

test("other bodies pass through untouched", async () => {
  const opts = { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } };
  assert.equal(await encodeForeignBody(opts), opts);
  const params = { method: "POST", body: new URLSearchParams({ a: "1" }) };
  assert.equal(await encodeForeignBody(params), params);
  assert.deepEqual(await encodeForeignBody({}), {});
});

test("the npm undici's own FormData is left to stream, and still arrives as multipart", async () => {
  const { FormData: UndiciFormData } = await import("undici");
  const fd = new UndiciFormData();
  fd.append("chat_id", "42");
  fd.append("photo", new Blob([PNG], { type: "image/png" }), "image.png");
  const opts = { method: "POST", body: fd };
  assert.equal(await encodeForeignBody(opts), opts, "not buffered");
  await fetch(`${base}/upload`, opts);
  assertMultipart();
});

test("a built-in Request passed to the patched fetch keeps its URL, method, headers and body", async () => {
  const res = await fetch(new Request(`${base}/req`, { method: "POST", body: "hello", headers: { "X-A": "1", "Content-Type": "text/plain" } }));
  assert.equal(res.status, 200);
  assert.equal(last.body.toString(), "hello");
  assert.equal(last.type, "text/plain");
});
