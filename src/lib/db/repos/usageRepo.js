import { EventEmitter } from "events";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { getMeta, setMeta } from "../helpers/metaStore.js";
import { costFromTokensNano, costFromImagesNano, nanoToUsd } from "../../../shared/utils/money.js";
import { resolveApiKeyOwner } from "./billingRepo.js";
import { chargeSync, ratePlanIdSync } from "../../billing/planQueue.js";
import { applyRequestDiscountSync } from "../../billing/discounts.js";
import { evaluateCacheMissCandidate } from "../../billing/cacheMissDetection.js";
import { insertCacheMissDetectionSync } from "./cacheMissRepo.js";
import { hashApiKey } from "./apiKeysRepo.js";
import {
  scheduleRollup, planRollupRange, forEachRollupSlice, rollupEpoch, readProviderRollup, readProviderConnectionRollup, readKeyRollup, readOwnerPeakRollup,
  invalidateRollupFromSync, pruneRollupSync, sha256Hex, scheduleProviderLastTsBackfill, hourLastTsByProviderSync,
} from "./usageRollup.js";

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

// Accumulate one bucket's/day's vendor-cost sum + priced-request count into an aggregate
// (spec vendor-cost-pricing). Both fields are additive and NULL-free on every source
// object by the time they reach here (aggregateEntryToDay / addToCounter seed them at 0),
// so a day blob written before this feature existed simply contributes 0 of each — which
// is the correct fact (those requests really have no recorded vendor cost), not a guess.
function addVendorCostTo(acc, source) {
  acc.vendorCostNanoUsd = (acc.vendorCostNanoUsd || 0) + Math.round(source?.vendorCostNanoUsd || 0);
  acc.pricedRequests = (acc.pricedRequests || 0) + (source?.pricedRequests || 0);
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
  // Rolled hours go with the raw rows they summarise.
  pruneRollupSync(db, cutoff);
}

// ─── Maps keyed by names that come from outside ─────────────────────────────────
// Model names are sent by the client (a combo name, or anything a denied request asked
// for), so they can be "__proto__", "constructor", "toString"… On a plain object,
// `map[name]` then reads an inherited member and `map[name] = v` can replace the prototype
// or write onto Object.prototype for the whole process. Every such map is either created
// without a prototype (in-memory maps) or read and written through own-property helpers
// (maps parsed back from a stored JSON blob are plain objects).
const newMap = () => Object.create(null);
function ownGet(map, key) {
  return map != null && Object.hasOwn(map, key) ? map[key] : undefined;
}
function ownSet(map, key, value) {
  Object.defineProperty(map, key, { value, writable: true, enumerable: true, configurable: true });
  return value;
}

// In-memory state shared across Next.js modules
if (!global._pendingRequests) global._pendingRequests = { byModel: newMap(), byAccount: newMap() };
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

// `target` is a day-blob map, possibly parsed from JSON: own-property access only.
//
// vendorCostNanoUsd/pricedRequests (spec vendor-cost-pricing) are additive fields on
// these SAME existing buckets — unlike the separate `req` map (requested-model view),
// there is no parallel structure that can be entirely missing for a historical day, so
// no background rebuild is needed: a bucket written before vendor cost existed simply
// has no key for either field yet, which seeds at 0 below. That is not a guess — it is
// the true fact for those requests (spec "Historical requests have no vendor cost").
// Mixing historical (unpriced) and new (possibly priced) requests in the same bucket
// therefore always yields a correct pricedRequests <= requests, never an undercount of
// `requests` itself and never a fabricated vendor cost for a request that has none.
function addToCounter(target, key, values) {
  const c = ownGet(target, key)
    || ownSet(target, key, { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, costNanoUsd: 0, vendorCostNanoUsd: 0, pricedRequests: 0 });
  // Seed from the legacy float once, for rollup blobs written before nano existed.
  if (c.costNanoUsd == null) c.costNanoUsd = Math.round((c.cost || 0) * 1e9);
  if (c.vendorCostNanoUsd == null) c.vendorCostNanoUsd = 0;
  if (c.pricedRequests == null) c.pricedRequests = 0;
  c.requests += values.requests || 1;
  c.promptTokens += values.promptTokens || 0;
  c.completionTokens += values.completionTokens || 0;
  c.cachedTokens += values.cachedTokens || 0;
  // Integer accumulates; the float mirror is re-derived so it never drifts.
  c.costNanoUsd = (c.costNanoUsd || 0) + (values.costNanoUsd || 0);
  c.cost = nanoToUsd(c.costNanoUsd);
  c.vendorCostNanoUsd += values.vendorCostNanoUsd || 0;
  c.pricedRequests += values.pricedRequests || 0;
  if (values.meta) Object.assign(c, values.meta);
  return c;
}

function aggregateEntryToDay(day, entry) {
  const promptTokens = entry.tokens?.prompt_tokens || entry.tokens?.input_tokens || 0;
  const completionTokens = entry.tokens?.completion_tokens || entry.tokens?.output_tokens || 0;
  const cachedTokens = entry.tokens?.cached_tokens || entry.tokens?.cache_read_input_tokens || 0;
  // Integer nanoUSD is the authoritative day total; `cost` is re-derived from it
  // as the legacy float mirror so old dashboard readers keep working.
  const costNano = entry.costNanoUsd != null ? Math.round(entry.costNanoUsd) : Math.round((entry.cost || 0) * 1e9);
  // null when unpriced (no vendor-cost record matched) — pricedRequests says how many of
  // the summed requests contributed a real vendorCostNanoUsd, so "0 priced" never reads
  // as "priced at zero" (design.md decision #4).
  const vendorCostNanoUsd = entry.vendorCostNanoUsd != null ? Math.round(entry.vendorCostNanoUsd) : 0;
  const pricedRequests = entry.vendorCostNanoUsd != null ? 1 : 0;
  const vals = { promptTokens, completionTokens, cachedTokens, costNanoUsd: costNano, vendorCostNanoUsd, pricedRequests };

  // Seed from the legacy float once, for day blobs written before nano existed.
  if (day.costNanoUsd == null) day.costNanoUsd = Math.round((day.cost || 0) * 1e9);
  if (day.vendorCostNanoUsd == null) day.vendorCostNanoUsd = 0;
  if (day.pricedRequests == null) day.pricedRequests = 0;
  day.requests = (day.requests || 0) + 1;
  day.promptTokens = (day.promptTokens || 0) + promptTokens;
  day.completionTokens = (day.completionTokens || 0) + completionTokens;
  day.cachedTokens = (day.cachedTokens || 0) + cachedTokens;
  day.costNanoUsd = (day.costNanoUsd || 0) + costNano;
  day.cost = nanoToUsd(day.costNanoUsd);
  day.vendorCostNanoUsd += vendorCostNanoUsd;
  day.pricedRequests += pricedRequests;

  day.byProvider ||= newMap();
  day.byModel ||= newMap();
  day.byAccount ||= newMap();
  day.byApiKey ||= newMap();
  day.byEndpoint ||= newMap();

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

  // Requested-model maps (spec admin-usage-views): written only into a COMPLETE `req`.
  // A day whose `req` is not complete yet (the deploy day, older days) is rebuilt from
  // its raw rows by scheduleRequestedBackfill, which then counts this request itself —
  // writing it here as well would count it twice.
  if (day.req?.complete === true) {
    addRequestedGroup(day.req, {
      reqModel: entry.requestedModel || entry.model || "unknown",
      provider: entry.provider || null,
      connectionId: entry.connectionId || null,
      apiKeyId: entry.apiKeyId || null,
      apiKey: entry.apiKey && typeof entry.apiKey === "string" ? entry.apiKey : null,
      endpoint: entry.endpoint || null,
    }, vals);
  }
}

// ─── Requested-model day maps (`day.req`) ───────────────────────────────────────
// The admin Overview can group by the model the client asked for (a combo name) instead
// of the upstream model that answered. Each usageDaily blob therefore carries
//   req: { complete, byModel, byAccount, byApiKey, byEndpoint }
// keyed by the effective requested model (requestedModel, else model, else "unknown" —
// the rule usageRollup.js uses for the Users tab) with exactly the counter values of the
// upstream maps. Cost is only re-aggregated from the recorded cost; billing never reads
// these maps.

function emptyRequestedMaps() {
  return { complete: true, byModel: newMap(), byAccount: newMap(), byApiKey: newMap(), byEndpoint: newMap() };
}

// `target` is a counter (fixed keys); its `providers` map is keyed by provider id.
function tallyProvider(target, provider, n) {
  if (!provider) return;
  target.providers ||= newMap();
  ownSet(target.providers, provider, (ownGet(target.providers, provider) || 0) + n);
}

/**
 * Add `n` requests of one (requested model, provider, account, key, endpoint) group to a
 * `req` object. `vals` carries the summed counters of those requests (same shape as the
 * upstream maps' addToCounter values). Used by the per-request writer (n = 1) and by the
 * rebuild (n = the group's row count), so both produce identical maps.
 */
function addRequestedGroup(req, g, vals, n = 1) {
  req.byModel ||= newMap();
  req.byAccount ||= newMap();
  req.byApiKey ||= newMap();
  req.byEndpoint ||= newMap();
  const counted = { ...vals, requests: n };

  tallyProvider(addToCounter(req.byModel, g.reqModel, { ...counted, meta: { rawModel: g.reqModel } }), g.provider, n);

  if (g.connectionId) {
    const accKey = `${g.reqModel}|${g.connectionId}`;
    addToCounter(req.byAccount, accKey, { ...counted, meta: { rawModel: g.reqModel, provider: g.provider, connectionId: g.connectionId } });
  }

  // Same key identity as the upstream byApiKey map: the apiKeys id when known, else the
  // raw string of a key nothing else can attribute, else no key at all.
  const keyIdent = g.apiKeyId ? `id:${g.apiKeyId}` : (g.apiKey || "local-no-key");
  const akKey = `${keyIdent}|${g.reqModel}`;
  tallyProvider(
    addToCounter(req.byApiKey, akKey, { ...counted, meta: { rawModel: g.reqModel, apiKey: g.apiKeyId ? null : (g.apiKey || null), apiKeyId: g.apiKeyId || null } }),
    g.provider, n
  );

  const endpoint = g.endpoint || "Unknown";
  const epKey = `${endpoint}|${g.reqModel}`;
  tallyProvider(addToCounter(req.byEndpoint, epKey, { ...counted, meta: { endpoint, rawModel: g.reqModel } }), g.provider, n);
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

// Admin-only vendor (upstream) cost snapshot (spec vendor-cost-pricing), resolved beside
// the customer-facing cost above but from a completely separate price (vendorCostRepo),
// using the request's OWN timestamp so a later edit to the vendor-cost rate can never
// change a request already logged. Returns null (not 0) when no vendor-cost record
// matches — distinct from a known cost of zero — so every downstream sum can tell
// "no data" apart from "zero profit".
async function calculateVendorCostNanoForEntry(provider, model, tokens, imageCount, atIso) {
  try {
    const { calculateVendorCostNano } = await import("./vendorCostRepo.js");
    const atMs = atIso ? Date.parse(atIso) : Date.now();
    return await calculateVendorCostNano(provider, model, tokens, imageCount, Number.isFinite(atMs) ? atMs : Date.now());
  } catch (e) {
    console.error("[usageRepo] vendor cost snapshot failed:", e.message);
    return null;
  }
}

export function trackPendingRequest(model, provider, connectionId, started, error = false) {
  const modelKey = provider ? `${model} (${provider})` : model;
  const timerKey = `${connectionId}|${modelKey}`;

  // Own-property access: the model name may be anything (see ownGet / ownSet).
  const byModel = pendingRequests.byModel;
  const nextModel = Math.max(0, (ownGet(byModel, modelKey) || 0) + (started ? 1 : -1));
  if (nextModel === 0) delete byModel[modelKey];
  else ownSet(byModel, modelKey, nextModel);

  if (connectionId) {
    const perAccount = ownGet(pendingRequests.byAccount, connectionId) || ownSet(pendingRequests.byAccount, connectionId, newMap());
    const nextAccount = Math.max(0, (ownGet(perAccount, modelKey) || 0) + (started ? 1 : -1));
    if (nextAccount === 0) {
      delete perAccount[modelKey];
      if (Object.keys(perAccount).length === 0) delete pendingRequests.byAccount[connectionId];
    } else {
      ownSet(perAccount, modelKey, nextAccount);
    }
  }

  if (started) {
    clearTimeout(pendingTimers[timerKey]);
    pendingTimers[timerKey] = setTimeout(() => {
      delete pendingTimers[timerKey];
      if (ownGet(pendingRequests.byModel, modelKey) > 0) ownSet(pendingRequests.byModel, modelKey, 0);
      const perAccount = connectionId ? ownGet(pendingRequests.byAccount, connectionId) : undefined;
      if (ownGet(perAccount, modelKey) > 0) ownSet(perAccount, modelKey, 0);
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
  // `pending` is the in-memory in-flight counter, so a live view needs nothing else.
  return { activeRequests, recentRequests, errorProvider, pending: pendingRequests };
}

export async function saveRequestUsage(entry) {
  // Real credit actually taken for this one request, unlimited-plan parts left
  // out — set inside the transaction below when a charge happens; 0 covers every
  // path that never reaches it (no owner, dedup hit, zero-cost request).
  let chargedNanoUsd = 0;
  try {
    const db = await getAdapter();

    if (!entry.timestamp) entry.timestamp = new Date().toISOString();
    // Authoritative integer nanoUSD; legacy float `cost` is derived from it so
    // the two columns can never disagree.
    const imageCount = Number(entry.imageCount) > 0 ? Math.floor(Number(entry.imageCount)) : 0;
    if (imageCount > 0) entry.tokens = { ...(entry.tokens || {}), image_count: imageCount };
    entry.costNanoUsd = await calculateCostNano(entry.provider, entry.model, entry.tokens, entry.requestedModel, imageCount);
    entry.cost = nanoToUsd(entry.costNanoUsd);
    // Snapshot once, at this timestamp; never recomputed after insert (see
    // calculateVendorCostNanoForEntry). Entirely separate from the cost above —
    // never read by billing.
    entry.vendorCostNanoUsd = await calculateVendorCostNanoForEntry(entry.provider, entry.model, entry.tokens, imageCount, entry.timestamp);

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

    // Cache-miss detection candidate (spec cache-miss-refund), evaluated here because
    // pricing resolution is async — the transaction below only does the synchronous
    // INSERT, once the usageHistory row's id exists and the real charged amount (the
    // final cap) is known. `entry.promptText` is the provider-bound prompt text
    // (open-sse's promptTextForCache), threaded in by the chatCore handlers; admin/
    // local keys (no owner) are never candidates.
    let cacheMissCandidate = null;
    if (owner?.userId && apiKeyId && entry.promptText) {
      try {
        cacheMissCandidate = await evaluateCacheMissCandidate({
          apiKeyId,
          provider: entry.provider,
          model: entry.model,
          requestedModel: entry.requestedModel,
          promptText: entry.promptText,
          promptTokens,
          cacheReadTokens: tokens.cached_tokens || tokens.cache_read_input_tokens || tokens.prompt_tokens_details?.cached_tokens || 0,
          costNanoUsd: entry.costNanoUsd || 0,
        });
      } catch (e) {
        console.error("[cache-miss] detection failed (swallowed):", e?.message || e);
      }
    }

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

      // The plan a customer key is pinned to (null = any plan). Read by id, not from
      // the 60 s owner cache, so a change applies to the key's very next request. It
      // decides which plan's discounts apply, who is charged and whose RPM/TPM
      // allowance the request counts against.
      // A key deleted mid-request has no row left: its tombstone kept the pin.
      let keyPlanId = null;
      if (owner?.deleted) {
        keyPlanId = owner.planId ?? null;
      } else if (owner) {
        try {
          // The owner may come from the 60 s cache, filled before the key was
          // deleted: with the row gone, the tombstone still holds the pin.
          const keyRow = db.get(`SELECT planId FROM apiKeys WHERE id = ?`, [owner.apiKeyId])
            ?? db.get(`SELECT planId FROM deletedApiKeys WHERE apiKeyId = ?`, [owner.apiKeyId]);
          keyPlanId = keyRow?.planId ?? null;
        } catch (e) {
          console.error("[rates] could not read key plan", e.message);
        }
      }

      // Time-limited model discounts (spec model-discounts): the list cost computed
      // above is lowered here, in the same transaction that writes the row and the
      // charge, so the usage cost, the ledger and every report share one figure.
      // A failure must not discard recorded usage; it falls back to the list cost.
      const discountMeta = {};
      try {
        const discounted = applyRequestDiscountSync(db, {
          listCostNanoUsd: entry.costNanoUsd,
          at: entry.timestamp,
          requestedModel: entry.requestedModel,
          userId: owner?.userId ?? null,
          planId: keyPlanId ?? undefined,
        });
        if (discounted.discountBp > 0) {
          discountMeta.listCostNanoUsd = discounted.listCostNanoUsd;
          discountMeta.discountBp = discounted.discountBp;
          discountMeta.discountRuleIds = discounted.ruleIds;
          entry.listCostNanoUsd = discounted.listCostNanoUsd;
          entry.discountBp = discounted.discountBp;
          entry.costNanoUsd = discounted.costNanoUsd;
          entry.cost = nanoToUsd(entry.costNanoUsd);
        }
      } catch (e) {
        console.error("[discounts] could not apply, charging list price", e.message);
      }

      // Plan allowance this request counts against (RPM/TPM are per user and plan,
      // shared by all keys).
      let ratePlanId = null;
      if (owner) {
        try {
          // The unit decides which purchase pays, so the rate recorded is the one of
          // the plan that actually covers this request.
          ratePlanId = ratePlanIdSync(
            db,
            owner.userId,
            keyPlanId,
            entry.timestamp || null,
            imageCount > 0 ? "image" : "llm",
            // The combo the client called: a purchase that does not include it can
            // neither pay nor own this allowance (spec plan-model-access).
            entry.requestedModel || null
          );
        } catch (e) {
          console.error("[rates] could not resolve rate plan", e.message);
        }
      }

      // `apiKey` is the deprecated column: only a key with no owning apiKeys row
      // still needs its raw value to stay attributable. Tenant keys store their
      // apiKeyId and leave the secret out of the database entirely.
      const insertedUsage = db.run(
        `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, apiKeyId, userId, endpoint, promptTokens, completionTokens, cost, costNanoUsd, status, tokens, meta, ratePlanId, clientIp, vendorCostNanoUsd) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.timestamp, entry.provider || null, entry.model || null,
          entry.connectionId || null, apiKeyId ? null : entry.apiKey || null, apiKeyId,
          // The owner, kept on the row so statistics survive the key's deletion.
          owner?.userId ?? null,
          entry.endpoint || null,
          promptTokens, completionTokens, entry.cost || 0, entry.costNanoUsd || 0, entry.status || "ok",
          stringifyJson(tokens), stringifyJson({ requestedModel: entry.requestedModel || null, latencyMs: entry.latencyMs ?? null, ...(Number.isFinite(entry.ttftMs) ? { ttftMs: entry.ttftMs } : {}), ...(entry.estimated === true ? { estimated: true } : {}), ...(entry.cacheEstimated === true ? { cacheEstimated: true } : {}), ...discountMeta }),
          ratePlanId,
          // Spec activity-ip-log: the trusted client IP of the API request, or null.
          typeof entry.clientIp === "string" && entry.clientIp ? entry.clientIp.slice(0, 64) : null,
          Number.isFinite(entry.vendorCostNanoUsd) ? Math.round(entry.vendorCostNanoUsd) : null,
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
          const charge = chargeSync(db, {
            userId: owner.userId,
            apiKeyId: owner.apiKeyId,
            usageId: insertedUsage.lastInsertRowid,
            requestKey: "usage:" + insertedUsage.lastInsertRowid,
            costNanoUsd: entry.costNanoUsd || 0,
            // An image request is billed in images by an image purchase; whatever
            // it cannot cover falls back to the dollar cost on a credit purchase.
            imageCount,
            nowIso: entry.timestamp || new Date().toISOString(),
            planId: keyPlanId,
            // Same filter as admission: a purchase that does not include the model
            // the client asked for must never be billed for it.
            model: entry.requestedModel || null,
          });
          // Real money taken from a real balance — an unlimited plan's own part is
          // left out, same exclusion tokenStats.js applies by reading
          // creditLedger's meta.unlimited; this is that same fact read straight off
          // the part chargeSync just computed, not re-derived from the ledger.
          chargedNanoUsd = (charge?.parts || [])
            .filter((p) => p.amountNanoUsd != null && !p.unlimited)
            .reduce((sum, p) => sum + p.amountNanoUsd, 0);
        } catch (e) {
          console.error("[billing] charge failed", e.message);
        }
      }

      // Cache-miss detection row (spec cache-miss-refund), finalized against the REAL
      // charge: a request fully covered by an unlimited plan took no real money, so
      // chargedNanoUsd is 0 and nothing is recorded — there is nothing to refund.
      // `usageHistoryId UNIQUE` is the idempotency guard against ever double-recording.
      if (cacheMissCandidate && chargedNanoUsd > 0) {
        const refundNanoUsd = Math.min(cacheMissCandidate.refundNanoUsd, chargedNanoUsd);
        if (refundNanoUsd > 0) {
          insertCacheMissDetectionSync(db, {
            usageHistoryId: insertedUsage.lastInsertRowid,
            userId: owner.userId,
            apiKeyId,
            provider: entry.provider || null,
            model: entry.model || null,
            requestedModel: entry.requestedModel || null,
            overlapTokens: cacheMissCandidate.overlapTokens,
            refundNanoUsd,
            detectedAt: entry.timestamp,
          });
        }
      }

      const dateKey = getLocalDateKey(entry.timestamp);
      const row = db.get(`SELECT data FROM usageDaily WHERE dateKey = ?`, [dateKey]);
      // A day created by this write has every one of its requests counted here, so its
      // requested-model maps start complete. An existing day without a complete `req`
      // gets only its upstream maps updated; the rebuild fills `req` (design D2).
      const day = row ? parseJson(row.data, {}) : {
        requests: 0, promptTokens: 0, completionTokens: 0, cost: 0, costNanoUsd: 0,
        byProvider: newMap(), byModel: newMap(), byAccount: newMap(), byApiKey: newMap(), byEndpoint: newMap(),
        req: emptyRequestedMaps(),
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

    return { costNanoUsd: entry.costNanoUsd || 0, chargedNanoUsd, vendorCostNanoUsd: entry.vendorCostNanoUsd ?? null };
  } catch (e) {
    console.error("Failed to save usage stats:", e);
    return { costNanoUsd: 0, chargedNanoUsd: 0, vendorCostNanoUsd: null };
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
  const rows = db.all(`SELECT id, timestamp, provider, model, connectionId, apiKey, endpoint, cost, costNanoUsd, status, tokens, meta FROM usageHistory ${where} ORDER BY id ASC`, params);

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
      // usageHistory.id — lets a caller (e.g. the account usage page) join this row
      // against `cacheMissDetections.usageHistoryId` for the cache-miss indicator
      // (spec cache-miss-refund "Customer visibility").
      usageHistoryId: r.id,
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

// ─── Time-sliced scans ──────────────────────────────────────────────────────────
// better-sqlite3 is synchronous, so one `db.all` over a month of usageHistory (millions
// of rows on a busy installation) plus a JS loop over it holds the event loop for
// seconds: the proxy, the dashboard and every other API stall with it. The dashboard
// summaries therefore read the range in short slices (indexed on timestamp) and yield
// to the event loop between them. The work done is the same, but no single turn of the
// loop lasts longer than one slice.
const USAGE_SLICE_MS = 3 * 60 * 60 * 1000;
// How far back getUsageStats refines a bucket's lastUsed from a date to a timestamp.
const OVERLAY_PRECISE_MS = 48 * 60 * 60 * 1000;
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

function parseRangeBound(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new RangeError(`Invalid date: ${value}`);
  return d.getTime();
}

/**
 * Run `select` over [startDate, endDate] one slice at a time, oldest first, handing
 * each slice's rows to `onRows` (synchronous) and yielding between slices. `select`
 * is the SELECT ... FROM usageHistory part with no WHERE; `conds` are extra
 * predicates; `tail` is what follows the WHERE (GROUP BY / ORDER BY). A GROUP BY here
 * is per slice, so the caller must merge groups that recur across slices. An invalid date throws RangeError before anything is read.
 */
async function forEachUsageSlice(db, { startDate, endDate, conds = [], select, tail = "", sliceMs = USAGE_SLICE_MS }, onRows) {
  const requestedStart = parseRangeBound(startDate);
  const endMs = parseRangeBound(endDate);
  // The range is clamped to the rows that exist, so an explicit far-away date (a year 2000
  // start, a year 9999 end) costs a handful of slices instead of one per 3 hours of it.
  const bounds = db.get(`SELECT MIN(timestamp) AS lo, MAX(timestamp) AS hi FROM usageHistory`);
  const loMs = bounds?.lo ? new Date(bounds.lo).getTime() : NaN;
  const hiMs = bounds?.hi ? new Date(bounds.hi).getTime() : NaN;
  if (!Number.isFinite(loMs) || !Number.isFinite(hiMs)) return;
  const startMs = Math.max(requestedStart ?? loMs, loMs);
  const horizonMs = Math.min(endMs ?? Infinity, hiMs);
  if (startMs > horizonMs) return;
  for (let from = startMs; ; from += sliceMs) {
    const to = from + sliceMs;
    // The last slice has no upper bound when no end date was given, so a row stamped a
    // little in the future is still counted, exactly as the single query did.
    const isLast = to > horizonMs;
    const where = ["timestamp >= ?"];
    const params = [new Date(from).toISOString()];
    if (!isLast) { where.push("timestamp < ?"); params.push(new Date(to).toISOString()); }
    else if (endMs != null) { where.push("timestamp <= ?"); params.push(new Date(endMs).toISOString()); }
    where.push(...conds);
    onRows(db.all(`${select} WHERE ${where.join(" AND ")} ${tail}`, params));
    if (isLast) break;
    await yieldToLoop();
  }
}

// ─── Requested-model rebuild (design D3) ────────────────────────────────────────
// Days recorded before `day.req` existed (or the deploy day, whose blob predates it) are
// rebuilt from their raw usageHistory rows, in the background and in slices:
//   1. snapshot MAX(id);
//   2. scan the day's rows with id <= snapshot, slice by slice, grouping inside SQLite;
//   3. in ONE synchronous transaction: re-read the blob, stop if `req` is already complete
//      (another loop or an earlier run finished it), add the rows with id > snapshot
//      written during the scan, and store `req` as complete.
// The writer never touches an incomplete `req` (aggregateEntryToDay), so every row of the
// day is counted exactly once: by the scan, by the delta, or — after completion — by the
// writer. Only days whose raw rows are all still kept are rebuilt; older days keep using
// their upstream maps in the requested view.

const DAY_MS = 24 * 60 * 60 * 1000;
const REQ_META_JSON = "CASE WHEN json_valid(meta) THEN meta END";
const REQ_TOKENS_JSON = "CASE WHEN json_valid(tokens) THEN tokens END";
// The effective requested model; same rule as usageRollup.js and aggregateEntryToDay.
const REQ_MODEL_SQL = `COALESCE(NULLIF(json_extract(${REQ_META_JSON}, '$.requestedModel'), ''), NULLIF(model, ''), 'unknown')`;
// Group sums mirroring aggregateEntryToDay exactly: JS `a || b || 0`, so a 0 or a missing
// value falls through to the next field; cost is the recorded integer, else the legacy float.
const REQ_GROUP_SELECT = `SELECT ${REQ_MODEL_SQL} AS rm, provider, connectionId, apiKey, apiKeyId, endpoint,
        COUNT(*) AS n,
        SUM(COALESCE(NULLIF(json_extract(${REQ_TOKENS_JSON}, '$.prompt_tokens'), 0),
                     NULLIF(json_extract(${REQ_TOKENS_JSON}, '$.input_tokens'), 0), 0)) AS pt,
        SUM(COALESCE(NULLIF(json_extract(${REQ_TOKENS_JSON}, '$.completion_tokens'), 0),
                     NULLIF(json_extract(${REQ_TOKENS_JSON}, '$.output_tokens'), 0), 0)) AS ct,
        SUM(COALESCE(NULLIF(json_extract(${REQ_TOKENS_JSON}, '$.cached_tokens'), 0),
                     NULLIF(json_extract(${REQ_TOKENS_JSON}, '$.cache_read_input_tokens'), 0), 0)) AS cached,
        SUM(CASE WHEN COALESCE(costNanoUsd, 0) != 0 THEN ROUND(costNanoUsd)
                 ELSE ROUND(COALESCE(cost, 0) * 1e9) END) AS costNano,
        SUM(COALESCE(vendorCostNanoUsd, 0)) AS vendorCostNano,
        SUM(CASE WHEN vendorCostNanoUsd IS NOT NULL THEN 1 ELSE 0 END) AS priced
   FROM usageHistory`;
const REQ_GROUP_TAIL = "GROUP BY rm, provider, connectionId, apiKey, apiKeyId, endpoint";

function emptyRequestedAccumulator() {
  return { byModel: newMap(), byAccount: newMap(), byApiKey: newMap(), byEndpoint: newMap() };
}

function addRequestedRows(req, rows) {
  for (const r of rows) {
    addRequestedGroup(req, {
      reqModel: r.rm,
      provider: r.provider || null,
      connectionId: r.connectionId || null,
      apiKeyId: r.apiKeyId || null,
      apiKey: r.apiKey || null,
      endpoint: r.endpoint || null,
    }, {
      // Token sums exactly as the writer adds them (it never rounds a token count, even a
      // fractional one); cost is an integer per row on both sides already.
      promptTokens: r.pt || 0,
      completionTokens: r.ct || 0,
      cachedTokens: r.cached || 0,
      costNanoUsd: Math.round(r.costNano || 0),
      vendorCostNanoUsd: Math.round(r.vendorCostNano || 0),
      pricedRequests: r.priced || 0,
    }, r.n);
  }
}

/** [start, end] (ms, end inclusive) of a local "YYYY-MM-DD" day — the key getLocalDateKey writes. */
function localDayBounds(dateKey) {
  const [y, m, d] = String(dateKey).split("-").map(Number);
  const startMs = new Date(y, m - 1, d).getTime();
  const nextMs = new Date(y, m - 1, d + 1).getTime();
  return { startMs, endMs: nextMs - 1 };
}

const retentionCutoffMs = (nowMs) => nowMs - LOG_RETENTION_DAYS * DAY_MS;

/**
 * Days whose `req` is neither complete nor known to be unrecoverable, and whose raw rows
 * are all still kept by retention, newest first. The extra day of margin covers the
 * probabilistic prune moving the cut-off while the rebuild runs.
 */
export function listRequestedPendingDaysSync(db, nowMs = Date.now()) {
  const minStartMs = retentionCutoffMs(nowMs) + DAY_MS;
  // dateKey prefilter first, so only the days in retention have their blob parsed.
  const rows = db.all(
    `SELECT dateKey FROM usageDaily
      WHERE dateKey >= ?
        AND COALESCE(json_extract(CASE WHEN json_valid(data) THEN data END, '$.req.complete'), 0) != 1
        AND COALESCE(json_extract(CASE WHEN json_valid(data) THEN data END, '$.req.unrecoverable'), 0) != 1
      ORDER BY dateKey DESC`,
    [getLocalDateKey(minStartMs)]
  );
  return rows.map((r) => r.dateKey).filter((key) => {
    const { startMs } = localDayBounds(key);
    return Number.isFinite(startMs) && startMs >= minStartMs;
  });
}

/** Steps 1–2: snapshot MAX(id) and aggregate the day's rows up to it, slice by slice. */
export async function scanRequestedDay(db, dateKey, { sliceMs } = {}) {
  const { startMs, endMs } = localDayBounds(dateKey);
  if (!Number.isFinite(startMs)) throw new RangeError(`Invalid day: ${dateKey}`);
  const maxRow = db.get(`SELECT MAX(id) AS m FROM usageHistory`);
  const maxId = Number.isSafeInteger(maxRow?.m) ? maxRow.m : 0;
  const req = emptyRequestedAccumulator();
  await forEachUsageSlice(db, {
    startDate: new Date(startMs).toISOString(),
    endDate: new Date(endMs).toISOString(),
    // An integer read from the database above, inlined because the slice conds take no params.
    conds: [`id <= ${maxId}`],
    select: REQ_GROUP_SELECT,
    tail: REQ_GROUP_TAIL,
    ...(sliceMs ? { sliceMs } : {}),
  }, (rows) => addRequestedRows(req, rows));
  return { dateKey, maxId, req };
}

// The day totals a rebuilt `req` must reproduce. Every row adds to exactly one byModel
// counter, so the byModel sums are the rows counted. Cost is not compared: blobs written
// before integer cost existed seeded `costNanoUsd` from a rounded float total, so their
// integer can differ from the sum of the rows without any row missing; the request count
// already moves when a row is missing.
const RECONCILED_FIELDS = ["requests", "promptTokens", "completionTokens", "cachedTokens"];

function countedTotals(req) {
  const out = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
  for (const c of Object.values(req.byModel || {})) {
    for (const f of RECONCILED_FIELDS) out[f] += c[f] || 0;
  }
  return out;
}

/**
 * Step 3, synchronous: completes the day's `req` from a scan plus the rows written since
 * its snapshot. Returns
 *   "complete"          this call completed the day;
 *   "unrecoverable"     the raw rows no longer add up to the day's upstream totals (part of
 *                       them was deleted — a customer's "Clear history", the legacy import,
 *                       a time-zone change); the day is marked so and keeps its upstream
 *                       maps in the requested view, and is never scanned again;
 *   "already"           the day was already complete or marked unrecoverable;
 *   "no-day"            there is no blob for the day;
 *   "out-of-retention"  the day fell behind the retention cut-off (rows may be pruned).
 */
export function commitRequestedDaySync(db, scan, nowMs = Date.now()) {
  const { startMs, endMs } = localDayBounds(scan.dateKey);
  // The prune deletes rows older than its own cut-off, which is never later than ours: a
  // day starting at or after our cut-off has not lost a single row to the prune.
  if (!(startMs >= retentionCutoffMs(nowMs))) return "out-of-retention";
  let status = "no-day";
  db.transaction(() => {
    const row = db.get(`SELECT data FROM usageDaily WHERE dateKey = ?`, [scan.dateKey]);
    if (!row) return;
    const day = parseJson(row.data, null);
    if (!day || typeof day !== "object") return;
    if (day.req?.complete === true || day.req?.unrecoverable === true) {
      status = "already";
      return;
    }
    // A copy: the same scan must never be merged twice into one object.
    const req = JSON.parse(JSON.stringify(scan.req));
    const delta = db.all(
      `${REQ_GROUP_SELECT} WHERE timestamp >= ? AND timestamp <= ? AND id > ? ${REQ_GROUP_TAIL}`,
      [new Date(startMs).toISOString(), new Date(endMs).toISOString(), scan.maxId]
    );
    addRequestedRows(req, delta);

    // Rows other than the prune's can disappear (a wipe) or never have existed (an import):
    // a `req` that does not add up to the day's totals would undercount silently.
    const counted = countedTotals(req);
    // Requests are integers and must match exactly. Token sums are compared within the
    // rounding error of adding n doubles, n × 2^-52 × |total| per side (so twice that), with
    // a tiny floor: a fractional count (3.5) is summed by SQLite here and by JS in the writer,
    // possibly in a different order. Integer sums below 2^53 are exact on both sides, so an
    // integer-only day matches exactly and any real difference (≥ 1 token) is far above it.
    const rows = Math.max(1, counted.requests, day.requests || 0);
    const tolerance = (total) => Math.max(1e-9, 2 * rows * Number.EPSILON * Math.abs(total));
    const differs = (f) => (f === "requests"
      ? counted[f] !== (day[f] || 0)
      : Math.abs(counted[f] - (day[f] || 0)) > tolerance(day[f] || 0));
    const mismatch = RECONCILED_FIELDS.filter(differs);
    if (mismatch.length > 0) {
      day.req = {
        complete: false,
        unrecoverable: true,
        at: new Date(nowMs).toISOString(),
        counted: counted.requests,
        expected: day.requests || 0,
      };
      status = "unrecoverable";
    } else {
      day.req = { complete: true, ...req };
      status = "complete";
    }
    db.run(`UPDATE usageDaily SET data = ? WHERE dateKey = ?`, [stringifyJson(day), scan.dateKey]);
  });
  return status;
}

/** Rebuild one day's `req` (scan + commit); returns the commit status. */
export async function rebuildRequestedDay(db, dateKey, { now = Date.now, sliceMs } = {}) {
  const scan = await scanRequestedDay(db, dateKey, { sliceMs });
  return commitRequestedDaySync(db, scan, now());
}

function requestedBackfillState() {
  if (!globalThis.__usageRequestedBackfill) {
    globalThis.__usageRequestedBackfill = { running: null, pendingDays: 0, generation: 0, started: false, allDone: false };
  }
  return globalThis.__usageRequestedBackfill;
}

/**
 * Progress of the requested-model rebuild, for the Overview's "recalculating" note.
 * `generation` grows each time a day is resolved (completed or found unrecoverable), so a
 * cache of requested figures can key on it and never serve figures from before a change.
 */
export function getRequestedBackfillProgress() {
  const state = requestedBackfillState();
  return { running: Boolean(state.running) && state.pendingDays > 0, pendingDays: state.pendingDays, generation: state.generation };
}

/**
 * Forget that every day is resolved, so the next trigger lists the pending days again.
 * Only needed after writing a day blob without a complete `req` outside the request
 * writer (which always creates complete days): an import, or a test.
 */
export function invalidateRequestedBackfill() {
  requestedBackfillState().allDone = false;
}

/**
 * Rebuild every pending day in the background, newest first, one slice per turn of the
 * event loop. One loop per process; calling again while it runs returns the same promise.
 * A failing day logs one line and stays incomplete; the next trigger retries it. Once a
 * loop has resolved every day, later triggers return at once without listing the days
 * again: the writer only ever creates complete days, so none can become pending.
 */
export function scheduleRequestedBackfill(db, { now = Date.now, sliceMs } = {}) {
  const state = requestedBackfillState();
  state.started = true;
  if (state.running) return state.running;
  if (state.allDone) return Promise.resolve();
  const run = async () => {
    let days;
    try {
      days = listRequestedPendingDaysSync(db, now());
    } catch (error) {
      console.error("[usageRepo] requested-model rebuild could not list days:", error?.message || error);
      return;
    }
    state.pendingDays = days.length;
    let failed = false;
    for (const dateKey of days) {
      try {
        const status = await rebuildRequestedDay(db, dateKey, { now, sliceMs });
        if (status === "complete" || status === "unrecoverable") state.generation += 1;
      } catch (error) {
        failed = true;
        console.error(`[usageRepo] requested-model rebuild failed for ${dateKey}:`, error?.message || error);
      }
      state.pendingDays = Math.max(0, state.pendingDays - 1);
      await yieldToLoop();
    }
    if (!failed) state.allDone = true;
  };
  // Started from a microtask, AFTER the assignment (same reason as scheduleRollup).
  state.running = Promise.resolve().then(run).finally(() => {
    state.running = null;
    state.pendingDays = 0;
  });
  return state.running;
}

/**
 * Usage summary for the admin Overview.
 *
 * `modelView` decides what the Model / Account / Key / Endpoint maps are grouped by:
 *   - "upstream": the upstream model that served each request (the historical output,
 *     unchanged);
 *   - "requested": the model the client asked for (a combo name), falling back to the
 *     upstream model for a request with no recorded requested model and for a day whose
 *     requested-model figures are missing (raw rows pruned or partly deleted, or not
 *     rebuilt yet). The result then also carries `modelView`, `requestedPartial` (some day
 *     in range used the fallback), `upstreamOnlyDays` (those days, oldest first) and
 *     `requestedSince` (the first day of the newest unbroken run of days with requested
 *     figures; null when the newest day in range has none) — daily periods only.
 * Totals, byProvider, last10Minutes, recentRequests and pending are the same in both.
 * The default stays "upstream" so callers that do not choose keep their output; the admin
 * route defaults to "requested".
 */
export async function getUsageStats(period = "all", { modelView = "upstream" } = {}) {
  const db = await getAdapter();
  const reqView = modelView === "requested";

  // Rebuild the requested-model day figures in the background: whenever they are asked
  // for, and once per process on first use. Fire and forget; reads never wait for it.
  if (reqView || !requestedBackfillState().started) scheduleRequestedBackfill(db);

  const [{ getProviderConnections }, { getApiKeys }, { getProviderNodes }] = await Promise.all([
    import("./connectionsRepo.js"),
    import("./apiKeysRepo.js"),
    import("./nodesRepo.js"),
  ]);

  let allConnections = [];
  try { allConnections = await getProviderConnections(); } catch {}
  const connectionMap = newMap();
  for (const c of allConnections) connectionMap[c.id] = c.name || c.email || c.id;

  const providerNodeNameMap = newMap();
  try {
    const nodes = await getProviderNodes();
    for (const n of nodes) if (n.id && n.name) providerNodeNameMap[n.id] = n.name;
  } catch {}

  let allApiKeys = [];
  try { allApiKeys = await getApiKeys(); } catch {}
  const apiKeyMap = newMap();
  const apiKeyMapById = newMap();
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

  // ── Requested view: buckets keyed by the requested model ──
  // byModel[model], byAccount["model (provider - account)"], byApiKey["keyIdent|model"],
  // byEndpoint["endpoint|model"]. Row fields keep the names the UI reads (`rawModel` is the
  // displayed model). Model, key and endpoint rows also list the providers that served
  // them (`providers`, most requests first; `provider` = their display names joined).
  const requestedDays = [];
  const upstreamOnlyDays = [];
  const providerTallies = new Map();
  const reqBucket = (map, key, init, lastUsed) => {
    if (!map[key]) map[key] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, costNanoUsd: 0, vendorCostNanoUsd: 0, pricedRequests: 0, ...init, lastUsed };
    return map[key];
  };
  const addCounts = (b, c, costNano, ts) => {
    b.requests += c.requests || 0;
    b.promptTokens += c.promptTokens || 0;
    b.completionTokens += c.completionTokens || 0;
    b.cachedTokens += c.cachedTokens || 0;
    addCostTo(b, costNano);
    // NULL-aware vendor-cost sum (spec vendor-cost-pricing): pricedRequests says how many
    // of `b.requests` contributed a real vendorCostNanoUsd, never conflating "no data"
    // with "zero profit" (design.md decision #4).
    b.vendorCostNanoUsd = (b.vendorCostNanoUsd || 0) + Math.round(c.vendorCostNanoUsd || 0);
    b.pricedRequests = (b.pricedRequests || 0) + (c.pricedRequests || 0);
    if (ts && (!b.lastUsed || new Date(ts) > new Date(b.lastUsed))) b.lastUsed = ts;
  };
  const tally = (b, provider, n) => {
    if (!provider || !n) return;
    let t = providerTallies.get(b);
    if (!t) { t = newMap(); providerTallies.set(b, t); }
    t[provider] = (t[provider] || 0) + n;
  };
  const tallyAll = (b, providers) => {
    for (const [p, n] of Object.entries(providers || {})) tally(b, p, n);
  };
  const reqModelRow = (model, c, costNano, ts) => {
    const b = reqBucket(stats.byModel, model, { rawModel: model }, ts);
    addCounts(b, c, costNano, ts);
    return b;
  };
  const reqAccountRow = (model, provider, connectionId, c, costNano, ts) => {
    const accountName = connectionMap[connectionId] || `Account ${connectionId.slice(0, 8)}...`;
    const key = `${model} (${provider} - ${accountName})`;
    const b = reqBucket(stats.byAccount, key, {
      rawModel: model, provider: providerNodeNameMap[provider] || provider, connectionId, accountName,
    }, ts);
    addCounts(b, c, costNano, ts);
    return b;
  };
  const reqKeyRow = (model, apiKeyId, apiKey, c, costNano, ts) => {
    const info = keyInfoOf(apiKeyId, apiKey);
    const keyName = info?.name || (apiKeyId ? "Key " + String(apiKeyId).slice(0, 8) + "..." : (apiKey ? apiKey.slice(0, 8) + "..." : "Local (No API Key)"));
    const apiKeyKey = keyIdent(apiKeyId, apiKey);
    const b = reqBucket(stats.byApiKey, `${apiKeyKey}|${model}`, {
      rawModel: model, apiKeyMasked: info?.masked ?? maskApiKey(apiKey), keyName, apiKeyKey,
    }, ts);
    addCounts(b, c, costNano, ts);
    return b;
  };
  const reqEndpointRow = (endpoint, model, c, costNano, ts) => {
    const b = reqBucket(stats.byEndpoint, `${endpoint}|${model}`, { endpoint, rawModel: model }, ts);
    addCounts(b, c, costNano, ts);
    return b;
  };

  // One usageDaily blob into the requested buckets: its `req` maps when complete, else
  // its upstream maps under the upstream model name (the fallback).
  const mergeRequestedDay = (day, dateKey) => {
    if (day.req?.complete === true) {
      requestedDays.push(dateKey);
      for (const [k, m] of Object.entries(day.req.byModel || {})) {
        tallyAll(reqModelRow(m.rawModel || k, m, blobCostNano(m), dateKey), m.providers);
      }
      for (const a of Object.values(day.req.byAccount || {})) {
        if (a.connectionId) reqAccountRow(a.rawModel || "unknown", a.provider || "", a.connectionId, a, blobCostNano(a), dateKey);
      }
      for (const ak of Object.values(day.req.byApiKey || {})) {
        tallyAll(reqKeyRow(ak.rawModel || "unknown", ak.apiKeyId || null, ak.apiKey || null, ak, blobCostNano(ak), dateKey), ak.providers);
      }
      for (const ep of Object.values(day.req.byEndpoint || {})) {
        tallyAll(reqEndpointRow(ep.endpoint || "Unknown", ep.rawModel || "unknown", ep, blobCostNano(ep), dateKey), ep.providers);
      }
      return;
    }
    upstreamOnlyDays.push(dateKey);
    for (const [mk, m] of Object.entries(day.byModel || {})) {
      const model = m.rawModel || mk.split("|")[0] || "unknown";
      const provider = m.provider || mk.split("|")[1] || "";
      tally(reqModelRow(model, m, blobCostNano(m), dateKey), provider, m.requests || 0);
    }
    for (const [connId, a] of Object.entries(day.byAccount || {})) {
      reqAccountRow(a.rawModel || "unknown", a.provider || "", connId, a, blobCostNano(a), dateKey);
    }
    for (const ak of Object.values(day.byApiKey || {})) {
      tally(reqKeyRow(ak.rawModel || "unknown", ak.apiKeyId || null, ak.apiKey || null, ak, blobCostNano(ak), dateKey), ak.provider, ak.requests || 0);
    }
    for (const [epKey, ep] of Object.entries(day.byEndpoint || {})) {
      const endpoint = ep.endpoint || epKey.split("|")[0] || "Unknown";
      tally(reqEndpointRow(endpoint, ep.rawModel || "unknown", ep, blobCostNano(ep), dateKey), ep.provider, ep.requests || 0);
    }
  };

  // Providers list + display string on the requested Model / Key / Endpoint rows.
  const finalizeRequested = () => {
    for (const map of [stats.byModel, stats.byApiKey, stats.byEndpoint]) {
      for (const b of Object.values(map)) {
        const providers = Object.entries(providerTallies.get(b) || {})
          .map(([id, requests]) => ({ id, name: providerNodeNameMap[id] || id, requests }))
          .sort((x, y) => y.requests - x.requests || x.name.localeCompare(y.name));
        b.providers = providers;
        b.provider = providers.map((p) => p.name).join(", ");
      }
    }
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
    // Admin-only profit summary (spec admin-usage-views "Overview profit and loss
    // summary"): sum of vendorCostNanoUsd over priced requests, and how many of
    // totalRequests were priced. totalPricedRequests === 0 means "no vendor cost data
    // for this period", never "zero cost".
    totalVendorCostNanoUsd: 0, totalPricedRequests: 0,
    // Prototype-less: keyed by model names a client can choose (see ownGet / ownSet).
    byProvider: newMap(), byModel: newMap(), byAccount: newMap(), byApiKey: newMap(), byEndpoint: newMap(),
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
      stats.totalVendorCostNanoUsd += Math.round(day.vendorCostNanoUsd || 0);
      stats.totalPricedRequests += day.pricedRequests || 0;

      for (const [prov, p] of Object.entries(day.byProvider || {})) {
        if (!stats.byProvider[prov]) stats.byProvider[prov] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, costNanoUsd: 0 };
        stats.byProvider[prov].requests += p.requests || 0;
        stats.byProvider[prov].promptTokens += p.promptTokens || 0;
        stats.byProvider[prov].completionTokens += p.completionTokens || 0;
        stats.byProvider[prov].cachedTokens += p.cachedTokens || 0;
        addCostTo(stats.byProvider[prov], blobCostNano(p));
      }

      if (reqView) {
        mergeRequestedDay(day, dateKey);
        continue;
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
        addVendorCostTo(stats.byModel[statsKey], m);
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
        addVendorCostTo(stats.byAccount[accountKey], a);
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
        addVendorCostTo(stats.byApiKey[groupKey], ak);
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
        addVendorCostTo(stats.byEndpoint[epKey], ep);
        if (dateKey > (stats.byEndpoint[epKey].lastUsed || "")) stats.byEndpoint[epKey].lastUsed = dateKey;
      }
    }

    // Overlay precise lastUsed timestamps from history. Only the last 48 hours: the page
    // shows "12m ago" / "3h ago" under a day and just a date beyond it, and the daily
    // rollup already carries the date, so older rows would only be scanned to be ignored
    // (this scan was the cold-load cost of the 30d / 60d / all views).
    const overlayCutoff = Date.now() - OVERLAY_PRECISE_MS;
    // One row per distinct (model, provider, account, key, endpoint) with its newest
    // timestamp, not one row per request: every bucket's lastUsed is the max of its
    // rows, so folding the per-group maxima gives the same answer while the scan runs
    // inside SQLite instead of materialising the whole period in JS.
    // Per slice, so a long range never holds the event loop for one big scan; a group that
    // recurs in several slices just keeps its newest timestamp.
    if (reqView) {
      // Same overlay, matched against the requested-model buckets.
      const newer = (b, ts) => { if (b && new Date(ts) > new Date(b.lastUsed)) b.lastUsed = ts; };
      await forEachUsageSlice(db, {
        startDate: new Date(overlayCutoff).toISOString(),
        select: `SELECT MAX(timestamp) AS timestamp, ${REQ_MODEL_SQL} AS rm, provider, connectionId, apiKey, apiKeyId, endpoint FROM usageHistory`,
        tail: "GROUP BY rm, provider, connectionId, apiKey, apiKeyId, endpoint",
      }, (histRows) => {
        for (const e of histRows) {
          const ts = e.timestamp;
          newer(stats.byModel[e.rm], ts);
          if (e.connectionId) {
            const accountName = connectionMap[e.connectionId] || `Account ${e.connectionId.slice(0, 8)}...`;
            newer(stats.byAccount[`${e.rm} (${e.provider || ""} - ${accountName})`], ts);
          }
          newer(stats.byApiKey[`${keyIdent(e.apiKeyId, e.apiKey && typeof e.apiKey === "string" ? e.apiKey : null)}|${e.rm}`], ts);
          newer(stats.byEndpoint[`${e.endpoint || "Unknown"}|${e.rm}`], ts);
        }
      });
    } else await forEachUsageSlice(db, {
      startDate: new Date(overlayCutoff).toISOString(),
      select: "SELECT MAX(timestamp) AS timestamp, provider, model, connectionId, apiKey, apiKeyId, endpoint FROM usageHistory",
      tail: "GROUP BY provider, model, connectionId, apiKey, apiKeyId, endpoint",
    }, (histRows) => {
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
    });
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
    // Aggregated per (provider, model, account, key, endpoint) inside SQLite: a busy day
    // is hundreds of thousands of rows, and parsing each one's `tokens` JSON in JS
    // blocked the event loop. `n` is the request count of the group, `ts` its newest
    // timestamp. Token counts follow the old per-row rules (`prompt_tokens || 0`,
    // `cached_tokens || cache_read_input_tokens || 0`); json_valid guards a malformed
    // row, which parseJson used to tolerate.
    const TK = "CASE WHEN json_valid(tokens) THEN tokens END";
    // Per slice (see forEachUsageSlice): the loop below adds each group's counts, so a
    // group that appears in two slices simply accumulates.
    const filtered = [];
    // The requested view also groups by the effective requested model (`rm`); the sums
    // are the same expressions, so totals and byProvider are identical in both views.
    await forEachUsageSlice(db, {
      startDate: cutoff,
      select: `SELECT ${reqView ? `${REQ_MODEL_SQL} AS rm, ` : ""}provider, model, connectionId, apiKey, apiKeyId, endpoint,
              COUNT(*) AS n,
              MAX(timestamp) AS ts,
              SUM(COALESCE(json_extract(${TK}, '$.prompt_tokens'), 0)) AS pt,
              SUM(COALESCE(json_extract(${TK}, '$.completion_tokens'), 0)) AS ct,
              SUM(COALESCE(NULLIF(json_extract(${TK}, '$.cached_tokens'), 0),
                           json_extract(${TK}, '$.cache_read_input_tokens'), 0)) AS cached,
              SUM(CASE WHEN COALESCE(costNanoUsd, 0) != 0 THEN ROUND(costNanoUsd)
                       ELSE ROUND(COALESCE(cost, 0) * 1e9) END) AS costNano,
              SUM(COALESCE(vendorCostNanoUsd, 0)) AS vendorCostNano,
              SUM(CASE WHEN vendorCostNanoUsd IS NOT NULL THEN 1 ELSE 0 END) AS priced
         FROM usageHistory`,
      tail: `GROUP BY ${reqView ? "rm, " : ""}provider, model, connectionId, apiKey, apiKeyId, endpoint`,
    }, (rows) => { for (const row of rows) filtered.push(row); });

    for (const r of filtered) {
      const promptTokens = Math.round(r.pt || 0);
      const completionTokens = Math.round(r.ct || 0);
      const cachedTokens = Math.round(r.cached || 0);
      const entryCostNano = Math.round(r.costNano || 0);
      const entryVendorCostNano = Math.round(r.vendorCostNano || 0);
      const entryPriced = r.priced || 0;
      const providerDisplayName = providerNodeNameMap[r.provider] || r.provider;

      stats.totalPromptTokens += promptTokens;
      stats.totalCompletionTokens += completionTokens;
      stats.totalCachedTokens += cachedTokens;
      stats.totalCostNanoUsd += entryCostNano;
      stats.totalCost = nanoToUsd(stats.totalCostNanoUsd);
      stats.totalVendorCostNanoUsd += entryVendorCostNano;
      stats.totalPricedRequests += entryPriced;

      if (!stats.byProvider[r.provider]) stats.byProvider[r.provider] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, costNanoUsd: 0 };
      stats.byProvider[r.provider].requests += r.n;
      stats.byProvider[r.provider].promptTokens += promptTokens;
      stats.byProvider[r.provider].completionTokens += completionTokens;
      stats.byProvider[r.provider].cachedTokens += cachedTokens;
      addCostTo(stats.byProvider[r.provider], entryCostNano);

      if (reqView) {
        const counts = { requests: r.n, promptTokens, completionTokens, cachedTokens, vendorCostNanoUsd: entryVendorCostNano, pricedRequests: entryPriced };
        tally(reqModelRow(r.rm, counts, entryCostNano, r.ts), r.provider, r.n);
        if (r.connectionId) reqAccountRow(r.rm, r.provider || "", r.connectionId, counts, entryCostNano, r.ts);
        tally(reqKeyRow(r.rm, r.apiKeyId || null, r.apiKey || null, counts, entryCostNano, r.ts), r.provider, r.n);
        tally(reqEndpointRow(r.endpoint || "Unknown", r.rm, counts, entryCostNano, r.ts), r.provider, r.n);
        continue;
      }

      const modelKey = r.provider ? `${r.model} (${r.provider})` : r.model;
      if (!stats.byModel[modelKey]) {
        stats.byModel[modelKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, costNanoUsd: 0, rawModel: r.model, provider: providerDisplayName, lastUsed: r.ts };
      }
      stats.byModel[modelKey].requests += r.n;
      stats.byModel[modelKey].promptTokens += promptTokens;
      stats.byModel[modelKey].completionTokens += completionTokens;
      stats.byModel[modelKey].cachedTokens += cachedTokens;
      addCostTo(stats.byModel[modelKey], entryCostNano);
      addVendorCostTo(stats.byModel[modelKey], { vendorCostNanoUsd: entryVendorCostNano, pricedRequests: entryPriced });
      if (new Date(r.ts) > new Date(stats.byModel[modelKey].lastUsed)) stats.byModel[modelKey].lastUsed = r.ts;

      if (r.connectionId) {
        const accountName = connectionMap[r.connectionId] || `Account ${r.connectionId.slice(0, 8)}...`;
        const accountKey = `${r.model} (${r.provider} - ${accountName})`;
        if (!stats.byAccount[accountKey]) {
          stats.byAccount[accountKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, costNanoUsd: 0, rawModel: r.model, provider: providerDisplayName, connectionId: r.connectionId, accountName, lastUsed: r.ts };
        }
        stats.byAccount[accountKey].requests += r.n;
        stats.byAccount[accountKey].promptTokens += promptTokens;
        stats.byAccount[accountKey].completionTokens += completionTokens;
        stats.byAccount[accountKey].cachedTokens += cachedTokens;
        addCostTo(stats.byAccount[accountKey], entryCostNano);
        addVendorCostTo(stats.byAccount[accountKey], { vendorCostNanoUsd: entryVendorCostNano, pricedRequests: entryPriced });
        if (new Date(r.ts) > new Date(stats.byAccount[accountKey].lastUsed)) stats.byAccount[accountKey].lastUsed = r.ts;
      }

      const liveKeyIdent = keyIdent(r.apiKeyId, r.apiKey);
      if (liveKeyIdent !== "local-no-key") {
        const keyInfo = keyInfoOf(r.apiKeyId, r.apiKey);
        const apiKeyMasked = keyInfo?.masked ?? maskApiKey(r.apiKey);
        const keyName = keyInfo?.name || (r.apiKeyId ? "Key " + String(r.apiKeyId).slice(0, 8) + "..." : r.apiKey.slice(0, 8) + "...");
        const akKey = `${liveKeyIdent}|${r.model}|${r.provider || "unknown"}`;
        if (!stats.byApiKey[akKey]) {
          stats.byApiKey[akKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, costNanoUsd: 0, rawModel: r.model, provider: providerDisplayName, apiKeyMasked, keyName, apiKeyKey: liveKeyIdent, lastUsed: r.ts };
        }
        const ake = stats.byApiKey[akKey];
        ake.requests += r.n; ake.promptTokens += promptTokens; ake.completionTokens += completionTokens; ake.cachedTokens += cachedTokens;
        addCostTo(ake, entryCostNano);
        addVendorCostTo(ake, { vendorCostNanoUsd: entryVendorCostNano, pricedRequests: entryPriced });
        if (new Date(r.ts) > new Date(ake.lastUsed)) ake.lastUsed = r.ts;
      } else {
        if (!stats.byApiKey["local-no-key"]) {
          stats.byApiKey["local-no-key"] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, costNanoUsd: 0, rawModel: r.model, provider: providerDisplayName, apiKeyMasked: null, keyName: "Local (No API Key)", apiKeyKey: "local-no-key", lastUsed: r.ts };
        }
        const ake = stats.byApiKey["local-no-key"];
        ake.requests += r.n; ake.promptTokens += promptTokens; ake.completionTokens += completionTokens; ake.cachedTokens += cachedTokens;
        addCostTo(ake, entryCostNano);
        addVendorCostTo(ake, { vendorCostNanoUsd: entryVendorCostNano, pricedRequests: entryPriced });
        if (new Date(r.ts) > new Date(ake.lastUsed)) ake.lastUsed = r.ts;
      }

      const endpoint = r.endpoint || "Unknown";
      const epKey = `${endpoint}|${r.model}|${r.provider || "unknown"}`;
      if (!stats.byEndpoint[epKey]) {
        stats.byEndpoint[epKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, costNanoUsd: 0, endpoint, rawModel: r.model, provider: providerDisplayName, lastUsed: r.ts };
      }
      const epe = stats.byEndpoint[epKey];
      epe.requests += r.n; epe.promptTokens += promptTokens; epe.completionTokens += completionTokens; epe.cachedTokens += cachedTokens;
      addCostTo(epe, entryCostNano);
      addVendorCostTo(epe, { vendorCostNanoUsd: entryVendorCostNano, pricedRequests: entryPriced });
      if (new Date(r.ts) > new Date(epe.lastUsed)) epe.lastUsed = r.ts;
    }
  }

  stats.totalRequests = Object.values(stats.byProvider).reduce((sum, p) => sum + (p.requests || 0), 0);
  if (reqView) {
    finalizeRequested();
    stats.modelView = "requested";
    upstreamOnlyDays.sort();
    const newestFallback = upstreamOnlyDays[upstreamOnlyDays.length - 1] ?? null;
    // The newest unbroken run of days with requested figures starts after the newest
    // fallback day; "Trước ngày <requestedSince> chỉ có model gốc" is then exact.
    const run = requestedDays.filter((d) => newestFallback == null || d > newestFallback).sort();
    stats.requestedSince = run[0] ?? null;
    stats.requestedPartial = upstreamOnlyDays.length > 0;
    stats.upstreamOnlyDays = upstreamOnlyDays;
    // True when the days without requested figures are exactly the days before
    // requestedSince; otherwise the page names them one by one.
    stats.upstreamOnlyIsPrefix = stats.requestedSince != null && requestedDays.every((d) => d >= stats.requestedSince);
  }
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
// Display form of a stored key: prefix and last four, never the middle.
function maskStoredKey(key) {
  if (!key || typeof key !== "string") return "";
  if (key.length <= 12) return "****";
  const dash = key.indexOf("-");
  const prefix = dash > 0 ? key.slice(0, dash + 1) : key.slice(0, 3);
  return `${prefix}…****${key.slice(-4)}`;
}

function emptyUsageTotals() {
  // vendorCostNanoUsd/pricedRequests (spec vendor-cost-pricing, admin-only) are populated
  // by getUsageByOwner (the admin Users tab); getKeyUsageSummary's per-key customer
  // summary never sets them, so they stay inert zeros there — never real admin data.
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, requests: 0, cost: 0, costNanoUsd: 0, vendorCostNanoUsd: 0, pricedRequests: 0 };
}

/**
 * Usage grouped by the customer who owns the key, for the admin usage page.
 *
 * One customer may hold many keys, so each owner gets one entry with totals over
 * all of their keys, a per-model breakdown, a per-key breakdown, the busiest
 * minute (tokens and requests summed across their keys) and the last request.
 * Keys with no owner (admin keys) share one "admin" entry, where requests made
 * without any key (loopback/local traffic) appear as a "no key" line; rows whose
 * key no longer exists share one "unknown" entry. Customers who own keys but made
 * no request in the range are listed with zero totals.
 *
 * Rows are matched to keys by apiKeyId, or by the legacy raw apiKey column.
 *
 * @param {{startDate?: string, endDate?: string}} [range]
 * @returns {Promise<Array<object>>} owners, highest cost first
 */
export async function getUsageByOwner({ startDate, endDate, sliceMs, useRollup = true, rollupSliceHours } = {}) {
  const db = await getAdapter();
  // Reject a bad date up front, before any read (the slices below would also throw).
  const startMs = parseRangeBound(startDate);
  const endMs = parseRangeBound(endDate);

  const keys = db.all(`SELECT id, key, keyPrefix, name, userId, isActive FROM apiKeys`);
  const users = db.all(`SELECT id, email, displayName, groupId, status FROM users`);
  let groups = [];
  try { groups = db.all(`SELECT id, name FROM keyGroups`); } catch { groups = []; }
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  const userById = new Map(users.map((u) => [u.id, u]));
  const keyById = new Map(keys.map((k) => [k.id, k]));
  const keyByRaw = new Map(keys.filter((k) => k.key).map((k) => [k.key, k]));
  // The hourly rollup keeps a hash of a raw key, never the key: match legacy rows by hash.
  const keyByRawHash = new Map(keys.filter((k) => k.key).map((k) => [sha256Hex(k.key), k]));

  const owners = new Map();
  const ownerFor = (ownerId) => {
    let o = owners.get(ownerId);
    if (o) return o;
    const user = userById.get(ownerId);
    o = {
      ownerId,
      kind: ownerId === "__admin" ? "admin" : ownerId === "__unknown" ? "unknown" : "user",
      userId: user ? user.id : null,
      email: user?.email ?? null,
      displayName: user?.displayName ?? null,
      group: user?.groupId ? groupName.get(user.groupId) ?? null : null,
      status: user?.status ?? null,
      keys: new Map(),
      byModel: newMap(), // keyed by the requested model: prototype-less
      totals: emptyUsageTotals(),
      perMinuteTok: {},
      perMinuteReq: {},
      lastUsedAt: null,
    };
    owners.set(ownerId, o);
    return o;
  };
  const ownerIdOfKey = (k) => (k.userId && userById.has(k.userId) ? k.userId : k.userId ? "__unknown" : "__admin");
  const blank = { requests: 0, tokens: 0, cost: 0, costNanoUsd: 0, lastUsedAt: null };
  // `k` is an apiKeys row, or null with `noKey` for a request made without any key.
  const keyEntry = (o, k, noKey = false) => {
    const id = k ? k.id : noKey ? "__nokey" : "__deleted";
    let e = o.keys.get(id);
    if (!e) {
      if (k) {
        e = {
          id: k.id,
          name: k.name || null,
          maskedKey: maskStoredKey(k.key) || (k.keyPrefix ? `${k.keyPrefix}…` : ""),
          active: k.isActive !== 0 && k.isActive !== false,
          ...blank,
        };
      } else if (noKey) {
        e = { id, name: null, maskedKey: "", active: true, noKey: true, ...blank };
      } else {
        e = { id, name: null, maskedKey: "", active: false, deleted: true, ...blank };
      }
      o.keys.set(id, e);
    }
    return e;
  };

  // Every customer who owns a key is listed, even with no traffic in the range.
  for (const k of keys) keyEntry(ownerFor(ownerIdOfKey(k)), k);

  // Whole hours come from the hourly rollup, the partial edges (and anything not rolled yet)
  // from the raw rows (see repos/usageRollup.js: the result equals a raw read).
  if (useRollup) void scheduleRollup(db);
  const plan = planRollupRange(db, startMs, endMs, { useRollup });
  const epoch = rollupEpoch();
  const rollupPeaks = new Map();
  if (plan.rollup) {
    await forEachRollupSlice(plan.rollup, (slice) => {
    for (const g of readKeyRollup(db, slice)) {
      const k = (g.apiKeyId && keyById.get(g.apiKeyId)) || (g.rawHash && keyByRawHash.get(g.rawHash)) || null;
      // No key at all: loopback/local traffic, shown under the admin entry.
      const noKey = !k && !g.apiKeyId && !g.rawHash;
      const o = ownerFor(k ? ownerIdOfKey(k) : noKey ? "__admin" : "__unknown");
      const prompt = g.pin || 0;
      const completion = g.pout || 0;
      const costNano = Math.round(g.costNano || 0);
      const m = o.byModel[g.m] || (o.byModel[g.m] = { model: g.m, ...emptyUsageTotals() });
      for (const acc of [m, o.totals]) {
        acc.input += prompt;
        acc.output += completion;
        acc.cacheRead += g.cr || 0;
        acc.cacheCreation += g.cc || 0;
        acc.requests += g.n;
        if (g.est === 1) acc.cacheEstimated = true;
        addCostTo(acc, costNano);
        acc.vendorCostNanoUsd += Math.round(g.vendorCostNano || 0);
        acc.pricedRequests += g.pricedRequests || 0;
      }
      const e = keyEntry(o, k, noKey);
      e.requests += g.n;
      e.tokens += prompt + completion;
      addCostTo(e, costNano);
      const ts = g.lastTs || "";
      if (ts && (!e.lastUsedAt || ts > e.lastUsedAt)) e.lastUsedAt = ts;
      if (ts && (!o.lastUsedAt || ts > o.lastUsedAt)) o.lastUsedAt = ts;
    }
    for (const p of readOwnerPeakRollup(db, slice)) {
      const seen = rollupPeaks.get(p.owner);
      rollupPeaks.set(p.owner, {
        peakTpm: Math.max(seen?.peakTpm || 0, p.peakTpm || 0),
        peakRpm: Math.max(seen?.peakRpm || 0, p.peakRpm || 0),
      });
    }
    }, rollupSliceHours);
    if (rollupEpoch() !== epoch) return getUsageByOwner({ startDate, endDate, sliceMs, useRollup: false });
  }

  for (const range of plan.raw) {
  await forEachUsageSlice(db, {
    startDate: range.startDate, endDate: range.endDate, sliceMs,
    select: "SELECT apiKey, apiKeyId, model, timestamp, promptTokens, completionTokens, cost, costNanoUsd, vendorCostNanoUsd, tokens, meta FROM usageHistory",
  }, (rows) => {
  for (const r of rows) {
    const k = (r.apiKeyId && keyById.get(r.apiKeyId)) || (r.apiKey && keyByRaw.get(r.apiKey)) || null;
    // No key at all: loopback/local traffic, shown under the admin entry.
    const noKey = !k && !r.apiKeyId && !r.apiKey;
    const o = ownerFor(k ? ownerIdOfKey(k) : noKey ? "__admin" : "__unknown");
    const t = parseJson(r.tokens, {}) || {};
    const meta = parseJson(r.meta, {}) || {};
    const prompt = r.promptTokens ?? t.prompt_tokens ?? t.input_tokens ?? 0;
    const completion = r.completionTokens ?? t.completion_tokens ?? t.output_tokens ?? 0;
    const cacheRead = t.cached_tokens ?? t.cache_read_input_tokens ?? t.prompt_tokens_details?.cached_tokens ?? 0;
    const cacheCreation = t.cache_creation_input_tokens ?? 0;
    const costNano = rowCostNano(r.costNanoUsd, r.cost);

    const model = meta.requestedModel || r.model || "unknown";
    const m = o.byModel[model] || (o.byModel[model] = { model, ...emptyUsageTotals() });
    for (const acc of [m, o.totals]) {
      acc.input += prompt;
      acc.output += completion;
      acc.cacheRead += cacheRead;
      acc.cacheCreation += cacheCreation;
      acc.requests += 1;
      if (meta.cacheEstimated === true && cacheRead > 0) acc.cacheEstimated = true;
      addCostTo(acc, costNano);
      if (r.vendorCostNanoUsd != null) {
        acc.vendorCostNanoUsd += Math.round(r.vendorCostNanoUsd);
        acc.pricedRequests += 1;
      }
    }

    const e = keyEntry(o, k, noKey);
    e.requests += 1;
    e.tokens += prompt + completion;
    addCostTo(e, costNano);
    const ts = r.timestamp || "";
    if (ts && (!e.lastUsedAt || ts > e.lastUsedAt)) e.lastUsedAt = ts;
    if (ts && (!o.lastUsedAt || ts > o.lastUsedAt)) o.lastUsedAt = ts;
    const minute = ts.slice(0, 16);
    if (minute) {
      o.perMinuteTok[minute] = (o.perMinuteTok[minute] || 0) + prompt + completion;
      o.perMinuteReq[minute] = (o.perMinuteReq[minute] || 0) + 1;
    }
  }
  });
  }

  const out = [];
  for (const o of owners.values()) {
    // Rolled hours carry their own per-hour peaks; a minute never straddles an hour, so the
    // owner's peak is the maximum of those and of the raw edges' per-minute sums.
    const rolled = rollupPeaks.get(o.ownerId);
    let peakTpm = rolled?.peakTpm || 0;
    for (const v of Object.values(o.perMinuteTok)) if (v > peakTpm) peakTpm = v;
    let peakRpm = rolled?.peakRpm || 0;
    for (const v of Object.values(o.perMinuteReq)) if (v > peakRpm) peakRpm = v;
    const keyList = [...o.keys.values()].sort(
      (a, b) => (b.costNanoUsd - a.costNanoUsd) || (b.requests - a.requests) || String(a.name || "").localeCompare(String(b.name || ""))
    );
    out.push({
      ownerId: o.ownerId,
      kind: o.kind,
      userId: o.userId,
      email: o.email,
      displayName: o.displayName,
      group: o.group,
      status: o.status,
      keyCount: keyList.filter((k) => !k.deleted && !k.noKey).length,
      activeKeyCount: keyList.filter((k) => !k.deleted && !k.noKey && k.active).length,
      keys: keyList,
      byModel: Object.values(o.byModel).sort((a, b) => (b.costNanoUsd - a.costNanoUsd) || (b.requests - a.requests) || String(a.model).localeCompare(String(b.model))),
      totals: o.totals,
      peakTpm,
      peakRpm,
      lastUsedAt: o.lastUsedAt,
    });
  }
  out.sort((a, b) => (b.totals.costNanoUsd - a.totals.costNanoUsd) || (b.totals.requests - a.totals.requests)
    || String(a.email || a.ownerId).localeCompare(String(b.email || b.ownerId)));
  return out;
}

/**
 * When each key last made a request, for the customer key list.
 *
 * A key's history is split across two row shapes (legacy rows carry the raw key
 * in `apiKey`, rows written since migration 005 carry `apiKeyId`), so both are
 * read; each MAX() is answered from its (column, timestamp DESC) index. Rows are
 * pruned after LOG_RETENTION_DAYS, so a key idle for longer reads as never used.
 *
 * @param {Array<{id: string, key?: string|null}>} keys
 * @returns {Promise<Record<string, string|null>>} key id -> ISO timestamp or null
 */
export async function getKeysLastUsedAt(keys = []) {
  const out = {};
  if (!Array.isArray(keys) || keys.length === 0) return out;
  const db = await getAdapter();
  for (const k of keys) {
    if (!k?.id) continue;
    const byId = db.get(`SELECT MAX(timestamp) AS ts FROM usageHistory WHERE apiKeyId = ?`, [k.id])?.ts || null;
    const byKey = k.key
      ? db.get(`SELECT MAX(timestamp) AS ts FROM usageHistory WHERE apiKey = ?`, [k.key])?.ts || null
      : null;
    out[k.id] = byId && byKey ? (byId > byKey ? byId : byKey) : byId || byKey;
  }
  return out;
}

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

  const byModel = newMap(); // keyed by the requested model: prototype-less
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
    // The cached figure includes at least one estimated row (upstream reported no cache).
    if (meta.cacheEstimated === true && cacheRead > 0) { m.cacheEstimated = true; totals.cacheEstimated = true; }
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
export async function getProviderUsageSummary({ startDate, endDate, sliceMs, useRollup = true, rollupSliceHours } = {}) {
  const db = await getAdapter();
  const startMs = parseRangeBound(startDate);
  const endMs = parseRangeBound(endDate);

  let connectionMap = newMap();
  try {
    const { getProviderConnections } = await import("./connectionsRepo.js");
    for (const c of await getProviderConnections()) connectionMap[c.id] = c.name || c.email || c.id;
  } catch { /* breakdown rows fall back to a generic label */ }

  const byProvider = newMap();
  const totals = { input: 0, output: 0, requests: 0, cost: 0, costNanoUsd: 0, cacheRead: 0, cacheCreation: 0, vendorCostNanoUsd: 0, pricedRequests: 0 };
  const ensure = (provider) => byProvider[provider]
    || (byProvider[provider] = {
      provider, input: 0, output: 0, requests: 0, cost: 0, costNanoUsd: 0, cacheRead: 0, cacheCreation: 0,
      vendorCostNanoUsd: 0, pricedRequests: 0, lastUsed: null,
      _minTok: {}, _minReq: {}, _peakTokS: 0, _rollTpm: 0, _rollRpm: 0, _byConnection: newMap(),
    });
  const touch = (p, ts) => { if (ts && (!p.lastUsed || ts > p.lastUsed)) p.lastUsed = ts; };
  // Per-connection breakdown bucket (spec admin-usage-views "Provider cache ratio and
  // per-connection breakdown"). '' = no recorded connection on those requests.
  const ensureConn = (p, connectionId) => p._byConnection[connectionId]
    || (p._byConnection[connectionId] = {
      connectionId: connectionId || null,
      accountName: connectionId ? (connectionMap[connectionId] || `Account ${connectionId.slice(0, 8)}...`) : null,
      requests: 0, input: 0, output: 0, cost: 0, costNanoUsd: 0, cacheRead: 0, cacheCreation: 0,
      vendorCostNanoUsd: 0, pricedRequests: 0,
    });

  // Whole hours come from the hourly rollup, the partial edges (and anything not rolled yet)
  // from the raw rows (see repos/usageRollup.js: the result equals a raw read).
  if (useRollup) {
    void scheduleRollup(db);
    // Hours rolled before the last-request column existed get it filled in place.
    void scheduleProviderLastTsBackfill(db);
  }
  const plan = planRollupRange(db, startMs, endMs, { useRollup });
  const epoch = rollupEpoch();
  if (plan.rollup) {
    await forEachRollupSlice(plan.rollup, (slice) => {
    for (const r of readProviderRollup(db, slice)) {
      const p = ensure(r.provider);
      const costNano = Math.round(r.costNano || 0);
      p.input += r.input || 0;
      p.output += r.output || 0;
      p.requests += r.requests || 0;
      addCostTo(p, costNano);
      p.cacheRead += r.cacheRead || 0;
      p.cacheCreation += r.cacheCreation || 0;
      p.vendorCostNanoUsd += Math.round(r.vendorCostNano || 0);
      p.pricedRequests += r.pricedRequests || 0;
      totals.input += r.input || 0;
      totals.output += r.output || 0;
      totals.requests += r.requests || 0;
      addCostTo(totals, costNano);
      totals.cacheRead += r.cacheRead || 0;
      totals.cacheCreation += r.cacheCreation || 0;
      totals.vendorCostNanoUsd += Math.round(r.vendorCostNano || 0);
      totals.pricedRequests += r.pricedRequests || 0;
      // A minute lies inside one hour, so a peak over hours is the maximum of the hourly ones.
      p._rollTpm = Math.max(p._rollTpm, r.peakTpm || 0);
      p._rollRpm = Math.max(p._rollRpm, r.peakRpm || 0);
      p._peakTokS = Math.max(p._peakTokS, r.peakTokS || 0);
      touch(p, r.lastTs);
      if (r.unfilledHour && (!p._unfilledHour || r.unfilledHour > p._unfilledHour)) p._unfilledHour = r.unfilledHour;
    }
    // Per-connection breakdown: a second, separately-grouped read of the same rolled
    // hours. Never used for peak figures (not distributive over a connection split —
    // see usageRollup.js rollProviderHour), only requests/tokens/cost/cache/vendor cost.
    for (const r of readProviderConnectionRollup(db, slice)) {
      const p = ensure(r.provider);
      const c = ensureConn(p, r.connectionId);
      const costNano = Math.round(r.costNano || 0);
      c.requests += r.requests || 0;
      c.input += r.input || 0;
      c.output += r.output || 0;
      c.cacheRead += r.cacheRead || 0;
      c.cacheCreation += r.cacheCreation || 0;
      addCostTo(c, costNano);
      c.vendorCostNanoUsd += Math.round(r.vendorCostNano || 0);
      c.pricedRequests += r.pricedRequests || 0;
    }
    }, rollupSliceHours);
    // Someone deleted history while this read yielded between slices: rolled rows it had not
    // read yet may be gone, so answer from the raw rows instead of undercounting.
    if (rollupEpoch() !== epoch) return getProviderUsageSummary({ startDate, endDate, sliceMs, useRollup: false });
    // Hours whose lastTs is not filled yet (rolled before the column existed): only a
    // provider's newest such hour can hold a later request than its filled ones. Providers
    // are grouped by that hour, and each distinct hour is read from the raw rows ONCE for all
    // of them (one grouped scan on idx_uh_ts), yielding between hours.
    const byHour = new Map();
    for (const p of Object.values(byProvider)) {
      if (p._unfilledHour && (!p.lastUsed || `${p._unfilledHour}:59:59.999Z` > p.lastUsed)) {
        if (!byHour.has(p._unfilledHour)) byHour.set(p._unfilledHour, []);
        byHour.get(p._unfilledHour).push(p);
      }
    }
    let first = true;
    for (const [hour, providers] of byHour) {
      if (!first) await yieldToLoop();
      first = false;
      const latest = hourLastTsByProviderSync(db, hour);
      for (const p of providers) touch(p, latest.get(p.provider) ?? null);
    }
  }

  for (const range of plan.raw) {
  await forEachUsageSlice(db, {
    startDate: range.startDate, endDate: range.endDate, sliceMs,
    // "platform" rows are key-holder denials (RPM/TPM/budget) recorded by the proxy —
    // not real upstream provider usage. Exclude them from the provider table.
    conds: ["COALESCE(provider, '') != 'platform'"],
    select: "SELECT provider, connectionId, timestamp, promptTokens, completionTokens, cost, costNanoUsd, vendorCostNanoUsd, tokens, meta FROM usageHistory",
    tail: "",
  }, (rows) => {
  for (const r of rows) {
    const t = parseJson(r.tokens, {}) || {};
    const prompt = r.promptTokens ?? t.prompt_tokens ?? t.input_tokens ?? 0;
    const completion = r.completionTokens ?? t.completion_tokens ?? t.output_tokens ?? 0;
    const cacheRead = t.cached_tokens ?? t.cache_read_input_tokens ?? t.prompt_tokens_details?.cached_tokens ?? 0;
    const cacheCreation = t.cache_creation_input_tokens ?? 0;
    const tokSum = prompt + completion;
    const provider = r.provider || "unknown";
    const costNano = rowCostNano(r.costNanoUsd, r.cost);

    const p = ensure(provider);
    p.input += prompt;
    p.output += completion;
    p.requests += 1;
    addCostTo(p, costNano);
    p.cacheRead += cacheRead;
    p.cacheCreation += cacheCreation;

    totals.input += prompt;
    totals.output += completion;
    totals.requests += 1;
    addCostTo(totals, costNano);
    totals.cacheRead += cacheRead;
    totals.cacheCreation += cacheCreation;

    if (r.vendorCostNanoUsd != null) {
      p.vendorCostNanoUsd += Math.round(r.vendorCostNanoUsd);
      p.pricedRequests += 1;
      totals.vendorCostNanoUsd += Math.round(r.vendorCostNanoUsd);
      totals.pricedRequests += 1;
    }

    // '' = no recorded connection — same convention readProviderConnectionRollup uses
    // (COALESCE(connectionId, '')), so the "no connection" bucket from the rolled hours
    // and the raw edges merge into one row instead of splitting into two.
    const c = ensureConn(p, r.connectionId || "");
    c.requests += 1;
    c.input += prompt;
    c.output += completion;
    c.cacheRead += cacheRead;
    c.cacheCreation += cacheCreation;
    addCostTo(c, costNano);
    if (r.vendorCostNanoUsd != null) {
      c.vendorCostNanoUsd += Math.round(r.vendorCostNanoUsd);
      c.pricedRequests += 1;
    }

    const ts = r.timestamp || "";
    touch(p, ts);
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
  });
  }

  // Share of input tokens that were cache reads or cache-creation writes (spec
  // admin-usage-views "Provider cache ratio and per-connection breakdown"). null (shown
  // as "—") when there were no input tokens to take a ratio of.
  const cacheHitRatio = (acc) => (acc.input > 0 ? (acc.cacheRead + acc.cacheCreation) / acc.input : null);
  // Profit (charge minus vendor cost), null-aware: no priced requests in this bucket ⇒
  // null (rendered as "no vendor cost data"), never a fabricated 0.
  const profitOf = (acc) => (acc.pricedRequests > 0 ? acc.costNanoUsd - acc.vendorCostNanoUsd : null);

  const items = Object.values(byProvider).map((p) => {
    let peakTpm = p._rollTpm, peakRpm = p._rollRpm, peakTokS = 0;
    for (const v of Object.values(p._minTok)) if (v > peakTpm) peakTpm = v;
    for (const v of Object.values(p._minReq)) if (v > peakRpm) peakRpm = v;
    peakTokS = Math.round((p._peakTokS || 0) * 10) / 10;
    const { provider, input, output, requests, cost, costNanoUsd, cacheRead, cacheCreation, vendorCostNanoUsd, pricedRequests, lastUsed } = p;
    const breakdown = Object.values(p._byConnection)
      .map((c) => ({ ...c, cacheHitRatio: cacheHitRatio(c), profitNanoUsd: profitOf(c) }))
      .sort((a, b) => (b.requests || 0) - (a.requests || 0) || String(a.accountName || "").localeCompare(String(b.accountName || "")));
    return {
      provider, input, output, requests, cost, costNanoUsd, cacheRead, cacheCreation, vendorCostNanoUsd, pricedRequests,
      cacheHitRatio: cacheHitRatio(p), profitNanoUsd: profitOf(p),
      peakTpm, peakRpm, peakTokS, lastUsed, breakdown,
    };
  }).sort((a, b) => (b.requests || 0) - (a.requests || 0) || String(a.provider).localeCompare(String(b.provider)));

  return { items, totals };
}


// All read from usageHistory with the idx_uh_apikey_ts index.

// Rows that use a customer's RPM/TPM allowance: requests that were served, and
// requests the client abandoned (499) — the upstream was already working on
// them, and a client that connects and hangs up in a loop must still be held to
// its rate. Failed upstream attempts (one row per account or combo member tried)
// and platform denials are recorded for history but do not count, so a provider
// outage or a client retrying its own 429s cannot lock the customer out.
// Served rows are written as 'ok' (chat) or 'success' (embeddings, images, the
// Gemini-native route); failures carry the HTTP status ("429", "502").
const RATE_COUNTED_SQL = "COALESCE(status, 'ok') IN ('ok', 'success', '499')";

// Count requests and sum tokens for an apiKey in the last `windowMs` ms.
// Returns { requests, tokens }.
export async function getKeyRateUsage(apiKey, windowMs = 60000) {
  const db = await getAdapter();
  const since = new Date(Date.now() - windowMs).toISOString();
  // Both row shapes count: legacy rows match on the raw key, new rows on apiKeyId.
  const keyFilter = usageKeyCond(db, apiKey);
  const row = db.get(
    `SELECT COUNT(*) as requests, COALESCE(SUM(COALESCE(promptTokens,0) + COALESCE(completionTokens,0)),0) as tokens
     FROM usageHistory WHERE ${keyFilter.cond} AND timestamp >= ? AND ${RATE_COUNTED_SQL}`,
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

// Every key id the user has held, including keys deleted within the tombstone
// window: without the deleted ones, "burst, delete the key, mint a new one" would
// drop the burst out of the per-minute count and reset RPM/TPM. Binds userId twice.
const USER_KEY_IDS_SQL =
  "SELECT id FROM apiKeys WHERE userId = ? UNION SELECT apiKeyId FROM deletedApiKeys WHERE userId = ?";

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
export async function getUserRateUsage(userId, windowMs = 60000, planId = null) {
  if (!userId) return { requests: 0, tokens: 0 };
  const db = await getAdapter();
  const since = new Date(Date.now() - windowMs).toISOString();
  // `planId` narrows the count to one plan's allowance (all keys of the user that
  // were counted against that plan); omitted = every request of the user.
  const row = db.get(
    `SELECT COUNT(*) AS requests,
            COALESCE(SUM(COALESCE(promptTokens, 0) + COALESCE(completionTokens, 0)), 0) AS tokens
       FROM usageHistory
      WHERE apiKeyId IN (${USER_KEY_IDS_SQL})
        AND timestamp >= ? AND ${RATE_COUNTED_SQL}${planId ? " AND ratePlanId = ?" : ""}`,
    planId ? [userId, userId, since, planId] : [userId, userId, since]
  );
  return { requests: row?.requests ?? 0, tokens: row?.tokens ?? 0 };
}

/**
 * Oldest usage timestamp in the rolling window across every key of a user — the
 * TPM wait-loop sleeps until that request falls out of the minute.
 */
export async function getUserOldestTokenAt(userId, windowMs = 60000, planId = null) {
  if (!userId) return null;
  const db = await getAdapter();
  const since = new Date(Date.now() - windowMs).toISOString();
  const row = db.get(
    `SELECT MIN(timestamp) AS oldest
       FROM usageHistory
      WHERE apiKeyId IN (${USER_KEY_IDS_SQL})
        AND timestamp >= ? AND ${RATE_COUNTED_SQL}${planId ? " AND ratePlanId = ?" : ""}`,
    planId ? [userId, userId, since, planId] : [userId, userId, since]
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
     FROM usageHistory WHERE ${keyFilter.cond} AND timestamp >= ? AND ${RATE_COUNTED_SQL}`,
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
    // The rollup must not keep numbers the raw rows no longer support: forget everything
    // from the oldest hour this key's rows touched; the next roll recomputes it.
    const oldest = db.get(`SELECT MIN(timestamp) AS t FROM usageHistory WHERE ${keyFilter.cond}`, keyFilter.params);
    if (oldest?.t) invalidateRollupFromSync(db, oldest.t);
    const h = db.run(`DELETE FROM usageHistory WHERE ${keyFilter.cond}`, keyFilter.params);
    history = h.changes || 0;
    // By raw key: rows written before requestDetails.apiKeyId existed have only that.
    const d = db.run(`DELETE FROM requestDetails WHERE apiKey = ?`, [apiKey]);
    details = d.changes || 0;
    // Invalidate any in-memory stats snapshot so the next read recomputes.
    scheduleStatsEvent("update", 0);
  });
  return { history, details };
}

