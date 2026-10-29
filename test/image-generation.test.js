// Image generation: custom OpenAI-compatible nodes, per-image pricing and charging.
//
// The upstream is a local HTTP fixture shaped like the gateway in the owner's curl
// (`POST <base>/images/generations` -> `{ created, data: [{ url }] }`). It has NOT
// been checked against the real upstream: the supplied key was refused with
// "endpoint not permitted for this key".
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-image-test-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const { getImageAdapter, isImageProvider } = await import("../open-sse/handlers/imageProviders/index.js");
const { handleImageGenerationCore } = await import("../open-sse/handlers/imageGenerationCore.js");
const { costFromImagesNano, NANO } = await import("../src/shared/utils/money.js");
const usage = await import("../src/lib/db/repos/usageRepo.js");
const pricing = await import("../src/lib/db/repos/pricingRepo.js");
const comboPricing = await import("../src/lib/db/repos/comboPricingRepo.js");

const USD = (n) => Math.round(n * NANO);
const NODE = "openai-compatible-abc123";

let db;
let server;
let baseUrl;
let received = [];

before(async () => {
  db = await getAdapter();
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      received.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(raw || "{}") });
      if (req.headers.authorization !== "Bearer good-key") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "forbidden: endpoint not permitted for this key" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ created: 1, data: [{ url: "https://img.test/a.png" }, { url: "https://img.test/b.png" }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/ai/openai/v1`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  received = [];
  for (const table of ["userPlanWindows", "creditLedger", "userPlans", "apiKeys", "users", "usageHistory", "kv"]) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* partial schema */ }
  }
});

const credentials = (apiKey = "good-key") => ({ apiKey, providerSpecificData: { baseUrl } });

test("a custom OpenAI-compatible node gets an image adapter; unknown providers do not", () => {
  assert.ok(getImageAdapter(NODE));
  assert.equal(isImageProvider(NODE), true);
  assert.equal(getImageAdapter("not-a-provider"), null);
  assert.equal(isImageProvider("not-a-provider"), false);
});

test("the node adapter forwards model-specific fields and swaps only the model", async () => {
  const body = {
    model: "ignored-client-name",
    prompt: "same fox, now at sunset",
    condition_images: ["https://files.test/9a3d.png"],
    num_inference_steps: 20,
    seed: 7,
    response_format: "url",
  };
  const result = await handleImageGenerationCore({
    body,
    modelInfo: { provider: NODE, model: "Qwen/Qwen-Image-2.1" },
    credentials: credentials(),
  });

  assert.equal(result.success, true);
  assert.equal(result.imageCount, 2, "the number of returned images is what gets charged");
  const sent = received[0];
  assert.equal(sent.method, "POST");
  assert.equal(sent.url, "/ai/openai/v1/images/generations");
  assert.equal(sent.auth, "Bearer good-key");
  assert.deepEqual(sent.body, { ...body, model: "Qwen/Qwen-Image-2.1" });
  assert.deepEqual((await result.response.json()).data.length, 2);
});

test("a rejected key surfaces the upstream message and does not crash the 403 path", async () => {
  const result = await handleImageGenerationCore({
    body: { prompt: "x" },
    modelInfo: { provider: NODE, model: "Qwen/Qwen-Image-2.1" },
    credentials: credentials("bad-key"),
  });
  assert.equal(result.success, false);
  assert.match(String(result.error), /not permitted for this key/);
});

test("the built-in OpenAI adapter still drops fields it does not whitelist", async () => {
  const adapter = getImageAdapter("openai");
  const sent = adapter.buildBody("gpt-image-1", { prompt: "p", seed: 7, condition_images: ["u"], n: 2 });
  assert.equal(sent.seed, undefined);
  assert.equal(sent.condition_images, undefined);
  assert.equal(sent.n, 2);
});

test("costFromImagesNano prices per image and is zero without a price", () => {
  assert.equal(costFromImagesNano(2, { image: 0.04 }), USD(0.08));
  assert.equal(costFromImagesNano(1, { image: 0 }), 0);
  assert.equal(costFromImagesNano(1, { input: 1 }), 0);
  assert.equal(costFromImagesNano(0, { image: 0.04 }), 0);
});

function seedCustomer({ creditUsd = 10 } = {}) {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
     VALUES('u1', 'u1@test.local', 'x', NULL, NULL, 'active', 0, ?, ?)`,
    [now, now]
  );
  db.run(`INSERT INTO apiKeys(id, key, name, isActive, createdAt, userId) VALUES('k1', 'secret-k1', 'k1', 1, ?, 'u1')`, [now]);
  db.run(
    `INSERT INTO userPlans(id, userId, planId, orderId, source, creditTotalNanoUsd, creditRemainingNanoUsd, startsAt, expiresAt, status, createdAt)
     VALUES('up1', 'u1', NULL, NULL, 'admin', ?, ?, ?, ?, 'active', ?)`,
    [USD(creditUsd), USD(creditUsd), now, new Date(Date.now() + 30 * 86_400_000).toISOString(), now]
  );
}

test("a finished image request is priced per image and charged to the customer's plan", async () => {
  await pricing.updatePricing({ [NODE]: { "Qwen/Qwen-Image-2.1": { image: 0.04 } } });
  seedCustomer();

  await usage.saveRequestUsage({
    provider: NODE,
    model: "Qwen/Qwen-Image-2.1",
    apiKey: "secret-k1",
    endpoint: "/v1/images/generations",
    tokens: {},
    imageCount: 2,
    status: "success",
  });

  const row = db.get(`SELECT * FROM usageHistory ORDER BY id DESC LIMIT 1`);
  assert.equal(row.costNanoUsd, USD(0.08));
  assert.equal(JSON.parse(row.tokens).image_count, 2);
  const charge = db.get(`SELECT * FROM creditLedger WHERE kind = 'charge'`);
  assert.equal(charge.deltaNanoUsd, -USD(0.08));
  assert.equal(db.get(`SELECT creditRemainingNanoUsd AS c FROM userPlans WHERE id = 'up1'`).c, USD(10) - USD(0.08));
});

test("a combo price per image wins over the per-model price", async () => {
  await pricing.updatePricing({ [NODE]: { "Qwen/Qwen-Image-2.1": { image: 0.04 } } });
  await comboPricing.updateComboPricing({ "my-image": { image: 0.1 } });
  seedCustomer();

  await usage.saveRequestUsage({
    provider: NODE,
    model: "Qwen/Qwen-Image-2.1",
    apiKey: "secret-k1",
    endpoint: "/v1/images/generations",
    tokens: {},
    imageCount: 1,
    status: "success",
    requestedModel: "my-image",
  });

  assert.equal(db.get(`SELECT costNanoUsd AS c FROM usageHistory ORDER BY id DESC LIMIT 1`).c, USD(0.1));
});

test("two image requests saved in the same millisecond are both recorded and charged", async () => {
  await pricing.updatePricing({ [NODE]: { "Qwen/Qwen-Image-2.1": { image: 0.04 } } });
  seedCustomer();
  const entry = {
    timestamp: new Date().toISOString(),
    provider: NODE,
    model: "Qwen/Qwen-Image-2.1",
    apiKey: "secret-k1",
    endpoint: "/v1/images/generations",
    tokens: {},
    imageCount: 1,
    status: "success",
  };

  await usage.saveRequestUsage({ ...entry });
  await usage.saveRequestUsage({ ...entry });

  assert.equal(db.get(`SELECT COUNT(*) AS n FROM usageHistory`).n, 2, "image rows have no token counts to tell them apart");
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM creditLedger WHERE kind = 'charge'`).n, 2);
  assert.equal(db.get(`SELECT creditRemainingNanoUsd AS c FROM userPlans WHERE id = 'up1'`).c, USD(10) - USD(0.08));
});
