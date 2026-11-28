// Combo names are matched ignoring case (change request-400-and-model-case, spec
// api-access-enforcement "Combo names are matched ignoring case").
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-model-case-"));
process.env.DATA_DIR = tmpDir;
register("./helpers/src-alias-hook.mjs", import.meta.url);
register("./helpers/next-server-hook.mjs", import.meta.url);

const { getAdapter } = await import("../src/lib/db/driver.js");
const { createApiKey } = await import("../src/lib/db/repos/apiKeysRepo.js");
const { createKeyGroup } = await import("../src/lib/db/repos/keyGroupsRepo.js");
const combos = await import("../src/lib/db/repos/combosRepo.js");
const { customerMayCallSync } = await import("../src/lib/models/customerModels.js");
const { matchesAllowed } = await import("../src/lib/auth/modelMatching.js");
const { superAdminAuthHeaders } = await import("./helpers/adminSession.mjs");

let db;
let customerKey;
let authHeaders;
before(async () => {
  db = await getAdapter();
  authHeaders = await superAdminAuthHeaders();
  const now = new Date().toISOString();
  const group = await createKeyGroup({ name: "g", allowedModels: ["DeepSeek-V4.1-Flash"] });
  db.run(`INSERT INTO users(id, email, passwordHash, status, groupId, createdAt) VALUES('u1', 'u1@t.io', 'x', 'active', ?, ?)`, [group.id, now]);
  db.run(`INSERT INTO combos(id, name, models, createdAt, updatedAt) VALUES('c1', 'DeepSeek-V4.1-Flash', ?, ?, ?)`, [JSON.stringify(["zai/glm-5.3:pre"]), now, now]);
  customerKey = (await createApiKey("cust", "m", { userId: "u1" })).key;
});
after(() => {
  try { db.close?.(); } catch { /* best effort */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("a combo is found whatever the case the client types", async () => {
  for (const typed of ["DeepSeek-V4.1-Flash", "deepseek-v4.1-flash", "DEEPSEEK-V4.1-FLASH", "dEEPseek-V4.1-flash"]) {
    assert.equal(await combos.canonicalComboName(typed), "DeepSeek-V4.1-Flash", typed);
    assert.equal(combos.canonicalComboNameSync(db, typed), "DeepSeek-V4.1-Flash", typed);
  }
});

test("anything that is not a single case-insensitive combo match is left alone", async () => {
  assert.equal(await combos.canonicalComboName("unknown-model"), "unknown-model");
  assert.equal(await combos.canonicalComboName("zai/glm-5.3:pre"), "zai/glm-5.3:pre"); // provider/model id
  assert.equal(await combos.canonicalComboName("ZAI/GLM-5.3:PRE"), "ZAI/GLM-5.3:PRE");
  assert.equal(await combos.canonicalComboName(""), "");
  assert.equal(await combos.canonicalComboName(undefined), undefined);
  assert.equal(await combos.canonicalComboName(42), 42);
});

test("an exact match wins, and two combos differing only by case stay ambiguous", async () => {
  const now = new Date().toISOString();
  db.run(`INSERT INTO combos(id, name, models, createdAt, updatedAt) VALUES('c2', 'Twin', ?, ?, ?)`, [JSON.stringify(["a/b"]), now, now]);
  db.run(`INSERT INTO combos(id, name, models, createdAt, updatedAt) VALUES('c3', 'twin', ?, ?, ?)`, [JSON.stringify(["a/b"]), now, now]);
  assert.equal(await combos.canonicalComboName("Twin"), "Twin");
  assert.equal(await combos.canonicalComboName("twin"), "twin");
  assert.equal(await combos.canonicalComboName("TWIN"), "TWIN"); // two candidates: no guess
  db.run(`DELETE FROM combos WHERE id IN ('c2','c3')`);
});

test("creating or renaming a combo cannot collide with another one by case", async () => {
  const hit = await combos.findComboByNameIgnoringCase("deepseek-v4.1-flash");
  assert.equal(hit?.name, "DeepSeek-V4.1-Flash");
  assert.equal(await combos.findComboByNameIgnoringCase("deepseek-v4.1-flash", "c1"), null); // renaming itself
  assert.equal(await combos.findComboByNameIgnoringCase("something-else"), null);
});

test("a customer may call the combo typed in any case, and an upstream id is still refused", async () => {
  const typed = await combos.canonicalComboName("deepseek-v4.1-flash");
  assert.equal(customerMayCallSync(db, { apiKey: customerKey, model: typed }), true);
  assert.equal(customerMayCallSync(db, { apiKey: customerKey, model: "zai/glm-5.3:pre" }), false);
  assert.equal(matchesAllowed("deepseek-v4.1-flash", ["DeepSeek-V4.1-Flash"]), true);
});

test("the handler records and answers with the combo's own spelling", async () => {
  const { handleChat } = await import("../src/sse/handlers/chat.js");
  const call = (model) => handleChat(new Request(`http://x/v1/chat/completions?key=${encodeURIComponent(customerKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  }));
  // This customer holds no plan, so both spellings stop at plan admission (402) after
  // the model checks: the lower-case one must not be refused as an unknown model.
  const exact = await call("DeepSeek-V4.1-Flash");
  const lower = await call("deepseek-v4.1-flash");
  assert.equal(exact.status, 402);
  assert.equal(lower.status, 402);
  assert.equal((await lower.json()).error.code, "insufficient_quota");
  // Platform denials are logged under the model the customer asked for.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const rows = db.all(`SELECT DISTINCT model, json_extract(meta, '$.requestedModel') AS requested FROM usageHistory`);
  const names = new Set(rows.flatMap((r) => [r.model, r.requested]).filter(Boolean));
  assert.ok(!names.has("deepseek-v4.1-flash"), `lower-case spelling reached the log: ${[...names]}`);
});

test("an image request typed in lower case is accepted as the combo and logged under its own name", async () => {
  const now = new Date().toISOString();
  db.run(`INSERT INTO combos(id, name, models, createdAt, updatedAt) VALUES('c9', 'Pic-Combo', ?, ?, ?)`, [JSON.stringify(["zai/glm-image"]), now, now]);
  const group = await createKeyGroup({ name: "g2", allowedModels: ["Pic-Combo"] });
  db.run(`INSERT INTO users(id, email, passwordHash, status, groupId, createdAt) VALUES('u2', 'u2@t.io', 'x', 'active', ?, ?)`, [group.id, now]);
  const key = (await createApiKey("pic", "m", { userId: "u2" })).key;
  const { handleImageGeneration } = await import("../src/sse/handlers/imageGeneration.js");
  const res = await handleImageGeneration(new Request(`http://x/v1/images/generations?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "pic-combo", prompt: "a cat" }),
  }));
  // No plan: stops at admission (402) after the model checks, instead of "unknown model".
  assert.notEqual(res.status, 404);
  assert.notEqual(res.status, 403);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const names = new Set(db.all(`SELECT DISTINCT model FROM usageHistory`).map((r) => r.model));
  assert.ok(!names.has("pic-combo"), `lower-case spelling reached the log: ${[...names]}`);
});

test("re-sending a combo's own name is not a collision, even beside a legacy case twin", async () => {
  const now = new Date().toISOString();
  db.run(`INSERT INTO combos(id, name, models, createdAt, updatedAt) VALUES('t1', 'Legacy', ?, ?, ?)`, [JSON.stringify(["a/b"]), now, now]);
  db.run(`INSERT INTO combos(id, name, models, createdAt, updatedAt) VALUES('t2', 'legacy', ?, ?, ?)`, [JSON.stringify(["a/b"]), now, now]);
  const route = await import("../src/app/api/combos/[id]/route.js");
  const put = (id, name) => route.PUT(
    new Request(`http://x/api/combos/${id}`, { method: "PUT", headers: { "content-type": "application/json", ...authHeaders }, body: JSON.stringify({ name, models: ["a/b"] }) }),
    { params: Promise.resolve({ id }) }
  );
  assert.equal((await put("t1", "Legacy")).status, 200); // its own name: no rename
  const clash = await put("t1", "LEGACY");               // a real rename onto the other twin's spelling
  assert.equal(clash.status, 400);
  assert.match((await clash.json()).error, /already exists/);
  db.run(`DELETE FROM combos WHERE id IN ('t1','t2','c9')`);
});
