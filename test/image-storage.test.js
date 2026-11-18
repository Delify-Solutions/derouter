// Image storage (spec image-storage): a customer's S3-compatible CDN, and the
// re-hosting of generated images onto it.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-image-storage-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const s3 = await import("../src/lib/storage/s3.js");
const st = await import("../src/lib/storage/userStorage.js");
// The image handler is written for Next (the "@/" alias): resolved through the test hook.
register("./helpers/src-alias-hook.mjs", import.meta.url);
const { imageStorageForTests: handler } = await import("../src/sse/handlers/imageGeneration.js");

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 3)]);

let db;
before(async () => { db = await getAdapter(); });
after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(() => { db.run(`DELETE FROM userStorage`); });

const R2 = {
  provider: "r2",
  endpoint: "https://abc123.r2.cloudflarestorage.com",
  bucket: "images",
  accessKeyId: "AKID1234567890",
  secretAccessKey: "s3cr3t/KEY+value",
  publicBaseUrl: "https://pub-x.r2.dev/",
};

const config = (over = {}) => ({
  endpoint: "https://abc123.r2.cloudflarestorage.com",
  region: "auto",
  bucket: "images",
  accessKeyId: "AKID",
  secretAccessKey: "SECRET",
  forcePathStyle: true,
  publicBaseUrl: "https://pub-x.r2.dev",
  pathPrefix: null,
  ...over,
});

test("SigV4 matches AWS's published examples (header auth and presigned GET)", () => {
  const cfg = {
    endpoint: "https://s3.amazonaws.com", bucket: "examplebucket", forcePathStyle: false, region: "us-east-1",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  };
  const date = new Date("2013-05-24T00:00:00Z");
  const loc = s3.objectLocation(cfg, "test.txt");
  assert.equal(loc.url, "https://examplebucket.s3.amazonaws.com/test.txt");
  const headers = s3.signHeaders({
    method: "GET", host: loc.host, path: loc.path, headers: { Range: "bytes=0-9" },
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    region: cfg.region, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, date,
  });
  assert.match(headers.authorization, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
  assert.match(s3.presignGetUrl(cfg, "test.txt", { expiresSec: 86400, date }), /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
  // path-style keeps the bucket in the path and encodes each key segment once
  assert.equal(s3.objectLocation({ endpoint: "https://x.example", bucket: "b", forcePathStyle: true }, "a b/c+d.png").path, "/b/a%20b/c%2Bd.png");
});

test("the form is checked: https only, no internal host, sane bucket and folder", () => {
  const ok = st.validateStorageInput(R2);
  assert.equal(ok.value.region, "auto", "the R2 preset region");
  assert.equal(ok.value.publicBaseUrl, "https://pub-x.r2.dev", "trailing slash dropped");
  assert.equal(ok.value.forcePathStyle, true);
  assert.equal(st.validateStorageInput({ ...R2, provider: "s3", endpoint: "", region: "ap-southeast-1" }).value.endpoint,
    "https://s3.ap-southeast-1.amazonaws.com");
  for (const [patch, expected] of [
    [{ endpoint: "http://abc.r2.cloudflarestorage.com" }, /https/],
    [{ endpoint: "https://127.0.0.1:9000" }, /nội bộ/],
    [{ endpoint: "https://localhost" }, /nội bộ/],
    [{ endpoint: "https://169.254.169.254" }, /nội bộ/],
    [{ endpoint: "https://user:pw@host.example" }, /tài khoản/],
    [{ bucket: "A" }, /bucket/],
    [{ pathPrefix: "../etc" }, /Thư mục/],
    [{ publicBaseUrl: "http://cdn.example" }, /https/],
    [{ provider: "ftp" }, /loại/],
    [{ secretAccessKey: "" }, /Secret/],
  ]) {
    assert.match(st.validateStorageInput({ ...R2, ...patch }).error || "", expected, JSON.stringify(patch));
  }
  // with a stored row, a blank secret and a blank key id keep the stored values
  const existing = { accessKeyId: "OLDKEY", secretAccessKey: "enc:v1:x" };
  const kept = st.validateStorageInput({ ...R2, accessKeyId: "", secretAccessKey: "" }, existing);
  assert.equal(kept.value.accessKeyId, "OLDKEY");
  assert.equal(kept.value.secretAccessKey, null);
});

test("the secret is encrypted at rest and never leaves through the public view", () => {
  const row = st.saveStorageSync(db, "u1", st.validateStorageInput(R2).value);
  assert.match(row.secretAccessKey, /^enc:v1:/);
  assert.equal(st.storageConfigFromRow(row).secretAccessKey, R2.secretAccessKey);
  const view = st.toPublicStorage(row);
  assert.equal(view.hasSecret, true);
  assert.equal(view.accessKeyIdMasked, "AKID…7890");
  assert.ok(!JSON.stringify(view).includes(R2.secretAccessKey));
  assert.ok(!JSON.stringify(view).includes(R2.accessKeyId));

  // a test result survives a save that changes nothing about where it writes…
  st.recordStorageResultSync(db, "u1", { ok: true });
  const same = st.saveStorageSync(db, "u1", st.validateStorageInput({ ...R2, accessKeyId: "", secretAccessKey: "", pathPrefix: "x" }, row).value);
  assert.equal(Number(same.lastTestOk), 1);
  assert.equal(same.secretAccessKey, row.secretAccessKey, "blank secret kept the stored ciphertext");
  // …and is cleared when the bucket changes
  const moved = st.saveStorageSync(db, "u1", st.validateStorageInput({ ...R2, bucket: "other", secretAccessKey: "" }, same).value);
  assert.equal(moved.lastTestOk, null);

  // a disabled storage is not usable
  const off = st.saveStorageSync(db, "u1", st.validateStorageInput({ ...R2, enabled: false, secretAccessKey: "" }, moved).value);
  assert.equal(st.storageConfigFromRow(off), null);
  assert.equal(st.deleteStorageSync(db, "u1"), true);
  assert.equal(st.getStorageRowSync(db, "u1"), null);
});

function fakeS3() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", headers: init.headers, body: init.body });
    return new Response(init.method === "DELETE" ? null : "ok", { status: init.method === "DELETE" ? 204 : 200 });
  };
  return { calls, fetchImpl };
}

test("an upstream link is downloaded, uploaded, and replaced by the storage link", async () => {
  const { calls, fetchImpl } = fakeS3();
  const downloads = [];
  const downloadImpl = async (url) => {
    downloads.push(url);
    return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
  };
  const body = {
    created: 1,
    data: [
      { url: "https://image-create.example/v1/images/files/x.png", revised_prompt: "p" },
      { b64_json: JPEG.toString("base64") },
    ],
  };
  const now = new Date("2026-11-18T10:00:00Z");
  const result = await st.rehostImageBody(body, config({ pathPrefix: "derouter" }), { fetchImpl, downloadImpl, now });
  assert.equal(result.ok, true);
  assert.deepEqual(downloads, ["https://image-create.example/v1/images/files/x.png"]);
  const puts = calls.filter((c) => c.method === "PUT");
  assert.equal(puts.length, 2);
  assert.match(puts[0].url, /^https:\/\/abc123\.r2\.cloudflarestorage\.com\/images\/derouter\/images\/2026-11-18\/[0-9a-f-]{36}\.png$/);
  assert.equal(puts[0].headers["content-type"], "image/png");
  assert.match(puts[0].headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/auto\/s3\/aws4_request/);
  assert.match(puts[1].url, /\.jpg$/);
  const [first, second] = result.body.data;
  assert.match(first.url, /^https:\/\/pub-x\.r2\.dev\/derouter\/images\/2026-11-18\/[0-9a-f-]{36}\.png$/);
  assert.equal(first.revised_prompt, "p");
  assert.ok(!JSON.stringify(result.body).includes("image-create.example"), "the upstream link is gone");
  assert.equal(second.b64_json, JPEG.toString("base64"), "an inline image the client asked for stays");
  assert.match(second.url, /^https:\/\/pub-x\.r2\.dev\//);
  assert.equal(body.data[0].url, "https://image-create.example/v1/images/files/x.png", "input not mutated");
});

test("without a public base the link is a presigned GET", async () => {
  const { fetchImpl } = fakeS3();
  const result = await st.rehostImageBody({ data: [{ b64_json: PNG.toString("base64") }] }, config({ publicBaseUrl: null }), { fetchImpl });
  assert.match(result.body.data[0].url, /^https:\/\/abc123\.r2\.cloudflarestorage\.com\/images\/images\/.+\.png\?X-Amz-Algorithm=AWS4-HMAC-SHA256&.+X-Amz-Expires=604800&.+X-Amz-Signature=[0-9a-f]{64}$/);
});

test("all or nothing: a failed download or upload fails the response and returns no upstream link", async () => {
  const { fetchImpl } = fakeS3();
  const notFound = await st.rehostImageBody({ data: [{ url: "https://up.example/a.png" }] }, config(), {
    fetchImpl,
    downloadImpl: async () => new Response("no", { status: 404 }),
  });
  assert.deepEqual(notFound, { ok: false, error: "Không tải được ảnh vừa tạo", charge: false, storageFault: false });

  const html = await st.rehostImageBody({ data: [{ url: "https://up.example/a.png" }] }, config(), {
    fetchImpl,
    downloadImpl: async () => new Response("<html>", { status: 200 }),
  });
  assert.equal(html.error, "Ảnh trả về không đọc được");

  const denied = await st.rehostImageBody({ data: [{ b64_json: PNG.toString("base64") }] }, config(), {
    fetchImpl: async () => new Response("<Error><Code>SignatureDoesNotMatch</Code></Error>", { status: 403 }),
  });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /Sai Access Key ID hoặc Secret \(SignatureDoesNotMatch\)/);
  assert.ok(!JSON.stringify(denied).includes("up.example"));
});

test("the storage test writes, reads back through the public link and deletes", async () => {
  const { calls, fetchImpl } = fakeS3();
  const ok = await st.testStorage(config(), { fetchImpl });
  assert.deepEqual(ok, { ok: true });
  assert.deepEqual(calls.map((c) => c.method), ["PUT", "GET", "DELETE"]);
  assert.match(calls[1].url, /^https:\/\/pub-x\.r2\.dev\/derouter-test\//);

  const privateBucket = await st.testStorage(config(), {
    fetchImpl: async (url, init = {}) => new Response("", { status: (init.method || "GET") === "GET" ? 403 : 200 }),
  });
  assert.equal(privateBucket.ok, true);
  assert.match(privateBucket.warning, /công khai/);

  const noBucket = await st.testStorage(config(), {
    fetchImpl: async () => new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 }),
  });
  assert.equal(noBucket.ok, false);
  assert.match(noBucket.error, /Không tìm thấy bucket/);
});

test("save-and-test records the result for the page", async () => {
  const saved = await st.saveAndTestStorage(db, "u2", R2, {
    testImpl: async () => ({ ok: false, error: "Không tìm thấy bucket" }),
    resolveImpl: async () => {},
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.test.ok, false);
  assert.equal(saved.body.storage.lastTestOk, false);
  assert.equal(saved.body.storage.lastError, "Không tìm thấy bucket");
  assert.ok(saved.body.providers.r2);

  const bad = await st.saveAndTestStorage(db, "u3", { ...R2, endpoint: "https://10.0.0.5" });
  assert.equal(bad.status, 400);
  assert.equal(st.getStorageRowSync(db, "u3"), null, "nothing stored on a refused form");
});

// ── the handler's storage gate and re-hosting step ───────────────────────────

function key(id, userId) {
  db.run(`INSERT OR REPLACE INTO apiKeys(id, key, name, isActive, createdAt, userId) VALUES(?, ?, 'k', 1, ?, ?)`,
    [id, `sk-${id}`, new Date().toISOString(), userId]);
}

test("a customer key without a storage is refused before any upstream call; admin keys are not", async () => {
  key("ka", null);
  key("kc", "cust-1");
  assert.equal(await handler.resolveCustomerStorage("sk-ka"), null, "admin key: no storage needed");
  assert.equal(await handler.resolveCustomerStorage(null), null);
  const refused = await handler.resolveCustomerStorage("sk-kc");
  assert.equal(refused.error.status, 403);
  const body = await refused.error.json();
  assert.match(JSON.stringify(body), /\/account\/storage/);

  st.saveStorageSync(db, "cust-1", st.validateStorageInput(R2).value);
  // saved but never tested: still refused, with the way out
  const untested = await handler.resolveCustomerStorage("sk-kc");
  assert.equal(untested.error.status, 403);
  assert.match(JSON.stringify(await untested.error.json()), /Kiểm tra lại/);
  st.recordStorageResultSync(db, "cust-1", { ok: true });
  const ok = await handler.resolveCustomerStorage("sk-kc");
  assert.equal(ok.userId, "cust-1");
  assert.equal(ok.config.secretAccessKey, R2.secretAccessKey);
});

test("the response is re-hosted before usage is charged; a failed upload charges nothing", async () => {
  const storage = { userId: "cust-2", config: config() };
  st.saveStorageSync(db, "cust-2", st.validateStorageInput(R2).value);
  const upstream = () => new Response(JSON.stringify({ created: 1, data: [{ url: "https://up.example/x.png" }] }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });

  const usage = [{ apiKey: null }];
  const good = await handler.finishImage(upstream(), { storage, usage, binaryOutput: false }, {
    rehost: async (body) => ({ ok: true, body: { ...body, data: [{ url: "https://pub-x.r2.dev/a.png" }] } }),
  });
  assert.equal(good.status, 200);
  assert.deepEqual((await good.json()).data, [{ url: "https://pub-x.r2.dev/a.png" }]);
  assert.equal(usage.length, 0, "usage flushed (saved) once the images are stored");

  const pending = [{ apiKey: "sk-would-be-charged" }];
  const bad = await handler.finishImage(upstream(), { storage, usage: pending, binaryOutput: false }, {
    rehost: async () => ({ ok: false, error: "Không tìm thấy bucket", charge: false, storageFault: true }),
  });
  assert.equal(bad.status, 502);
  const text = JSON.stringify(await bad.json());
  assert.match(text, /không bị tính phí/);
  assert.equal(st.usableStorageSync(db, "cust-2").error ? true : false, true, "a failure blocks the next request until a re-test");
  assert.ok(!text.includes("up.example"), "no upstream link in the error");
  assert.equal(pending.length, 0, "dropped, not saved");
  assert.equal(st.toPublicStorage(st.getStorageRowSync(db, "cust-2")).lastError, "Không tìm thấy bucket");

  // bytes already handed to the customer's endpoint: the request is charged anyway
  const charged = [{ apiKey: null }];
  const after = await handler.finishImage(upstream(), { storage, usage: charged, binaryOutput: false }, {
    rehost: async () => ({ ok: false, error: "Lưu trữ trả lỗi HTTP 500", charge: true }),
  });
  assert.equal(after.status, 502);
  assert.match(JSON.stringify(await after.json()), /vẫn tính phí/);
  assert.equal(charged.length, 0, "flushed (saved), not dropped");

  // binary output: the bytes come back with the storage link in a header
  const bin = await handler.finishImage(new Response(PNG, { headers: { "Content-Type": "image/png" } }), {
    storage, usage: [], binaryOutput: true,
  }, { upload: async () => ({ ok: true, url: "https://pub-x.r2.dev/b.png" }) });
  assert.equal(bin.headers.get("X-Image-Url"), "https://pub-x.r2.dev/b.png");
  assert.deepEqual(Buffer.from(await bin.arrayBuffer()), PNG);

  // no storage (admin key) or an upstream error: passed through untouched
  const err = new Response("{}", { status: 500 });
  assert.equal(await handler.finishImage(err, { storage, usage: [], binaryOutput: false }), err);
  const adminResponse = upstream();
  assert.equal(await handler.finishImage(adminResponse, { storage: null, usage: [], binaryOutput: false }), adminResponse);
});

test("charging: free only while no image byte reached the customer's endpoint", async () => {
  const two = { data: [{ b64_json: PNG.toString("base64") }, { b64_json: JPEG.toString("base64") }] };
  let n = 0;
  const secondFails = async (url, init = {}) => {
    n += 1;
    return new Response(n === 1 ? "" : "<Error><Code>InternalError</Code></Error>", { status: n === 1 ? 200 : 500 });
  };
  const partial = await st.rehostImageBody(two, config(), { fetchImpl: secondFails });
  assert.equal(partial.ok, false);
  assert.equal(partial.charge, true, "image 1 is in the customer's bucket");

  const answeredError = await st.rehostImageBody({ data: [{ b64_json: PNG.toString("base64") }] }, config(), {
    fetchImpl: async () => new Response("", { status: 500 }),
  });
  assert.equal(answeredError.charge, true, "the bytes were sent before the error came back");

  const blockedEndpoint = await st.rehostImageBody({ data: [{ b64_json: PNG.toString("base64") }] }, config(), {
    fetchImpl: async () => { const e = new Error("Blocked URL"); e.blocked = true; throw e; },
  });
  assert.equal(blockedEndpoint.charge, false, "nothing left the router");
  assert.match(blockedEndpoint.error, /nội bộ/);

  const notAnImage = await st.rehostImageBody({ data: [{ b64_json: Buffer.from("<html>hello world</html>").toString("base64") }] }, config(), {
    fetchImpl: async () => { throw new Error("must not upload"); },
  });
  assert.deepEqual(notAnImage, { ok: false, error: "Ảnh trả về không đọc được", charge: false, storageFault: false });
});

test("zero images is a failure, and only known fields reach the customer", async () => {
  const { fetchImpl } = fakeS3();
  for (const body of [{ data: [] }, { images: [{ url: "https://upstream.example/x.png" }] }, {}]) {
    const r = await st.rehostImageBody(body, config(), { fetchImpl });
    assert.deepEqual(r, { ok: false, error: "Model không trả về ảnh nào", charge: false, storageFault: false });
  }
  const r = await st.rehostImageBody({
    created: 5,
    provider_url: "https://upstream.example/raw",
    usage: { total_tokens: 3 },
    data: [{ b64_json: PNG.toString("base64"), source: "https://upstream.example/x.png", revised_prompt: "rp" }],
  }, config(), { fetchImpl });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.body).sort(), ["created", "data", "usage"]);
  assert.deepEqual(Object.keys(r.body.data[0]).sort(), ["b64_json", "revised_prompt", "url"]);
  assert.ok(!JSON.stringify(r.body).includes("upstream.example"));
});

test("the 25 MB cap holds for inline, data: URL and downloaded images", async () => {
  const { fetchImpl } = fakeS3();
  const big = Buffer.concat([PNG, Buffer.alloc(st.IMAGE_DOWNLOAD_MAX_BYTES)]);
  const inline = await st.rehostImageBody({ data: [{ b64_json: big.toString("base64") }] }, config(), { fetchImpl });
  assert.equal(inline.error, "Ảnh vượt quá 25 MB");
  const dataUrl = await st.rehostImageBody({ data: [{ url: `data:image/png;base64,${big.toString("base64")}` }] }, config(), { fetchImpl });
  assert.equal(dataUrl.error, "Ảnh vượt quá 25 MB");
  // a download with no content-length is cut while streaming
  const streamed = await st.rehostImageBody({ data: [{ url: "https://up.example/a.png" }] }, config(), {
    fetchImpl,
    downloadImpl: async () => new Response(new ReadableStream({
      start(c) { for (let i = 0; i < 27; i++) c.enqueue(new Uint8Array(1024 * 1024)); c.close(); },
    })),
  });
  assert.equal(streamed.error, "Ảnh vượt quá 25 MB");
  assert.equal((await st.uploadImage(config(), big, { fetchImpl })).sent, false);
});

test("customer endpoints: https only, internal addresses refused at save time and at connect time", async () => {
  const { safeFetch, guardedLookup } = await import("../src/lib/storage/safeHttp.js");
  await assert.rejects(safeFetch("http://example.com/x"), (e) => e.blocked === true);
  await assert.rejects(safeFetch("https://127.0.0.1/x"), (e) => e.blocked === true);
  await assert.rejects(safeFetch("https://[::1]/x"), (e) => e.blocked === true);
  // the lookup used to open the socket refuses a name that resolves inside
  await new Promise((resolve) => guardedLookup("localhost", {}, (err) => {
    assert.equal(err?.blocked, true);
    resolve();
  }));

  const refused = await st.saveAndTestStorage(db, "u9", { ...R2, endpoint: "https://rebind.example" }, {
    resolveImpl: async () => { throw new Error("Blocked URL: hostname resolves to an internal host"); },
    testImpl: async () => { throw new Error("must not test"); },
  });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /nội bộ/);
  assert.equal(st.getStorageRowSync(db, "u9"), null);
});

test("tests are rate limited per account on the customer routes", async () => {
  st.resetStorageTestLimitForTests();
  const pass = async () => ({ ok: true });
  const none = async () => {};
  for (let i = 0; i < 10; i++) {
    const r = await st.saveAndTestStorage(db, "u10", R2, { testImpl: pass, rateLimit: true, resolveImpl: none });
    assert.equal(r.status, 200, `attempt ${i + 1}`);
  }
  const limited = await st.retestStorage(db, "u10", { testImpl: pass, rateLimit: true });
  assert.equal(limited.status, 429);
  // the admin route is not limited
  assert.equal((await st.retestStorage(db, "u10", { testImpl: pass })).status, 200);
  st.resetStorageTestLimitForTests();
});

test("an upstream without a usable image does not mark the storage as failing", async () => {
  const storage = { userId: "cust-3", config: config() };
  st.saveStorageSync(db, "cust-3", st.validateStorageInput(R2).value);
  st.recordStorageResultSync(db, "cust-3", { ok: true });
  const res = await handler.finishImage(new Response(JSON.stringify({ data: [] }), { status: 200 }), {
    storage, usage: [{ apiKey: "x" }], binaryOutput: false,
  });
  assert.equal(res.status, 502);
  const text = JSON.stringify(await res.json());
  assert.match(text, /Không nhận được ảnh hợp lệ từ model/);
  assert.match(text, /không bị tính phí/);
  assert.ok(!st.usableStorageSync(db, "cust-3").error, "the storage stays usable");
});

test("the transport settles on every ending: 101 upgrade, closed socket, refused connection", async () => {
  const http = await import("node:http");
  const net = await import("node:net");
  const { guardedRequest } = await import("../src/lib/storage/safeHttp.js");
  const loose = { transport: http, protocol: "http:", checkLiteral: false, lookup: undefined, hardTimeoutMs: 3000 };

  // a server that reads the whole body, then answers 101
  const upgrade = net.createServer((socket) => {
    socket.once("data", () => socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\nConnection: Upgrade\r\n\r\n"));
  });
  await new Promise((r) => upgrade.listen(0, "127.0.0.1", r));
  const started = Date.now();
  await assert.rejects(
    guardedRequest(`http://127.0.0.1:${upgrade.address().port}/k`, { method: "PUT", body: Buffer.from("img") }, loose),
    (e) => /upgrade|closed/.test(e.message) && !e.notSent,
  );
  assert.ok(Date.now() - started < 2500, "settled by the event, not the hard timer");
  upgrade.close();

  // a server that drops the connection after reading the body
  const drop = net.createServer((socket) => socket.once("data", () => socket.destroy()));
  await new Promise((r) => drop.listen(0, "127.0.0.1", r));
  await assert.rejects(
    guardedRequest(`http://127.0.0.1:${drop.address().port}/k`, { method: "PUT", body: Buffer.from("img") }, loose),
    (e) => !e.notSent, // the body was written: charged
  );
  drop.close();

  // nothing listening: nothing can have been sent
  const free = net.createServer();
  await new Promise((r) => free.listen(0, "127.0.0.1", r));
  const port = free.address().port;
  await new Promise((r) => free.close(r));
  await assert.rejects(
    guardedRequest(`http://127.0.0.1:${port}/k`, { method: "PUT", body: Buffer.from("img") }, loose),
    (e) => e.notSent === true,
  );

  // a server that never answers: the hard timer ends it
  const silent = net.createServer(() => {});
  await new Promise((r) => silent.listen(0, "127.0.0.1", r));
  await assert.rejects(
    guardedRequest(`http://127.0.0.1:${silent.address().port}/k`, { method: "PUT", body: Buffer.from("img") }, { ...loose, hardTimeoutMs: 300 }),
    (e) => e.name === "TimeoutError",
  );
  silent.close();
});

test("a failure before the connection is up is not charged", async () => {
  const notConnected = await st.rehostImageBody({ data: [{ b64_json: PNG.toString("base64") }] }, config(), {
    fetchImpl: async () => { const e = new Error("connect ECONNREFUSED"); e.notSent = true; throw e; },
  });
  assert.equal(notConnected.charge, false);
  assert.equal(notConnected.storageFault, true);
});


// ── the system storage (admin fallback) and the admin overview ───────────────

function systemStorage({ ok = true } = {}) {
  st.saveStorageSync(db, st.SYSTEM_STORAGE_ID, st.validateStorageInput({ ...R2, bucket: "system-images" }).value, { actor: "admin" });
  if (ok != null) st.recordStorageResultSync(db, st.SYSTEM_STORAGE_ID, { ok });
}

test("the system storage serves customers whose own storage is missing, failing or off", async () => {
  key("ks", "cust-sys");
  // no system storage yet: refused as before
  assert.equal((await handler.resolveCustomerStorage("sk-ks")).error.status, 403);

  // configured but its test failed: not used
  systemStorage({ ok: false });
  assert.equal((await handler.resolveCustomerStorage("sk-ks")).error.status, 403);
  assert.equal(st.storageViewSync(db, "cust-sys").systemFallback, false);

  systemStorage({ ok: true });
  const viaSystem = await handler.resolveCustomerStorage("sk-ks");
  assert.equal(viaSystem.system, true);
  assert.equal(viaSystem.userId, st.SYSTEM_STORAGE_ID);
  assert.equal(viaSystem.config.bucket, "system-images");
  const view = st.storageViewSync(db, "cust-sys");
  assert.equal(view.systemFallback, true);
  assert.equal(view.storage, null, "the customer never sees the system storage itself");

  // the customer's own working storage wins
  st.saveStorageSync(db, "cust-sys", st.validateStorageInput(R2).value);
  st.recordStorageResultSync(db, "cust-sys", { ok: true });
  const own = await handler.resolveCustomerStorage("sk-ks");
  assert.equal(own.system, false);
  assert.equal(own.userId, "cust-sys");

  // own storage failing: back to the system one
  st.recordStorageResultSync(db, "cust-sys", { ok: false, error: "x" });
  assert.equal((await handler.resolveCustomerStorage("sk-ks")).system, true);

  // the system storage switched off: refused with the customer's own reason
  systemStorage({ ok: true });
  const row = st.getStorageRowSync(db, st.SYSTEM_STORAGE_ID);
  st.saveStorageSync(db, st.SYSTEM_STORAGE_ID, { ...st.validateStorageInput({ ...R2, bucket: "system-images" }, row).value, enabled: false }, { actor: "admin" });
  const refused = await handler.resolveCustomerStorage("sk-ks");
  assert.equal(refused.error.status, 403);
  assert.match(JSON.stringify(await refused.error.json()), /Kiểm tra lại/);
});

test("a system storage failure is never charged, marks it failing and hides its reason", async () => {
  systemStorage({ ok: true });
  const storage = { userId: st.SYSTEM_STORAGE_ID, system: true, config: config() };
  const upstream = () => new Response(JSON.stringify({ data: [{ url: "https://up.example/x.png" }] }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
  const pending = [{ apiKey: "sk-would-be-charged" }];
  const res = await handler.finishImage(upstream(), { storage, usage: pending, binaryOutput: false }, {
    rehost: async () => ({ ok: false, error: "Sai Access Key ID hoặc Secret", charge: true, storageFault: true }),
  });
  assert.equal(res.status, 502);
  const text = JSON.stringify(await res.json());
  assert.match(text, /không bị tính phí/);
  assert.ok(!text.includes("Access Key"), "the system bucket's error stays with the admin");
  assert.ok(!text.includes("up.example"));
  assert.equal(pending.length, 0, "dropped, not saved");
  assert.equal(st.systemStorageConfigSync(db), null, "unusable until re-tested");
  assert.equal(st.getStorageRowSync(db, st.SYSTEM_STORAGE_ID).lastError, "Sai Access Key ID hoặc Secret");
});

test("the admin overview lists customer storages by status, never the system one or a secret", () => {
  const now = new Date().toISOString();
  for (const [id, email] of [["ov-1", "a@x.test"], ["ov-2", "b@x.test"], ["ov-3", "c@x.test"]]) {
    db.run(
      `INSERT OR REPLACE INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
       VALUES(?, ?, 'h', NULL, NULL, 'active', 0, ?, ?)`,
      [id, email, now, now]
    );
  }
  st.saveStorageSync(db, "ov-1", st.validateStorageInput(R2).value);
  st.recordStorageResultSync(db, "ov-1", { ok: true });
  st.saveStorageSync(db, "ov-2", st.validateStorageInput(R2).value);
  st.recordStorageResultSync(db, "ov-2", { ok: false, error: "Không tìm thấy bucket" });
  systemStorage({ ok: true });

  const overview = st.storageOverviewSync(db);
  assert.deepEqual(overview.storages.map((s) => [s.userId, s.status]).sort(), [["ov-1", "ok"], ["ov-2", "failing"]]);
  assert.equal(overview.storages.find((s) => s.userId === "ov-1").email, "a@x.test");
  assert.equal(overview.counts.ok, 1);
  assert.equal(overview.counts.failing, 1);
  assert.equal(overview.counts.none, overview.customers - 2);
  assert.equal(overview.systemActive, true);
  assert.equal(overview.system.bucket, "system-images");
  const text = JSON.stringify(overview);
  assert.ok(!text.includes(R2.secretAccessKey), "no secret");
  assert.ok(!text.includes(R2.accessKeyId), "key ids masked");
});

test("the admin is alerted once when the system storage goes down, never for a customer's", async () => {
  const sent = [];
  const notify = async (text) => { sent.push(text); return { ok: true }; };
  systemStorage({ ok: true });
  const system = { userId: st.SYSTEM_STORAGE_ID, system: true, config: config() };
  await handler.markStorageFailing(system, "Không tìm thấy bucket", { notify });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /CDN ảnh hệ thống lỗi/);
  await handler.markStorageFailing(system, "again", { notify });
  assert.equal(sent.length, 1, "already failing: no second alert");

  st.saveStorageSync(db, "cust-alert", st.validateStorageInput(R2).value);
  st.recordStorageResultSync(db, "cust-alert", { ok: true });
  await handler.markStorageFailing({ userId: "cust-alert", system: false, config: config() }, "x", { notify });
  assert.equal(sent.length, 1, "a customer's storage never alerts the admin");
  assert.equal(st.getStorageRowSync(db, "cust-alert").lastTestOk, 0);
});

// ── local storage (admin-picked customers) ───────────────────────────────────

test("an admin-picked customer's images go to the router's disk, ahead of any CDN", async () => {
  const local = await import("../src/lib/storage/localImages.js");
  const now = new Date().toISOString();
  db.run(
    `INSERT OR REPLACE INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
     VALUES('loc-1', 'loc@x.test', 'h', NULL, NULL, 'active', 0, ?, ?)`,
    [now, now]
  );
  key("kl", "loc-1");
  st.saveStorageSync(db, "loc-1", st.validateStorageInput(R2).value);
  st.recordStorageResultSync(db, "loc-1", { ok: true });
  assert.equal((await handler.resolveCustomerStorage("sk-kl", { baseUrl: "https://ai.example" })).local, false);

  assert.equal(local.setLocalImageUserSync(db, "loc-1", true), true);
  const picked = await handler.resolveCustomerStorage("sk-kl", { baseUrl: "https://ai.example" });
  assert.equal(picked.local, true, "the admin's pick wins over the customer's own CDN");
  assert.equal(st.storageViewSync(db, "loc-1").localStorage, true);
  assert.equal((await handler.resolveCustomerStorage("sk-kl")).error.status, 403, "no public origin: refused, not a broken link");

  // the image is written under DATA_DIR and served back by its public name
  const out = await st.rehostImageBody({ data: [{ url: "https://up.example/x.png" }] }, picked.config, {
    downloadImpl: async () => new Response(PNG, { status: 200 }),
  });
  assert.equal(out.ok, true);
  const link = out.body.data[0].url;
  assert.match(link, /^https:\/\/ai\.example\/api\/public\/images\/\d{8}-[0-9a-f-]{36}\.png$/);
  const served = await local.readLocalImage(link.split("/").pop());
  assert.deepEqual(served.bytes, PNG);
  assert.equal(served.type, "image/png");
  assert.ok((await local.localImagesUsage({ fresh: true })).files >= 1);

  // names are ours only: no traversal, no other file under DATA_DIR
  for (const bad of ["../storage.sqlite", "20260101-x.png", `20260101-${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}.svg`, ""]) {
    assert.equal(await local.readLocalImage(bad), null, bad);
  }

  const overview = st.storageOverviewSync(db);
  assert.deepEqual(overview.localUsers.map((u) => u.email), ["loc@x.test"]);

  local.setLocalImageUserSync(db, "loc-1", false);
  assert.equal((await handler.resolveCustomerStorage("sk-kl", { baseUrl: "https://ai.example" })).local, false);
});

test("a failed write to the router's disk is free and marks no storage", async () => {
  st.saveStorageSync(db, "loc-2", st.validateStorageInput(R2).value);
  st.recordStorageResultSync(db, "loc-2", { ok: true });
  const failed = await st.uploadImage({ local: true, baseUrl: "https://ai.example" }, PNG, {
    saveLocal: () => { throw new Error("ENOSPC"); },
  });
  assert.deepEqual(failed, { ok: false, error: "Máy chủ không ghi được ảnh (unknown)", sent: false, storageFault: true });

  const storage = { userId: "loc-2", system: false, local: true, config: { local: true, baseUrl: "https://ai.example" } };
  const pending = [{ apiKey: "sk-would-be-charged" }];
  const res = await handler.finishImage(
    new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    { storage, usage: pending, binaryOutput: false },
    { rehost: async () => ({ ok: false, error: "Máy chủ không ghi được ảnh", charge: true, storageFault: true }) },
  );
  assert.equal(res.status, 502);
  assert.match(JSON.stringify(await res.json()), /không bị tính phí/);
  assert.equal(pending.length, 0, "dropped, not saved");
  assert.equal(st.getStorageRowSync(db, "loc-2").lastTestOk, 1, "the customer's own CDN is untouched");
});

test("local links use the configured or forwarded origin, never the server's bind address", async () => {
  const { localImageBaseUrl } = await import("../src/lib/storage/localImages.js");
  const req = (url, headers = {}) => new Request(url, { headers });
  // Next hands route handlers the bind address: never usable as a link.
  assert.equal(localImageBaseUrl(req("http://0.0.0.0:20128/v1/images/generations"), {}), "");
  assert.equal(localImageBaseUrl(req("http://0.0.0.0:20128/x", { host: "0.0.0.0:20128" }), {}), "");
  assert.equal(localImageBaseUrl(req("http://0.0.0.0:20128/x", { host: "localhost:20128" }), {}), "");
  assert.equal(
    localImageBaseUrl(req("http://0.0.0.0:20128/x", { "x-forwarded-host": "ai.example", "x-forwarded-proto": "https", host: "127.0.0.1:20128" }), {}),
    "https://ai.example"
  );
  assert.equal(localImageBaseUrl(req("http://0.0.0.0:20128/x", { host: "AI.example" }), {}), "https://ai.example");
  assert.equal(localImageBaseUrl(req("http://0.0.0.0:20128/x", { host: "evil.example/path?x" }), {}), "", "not a host");
  for (const internal of ["router:20128", "172.18.0.3:20128", "10.0.0.5", "[fd00::1]:20128", "192.168.1.2"]) {
    assert.equal(localImageBaseUrl(req("http://0.0.0.0:20128/x", { host: internal }), {}), "", internal);
  }
  assert.equal(localImageBaseUrl(req("http://0.0.0.0:20128/x", { host: "8.8.8.8:8443" }), {}), "https://8.8.8.8:8443");
  assert.equal(
    localImageBaseUrl(req("http://0.0.0.0:20128/x", { host: "other.example" }), { publicBaseUrl: "https://ai.delify.example/" }),
    "https://ai.delify.example",
    "the configured origin wins"
  );
});

test("the router's disk is not filled: writes stop below the free-space floor", async () => {
  const local = await import("../src/lib/storage/localImages.js");
  assert.throws(
    () => local.saveLocalImage(PNG, "image/png", new Date(), { freeBytes: () => local.LOCAL_IMAGE_MIN_FREE_BYTES }),
    (e) => e.code === "LOW_DISK"
  );
  const failed = await st.uploadImage({ local: true, baseUrl: "https://ai.example" }, PNG, {
    saveLocal: () => { const e = new Error("full"); e.code = "LOW_DISK"; throw e; },
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /sắp hết dung lượng.*LOW_DISK/);
  assert.equal(failed.sent, false);
});

test("the public image route streams a stored image with safe headers and 404s anything else", async () => {
  const local = await import("../src/lib/storage/localImages.js");
  const { GET } = await import("../src/app/api/public/images/[name]/route.js");
  const name = local.saveLocalImage(PNG, "image/png", new Date(), { freeBytes: () => null });
  const res = await GET(new Request(`https://ai.example/api/public/images/${name}`), { params: Promise.resolve({ name }) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(res.headers.get("content-length"), String(PNG.length));
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(res.headers.get("content-security-policy"), /sandbox/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  // HEAD answers from stat alone: no stream is opened that nobody would close
  const { HEAD } = await import("../src/app/api/public/images/[name]/route.js");
  const head = await HEAD(new Request(`https://ai.example/api/public/images/${name}`, { method: "HEAD" }), { params: Promise.resolve({ name }) });
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  assert.equal(head.headers.get("content-length"), String(PNG.length));
  assert.equal(head.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await HEAD(new Request("https://ai.example/x", { method: "HEAD" }), { params: Promise.resolve({ name: "../x" }) })).status, 404);
  for (const bad of ["../storage.sqlite", name.replace(".png", ".svg"), name.toUpperCase()]) {
    const miss = await GET(new Request("https://ai.example/x"), { params: Promise.resolve({ name: bad }) });
    assert.equal(miss.status, 404, bad);
  }
});
