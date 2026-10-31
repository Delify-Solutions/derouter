import { EventEmitter } from "events";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { getMeta, setMeta } from "../helpers/metaStore.js";
import { costFromTokensNano, costFromImagesNano, nanoToUsd } from "../../../shared/utils/money.js";
import { resolveApiKeyOwner } from "./billingRepo.js";
import { chargeSync } from "../../billing/planQueue.js";
import { hashApiKey } from "./apiKeysRepo.js";

// Money is stored as integer nanoUSD. `costNanoUsd` is authoritative; the legacy
// float `cost` column is written alongside for readers we do not control.
// A row whose nano value is 0 but float cost is non-zero predates the backfill
// (e.g. imported from legacy JSON), so fall back to the float.
function rowCostUsd(nano, usd) {
  return nano ? nanoToUsd(nano) : usd || 0;
}

// Integer cost of one usageHistory row. Rows imported from legacy JSON only have
// the float `cost`, so round it once here rather than leaking a float upward.
function rowCostNano(nano, usd) {
  return nano ? Math.round(nano) : Math.round((usd || 0) * 1e9);
}

// Daily rollup blobs carry both `costNanoUsd` (authoritative) and `cost` (legacy
// float mirror). Prefer the integer; older blobs may only have the float.

// Accumulate one integer nanoUSD cost into an aggregate. The legacy float mirror
// is re-derived from the running integer total, so repeated float addition can
// never drift (0.006 x 500 must stay exactly $3.00).
function addCostTo(acc, costNano) {
  acc.costNanoUsd = (acc.costNanoUsd || 0) + (costNano || 0);
  acc.cost = nanoToUsd(acc.costNanoUsd);
}

// Cost of a usageDaily blob — either the whole day or one of its counters
// (byProvider/byModel/...). Blobs written before the nano migration only carry
// the legacy float, so round it once here. The integer always wins when present.
function blobCostNano(c) {
  return c?.costNanoUsd ? Math.round(c.costNanoUsd) : Math.round((c?.cost || 0) * 1e9);
}

function maskApiKey(key) {
  if (!key || typeof key !== "string") return null;
  if (key.length <= 8) return key.charAt(0) + "***";
  return key.slice(0, 8) + "***";
}

// apiKeys.id for a raw key string, or null when no apiKeys row owns it (a
// locally configured admin key). Dual lookup mirrors resolveApiKeyOwner: legacy
// rows still have the plaintext in apiKeys.key, newer ones only keyHash.
//
// Cached per adapter for 60s: this runs on the hot path (keyEnforcement calls
// getKeyRateUsage once or twice per proxied request), and a doomed-to-be-stale
// entry is no worse than resolveApiKeyOwner's own cache, which already answers
// for the same rows with the same TTL.
const KEY_ID_TTL_MS = 60 * 1000;
const keyIdCaches = new WeakMap();

function resolveApiKeyId(db, apiKey) {
  if (!db || !apiKey) return null;
  let cache = keyIdCaches.get(db);
  if (!cache) {
    cache = new Map();
    keyIdCaches.set(db, cache);
  }
  const hit = cache.get(apiKey);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  let value = null;
  try {
    let row = db.get(`SELECT id FROM apiKeys WHERE key = ?`, [apiKey]);
    if (!row) {
      const hash = hashApiKey(apiKey);
      if (hash) row = db.get(`SELECT id FROM apiKeys WHERE keyHash = ?`, [hash]);
    }
    value = row?.id ?? null;
  } catch {
    return null;
  }

  cache.set(apiKey, { value, expiresAt: Date.now() + KEY_ID_TTL_MS });
  // Bounded for the same reason as the owner cache: a key-rotation loop must not
  // grow this without limit.
  if (cache.size > 1000) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return value;
}

// WHERE fragment matching every usageHistory row of one raw api key, plus its
// params. Rows written before migration 005 carry the raw secret in `apiKey`;
// rows written since carry only `apiKeyId` and leave `apiKey` NULL. Both kinds
// belong to the same key, so the union (apiKey = ? OR apiKeyId = ?) is matched —
// a key's history must never be split. When no apiKeys row owns the string (an
// admin/local key), the raw comparison alone is the whole history.
function usageKeyCond(db, apiKey) {
  const keyId = resolveApiKeyId(db, apiKey);
  if (!keyId) return { cond: "apiKey = ?", params: [apiKey] };
  return { cond: "(apiKey = ? OR apiKeyId = ?)", params: [apiKey, keyId] };
}

const PENDING_TIMEOUT_MS = 60 * 1000;
const RING_CAP = 50;
const CONN_CACHE_TTL_MS = 30 * 1000;
const PERIOD_MS = { "24h": 86400000, "7d": 604800000, "30d": 2592000000, "60d": 5184000000 };

// Log retention: prune usageHistory/requestDetails older than N days to bound DB size.
// Default 60 days. Prune runs probabilistically (~1/N of inserts) to amortize cost.
const LOG_RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS || "60", 10);
const PRUNE_EVERY_N = 100;
let _pruneCounter = 0;

function pruneOldUsage(db) {
  const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 86400000).toISOString();
  db.run(`DELETE FROM usageHistory WHERE timestamp < ?`, [cutoff]);
  db.run(`DELETE FROM requestDetails WHERE timestamp < ?`, [cutoff]);
}

// In-memory state shared across Next.js modules
if (!global._pendingRequests) global._pendingRequests = { byModel: {}, byAccount: {} };
if (!global._lastErrorProvider) global._lastErrorProvider = { provider: "", ts: 0 };
if (!global._statsEmitter) {
  global._statsEmitter = new EventEmitter();
  global._statsEmitter.setMaxListeners(50);
}
if (!global._pendingTimers) global._pendingTimers = {};
if (!global._recentRing) global._recentRing = { items: [], initialized: false };
if (!global._connectionMapCache) global._connectionMapCache = { map: {}, ts: 0 };
if (!global._statsEmitTimers) global._statsEmitTimers = { pending: null, update: null };

const pendingRequests = global._pendingRequests;
const lastErrorProvider = global._lastErrorProvider;
const pendingTimers = global._pendingTimers;
const recentRing = global._recentRing;
const connCache = global._connectionMapCache;
const statsEmitTimers = global._statsEmitTimers;

export const statsEmitter = global._statsEmitter;

function scheduleStatsEvent(event, delayMs = 150) {
  const key = event === "update" ? "update" : "pending";
  if (statsEmitTimers[key]) return;
  statsEmitTimers[key] = setTimeout(() => {
    statsEmitTimers[key] = null;
    statsEmitter.emit(event);
  }, delayMs);
  statsEmitTimers[key]?.unref?.();
}

function getLocalDateKey(timestamp) {
  const d = timestamp ? new Date(timestamp) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addToCounter(target, key, values) {
  if (!target[key]) target[key] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, costNanoUsd: 0 };
  // Seed from the legacy float once, for rollup blobs written before nano existed.
  if (target[key].costNanoUsd == null) target[key].costNanoUsd = Math.round((target[key].cost || 0) * 1e9);
  target[key].requests += values.requests || 1;
  target[key].promptTokens += values.promptTokens || 0;
  target[key].completionTokens += values.completionTokens || 0;
  target[key].cachedTokens += values.cachedTokens || 0;
  // Integer accumulates; the float mirror is re-derived so it never drifts.
  target[key].costNanoUsd = (target[key].costNanoUsd || 0) + (values.costNanoUsd || 0);
  target[key].cost = nanoToUsd(target[key].costNanoUsd);
  if (values.meta) Object.assign(target[key], values.meta);
}

function aggregateEntryToDay(day, entry) {
  const promptTokens = entry.tokens?.prompt_tokens || entry.tokens?.input_tokens || 0;
  const completionTokens = entry.tokens?.completion_tokens || entry.tokens?.output_tokens || 0;
  const cachedTokens = entry.tokens?.cached_tokens || entry.tokens?.cache_read_input_tokens || 0;
  // Integer nanoUSD is the authoritative day total; `cost` is re-derived from it
  // as the legacy float mirror so old dashboard readers keep working.
  const costNano = entry.costNanoUsd != null ? Math.round(entry.costNanoUsd) : Math.round((entry.cost || 0) * 1e9);
  const vals = { promptTokens, completionTokens, cachedTokens, costNanoUsd: costNano };

  // Seed from the legacy float once, for day blobs written before nano existed.
  if (day.costNanoUsd == null) day.costNanoUsd = Math.round((day.cost || 0) * 1e9);
  day.requests = (day.requests || 0) + 1;
  day.promptTokens = (day.promptTokens || 0) + promptTokens;
  day.completionTokens = (day.completionTokens || 0) + completionTokens;
  day.cachedTokens = (day.cachedTokens || 0) + cachedTokens;
  day.costNanoUsd = (day.costNanoUsd || 0) + costNano;
  day.cost = nanoToUsd(day.costNanoUsd);

  day.byProvider ||= {};
  day.byModel ||= {};
  day.byAccount ||= {};
  day.byApiKey ||= {};
  day.byEndpoint ||= {};

  if (entry.provider) addToCounter(day.byProvider, entry.provider, vals);

  const modelKey = entry.provider ? `${entry.model}|${entry.provider}` : entry.model;
  addToCounter(day.byModel, modelKey, { ...vals, meta: { rawModel: entry.model, provider: entry.provider } });

  if (entry.connectionId) {
    addToCounter(day.byAccount, entry.connectionId, { ...vals, meta: { rawModel: entry.model, provider: entry.provider } });
  }

  // Key identity for the rollup blob. Rows written from v7 on carry apiKeyId and
  // no raw secret, so the id is the stable identity; legacy rows and admin keys
  // with no apiKeys row still identify by the raw string. Readers canonicalize
  // both onto the id (see getUsageStats) so one key never splits across buckets.
  // meta.apiKey follows the same rule as the usageHistory column: drop the secret
  // when the id is known, keep it only for a key nothing else can attribute.
  const apiKeyIdent = entry.apiKeyId
    ? `id:${entry.apiKeyId}`
    : (entry.apiKey && typeof entry.apiKey === "string" ? entry.apiKey : "local-no-key");
  const akModelKey = `${apiKeyIdent}|${entry.model}|${entry.provider || "unknown"}`;
  addToCounter(day.byApiKey, akModelKey, { ...vals, meta: { rawModel: entry.model, provider: entry.provider, apiKey: entry.apiKeyId ? null : (entry.apiKey || null), apiKeyId: entry.apiKeyId || null } });

  const endpoint = entry.endpoint || "Unknown";
  const epKey = `${endpoint}|${entry.model}|${entry.provider || "unknown"}`;
  addToCounter(day.byEndpoint, epKey, { ...vals, meta: { endpoint, rawModel: entry.model, provider: entry.provider } });
}

function pushToRing(entry) {
  recentRing.items.push(entry);
  if (recentRing.items.length > RING_CAP) {
    recentRing.items = recentRing.items.slice(-RING_CAP);
  }
}

async function getConnectionMapCached() {
  if (Date.now() - connCache.ts < CONN_CACHE_TTL_MS) return connCache.map;
  try {
    const { getProviderConnections } = await import("./connectionsRepo.js");
    const all = await getProviderConnections();
    const map = {};
    for (const c of all) map[c.id] = c.name || c.email || c.id;
    connCache.map = map;
    connCache.ts = Date.now();
  } catch {}
  return connCache.map;
}

async function ensureRingInitialized() {
  if (recentRing.initialized) return;
  recentRing.initialized = true;
  try {
    const db = await getAdapter();
    const rows = db.all(`SELECT timestamp, provider, model, connectionId, apiKey, endpoint, cost, costNanoUsd, status, tokens FROM usageHistory ORDER BY id DESC LIMIT ?`, [RING_CAP]);
    recentRing.items = rows.reverse().map((r) => ({
      timestamp: r.timestamp, provider: r.provider, model: r.model, connectionId: r.connectionId,
      apiKey: r.apiKey, endpoint: r.endpoint, cost: rowCostUsd(r.costNanoUsd, r.cost), costNanoUsd: rowCostNano(r.costNanoUsd, r.cost), status: r.status,
      tokens: parseJson(r.tokens, {}),
    }));
  } catch {}
}

// Compute the cost of one request as integer nanoUSD.
// `requestedModel` carries the original client model string; resolvePrice uses it
// to let a combo-level price override take precedence for bare combo names, so
// budgets for key-holders (who consume combos) are charged at the combo price
// the admin set, not the internal pool model's price.
async function calculateCostNano(provider, model, tokens, requestedModel, imageCount = 0) {
  if (!tokens && !(imageCount > 0)) return 0;
  try {
    const { resolvePrice } = await import("./pricingRepo.js");
    const { pricing } = await resolvePrice({ provider, model, requestedModel });
    if (!pricing) return 0;
    // An image request is priced per image; it carries no token counts.
    if (imageCount > 0) return costFromImagesNano(imageCount, pricing);
    return costFromTokensNano(tokens, pricing);
  } catch (e) {
    console.error("Error calculating cost:", e);
    return 0;
  }
}

export function trackPendingRequest(model, provider, connectionId, started, error = false) {
  const modelKey = provider ? `${model} (${provider})` : model;
  const timerKey = `${connectionId}|${modelKey}`;

  if (!pendingRequests.byModel[modelKey]) pendingRequests.byModel[modelKey] = 0;
  pendingRequests.byModel[modelKey] = Math.max(0, pendingRequests.byModel[modelKey] + (started ? 1 : -1));
  if (pendingRequests.byModel[modelKey] === 0) delete pendingRequests.byModel[modelKey];

  if (connectionId) {
    if (!pendingRequests.byAccount[connectionId]) pendingRequests.byAccount[connectionId] = {};
    if (!pendingRequests.byAccount[connectionId][modelKey]) pendingRequests.byAccount[connectionId][modelKey] = 0;
    pendingRequests.byAccount[connectionId][modelKey] = Math.max(0, pendingRequests.byAccount[connectionId][modelKey] + (started ? 1 : -1));
    if (pendingRequests.byAccount[connectionId][modelKey] === 0) {
      delete pendingRequests.byAccount[connectionId][modelKey];
      if (Object.keys(pendingRequests.byAccount[connectionId]).length === 0) {
        delete pendingRequests.byAccount[connectionId];
      }
    }
  }

  if (started) {
    clearTimeout(pendingTimers[timerKey]);
    pendingTimers[timerKey] = setTimeout(() => {
      delete pendingTimers[timerKey];
      if (pendingRequests.byModel[modelKey] > 0) pendingRequests.byModel[modelKey] = 0;
      if (connectionId && pendingRequests.byAccount[connectionId]?.[modelKey] > 0) {
        pendingRequests.byAccount[connectionId][modelKey] = 0;
      }
      scheduleStatsEvent("pending");
    }, PENDING_TIMEOUT_MS);
  } else {
    clearTimeout(pendingTimers[timerKey]);
    delete pendingTimers[timerKey];
  }

  if (!started && error && provider) {
    lastErrorProvider.provider = provider.toLowerCase();
    lastErrorProvider.ts = Date.now();
  }

  // [PENDING] console line removed; lifecycle is visible via "▶" and "📊 done" lines
  scheduleStatsEvent("pending");
}

export async function getActiveRequests() {
  const activeRequests = [];
  const connectionMap = await getConnectionMapCached();

  for (const [connectionId, models] of Object.entries(pendingRequests.byAccount)) {
    for (const [modelKey, count] of Object.entries(models)) {
      if (count > 0) {
        const accountName = connectionMap[connectionId] || `Account ${connectionId.slice(0, 8)}...`;
        const match = modelKey.match(/^(.*) \((.*)\)$/);
        activeRequests.push({
          model: match ? match[1] : modelKey,
          provider: match ? match[2] : "unknown",
          account: accountName, count,
        });
      }
    }
  }

  await ensureRingInitialized();
  const seen = new Set();
  const recentRequests = [...recentRing.items]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .map((e) => {
      const t = e.tokens || {};
      return {
        timestamp: e.timestamp, model: e.model, provider: e.provider || "",
        promptTokens: t.prompt_tokens || t.input_tokens || 0,
        completionTokens: t.completion_tokens || t.output_tokens || 0,
        status: e.status || "ok",
      };
    })
    .filter((e) => {
      if (e.promptTokens === 0 && e.completionTokens === 0) return false;
      const minute = e.timestamp ? e.timestamp.slice(0, 16) : "";
      const key = `${e.model}|${e.provider}|${e.promptTokens}|${e.completionTokens}|${minute}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);

  const errorProvider = (Date.now() - lastErrorProvider.ts < 10000) ? lastErrorProvider.provider : "";
  return { activeRequests, recentRequests, errorProvider };
}

export async function saveRequestUsage(entry) {
  try {
    const db = await getAdapter();

    if (!entry.timestamp) entry.timestamp = new Date().toISOString();
    // Authoritative integer nanoUSD; legacy float `cost` is derived from it so
    // the two columns can never disagree.
    const imageCount = Number(entry.imageCount) > 0 ? Math.floor(Number(entry.imageCount)) : 0;
    if (imageCount > 0) entry.tokens = { ...(entry.tokens || {}), image_count: imageCount };
    entry.costNanoUsd = await calculateCostNano(entry.provider, entry.model, entry.tokens, entry.requestedModel, imageCount);
    entry.cost = nanoToUsd(entry.costNanoUsd);

    const tokens = entry.tokens || {};
    const promptTokens = tokens.prompt_tokens || tokens.input_tokens || 0;
    const completionTokens = tokens.completion_tokens || tokens.output_tokens || 0;

    // Resolve the owning tenant key BEFORE the insert: the row stores that key's
    // id instead of the raw secret, and the dedup predicate below needs to know
    // whether an id exists. `resolveApiKeyOwner` returns null for a key with no
    // apiKeys row OR no userId (an admin/local key), which is exactly the set that
    // must keep its raw value to stay attributable.
    const owner = entry.apiKey ? resolveApiKeyOwner(db, entry.apiKey) : null;
    const apiKeyId = owner?.apiKeyId ?? null;
    // Carried on the entry so the daily rollup records the same identity.
    entry.apiKeyId = apiKeyId;

    let inserted = false;

    // All 3 writes (history insert, daily upsert, lifetime counter) in ONE transaction.
    // better-sqlite3 is sync → no JS yield mid-transaction → no race in same process.
    db.transaction(() => {
      // Dedup: a retried request must not be recorded twice. New rows no longer
      // carry the raw key when an owner resolved, so the old raw comparison would
      // miss them. Match explicitly on the same identity that will be written:
      // by apiKeyId when the key has one, otherwise by the raw key (legacy
      // admin/local keys). The apiKey arm is kept alongside the id arm for a
      // legacy row of a tenant key that 005 could not backfill — it is still the
      // same key, so a retry must still dedupe against it.
      const keyCond = apiKeyId
        ? "(apiKeyId = ? OR apiKey = ?)"
        : "COALESCE(apiKey, '') = COALESCE(?, '')";
      const keyParams = apiKeyId ? [apiKeyId, entry.apiKey || null] : [entry.apiKey || null];
      // Image rows all carry 0/0 tokens, so the token-based match below would merge two
      // genuine image requests that land in the same millisecond. Each image request is
      // saved exactly once, so it is never deduped.
      const existing = imageCount > 0 ? null : db.get(
        `SELECT id, endpoint FROM usageHistory
         WHERE timestamp = ?
           AND COALESCE(provider, '') = COALESCE(?, '')
           AND COALESCE(model, '') = COALESCE(?, '')
           AND COALESCE(connectionId, '') = COALESCE(?, '')
           AND ${keyCond}
           AND promptTokens = ?
           AND completionTokens = ?
         ORDER BY id DESC LIMIT 1`,
        [
          entry.timestamp, entry.provider || null, entry.model || null,
          entry.connectionId || null, ...keyParams,
          promptTokens, completionTokens,
        ]
      );

      if (existing) {
        if (!existing.endpoint && entry.endpoint) {
          db.run(`UPDATE usageHistory SET endpoint = ? WHERE id = ?`, [entry.endpoint, existing.id]);
        }
        return;
      }

      // `apiKey` is the deprecated column: only a key with no owning apiKeys row
      // still needs its raw value to stay attributable. Tenant keys store their
      // apiKeyId and leave the secret out of the database entirely.
      const insertedUsage = db.run(
        `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, apiKeyId, endpoint, promptTokens, completionTokens, cost, costNanoUsd, status, tokens, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.timestamp, entry.provider || null, entry.model || null,
          entry.connectionId || null, apiKeyId ? null : entry.apiKey || null, apiKeyId,
          entry.endpoint || null,
          promptTokens, completionTokens, entry.cost || 0, entry.costNanoUsd || 0, entry.status || "ok",
          stringifyJson(tokens), stringifyJson({ requestedModel: entry.requestedModel || null, latencyMs: entry.latencyMs ?? null }),
        ]
      );

      // Charge the owner from their plan queue in the SAME transaction as the usage
      // row, keyed on that row's id so a retry is idempotent. Failures are logged,
      // never thrown: a billing problem must not discard recorded usage.
      //
      // The charge engine re-evaluates the queue at charge time (design D4) rather
      // than pinning whatever admission picked, and a request admitted on a plan
      // that has since filled up is still paid (pass 2), with anything uncovered
      // becoming debt. Admin keys have no owner and are never charged.
      if (entry.apiKey && owner) {
        try {
          chargeSync(db, {
            userId: owner.userId,
            apiKeyId: owner.apiKeyId,
            usageId: insertedUsage.lastInsertRowid,
            requestKey: "usage:" + insertedUsage.lastInsertRowid,
            costNanoUsd: entry.costNanoUsd || 0,
            nowIso: entry.timestamp || new Date().toISOString(),
          });
        } catch (e) {
          console.error("[billing] charge failed", e.message);
        }
      }

      const dateKey = getLocalDateKey(entry.timestamp);
      const row = db.get(`SELECT data FROM usageDaily WHERE dateKey = ?`, [dateKey]);
      const day = row ? parseJson(row.data, {}) : {
        requests: 0, promptTokens: 0, completionTokens: 0, cost: 0, costNanoUsd: 0,
        byProvider: {}, byModel: {}, byAccount: {}, byApiKey: {}, byEndpoint: {},
      };
      aggregateEntryToDay(day, entry);
      db.run(`INSERT INTO usageDaily(dateKey, data) VALUES(?, ?) ON CONFLICT(dateKey) DO UPDATE SET data = excluded.data`, [dateKey, stringifyJson(day)]);

      // Atomic counter increment in same transaction
      const cur = db.get(`SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'`);
      const next = (cur ? parseInt(cur.value, 10) : 0) + 1;
      db.run(`INSERT INTO _meta(key, value) VALUES('totalRequestsLifetime', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(next)]);
      inserted = true;

      // Probabilistic retention prune — amortized across inserts, no per-request cost.
      if (++_pruneCounter >= PRUNE_EVERY_N) {
        _pruneCounter = 0;
        try { pruneOldUsage(db); } catch (e) { console.warn("[usageRepo] prune failed:", e.message); }
      }
    });

    if (inserted) {
      pushToRing(entry);
      scheduleStatsEvent("update", 250);
    }
  } catch (e) {
    console.error("Failed to save usage stats:", e);
  }
}

export async function getUsageHistory(filter = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  if (filter.provider) { conds.push("provider = ?"); params.push(filter.provider); }
  if (filter.model) { conds.push("model = ?"); params.push(filter.model); }
  if (filter.apiKey) {
    // Union of both row kinds (legacy raw `apiKey` + post-005 `apiKeyId`) so a
    // key's history is never split.
    const { cond, params: keyParams } = usageKeyCond(db, filter.apiKey);
    conds.push(cond);
    params.push(...keyParams);
  }
  if (filter.startDate) { conds.push("timestamp >= ?"); params.push(new Date(filter.startDate).toISOString()); }
  if (filter.endDate) { conds.push("timestamp <= ?"); params.push(new Date(filter.endDate).toISOString()); }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = db.all(`SELECT timestamp, provider, model, connectionId, apiKey, endpoint, cost, costNanoUsd, status, tokens, meta FROM usageHistory ${where} ORDER BY id ASC`, params);

  // Post-005 rows carry apiKeyId and no raw key, so derive the mask from the
  // caller's own key: a key holder's receipt must still identify the key.
  const filterKeyMasked = filter.apiKey ? maskApiKey(filter.apiKey) : null;

  return rows.map((r) => {
    const meta = parseJson(r.meta, {});
    // requestedModel = the original client model string (a bare combo name when the
    // request targeted a combo). When present, the public /usage page shows the combo
    // the key holder called, not the internal pool/fallback model the proxy resolved to.
    const requestedModel = meta.requestedModel || null;
    return {
      timestamp: r.timestamp, provider: r.provider,
      model: requestedModel || r.model, // display model: combo name if known, else resolved
      resolvedModel: r.model,            // internal fallback model (kept for cost/accuracy)
      requestedModel,
      connectionId: r.connectionId, apiKeyMasked: maskApiKey(r.apiKey) ?? filterKeyMasked, endpoint: r.endpoint,
      // Legacy float (derived from the authoritative integer) + the integer itself,
      // so money-aware consumers never have to re-parse a float.
      cost: rowCostUsd(r.costNanoUsd, r.cost),
      costNanoUsd: rowCostNano(r.costNanoUsd, r.cost),
      status: r.status, tokens: parseJson(r.tokens, {}),
      // Raw meta JSON (carries requestedModel + latencyMs). Exposed so downstream
      // readers (e.g. /api/usage/key/receipts) can show each request's response time.
      meta,
    };
  });
}

function loadDaysInRange(adapter, maxDays) {
  if (maxDays == null) {
    return adapter.all(`SELECT dateKey, data FROM usageDaily`);
  }
  const today = new Date();
  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - maxDays + 1);
  const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;
  return adapter.all(`SELECT dateKey, data FROM usageDaily WHERE dateKey >= ?`, [cutoffKey]);
}

export async function getUsageStats(period = "all") {
  const db = await getAdapter();

  const [{ getProviderConnections }, { getApiKeys }, { getProviderNodes }] = await Promise.all([
    import("./connectionsRepo.js"),
    import("./apiKeysRepo.js"),
    import("./nodesRepo.js"),
  ]);

  let allConnections = [];
  try { allConnections = await getProviderConnections(); } catch {}
  const connectionMap = {};
  for (const c of allConnections) connectionMap[c.id] = c.name || c.email || c.id;

  const providerNodeNameMap = {};
  try {
    const nodes = await getProviderNodes();
    for (const n of nodes) if (n.id && n.name) providerNodeNameMap[n.id] = n.name;
  } catch {}

  let allApiKeys = [];
  try { allApiKeys = await getApiKeys(); } catch {}
  const apiKeyMap = {};
  const apiKeyMapById = {};
  for (const k of allApiKeys) {
    // `masked` is the only key-derived value that leaves this function for display:
    // usage views must never receive the secret itself.
    const info = {
      name: k.name, id: k.id, createdAt: k.createdAt,
      masked: k.key ? maskApiKey(k.key) : (k.keyPrefix ? `${k.keyPrefix}***` : null),
    };
    if (k.key) apiKeyMap[k.key] = info;
    if (k.id) apiKeyMapById[k.id] = info;
  }

  // Rollup buckets and history rows identify a key either by apiKeys.id (rows
  // written from v7 on) or by the raw string (legacy rows, admin keys with no
  // apiKeys row). Canonicalize both onto one identity so the same key lands in one
  // bucket regardless of the period being viewed: a raw key that apiKeys still
  // owns resolves to its id, so a pre-v7 bucket and a v7 bucket for the same key
  // merge instead of appearing as two keys.
  // Memoized per call: resolveApiKeyId hits the DB (key, then keyHash) and a
  // stats pass walks every row, but there are only a handful of distinct keys.
  const resolvedKeyId = new Map();
  const keyIdFor = (apiKey) => {
    if (!apiKey) return null;
    if (!resolvedKeyId.has(apiKey)) resolvedKeyId.set(apiKey, apiKeyMap[apiKey]?.id ?? resolveApiKeyId(db, apiKey));
    return resolvedKeyId.get(apiKey);
  };
  const keyIdent = (apiKeyId, apiKey) => {
    const id = apiKeyId || keyIdFor(apiKey);
    return id ? `id:${id}` : (apiKey || "local-no-key");
  };
  const keyInfoOf = (apiKeyId, apiKey) => {
    const id = apiKeyId || keyIdFor(apiKey);
    return (id ? apiKeyMapById[id] : null) || (apiKey ? apiKeyMap[apiKey] : null) || null;
  };

  // recentRequests from live history (last 100 entries enough for 20 deduped)
  const recentRows = db.all(`SELECT timestamp, provider, model, tokens, status FROM usageHistory ORDER BY id DESC LIMIT 100`);
  const seen = new Set();
  const recentRequests = recentRows
    .map((r) => {
      const t = parseJson(r.tokens, {}) || {};
      return {
        timestamp: r.timestamp, model: r.model, provider: r.provider || "",
        promptTokens: t.prompt_tokens || t.input_tokens || 0,
        completionTokens: t.completion_tokens || t.output_tokens || 0,
        cachedTokens: t.cached_tokens || t.cache_read_input_tokens || 0,
        status: r.status || "ok",
      };
    })
    .filter((e) => {
      if (e.promptTokens === 0 && e.completionTokens === 0) return false;
      const minute = e.timestamp ? e.timestamp.slice(0, 16) : "";
      const key = `${e.model}|${e.provider}|${e.promptTokens}|${e.completionTokens}|${minute}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);

  const stats = {
    totalRequests: 0,
    totalPromptTokens: 0, totalCompletionTokens: 0, totalCachedTokens: 0, totalCost: 0,
    // Integer nanoUSD total — authoritative. `totalCost` is the legacy float mirror.
    totalCostNanoUsd: 0,
    byProvider: {}, byModel: {}, byAccount: {}, byApiKey: {}, byEndpoint: {},
    last10Minutes: [],
    pending: pendingRequests,
    activeRequests: [],
    recentRequests,
    errorProvider: (Date.now() - lastErrorProvider.ts < 10000) ? lastErrorProvider.provider : "",
  };

  // Active requests
  for (const [connectionId, models] of Object.entries(pendingRequests.byAccount)) {
    for (const [modelKey, count] of Object.entries(models)) {
      if (count > 0) {
        const accountName = connectionMap[connectionId] || `Account ${connectionId.slice(0, 8)}...`;
        const match = modelKey.match(/^(.*) \((.*)\)$/);
        stats.activeRequests.push({
          model: match ? match[1] : modelKey,
          provider: match ? match[2] : "unknown",
          account: accountName, count,
        });
      }
    }
  }

  // last10Minutes — query 10min window
  const now = new Date();
  const currentMinuteStart = new Date(Math.floor(now.getTime() / 60000) * 60000);
  const tenMinutesAgo = new Date(currentMinuteStart.getTime() - 9 * 60 * 1000);
  const bucketMap = {};
  for (let i = 0; i < 10; i++) {
    const ts = currentMinuteStart.getTime() - (9 - i) * 60 * 1000;
    bucketMap[ts] = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0, costNanoUsd: 0 };
    stats.last10Minutes.push(bucketMap[ts]);
  }
  const recent10 = db.all(
    `SELECT timestamp, promptTokens, completionTokens, cost, costNanoUsd FROM usageHistory WHERE timestamp >= ? AND timestamp <= ?`,
    [tenMinutesAgo.toISOString(), now.toISOString()]
  );
  for (const r of recent10) {
    const tt = new Date(r.timestamp).getTime();
    const minuteStart = Math.floor(tt / 60000) * 60000;
    if (bucketMap[minuteStart]) {
      bucketMap[minuteStart].requests++;
      bucketMap[minuteStart].promptTokens += r.promptTokens || 0;
      bucketMap[minuteStart].completionTokens += r.completionTokens || 0;
      addCostTo(bucketMap[minuteStart], rowCostNano(r.costNanoUsd, r.cost));
    }
  }

  const useDailySummary = period !== "24h" && period !== "today";

  if (useDailySummary) {
    const periodDays = { "7d": 7, "30d": 30, "60d": 60 };
    const maxDays = periodDays[period] || null;
    const dayRows = loadDaysInRange(db, maxDays);

    for (const dr of dayRows) {
      const dateKey = dr.dateKey;
      const day = parseJson(dr.data, {});
      stats.totalPromptTokens += day.promptTokens || 0;
      stats.totalCompletionTokens += day.completionTokens || 0;
      stats.totalCachedTokens += day.cachedTokens || 0;
      stats.totalCostNanoUsd += blobCostNano(day);
      stats.totalCost = nanoToUsd(stats.totalCostNanoUsd);

      for (const [prov, p] of Object.entries(day.byProvider || {})) {
        if (!stats.byProvider[prov]) stats.byProvider[prov] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, costNanoUsd: 0 };
        stats.byProvider[prov].requests += p.requests || 0;
        stats.byProvider[prov].promptTokens += p.promptTokens || 0;
        stats.byProvider[prov].completionTokens += p.completionTokens || 0;
        stats.byProvider[prov].cachedTokens += p.cachedTokens || 0;
        addCostTo(stats.byProvider[prov], blobCostNano(p));
      }

      for (const [mk, m] of Object.entries(day.byModel || {})) {
        const rawModel = m.rawModel || mk.split("|")[0];
        const provider = m.provider || mk.split("|")[1] || "";
        const statsKey = provider ? `${rawModel} (${provider})` : rawModel;
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        if (!stats.byModel[statsKey]) {
          stats.byModel[statsKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, costNanoUsd: 0, rawModel, provider: providerDisplayName, lastUsed: dateKey };
        }
        stats.byModel[statsKey].requests += m.requests || 0;
        stats.byModel[statsKey].promptTokens += m.promptTokens || 0;
        stats.byModel[statsKey].completionTokens += m.completionTokens || 0;
        stats.byModel[statsKey].cachedTokens += m.cachedTokens || 0;
        addCostTo(stats.byModel[statsKey], blobCostNano(m));
        if (dateKey > (stats.byModel[statsKey].lastUsed || "")) stats.byModel[statsKey].lastUsed = dateKey;
      }

      for (const [connId, a] of Object.entries(day.byAccount || {})) {
        const accountName = connectionMap[connId] || `Account ${connId.slice(0, 8)}...`;
        const rawModel = a.rawModel || "";
        const provider = a.provider || "";
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        const accountKey = `${rawModel} (${provider} - ${accountName})`;
        if (!stats.byAccount[accountKey]) {
          stats.byAccount[accountKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, costNanoUsd: 0, rawModel, provider: providerDisplayName, connectionId: connId, accountName, lastUsed: dateKey };
        }
        stats.byAccount[accountKey].requests += a.requests || 0;
        stats.byAccount[accountKey].promptTokens += a.promptTokens || 0;
        stats.byAccount[accountKey].completionTokens += a.completionTokens || 0;
        stats.byAccount[accountKey].cachedTokens += a.cachedTokens || 0;
        addCostTo(stats.byAccount[accountKey], blobCostNano(a));
        if (dateKey > (stats.byAccount[accountKey].lastUsed || "")) stats.byAccount[accountKey].lastUsed = dateKey;
      }

      for (const [akKey, ak] of Object.entries(day.byApiKey || {})) {
        const rawModel = ak.rawModel || "";
        const provider = ak.provider || "";
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        const info = keyInfoOf(ak.apiKeyId, ak.apiKey);
        const keyName = info?.name || (ak.apiKeyId ? "Key " + String(ak.apiKeyId).slice(0, 8) + "..." : (ak.apiKey ? ak.apiKey.slice(0, 8) + "..." : "Local (No API Key)"));
        const apiKeyMasked = info?.masked ?? maskApiKey(ak.apiKey);
        const apiKeyKey = keyIdent(ak.apiKeyId, ak.apiKey);
        // Bucket key is rebuilt from the canonical identity, not the stored blob
        // key, because pre-v7 blobs embed the raw secret while v7 blobs embed
        // `id:<uuid>` — both must merge into one bucket per key.
        const groupKey = `${apiKeyKey}|${rawModel}|${provider || "unknown"}`;
        if (!stats.byApiKey[groupKey]) {
          stats.byApiKey[groupKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, costNanoUsd: 0, rawModel, provider: providerDisplayName, apiKeyMasked, keyName, apiKeyKey, lastUsed: dateKey };
        }
        stats.byApiKey[groupKey].requests += ak.requests || 0;
        stats.byApiKey[groupKey].promptTokens += ak.promptTokens || 0;
        stats.byApiKey[groupKey].completionTokens += ak.completionTokens || 0;
        stats.byApiKey[groupKey].cachedTokens += ak.cachedTokens || 0;
        addCostTo(stats.byApiKey[groupKey], blobCostNano(ak));
        if (dateKey > (stats.byApiKey[groupKey].lastUsed || "")) stats.byApiKey[groupKey].lastUsed = dateKey;
      }

      for (const [epKey, ep] of Object.entries(day.byEndpoint || {})) {
        const endpoint = ep.endpoint || epKey.split("|")[0] || "Unknown";
        const rawModel = ep.rawModel || "";
        const provider = ep.provider || "";
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        if (!stats.byEndpoint[epKey]) {
          stats.byEndpoint[epKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, costNanoUsd: 0, endpoint, rawModel, provider: providerDisplayName, lastUsed: dateKey };
        }
        stats.byEndpoint[epKey].requests += ep.requests || 0;
        stats.byEndpoint[epKey].promptTokens += ep.promptTokens || 0;
        stats.byEndpoint[epKey].completionTokens += ep.completionTokens || 0;
        stats.byEndpoint[epKey].cachedTokens += ep.cachedTokens || 0;
        addCostTo(stats.byEndpoint[epKey], blobCostNano(ep));
        if (dateKey > (stats.byEndpoint[epKey].lastUsed || "")) stats.byEndpoint[epKey].lastUsed = dateKey;
      }
    }

    // Overlay precise lastUsed timestamps from history
    const overlayCutoff = maxDays ? Date.now() - maxDays * 86400000 : 0;
    const histRows = db.all(
      `SELECT timestamp, provider, model, connectionId, apiKey, apiKeyId, endpoint FROM usageHistory WHERE timestamp >= ?`,
      [new Date(overlayCutoff).toISOString()]
    );
    for (const e of histRows) {
      const ts = e.timestamp;
      const modelKey = e.provider ? `${e.model} (${e.provider})` : e.model;
      if (stats.byModel[modelKey] && new Date(ts) > new Date(stats.byModel[modelKey].lastUsed)) stats.byModel[modelKey].lastUsed = ts;

      if (e.connectionId) {
        const accountName = connectionMap[e.connectionId] || `Account ${e.connectionId.slice(0, 8)}...`;
        const accountKey = `${e.model} (${e.provider} - ${accountName})`;
        if (stats.byAccount[accountKey] && new Date(ts) > new Date(stats.byAccount[accountKey].lastUsed)) stats.byAccount[accountKey].lastUsed = ts;
      }

      const keyIdPart = keyIdent(e.apiKeyId, e.apiKey && typeof e.apiKey === "string" ? e.apiKey : null);
      const apiKeyKey = keyIdPart === "local-no-key"
        ? "local-no-key"
        : `${keyIdPart}|${e.model}|${e.provider || "unknown"}`;
      if (stats.byApiKey[apiKeyKey] && new Date(ts) > new Date(stats.byApiKey[apiKeyKey].lastUsed)) stats.byApiKey[apiKeyKey].lastUsed = ts;

      const endpoint = e.endpoint || "Unknown";
      const endpointKey = `${endpoint}|${e.model}|${e.provider || "unknown"}`;
      if (stats.byEndpoint[endpointKey] && new Date(ts) > new Date(stats.byEndpoint[endpointKey].lastUsed)) stats.byEndpoint[endpointKey].lastUsed = ts;
    }
  } else {
    // 24h / today: live history
    let cutoff;
    if (period === "today") {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      cutoff = startOfDay.toISOString();
    } else {
      cutoff = new Date(Date.now() - PERIOD_MS["24h"]).toISOString();
    }
    const filtered = db.all(
      `SELECT timestamp, provider, model, connectionId, apiKey, apiKeyId, endpoint, promptTokens, completionTokens, cost, costNanoUsd, tokens FROM usageHistory WHERE timestamp >= ?`,
      [cutoff]
    );

    for (const r of filtered) {
      const tokens = parseJson(r.tokens, {}) || {};
      const promptTokens = tokens.prompt_tokens || 0;
      const completionTokens = tokens.completion_tokens || 0;
      const cachedTokens = tokens.cached_tokens || tokens.cache_read_input_tokens || 0;
      const entryCostNano = rowCostNano(r.costNanoUsd, r.cost);
      const providerDisplayName = providerNodeNameMap[r.provider] || r.provider;

      stats.totalPromptTokens += promptTokens;
      stats.totalCompletionTokens += completionTokens;
      stats.totalCachedTokens += cachedTokens;
      stats.totalCostNanoUsd += entryCostNano;
      stats.totalCost = nanoToUsd(stats.totalCostNanoUsd);

      if (!stats.byProvider[r.provider]) stats.byProvider[r.provider] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, costNanoUsd: 0 };
      stats.byProvider[r.provider].requests++;
      stats.byProvider[r.provider].promptTokens += promptTokens;
      stats.byProvider[r.provider].completionTokens += completionTokens;
      stats.byProvider[r.provider].cachedTokens += cachedTokens;
      addCostTo(stats.byProvider[r.provider], entryCostNano);

      const modelKey = r.provider ? `${r.model} (${r.provider})` : r.model;
      if (!stats.byModel[modelKey]) {
        stats.byModel[modelKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, costNanoUsd: 0, rawModel: r.model, provider: providerDisplayName, lastUsed: r.timestamp };
      }
      stats.byModel[modelKey].requests++;
      stats.byModel[modelKey].promptTokens += promptTokens;
      stats.byModel[modelKey].completionTokens += completionTokens;
      stats.byModel[modelKey].cachedTokens += cachedTokens;
      addCostTo(stats.byModel[modelKey], entryCostNano);
      if (new Date(r.timestamp) > new Date(stats.byModel[modelKey].lastUsed)) stats.byModel[modelKey].lastUsed = r.timestamp;

      if (r.connectionId) {
        const accountName = connectionMap[r.connectionId] || `Account ${r.connectionId.slice(0, 8)}...`;
        const accountKey = `${r.model} (${r.provider} - ${accountName})`;
        if (!stats.byAccount[accountKey]) {
          stats.byAccount[accountKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, costNanoUsd: 0, rawModel: r.model, provider: providerDisplayName, connectionId: r.connectionId, accountName, lastUsed: r.timestamp };
        }
        stats.byAccount[accountKey].requests++;
        stats.byAccount[accountKey].promptTokens += promptTokens;
        stats.byAccount[accountKey].completionTokens += completionTokens;
        stats.byAccount[accountKey].cachedTokens += cachedTokens;
        addCostTo(stats.byAccount[accountKey], entryCostNano);
        if (new Date(r.timestamp) > new Date(stats.byAccount[accountKey].lastUsed)) stats.byAccount[accountKey].lastUsed = r.timestamp;
      }

      const liveKeyIdent = keyIdent(r.apiKeyId, r.apiKey);
      if (liveKeyIdent !== "local-no-key") {
        const keyInfo = keyInfoOf(r.apiKeyId, r.apiKey);
        const apiKeyMasked = keyInfo?.masked ?? maskApiKey(r.apiKey);
        const keyName = keyInfo?.name || (r.apiKeyId ? "Key " + String(r.apiKeyId).slice(0, 8) + "..." : r.apiKey.slice(0, 8) + "...");
        const akKey = `${liveKeyIdent}|${r.model}|${r.provider || "unknown"}`;
        if (!stats.byApiKey[akKey]) {
          stats.byApiKey[akKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, costNanoUsd: 0, rawModel: r.model, provider: providerDisplayName, apiKeyMasked, keyName, apiKeyKey: liveKeyIdent, lastUsed: r.timestamp };
        }
        const ake = stats.byApiKey[akKey];
        ake.requests++; ake.promptTokens += promptTokens; ake.completionTokens += completionTokens; ake.cachedTokens += cachedTokens;
        addCostTo(ake, entryCostNano);
        if (new Date(r.timestamp) > new Date(ake.lastUsed)) ake.lastUsed = r.timestamp;
      } else {
        if (!stats.byApiKey["local-no-key"]) {
          stats.byApiKey["local-no-key"] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, costNanoUsd: 0, rawModel: r.model, provider: providerDisplayName, apiKeyMasked: null, keyName: "Local (No API Key)", apiKeyKey: "local-no-key", lastUsed: r.timestamp };
        }
        const ake = stats.byApiKey["local-no-key"];
        ake.requests++; ake.promptTokens += promptTokens; ake.completionTokens += completionTokens; ake.cachedTokens += cachedTokens;
        addCostTo(ake, entryCostNano);
        if (new Date(r.timestamp) > new Date(ake.lastUsed)) ake.lastUsed = r.timestamp;
      }

      const endpoint = r.endpoint || "Unknown";
      const epKey = `${endpoint}|${r.model}|${r.provider || "unknown"}`;
      if (!stats.byEndpoint[epKey]) {
        stats.byEndpoint[epKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, costNanoUsd: 0, endpoint, rawModel: r.model, provider: providerDisplayName, lastUsed: r.timestamp };
      }
      const epe = stats.byEndpoint[epKey];
      epe.requests++; epe.promptTokens += promptTokens; epe.completionTokens += completionTokens; epe.cachedTokens += cachedTokens;
      addCostTo(epe, entryCostNano);
      if (new Date(r.timestamp) > new Date(epe.lastUsed)) epe.lastUsed = r.timestamp;
    }
  }

  stats.totalRequests = Object.values(stats.byProvider).reduce((sum, p) => sum + (p.requests || 0), 0);
  return stats;
}

export async function getChartData(period = "7d") {
  const db = await getAdapter();
  const now = Date.now();

  if (period === "today") {
    const bucketCount = 24;
    const bucketMs = 3600000;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startTime = startOfDay.getTime();
    const endTime = startTime + bucketCount * bucketMs;
    const labelFn = (ts) => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({ label: labelFn(startTime + i * bucketMs), tokens: 0, cost: 0, costNanoUsd: 0 }));

    const rows = db.all(
      `SELECT timestamp, promptTokens, completionTokens, cost, costNanoUsd FROM usageHistory WHERE timestamp >= ?`,
      [new Date(startTime).toISOString()]
    );
    for (const r of rows) {
      const t = new Date(r.timestamp).getTime();
      if (t < startTime || t >= endTime) continue;
      const idx = Math.floor((t - startTime) / bucketMs);
      if (idx >= 0 && idx < bucketCount) {
        buckets[idx].tokens += (r.promptTokens || 0) + (r.completionTokens || 0);
        addCostTo(buckets[idx], rowCostNano(r.costNanoUsd, r.cost));
      }
    }
    return buckets;
  }

  if (period === "24h") {
    const bucketCount = 24;
    const bucketMs = 3600000;
    const labelFn = (ts) => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    const startTime = now - bucketCount * bucketMs;
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({ label: labelFn(startTime + i * bucketMs), tokens: 0, cost: 0, costNanoUsd: 0 }));

    const rows = db.all(
      `SELECT timestamp, promptTokens, completionTokens, cost, costNanoUsd FROM usageHistory WHERE timestamp >= ?`,
      [new Date(startTime).toISOString()]
    );
    for (const r of rows) {
      const t = new Date(r.timestamp).getTime();
      if (t < startTime || t > now) continue;
      const idx = Math.min(Math.floor((t - startTime) / bucketMs), bucketCount - 1);
      buckets[idx].tokens += (r.promptTokens || 0) + (r.completionTokens || 0);
      addCostTo(buckets[idx], rowCostNano(r.costNanoUsd, r.cost));
    }
    return buckets;
  }

  const bucketCount = period === "7d" ? 7 : period === "30d" ? 30 : 60;
  const today = new Date();
  const labelFn = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  // Build map of dateKey → day data
  const dayRows = loadDaysInRange(db, bucketCount);
  const dayMap = {};
  for (const r of dayRows) dayMap[r.dateKey] = parseJson(r.data, {});

  return Array.from({ length: bucketCount }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (bucketCount - 1 - i));
    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const dayData = dayMap[dateKey];
    return {
      label: labelFn(d),
      tokens: dayData ? (dayData.promptTokens || 0) + (dayData.completionTokens || 0) : 0,
      costNanoUsd: blobCostNano(dayData),
      cost: nanoToUsd(blobCostNano(dayData)),
    };
  });
}

function formatLogDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// No-op: request log is now derived from usageHistory table on read.
export async function appendRequestLog() {}

export async function getRecentLogs(limit = 200) {
  try {
    const db = await getAdapter();
    const rows = db.all(
      `SELECT timestamp, provider, model, connectionId, promptTokens, completionTokens, status, tokens FROM usageHistory ORDER BY id DESC LIMIT ?`,
      [limit],
    );
    if (!rows.length) return [];

    const connMap = {};
    try {
      const { getProviderConnections } = await import("./connectionsRepo.js");
      const connections = await getProviderConnections();
      for (const c of connections) connMap[c.id] = c.name || c.email || "";
    } catch {}

    return rows.map((r) => {
      const ts = formatLogDate(new Date(r.timestamp));
      const p = r.provider?.toUpperCase() || "-";
      const m = r.model || "-";
      const account = connMap[r.connectionId] || (r.connectionId ? r.connectionId.slice(0, 8) : "-");
      const tk = r.tokens ? parseJson(r.tokens, {}) : {};
      const sent = r.promptTokens ?? tk.prompt_tokens ?? "-";
      const received = r.completionTokens ?? tk.completion_tokens ?? "-";
      return `${ts} | ${m} | ${p} | ${account} | ${sent} | ${received} | ${r.status || "-"}`;
    });
  } catch (e) {
    console.error("[usageRepo] getRecentLogs failed:", e.message);
    return [];
  }
}

// ── Per-key usage summary (viber-router KeyTokenUsage-style) ─────────────────
// Aggregates usageHistory for one apiKey in [startDate, endDate], grouped by model,
// plus peak figures:
//   peakTpm  — max sum of (prompt+completion) tokens in any 1-minute bucket
//   peakRpm  — max request count in any 1-minute bucket
//   peakTokS — max sum of COMPLETION (output) tokens in any 1-second bucket
// (Tok/s = LLM generation speed = output tokens/sec. Input tokens are the
//  prompt sent in, not generated, so they're excluded. Thresholds: <10 slow,
//  20-40 normal, 80+ instant.)
export async function getKeyUsageSummary(apiKey, { startDate, endDate } = {}) {
  if (!apiKey) return { items: [], totals: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, requests: 0, cost: 0, costNanoUsd: 0 }, peakTpm: 0, peakRpm: 0, peakTokS: 0 };
  const db = await getAdapter();
  // Union of legacy raw-key rows and post-005 apiKeyId rows — a key's summary
  // must include its whole history, never just one row shape.
  const keyFilter = usageKeyCond(db, apiKey);
  const conds = [keyFilter.cond];
  const params = [...keyFilter.params];
  if (startDate) { conds.push("timestamp >= ?"); params.push(new Date(startDate).toISOString()); }
  if (endDate) { conds.push("timestamp <= ?"); params.push(new Date(endDate).toISOString()); }
  const where = `WHERE ${conds.join(" AND ")}`;

  const rows = db.all(
    `SELECT model, timestamp, promptTokens, completionTokens, cost, costNanoUsd, tokens, meta FROM usageHistory ${where} ORDER BY timestamp ASC`,
    params
  );

  const byModel = {};
  const totals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, requests: 0, cost: 0, costNanoUsd: 0 };

  // Peak buckets: per-minute tokens (TPM), per-minute requests (RPM), and the
  // per-request generation-speed peak (Tok/s = output / generation_seconds).
  const perMinuteTok = {};
  const perMinuteReq = {};
  let peakTokS = 0;
  for (const r of rows) {
    const t = parseJson(r.tokens, {}) || {};
    const prompt = r.promptTokens ?? t.prompt_tokens ?? t.input_tokens ?? 0;
    const completion = r.completionTokens ?? t.completion_tokens ?? t.output_tokens ?? 0;
    const cacheRead = t.cached_tokens ?? t.cache_read_input_tokens ?? t.prompt_tokens_details?.cached_tokens ?? 0;
    const cacheCreation = t.cache_creation_input_tokens ?? 0;
    const tokSum = prompt + completion;

    // Group by the combo the caller asked for (requestedModel) when present, so the
    // By-Model summary on /usage lists combos (mygpt, testcombo) rather than the
    // internal pool/fallback model the proxy resolved to (glm-5.3:pre). Older rows
    // without requestedModel fall back to the resolved model — their cost is still
    // attributed, just under the pool-model label.
    const meta = parseJson(r.meta, {}) || {};
    const model = meta.requestedModel || r.model || "unknown";
    if (!byModel[model]) byModel[model] = { model, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, requests: 0, cost: 0, costNanoUsd: 0 };
    const m = byModel[model];
    m.input += prompt;
    m.output += completion;
    m.cacheRead += cacheRead;
    m.cacheCreation += cacheCreation;
    m.requests += 1;
    addCostTo(m, rowCostNano(r.costNanoUsd, r.cost));

    totals.input += prompt;
    totals.output += completion;
    totals.cacheRead += cacheRead;
    totals.cacheCreation += cacheCreation;
    totals.requests += 1;
    addCostTo(totals, rowCostNano(r.costNanoUsd, r.cost));

    const ts = r.timestamp || "";
    const minute = ts.slice(0, 16); // YYYY-MM-DDTHH:MM
    if (minute) {
      perMinuteTok[minute] = (perMinuteTok[minute] || 0) + tokSum;
      perMinuteReq[minute] = (perMinuteReq[minute] || 0) + 1;
    }

    // Peak Tok/s = the FASTEST single request's generation speed
    // (output / generation_seconds), matching the Tok/s column on /usage.
    // Previously this was a per-second AGGREGATE (sum of output tokens across
    // concurrent requests in the same wall-clock second) — a throughput bucket,
    // not a speed — which returned values like 5,970 that didn't match any
    // single request in the column (column max ~143). Admins expect Peak Tok/s
    // to be the highest per-request generation speed.
    const latencyMs = meta?.latencyMs;
    if (latencyMs && latencyMs > 0 && completion > 0) {
      const tokS = completion / (latencyMs / 1000);
      if (tokS > peakTokS) peakTokS = tokS;
    }
  }
  // Round to 1 decimal to match /usage history column Tok/s formatting.
  peakTokS = Math.round(peakTokS * 10) / 10;
  let peakTpm = 0;
  for (const v of Object.values(perMinuteTok)) if (v > peakTpm) peakTpm = v;
  let peakRpm = 0;
  for (const v of Object.values(perMinuteReq)) if (v > peakRpm) peakRpm = v;

  const items = Object.values(byModel).sort((a, b) => (b.requests || 0) - (a.requests || 0));
  return { items, totals, peakTpm, peakRpm, peakTokS };
}

// ── Per-provider usage summary (admin Providers tab) ──────────────────────
// Aggregates usageHistory in [startDate, endDate] grouped by provider, with the
// same peak RPM/TPM/Tok-s metrics as getKeyUsageSummary but per-provider instead
// of per-key. Returns items keyed by provider id.
export async function getProviderUsageSummary({ startDate, endDate } = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];
  if (startDate) { conds.push("timestamp >= ?"); params.push(new Date(startDate).toISOString()); }
  if (endDate) { conds.push("timestamp <= ?"); params.push(new Date(endDate).toISOString()); }
  // "platform" rows are key-holder denials (RPM/TPM/budget) recorded by the proxy —
  // not real upstream provider usage. Exclude them from the provider table.
  conds.push("COALESCE(provider, '') != 'platform'");
  const where = `WHERE ${conds.join(" AND ")}`;

  const rows = db.all(
    `SELECT provider, timestamp, promptTokens, completionTokens, cost, costNanoUsd, tokens, meta FROM usageHistory ${where} ORDER BY timestamp ASC`,
    params
  );

  const byProvider = {};
  const totals = { input: 0, output: 0, requests: 0, cost: 0, costNanoUsd: 0 };

  for (const r of rows) {
    const t = parseJson(r.tokens, {}) || {};
    const prompt = r.promptTokens ?? t.prompt_tokens ?? t.input_tokens ?? 0;
    const completion = r.completionTokens ?? t.completion_tokens ?? t.output_tokens ?? 0;
    const tokSum = prompt + completion;
    const provider = r.provider || "unknown";

    if (!byProvider[provider]) byProvider[provider] = { provider, input: 0, output: 0, requests: 0, cost: 0, costNanoUsd: 0, _minTok: {}, _minReq: {}, _peakTokS: 0 };
    const p = byProvider[provider];
    p.input += prompt;
    p.output += completion;
    p.requests += 1;
    addCostTo(p, rowCostNano(r.costNanoUsd, r.cost));

    totals.input += prompt;
    totals.output += completion;
    totals.requests += 1;
    addCostTo(totals, rowCostNano(r.costNanoUsd, r.cost));

    const ts = r.timestamp || "";
    const minute = ts.slice(0, 16);
    if (minute) {
      p._minTok[minute] = (p._minTok[minute] || 0) + tokSum;
      p._minReq[minute] = (p._minReq[minute] || 0) + 1;
    }

    // Peak Tok/s = fastest single request's generation speed (output/generation_s).
    // See getKeyUsageSummary above for the rationale (matches /usage column).
    const meta = parseJson(r.meta, {}) || {};
    const latencyMs = meta?.latencyMs;
    if (latencyMs && latencyMs > 0 && completion > 0) {
      const tokS = completion / (latencyMs / 1000);
      if (tokS > p._peakTokS) p._peakTokS = tokS;
    }
  }

  const items = Object.values(byProvider).map((p) => {
    let peakTpm = 0, peakRpm = 0, peakTokS = 0;
    for (const v of Object.values(p._minTok)) if (v > peakTpm) peakTpm = v;
    for (const v of Object.values(p._minReq)) if (v > peakRpm) peakRpm = v;
    peakTokS = Math.round((p._peakTokS || 0) * 10) / 10;
    const { provider, input, output, requests, cost, costNanoUsd } = p;
    return { provider, input, output, requests, cost, costNanoUsd, peakTpm, peakRpm, peakTokS };
  }).sort((a, b) => (b.requests || 0) - (a.requests || 0));

  return { items, totals };
}


// All read from usageHistory with the idx_uh_apikey_ts index.

// Count requests and sum tokens for an apiKey in the last `windowMs` ms.
// Returns { requests, tokens }.
export async function getKeyRateUsage(apiKey, windowMs = 60000) {
  const db = await getAdapter();
  const since = new Date(Date.now() - windowMs).toISOString();
  // Both row shapes count: legacy rows match on the raw key, new rows on apiKeyId.
  const keyFilter = usageKeyCond(db, apiKey);
  const row = db.get(
    `SELECT COUNT(*) as requests, COALESCE(SUM(COALESCE(promptTokens,0) + COALESCE(completionTokens,0)),0) as tokens
     FROM usageHistory WHERE ${keyFilter.cond} AND timestamp >= ?`,
    [...keyFilter.params, since],
  );
  return {
    requests: row?.requests ?? 0,
    tokens: row?.tokens ?? 0,
  };
}

// Live per-provider request count + token sum over the last `windowMs` ms
// (rolling window, default 60s → live RPM/TPM). Mirrors getKeyRateUsage but
// grouped by provider, and excludes 'platform' denials (not real upstream use).
// Returns a Map<provider, { requests, tokens }>.
export async function getProviderRateUsage(windowMs = 60000) {
  const db = await getAdapter();
  const since = new Date(Date.now() - windowMs).toISOString();
  const rows = db.all(
    `SELECT provider,
            COUNT(*) as requests,
            COALESCE(SUM(COALESCE(promptTokens,0) + COALESCE(completionTokens,0)),0) as tokens
     FROM usageHistory
     WHERE timestamp >= ? AND COALESCE(provider, '') != 'platform'
     GROUP BY provider`,
    [since],
  );
  const out = {};
  for (const r of rows) {
    out[r.provider || "unknown"] = {
      requests: r.requests ?? 0,
      tokens: r.tokens ?? 0,
    };
  }
  return out;
}

/**
 * Requests and tokens over the last `windowMs` across EVERY key owned by a user
 * (design D7).
 *
 * Customer RPM/TPM are per customer, not per key: creating a second key must not
 * hand out a second allowance. The join is over `apiKeys.userId`, so a key created
 * after this request is counted from its first use, and a deleted key's historical
 * rows stop counting (which is what "the customer's current traffic" means).
 * idx_uh_apikeyid_ts covers the per-key side of the join.
 *
 * @returns {{ requests: number, tokens: number }}
 */
export async function getUserRateUsage(userId, windowMs = 60000) {
  if (!userId) return { requests: 0, tokens: 0 };
  const db = await getAdapter();
  const since = new Date(Date.now() - windowMs).toISOString();
  const row = db.get(
    `SELECT COUNT(*) AS requests,
            COALESCE(SUM(COALESCE(promptTokens, 0) + COALESCE(completionTokens, 0)), 0) AS tokens
       FROM usageHistory
      WHERE apiKeyId IN (SELECT id FROM apiKeys WHERE userId = ?)
        AND timestamp >= ?`,
    [userId, since]
  );
  return { requests: row?.requests ?? 0, tokens: row?.tokens ?? 0 };
}

/**
 * Oldest usage timestamp in the rolling window across every key of a user — the
 * TPM wait-loop sleeps until that request falls out of the minute.
 */
export async function getUserOldestTokenAt(userId, windowMs = 60000) {
  if (!userId) return null;
  const db = await getAdapter();
  const since = new Date(Date.now() - windowMs).toISOString();
  const row = db.get(
    `SELECT MIN(timestamp) AS oldest
       FROM usageHistory
      WHERE apiKeyId IN (SELECT id FROM apiKeys WHERE userId = ?)
        AND timestamp >= ?`,
    [userId, since]
  );
  return row?.oldest ?? null;
}

// Timestamp (ISO) of the oldest usage row in the rolling window for an apiKey.
// Used by keyEnforcement's TPM wait-loop to compute how long until the oldest
// token request falls out of the 60s window and frees up room — so a request
// that's over TPM can sleep until just after that expiry rather than polling
// blindly. Returns null when there are no rows in the window.
export async function getKeyOldestTokenAt(apiKey, windowMs = 60000) {
  const db = await getAdapter();
  const since = new Date(Date.now() - windowMs).toISOString();
  const keyFilter = usageKeyCond(db, apiKey);
  const row = db.get(
    `SELECT MIN(timestamp) as oldest
     FROM usageHistory WHERE ${keyFilter.cond} AND timestamp >= ?`,
    [...keyFilter.params, since],
  );
  return row?.oldest ?? null;
}

// Per-row integer nanoUSD expression. `costNanoUsd` is authoritative; rows that
// never got it (legacy JSON import path, which only writes the float `cost`)
// fall back to their rounded float. Per-row rounding keeps the SUM integral.
const COST_NANO_EXPR = `(COALESCE(costNanoUsd, 0) + CASE WHEN COALESCE(costNanoUsd, 0) = 0 THEN CAST(ROUND(COALESCE(cost, 0) * 1000000000) AS INTEGER) ELSE 0 END)`;

// Sum cost for an apiKey since a given ISO timestamp as integer nanoUSD.
// Budget enforcement uses this: integer math means 500 × 6_000_000 nano sums to
// exactly 3_000_000_000 instead of drifting through float addition.
export async function getKeyCostSinceNano(apiKey, sinceIso) {
  const db = await getAdapter();
  const keyFilter = usageKeyCond(db, apiKey);
  const row = db.get(
    `SELECT COALESCE(SUM(${COST_NANO_EXPR}),0) as total FROM usageHistory WHERE ${keyFilter.cond} AND timestamp >= ?`,
    [...keyFilter.params, sinceIso],
  );
  return Math.round(row?.total ?? 0);
}

// Sum cost for an apiKey since a given ISO timestamp, as a legacy USD float.
// Kept for the read routes that still display dollars; new money paths should
// use getKeyCostSinceNano.
export async function getKeyCostSince(apiKey, sinceIso) {
  return nanoToUsd(await getKeyCostSinceNano(apiKey, sinceIso));
}

/**
 * Cost per model, for one user, since a given instant. One query for every
 * model, so metering a request does not issue a lookup per configured limit.
 *
 * Mirrors how the charge path attributes a row: post-005 rows carry apiKeyId
 * and belong to a tenant through apiKeys.userId; legacy rows only have the raw
 * key. Both are counted so a plan limit cannot be bypassed by using an old key.
 *
 * @returns {Promise<Map<string, number>>} model id -> integer nanoUSD spent
 */
export async function getModelCostSinceNano(userId, sinceIso) {
  const db = await getAdapter();
  if (!userId) return new Map();
  const rows = db.all(
    `SELECT COALESCE(uh.model, '') AS model,
            COALESCE(SUM(${COST_NANO_EXPR}), 0) AS total
       FROM usageHistory uh
       LEFT JOIN apiKeys ak ON ak.id = uh.apiKeyId
      WHERE (ak.userId = ? OR uh.apiKey IN (SELECT key FROM apiKeys WHERE userId = ?))
        AND uh.timestamp >= ?
      GROUP BY COALESCE(uh.model, '')`,
    [userId, userId, sinceIso]
  );
  const out = new Map();
  for (const r of rows) out.set(r.model, Math.round(Number(r.total) || 0));
  return out;
}

// Sum cost over an arbitrary usageHistory filter, as integer nanoUSD.
// Supported filter keys: provider, model, apiKey, startDate, endDate.
export async function getUsageCostTotalNano(filter = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];
  if (filter.provider) { conds.push("provider = ?"); params.push(filter.provider); }
  if (filter.model) { conds.push("model = ?"); params.push(filter.model); }
  if (filter.apiKey) {
    // Union of legacy raw-key rows and post-005 apiKeyId rows.
    const keyFilter = usageKeyCond(db, filter.apiKey);
    conds.push(keyFilter.cond);
    params.push(...keyFilter.params);
  }
  if (filter.startDate) { conds.push("timestamp >= ?"); params.push(new Date(filter.startDate).toISOString()); }
  if (filter.endDate) { conds.push("timestamp <= ?"); params.push(new Date(filter.endDate).toISOString()); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const row = db.get(`SELECT COALESCE(SUM(${COST_NANO_EXPR}),0) as total FROM usageHistory ${where}`, params);
  return Math.round(row?.total ?? 0);
}

// Count requests for an apiKey since a given ISO timestamp (for window request count).
export async function getKeyRequestCountSince(apiKey, sinceIso) {
  const db = await getAdapter();
  const keyFilter = usageKeyCond(db, apiKey);
  const row = db.get(
    `SELECT COUNT(*) as c FROM usageHistory WHERE ${keyFilter.cond} AND timestamp >= ?`,
    [...keyFilter.params, sinceIso],
  );
  return row?.c ?? 0;
}

// Delete ALL stored history for one apiKey — both the usageHistory rows and the
// matching requestDetails rows (joined on apiKey). Used by the public /usage
// page "Clear history" button so a key holder can wipe their own request log.
// Returns { history, details } = rows removed. This does NOT touch the daily
// rollup (usageDaily) or lifetime counters — those are aggregate admin stats,
// not a per-key log, and scrubbing them would desync the dashboard.
export async function deleteKeyUsageHistory(apiKey) {
  if (!apiKey) return { history: 0, details: 0 };
  const db = await getAdapter();
  // Both row shapes must be removed, otherwise half a key's log would survive.
  const keyFilter = usageKeyCond(db, apiKey);
  let history = 0;
  let details = 0;
  db.transaction(() => {
    const h = db.run(`DELETE FROM usageHistory WHERE ${keyFilter.cond}`, keyFilter.params);
    history = h.changes || 0;
    // requestDetails has no apiKeyId column — only its raw-key rows exist.
    const d = db.run(`DELETE FROM requestDetails WHERE apiKey = ?`, [apiKey]);
    details = d.changes || 0;
    // Invalidate any in-memory stats snapshot so the next read recomputes.
    scheduleStatsEvent("update", 0);
  });
  return { history, details };
}

