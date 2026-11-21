// Bots of the "AI doanh nghiệp" product (spec business-bots "Bot lifecycle",
// "Business quota comes from live business purchases", design D9).
//
// A bot belongs to one customer, answers with one business combo and owns zero or
// more api keys (`apiKeys.botId`) plus a knowledge base. The number of bots and the
// knowledge-base size come from the customer's LIVE business purchases, never from
// what they bought once: an expired business plan keeps its bots and documents
// visible but grants no new ones.
//
// Relative imports only: tests import this under plain `node --test`.
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { deleteApiKeyInTransactionSync } from "./apiKeysRepo.js";

export const BOT_LIMITS = {
  name: { min: 1, max: 80 },
  companyName: { min: 1, max: 120 },
  domainDescription: { min: 10, max: 2000 },
  refusalMessage: { min: 1, max: 500 },
  extraInstructions: { min: 0, max: 2000 },
};

export const BOT_MODES = ["strict", "flexible"];
export const MAX_KEYS_PER_BOT = 10;

export const CREATE_WITHOUT_PLAN = "Cần gói AI doanh nghiệp còn hạn để tạo bot";
export const ADD_DOCUMENT_WITHOUT_PLAN = "Cần gói AI doanh nghiệp còn hạn để thêm tài liệu";

/** `Xin lỗi, tôi chỉ hỗ trợ các câu hỏi liên quan đến <companyName>.` */
export function defaultRefusalMessage(companyName) {
  return `Xin lỗi, tôi chỉ hỗ trợ các câu hỏi liên quan đến ${companyName || "doanh nghiệp của bạn"}.`;
}

function rowToBot(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    companyName: row.companyName,
    domainDescription: row.domainDescription,
    mode: row.mode === "flexible" ? "flexible" : "strict",
    refusalMessage: row.refusalMessage,
    extraInstructions: row.extraInstructions ?? "",
    modelId: row.modelId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function lengthError(value, { min, max }, field) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < min) return `${field} cần ít nhất ${min} ký tự`;
  if (text.length > max) return `${field} tối đa ${max} ký tự`;
  return null;
}

/**
 * Vietnamese error for a create/update payload, or null.
 *
 * @param {object} input
 * @param {{ businessModelIds?: string[], partial?: boolean }} [options]
 *        `partial` skips the required-field checks an update does not resend.
 */
export function validateBotInput(input = {}, { businessModelIds = [], partial = false } = {}) {
  const has = (field) => input[field] !== undefined && input[field] !== null;
  const value = (field) => (typeof input[field] === "string" ? input[field].trim() : input[field]);

  if (!partial || has("name")) {
    const invalid = lengthError(value("name"), BOT_LIMITS.name, "Tên bot");
    if (invalid) return invalid;
  }
  if (!partial || has("companyName")) {
    const invalid = lengthError(value("companyName"), BOT_LIMITS.companyName, "Tên doanh nghiệp");
    if (invalid) return invalid;
  }
  if (!partial || has("domainDescription")) {
    const invalid = lengthError(value("domainDescription"), BOT_LIMITS.domainDescription, "Mô tả lĩnh vực");
    if (invalid) return invalid;
  }
  if (has("refusalMessage")) {
    const invalid = lengthError(value("refusalMessage"), BOT_LIMITS.refusalMessage, "Câu từ chối");
    if (invalid) return invalid;
  }
  if (has("extraInstructions")) {
    const invalid = lengthError(value("extraInstructions"), BOT_LIMITS.extraInstructions, "Chỉ dẫn thêm");
    if (invalid) return invalid;
  }
  if (has("mode") && !BOT_MODES.includes(input.mode)) {
    return "Chế độ phải là strict hoặc flexible";
  }
  if (!partial || has("modelId")) {
    const modelId = typeof input.modelId === "string" ? input.modelId.trim() : "";
    if (!modelId) return "Cần chọn model doanh nghiệp";
    if (!businessModelIds.includes(modelId)) {
      return `Model ${modelId} không nằm trong danh sách model doanh nghiệp`;
    }
  }
  if (has("isActive") && typeof input.isActive !== "boolean") {
    return "Trạng thái hoạt động phải là true hoặc false";
  }
  return null;
}

/**
 * Quota over live business purchases (spec "Business quota comes from live business
 * purchases"): active, unexpired purchases of a business plan. Credit left on a
 * purchase does not matter, and the largest value of each limit wins.
 */
export function businessQuotaSync(db, userId, nowIso = new Date().toISOString()) {
  const rows = db.all(
    `SELECT p.maxBots AS maxBots, p.maxKbBytes AS maxKbBytes
       FROM userPlans up JOIN plans p ON p.id = up.planId
      WHERE up.userId = ? AND up.status = 'active' AND up.expiresAt > ?
        AND p.productLine = 'business'`,
    [userId, nowIso]
  );
  let maxBots = 0;
  let maxKbBytes = 0;
  for (const row of rows) {
    maxBots = Math.max(maxBots, Number(row.maxBots) || 0);
    maxKbBytes = Math.max(maxKbBytes, Number(row.maxKbBytes) || 0);
  }

  const botCount = Number(db.get(`SELECT COUNT(*) AS n FROM bizBots WHERE userId = ?`, [userId])?.n) || 0;
  const kbBytesUsed =
    Number(db.get(`SELECT COALESCE(SUM(bytes), 0) AS n FROM bizDocuments WHERE userId = ?`, [userId])?.n) || 0;

  return { hasBusinessPlan: rows.length > 0, maxBots, maxKbBytes, botCount, kbBytesUsed };
}

/** The quota shape `GET /api/account/biz/quota` returns. */
export function quotaSync(db, userId, nowIso = new Date().toISOString()) {
  const { hasBusinessPlan, maxBots, botCount, maxKbBytes, kbBytesUsed } = businessQuotaSync(db, userId, nowIso);
  return { hasBusinessPlan, maxBots, botCount, maxKbBytes, kbBytesUsed };
}

export function listBotsSync(db, userId) {
  return db
    .all(`SELECT * FROM bizBots WHERE userId = ? ORDER BY createdAt ASC`, [userId])
    .map(rowToBot);
}

export function getBotSync(db, id) {
  return rowToBot(db.get(`SELECT * FROM bizBots WHERE id = ?`, [id]));
}

/** A bot of `userId`, else null — another customer's bot is indistinguishable from a missing one. */
export function getOwnedBotSync(db, userId, id) {
  const bot = getBotSync(db, id);
  return bot && bot.userId === userId ? bot : null;
}

/**
 * Create a bot inside the caller's transaction.
 *
 * @returns {{ ok:true, bot:object } | { ok:false, status:number, error:string }}
 */
export function createBotSync(db, userId, input = {}, { businessModelIds = [], nowIso = new Date().toISOString() } = {}) {
  const invalid = validateBotInput(input, { businessModelIds });
  if (invalid) return { ok: false, status: 400, error: invalid };

  const quota = businessQuotaSync(db, userId, nowIso);
  if (!quota.hasBusinessPlan) return { ok: false, status: 403, error: CREATE_WITHOUT_PLAN };
  if (quota.botCount >= quota.maxBots) {
    return { ok: false, status: 403, error: `Đã đạt số bot tối đa của gói (${quota.maxBots})` };
  }

  const companyName = String(input.companyName).trim();
  const bot = {
    id: uuidv4(),
    userId,
    name: String(input.name).trim(),
    companyName,
    domainDescription: String(input.domainDescription).trim(),
    mode: BOT_MODES.includes(input.mode) ? input.mode : "strict",
    refusalMessage:
      typeof input.refusalMessage === "string" && input.refusalMessage.trim()
        ? input.refusalMessage.trim()
        : defaultRefusalMessage(companyName),
    extraInstructions: typeof input.extraInstructions === "string" ? input.extraInstructions.trim() : "",
    modelId: String(input.modelId).trim(),
    isActive: input.isActive === false ? false : true,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  db.run(
    `INSERT INTO bizBots(id, userId, name, companyName, domainDescription, mode, refusalMessage,
       extraInstructions, modelId, isActive, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      bot.id, bot.userId, bot.name, bot.companyName, bot.domainDescription, bot.mode,
      bot.refusalMessage, bot.extraInstructions, bot.modelId, bot.isActive ? 1 : 0,
      bot.createdAt, bot.updatedAt,
    ]
  );
  return { ok: true, bot };
}

/**
 * Update a bot. A bot keeps working after its business plan expires, so no quota
 * check happens here (spec "Updating or deleting an existing bot SHALL NOT require
 * a live business plan").
 */
export function updateBotSync(db, id, input = {}, { businessModelIds = [], nowIso = new Date().toISOString() } = {}) {
  const current = getBotSync(db, id);
  if (!current) return { ok: false, status: 404, error: "Bot not found" };
  const invalid = validateBotInput(input, { businessModelIds, partial: true });
  if (invalid) return { ok: false, status: 400, error: invalid };

  const next = {
    ...current,
    name: input.name !== undefined ? String(input.name).trim() : current.name,
    companyName: input.companyName !== undefined ? String(input.companyName).trim() : current.companyName,
    domainDescription:
      input.domainDescription !== undefined ? String(input.domainDescription).trim() : current.domainDescription,
    mode: input.mode !== undefined ? input.mode : current.mode,
    refusalMessage:
      input.refusalMessage !== undefined ? String(input.refusalMessage).trim() : current.refusalMessage,
    extraInstructions:
      input.extraInstructions !== undefined ? String(input.extraInstructions).trim() : current.extraInstructions,
    modelId: input.modelId !== undefined ? String(input.modelId).trim() : current.modelId,
    isActive: input.isActive !== undefined ? Boolean(input.isActive) : current.isActive,
    updatedAt: nowIso,
  };
  db.run(
    `UPDATE bizBots SET name = ?, companyName = ?, domainDescription = ?, mode = ?, refusalMessage = ?,
       extraInstructions = ?, modelId = ?, isActive = ?, updatedAt = ? WHERE id = ?`,
    [
      next.name, next.companyName, next.domainDescription, next.mode, next.refusalMessage,
      next.extraInstructions, next.modelId, next.isActive ? 1 : 0, next.updatedAt, id,
    ]
  );
  return { ok: true, bot: next };
}

/**
 * Delete a bot and everything it owns, in one transaction: its keys (with the usual
 * tombstone, so a request already in flight is still billed), its documents, their
 * chunks and its guard events.
 */
export function deleteBotSync(db, id, nowIso = new Date().toISOString()) {
  let deleted = false;
  db.transaction(() => {
    const keys = db.all(`SELECT id FROM apiKeys WHERE botId = ?`, [id]);
    for (const key of keys) deleteApiKeyInTransactionSync(db, key.id, nowIso);
    db.run(`DELETE FROM bizChunks WHERE botId = ?`, [id]);
    db.run(`DELETE FROM bizDocuments WHERE botId = ?`, [id]);
    db.run(`DELETE FROM bizGuardEvents WHERE botId = ?`, [id]);
    const res = db.run(`DELETE FROM bizBots WHERE id = ?`, [id]);
    deleted = (res?.changes ?? 0) > 0;
  });
  return deleted;
}

// ── Async wrappers used by the routes ───────────────────────────────────────

export async function listBots(userId) {
  return listBotsSync(await getAdapter(), userId);
}

export async function getBot(id) {
  return getBotSync(await getAdapter(), id);
}

export async function getOwnedBot(userId, id) {
  return getOwnedBotSync(await getAdapter(), userId, id);
}

export async function quota(userId) {
  return quotaSync(await getAdapter(), userId);
}

export async function createBot(userId, input, options = {}) {
  const db = await getAdapter();
  return db.transaction(() => createBotSync(db, userId, input, options));
}

export async function updateBot(id, input, options = {}) {
  const db = await getAdapter();
  return db.transaction(() => updateBotSync(db, id, input, options));
}

export async function deleteBot(id) {
  return deleteBotSync(await getAdapter(), id);
}
