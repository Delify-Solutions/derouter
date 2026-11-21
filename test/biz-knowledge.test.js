// Business quota, bots, the knowledge base and retrieval (spec business-bots).
//
// Everything runs against a throwaway SQLite database seeded by direct SQL, plus
// the ingestion worker with a stubbed embedding caller — the real one goes through
// the router's own handlers, which do not run under plain `node --test`.
//
// The invariants pinned here are the ones a customer or the operator would notice:
//   * quota comes from LIVE business purchases and never from the api line;
//   * a bot over the plan's limit is refused, and the reason names the limit;
//   * deleting a bot takes its keys, documents, chunks and events with it;
//   * the knowledge-base size ceiling refuses a document before anything is stored;
//   * chunking overlaps by exactly 200 characters;
//   * retrieval returns the top 5 above the threshold, in score order;
//   * a model change makes documents stale and excludes their chunks.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-biz-kb-test-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const { NANO } = await import("../src/shared/utils/money.js");
const bots = await import("../src/lib/db/repos/bizBotsRepo.js");
const docs = await import("../src/lib/db/repos/bizDocumentsRepo.js");
const { chunkText, qaChunks } = await import("../src/lib/biz/chunking.js");
const { encodeVector, decodeVector, cosine, topK } = await import("../src/lib/biz/vector.js");
const { retrieve, clearVectorCache } = await import("../src/lib/biz/retrieval.js");
const { runIngestTick, setIngestEmbedder } = await import("../src/lib/biz/ingestWorker.js");
const { validateBotInput, defaultRefusalMessage } = await import("../src/lib/db/repos/bizBotsRepo.js");

let db;
const USD = (n) => Math.round(n * NANO);
const NOW = () => new Date().toISOString();
const inDays = (d) => new Date(Date.now() + d * 86_400_000).toISOString();
const BUSINESS_MODELS = ["delify-biz"];
const MB = 1024 * 1024;

before(async () => {
  db = await getAdapter();
});

after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  for (const table of [
    "bizGuardEvents", "bizChunks", "bizDocuments", "bizBots", "apiKeys",
    "userPlans", "creditLedger", "plans", "users", "settings",
  ]) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* partial schema */ }
  }
  clearVectorCache();
  setIngestEmbedder(null);
});

// ── Fixtures ────────────────────────────────────────────────────────────────

function user(id = "u1") {
  db.run(
    `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
     VALUES(?, ?, 'x', NULL, NULL, 'active', 0, ?, ?)`,
    [id, `${id}@test.local`, NOW(), NOW()]
  );
}

function plan(id, { productLine = "api", maxBots = null, maxKbBytes = null, creditUsd = 100 } = {}) {
  db.run(
    `INSERT INTO plans(id, code, name, priceNanoUsd, creditNanoUsd, durationDays, isActive, productLine, maxBots, maxKbBytes, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, 30, 1, ?, ?, ?, ?, ?)`,
    [id, id, id, USD(10), USD(creditUsd), productLine, maxBots, maxKbBytes, NOW(), NOW()]
  );
}

function purchase(userId, planId, { expiresAt = inDays(30), status = "active", creditUsd = 100 } = {}) {
  const id = `up_${Math.random().toString(36).slice(2, 10)}`;
  db.run(
    `INSERT INTO userPlans(id, userId, planId, orderId, source, creditTotalNanoUsd, creditRemainingNanoUsd, startsAt, expiresAt, status, createdAt)
     VALUES(?, ?, ?, NULL, 'purchase', ?, ?, ?, ?, ?, ?)`,
    [id, userId, planId, USD(creditUsd), USD(creditUsd), NOW(), expiresAt, status, NOW()]
  );
  return id;
}

function bot(userId, overrides = {}) {
  const result = db.transaction(() => bots.createBotSync(db, userId, {
    name: "Bot bán hàng",
    companyName: "Nội thất An Gia",
    domainDescription: "Cửa hàng bán sofa, bàn ăn và đồ nội thất gỗ cho gia đình.",
    mode: "strict",
    modelId: BUSINESS_MODELS[0],
    ...overrides,
  }, { businessModelIds: BUSINESS_MODELS }));
  assert.equal(result.ok, true, result.error);
  return result.bot;
}

function insertKey(id, { userId = null, botId = null, name = "Key" } = {}) {
  const now = NOW();
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, groupId, windowCostUsd, updatedAt, userId, botId)
     VALUES(?, ?, ?, NULL, 1, ?, NULL, 0, ?, ?, ?)`,
    [id, `secret-${id}`, name, now, now, userId, botId]
  );
}

const vector = (values) => encodeVector(values);

// ── Quota ───────────────────────────────────────────────────────────────────

test("quota takes the largest limit across live business purchases only", () => {
  user("u-quota");
  plan("p-biz-small", { productLine: "business", maxBots: 1, maxKbBytes: 5 * MB });
  plan("p-biz-big", { productLine: "business", maxBots: 3, maxKbBytes: 2 * MB });
  plan("p-api", { productLine: "api" });
  purchase("u-quota", "p-biz-small");
  purchase("u-quota", "p-biz-big");
  purchase("u-quota", "p-api");

  const quota = bots.quotaSync(db, "u-quota");
  assert.equal(quota.hasBusinessPlan, true);
  assert.equal(quota.maxBots, 3);
  assert.equal(quota.maxKbBytes, 5 * MB);
  assert.equal(quota.botCount, 0);
});

test("an expired business purchase grants nothing but keeps the bots listed", () => {
  user("u-expired");
  plan("p-biz", { productLine: "business", maxBots: 2, maxKbBytes: 5 * MB });
  purchase("u-expired", "p-biz", { expiresAt: inDays(-1) });

  const created = db.transaction(() => bots.createBotSync(db, "u-expired", {
    name: "Bot", companyName: "Công ty A", domainDescription: "Bán hàng nội thất gỗ tự nhiên",
    modelId: "delify-biz",
  }, { businessModelIds: BUSINESS_MODELS }));
  // No live plan → no new bot.
  assert.equal(created.ok, false);
  assert.equal(created.status, 403);
  assert.equal(created.error, bots.CREATE_WITHOUT_PLAN);

  // Seed one as if it existed before the expiry.
  const now = NOW();
  db.run(
    `INSERT INTO bizBots(id, userId, name, companyName, domainDescription, mode, refusalMessage, extraInstructions, modelId, isActive, createdAt, updatedAt)
     VALUES('b-old', 'u-expired', 'Bot cũ', 'Công ty A', 'Bán hàng nội thất gỗ tự nhiên', 'strict', 'x', '', 'delify-biz', 1, ?, ?)`,
    [now, now]
  );
  const quota = bots.quotaSync(db, "u-expired");
  assert.equal(quota.hasBusinessPlan, false);
  assert.equal(quota.maxBots, 0);
  assert.equal(quota.botCount, 1);
  assert.deepEqual(bots.listBotsSync(db, "u-expired").map((b) => b.id), ["b-old"]);
});

test("creating a bot past the plan limit is refused with the limit in the message", () => {
  user("u-limit");
  plan("p-biz", { productLine: "business", maxBots: 1, maxKbBytes: 5 * MB });
  purchase("u-limit", "p-biz");
  bot("u-limit");

  const second = db.transaction(() => bots.createBotSync(db, "u-limit", {
    name: "Bot 2", companyName: "Công ty B", domainDescription: "Bán hàng nội thất gỗ tự nhiên",
    modelId: "delify-biz",
  }, { businessModelIds: BUSINESS_MODELS }));
  assert.equal(second.ok, false);
  assert.equal(second.status, 403);
  assert.equal(second.error, "Đã đạt số bot tối đa của gói (1)");
  assert.equal(bots.listBotsSync(db, "u-limit").length, 1);
});

test("bot validation names the offending field", () => {
  assert.match(validateBotInput({ name: "", companyName: "A", domainDescription: "x".repeat(20), modelId: "delify-biz" }, { businessModelIds: BUSINESS_MODELS }), /Tên bot/);
  assert.match(validateBotInput({ name: "B", companyName: "A", domainDescription: "ngắn", modelId: "delify-biz" }, { businessModelIds: BUSINESS_MODELS }), /Mô tả lĩnh vực/);
  assert.match(validateBotInput({ name: "B", companyName: "A", domainDescription: "x".repeat(20), modelId: "gpt-4o" }, { businessModelIds: BUSINESS_MODELS }), /model doanh nghiệp/);
  assert.match(validateBotInput({ name: "B", companyName: "A", domainDescription: "x".repeat(20), modelId: "delify-biz", mode: "loose" }, { businessModelIds: BUSINESS_MODELS }), /strict/);
});

test("the default refusal message names the company", () => {
  assert.equal(
    defaultRefusalMessage("Nội thất An Gia"),
    "Xin lỗi, tôi chỉ hỗ trợ các câu hỏi liên quan đến Nội thất An Gia."
  );
});

test("a bot of another customer is not readable through the owned lookup", () => {
  user("u-a");
  user("u-b");
  plan("p-biz", { productLine: "business", maxBots: 1, maxKbBytes: 5 * MB });
  purchase("u-a", "p-biz");
  const created = bot("u-a");
  assert.equal(bots.getOwnedBotSync(db, "u-b", created.id), null);
  assert.ok(bots.getOwnedBotSync(db, "u-a", created.id));
});

test("deleting a bot removes its keys, documents, chunks and guard events", () => {
  user("u-cascade");
  plan("p-biz", { productLine: "business", maxBots: 2, maxKbBytes: 5 * MB });
  purchase("u-cascade", "p-biz");
  const created = bot("u-cascade");

  insertKey("k1", { userId: "u-cascade", botId: created.id });
  insertKey("k2", { userId: "u-cascade", botId: created.id });
  for (let i = 0; i < 3; i += 1) {
    const made = db.transaction(() => docs.createDocumentSync(db, {
      botId: created.id, userId: "u-cascade", title: `Tài liệu ${i}`, sourceType: "text",
      text: "Nội dung tài liệu đủ dài để tạo một chunk.", chunks: [`Nội dung số ${i}`],
    }));
    assert.equal(made.ok, true, made.error);
  }
  for (let i = 0; i < 10; i += 1) {
    docs.recordGuardEventSync(db, { botId: created.id, apiKeyId: "k1", category: "political", excerpt: `Q${i}` });
  }

  assert.equal(db.get(`SELECT COUNT(*) AS n FROM bizChunks WHERE botId = ?`, [created.id]).n, 3);
  assert.equal(bots.deleteBotSync(db, created.id), true);

  for (const table of ["bizBots", "bizDocuments", "bizChunks", "bizGuardEvents"]) {
    const column = table === "bizBots" ? "id" : "botId";
    assert.equal(db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, [created.id]).n, 0, table);
  }
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM apiKeys WHERE botId = ?`, [created.id]).n, 0);
  // The keys are tombstoned, so a request already in flight is still attributed.
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM deletedApiKeys WHERE botId = ?`, [created.id]).n, 2);
});

// ── Knowledge base ──────────────────────────────────────────────────────────

test("chunking overlaps by exactly the last 200 characters", () => {
  const text = "a".repeat(2500);
  const chunks = chunkText(text);
  assert.ok(chunks.length >= 3 && chunks.length <= 4, `got ${chunks.length}`);
  assert.ok(chunks.every((chunk) => chunk.length <= 1000));
  for (let i = 1; i < chunks.length; i += 1) {
    assert.ok(chunks[i].startsWith(chunks[i - 1].slice(-200)), `chunk ${i} lost its overlap`);
  }
});

test("a long paragraph is split on sentence boundaries", () => {
  const sentence = `${"Câu văn dài ".repeat(12)}. `;
  const chunks = chunkText(sentence.repeat(10));
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 1000));
});

test("Q&A pairs become one chunk each", () => {
  const result = qaChunks([
    { question: "Giá sofa?", answer: "12 triệu" },
    { question: "Bảo hành?", answer: "2 năm" },
  ]);
  assert.equal(result.chunks.length, 2);
  assert.ok(result.chunks.every((chunk) => chunk.startsWith("Hỏi: ")));
  assert.match(qaChunks([{ question: "x", answer: "y".repeat(2100) }]).error, /2000/);
});

test("cosine ranking keeps the top 5 at or above the threshold, in order", () => {
  // 2-D vectors whose cosine against [1,0] is exactly the listed score.
  const score = (value) => {
    const angle = Math.acos(value);
    return decodeVector(vector([Math.cos(angle), Math.sin(angle)]));
  };
  const query = decodeVector(vector([1, 0]));
  const scores = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.2, 0.1];
  const items = scores.map((value, index) => ({ id: index, embedding: score(value) }));

  const ranked = topK(query, items, { topK: 5, threshold: 0.3 });
  assert.deepEqual(ranked.map((entry) => entry.item.id), [0, 1, 2, 3, 4]);
  for (let i = 1; i < ranked.length; i += 1) assert.ok(ranked[i - 1].score >= ranked[i].score);

  // Everything below the threshold → nothing.
  const cold = scores.map((value, index) => ({ id: index, embedding: score(value) }));
  assert.equal(topK(query, cold.map((entry) => ({ ...entry, embedding: score(0.1) })), { topK: 5, threshold: 0.3 }).length, 0);
  assert.ok(Math.abs(cosine(query, score(0.9)) - 0.9) < 1e-5);
});

test("a typed-array embedding round-trips through the BLOB", () => {
  // The ingest worker passes a Float32Array straight from the embedding call;
  // Array.isArray() is false for it, and an empty BLOB made every chunk
  // unretrievable before this was pinned.
  const source = Float32Array.from([0.5, -0.25, 0.125]);
  const encoded = encodeVector(source);
  assert.equal(encoded.length, 12);
  const decoded = decodeVector(encoded, 3);
  assert.deepEqual(Array.from(decoded), Array.from(source));
  assert.equal(decodeVector(encoded, 4), null, "a dims mismatch is rejected");
});

test("a document over the knowledge-base ceiling is refused and stores nothing", () => {
  user("u-kb");
  plan("p-biz", { productLine: "business", maxBots: 1, maxKbBytes: 5 * MB });
  purchase("u-kb", "p-biz");
  const created = bot("u-kb");

  // Fill the quota to 4.9 MB with one document.
  const filler = "x".repeat(Math.round(4.9 * MB));
  const first = db.transaction(() => docs.createDocumentSync(db, {
    botId: created.id, userId: "u-kb", title: "Lớn", sourceType: "text", text: filler,
    chunks: chunkText(filler),
  }));
  assert.equal(first.ok, true, first.error);

  const big = "y".repeat(200 * 1024);
  const second = db.transaction(() => docs.createDocumentSync(db, {
    botId: created.id, userId: "u-kb", title: "Vượt", sourceType: "text", text: big,
    chunks: chunkText(big),
  }));
  assert.equal(second.ok, false);
  assert.equal(second.status, 413);
  assert.match(second.error, /Vượt dung lượng tài liệu của gói/);
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM bizDocuments WHERE botId = ?`, [created.id]).n, 1);
});

test("a business plan with a NULL knowledge-base limit grants no documents at all", () => {
  user("u-nolimit");
  plan("p-biz-nokb", { productLine: "business", maxBots: 1, maxKbBytes: null });
  purchase("u-nolimit", "p-biz-nokb");
  const created = bot("u-nolimit");

  const result = db.transaction(() => docs.createDocumentSync(db, {
    botId: created.id, userId: "u-nolimit", title: "Tài liệu", sourceType: "text",
    text: "Nội dung", chunks: ["Nội dung"],
  }));
  assert.equal(result.ok, false);
  assert.equal(result.status, 413);
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM bizDocuments WHERE botId = ?`, [created.id]).n, 0);
});

test("a binary file sent as text is refused instead of chunked", async () => {
  const { extractFileText } = await import("../src/lib/biz/extract.js");
  // An .xlsx is a zip: a browser without a MIME mapping sends octet-stream.
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
  const result = await extractFileText({ bytes: zip, filename: "price.xlsx", mime: "application/octet-stream" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 415);

  const text = await extractFileText({ bytes: Buffer.from("xin chào"), filename: "a.txt", mime: "text/plain" });
  assert.equal(text.ok, true);
  assert.equal(text.text, "xin chào");
});

test("ingestion embeds the chunks and marks the document ready", async () => {
  user("u-ingest");
  plan("p-biz", { productLine: "business", maxBots: 1, maxKbBytes: 5 * MB });
  purchase("u-ingest", "p-biz");
  const created = bot("u-ingest");

  const made = db.transaction(() => docs.createDocumentSync(db, {
    botId: created.id, userId: "u-ingest", title: "Chính sách", sourceType: "text",
    text: "Chính sách bảo hành hai năm cho mọi sản phẩm gỗ.", chunks: chunkText("Chính sách bảo hành hai năm cho mọi sản phẩm gỗ."),
  }, { currentModel: "embed-a" }));
  assert.equal(made.ok, true, made.error);
  assert.equal(made.document.status, "processing");

  setIngestEmbedder(async ({ input }) => input.map((text) => Float32Array.from([text.length, 1, 0])));
  const tick = await runIngestTick({ embeddingModel: "embed-a" });
  assert.equal(tick.ready, 1);

  const listed = docs.listDocumentsSync(db, created.id, "embed-a");
  assert.equal(listed[0].status, "ready");
  assert.ok(listed[0].chunkCount >= 1);
});

test("an embedding failure marks the document failed and keeps its chunks", async () => {
  user("u-embed-fail");
  plan("p-biz", { productLine: "business", maxBots: 1, maxKbBytes: 5 * MB });
  purchase("u-embed-fail", "p-biz");
  const created = bot("u-embed-fail");

  const made = db.transaction(() => docs.createDocumentSync(db, {
    botId: created.id, userId: "u-embed-fail", title: "Tài liệu", sourceType: "text",
    text: "Nội dung đủ dài cho một chunk.", chunks: ["Nội dung đủ dài cho một chunk."],
  }, { currentModel: "embed-a" }));
  assert.equal(made.ok, true, made.error);

  setIngestEmbedder(async () => {
    throw new Error("upstream down");
  });
  const tick = await runIngestTick({ embeddingModel: "embed-a" });
  assert.equal(tick.failed, 1);

  const listed = docs.listDocumentsSync(db, created.id, "embed-a");
  assert.equal(listed[0].status, "failed");
  assert.ok(listed[0].error);
  assert.equal(db.get(`SELECT COUNT(*) AS n FROM bizChunks WHERE docId = ?`, [made.document.id]).n, 1);
});

test("changing the embedding model makes documents stale and excludes their chunks", async () => {
  user("u-stale");
  plan("p-biz", { productLine: "business", maxBots: 1, maxKbBytes: 5 * MB });
  purchase("u-stale", "p-biz");
  const created = bot("u-stale");

  const made = db.transaction(() => docs.createDocumentSync(db, {
    botId: created.id, userId: "u-stale", title: "Tài liệu", sourceType: "text",
    text: "Sofa da bảo hành hai năm.", chunks: ["Sofa da bảo hành hai năm."],
  }, { currentModel: "embed-a" }));
  setIngestEmbedder(async ({ input }) => input.map(() => Float32Array.from([1, 0, 0])));
  await runIngestTick({ embeddingModel: "embed-a" });

  // Still fresh under A.
  assert.equal(docs.listDocumentsSync(db, created.id, "embed-a")[0].status, "ready");
  // Switching to B makes it stale and its chunks are invisible to retrieval.
  assert.equal(docs.listDocumentsSync(db, created.id, "embed-b")[0].status, "stale");

  const hits = await retrieve({
    botId: created.id,
    question: "bảo hành",
    embeddingModel: "embed-b",
    threshold: 0.3,
    embed: async () => Float32Array.from([1, 0, 0]),
  });
  assert.deepEqual(hits, []);

  // Retrying with B re-embeds it.
  const retried = docs.retryDocumentSync(db, made.document.id, { currentModel: "embed-b" });
  assert.equal(retried.ok, true, retried.error);
  await runIngestTick({ embeddingModel: "embed-b" });
  assert.equal(docs.listDocumentsSync(db, created.id, "embed-b")[0].status, "ready");
});

test("retry refuses a ready document", () => {
  user("u-retry");
  plan("p-biz", { productLine: "business", maxBots: 1, maxKbBytes: 5 * MB });
  purchase("u-retry", "p-biz");
  const created = bot("u-retry");
  const made = db.transaction(() => docs.createDocumentSync(db, {
    botId: created.id, userId: "u-retry", title: "Tài liệu", sourceType: "text",
    text: "x".repeat(50), chunks: ["x".repeat(50)], status: "ready",
  }));
  const result = docs.retryDocumentSync(db, made.document.id, { currentModel: "embed-a" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
});

test("retrieval returns the best chunks above the threshold", async () => {
  user("u-retrieve");
  plan("p-biz", { productLine: "business", maxBots: 1, maxKbBytes: 5 * MB });
  purchase("u-retrieve", "p-biz");
  const created = bot("u-retrieve");

  const made = db.transaction(() => docs.createDocumentSync(db, {
    botId: created.id, userId: "u-retrieve", title: "Q&A", sourceType: "text",
    text: "Sofa da\nSofa vải\nBàn ăn", chunks: ["Sofa da", "Sofa vải", "Bàn ăn"],
  }, { currentModel: "embed-a" }));
  assert.equal(made.ok, true, made.error);

  // Give chunk 1 a perfect match, chunk 2 a weak one, chunk 3 nothing.
  const rows = db.all(`SELECT id FROM bizChunks WHERE docId = ? ORDER BY ord`, [made.document.id]);
  docs.saveChunkEmbeddingSync(db, rows[0].id, { embedding: vector([1, 0]), embeddingModel: "embed-a", dims: 2 });
  docs.saveChunkEmbeddingSync(db, rows[1].id, { embedding: vector([0.6, 0.8]), embeddingModel: "embed-a", dims: 2 });
  docs.saveChunkEmbeddingSync(db, rows[2].id, { embedding: vector([0, 1]), embeddingModel: "embed-a", dims: 2 });
  clearVectorCache();

  const hits = await retrieve({
    botId: created.id,
    question: "sofa da",
    embeddingModel: "embed-a",
    threshold: 0.3,
    embed: async () => Float32Array.from([1, 0]),
  });
  assert.equal(hits.length, 2);
  assert.equal(hits[0].text, "Sofa da");
  assert.equal(hits[1].text, "Sofa vải");
  assert.ok(hits[0].score > hits[1].score);
});

test("a bot with no eligible chunks returns nothing", async () => {
  user("u-empty");
  plan("p-biz", { productLine: "business", maxBots: 1, maxKbBytes: 5 * MB });
  purchase("u-empty", "p-biz");
  const created = bot("u-empty");
  const hits = await retrieve({
    botId: created.id, question: "giá", embeddingModel: "embed-a",
    embed: async () => Float32Array.from([1, 0]),
  });
  assert.deepEqual(hits, []);
});
