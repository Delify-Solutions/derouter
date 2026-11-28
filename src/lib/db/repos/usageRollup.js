// Hourly rollups of usageHistory for the admin usage summaries (Users and Providers tabs).
//
// Those summaries answer "what happened over the last 30 days?" and used to read every row
// of the range, which is linear in traffic. A rollup holds the answer per COMPLETE HOUR, so
// a month costs ~720 hours' worth of rows instead of millions of requests.
//
// Exactness is the contract, not an approximation:
//   * a range is split at hour boundaries — whole hours come from the rollup, the (at most
//     two) partial edges still come from the raw rows, so the figures equal a raw read;
//   * only hours older than the watermark exist in the rollup; everything after it (the
//     running hour, the lag window, anything not rolled yet) is read raw. A rollup that has
//     not caught up is therefore slower, never wrong — and the very first run backfills in
//     the background in small steps while queries keep working on raw rows;
//   * per-minute peaks never straddle an hour, so a peak is the maximum of per-hour peaks;
//   * a row is rolled only once its hour ended ROLLUP_LAG_MS ago, so a request that started
//     before the hour boundary and was recorded after it is still counted;
//   * deleting history (a customer wiping their log) invalidates the rollup from the oldest
//     hour touched; retention pruning drops rolled hours the same way raw rows are dropped.
//
// Four tables (schema.js): usageRollupProvider, usageRollupKey, usageRollupOwnerPeak, and
// usageRollupMeta for the watermark. The key table stores a SHA-256 of a raw API key, never
// the key itself.
//
// Synchronous functions take `db` first, like the rest of the repos. Relative imports only.
import { createHash } from "node:crypto";

const HOUR_MS = 60 * 60 * 1000;
export const ROLLUP_LAG_MS = 30 * 60 * 1000;
const META_NAME = "rolledThrough";

export const hourStart = (ms) => Math.floor(ms / HOUR_MS) * HOUR_MS;
export const ceilHour = (ms) => Math.ceil(ms / HOUR_MS) * HOUR_MS;
/** "YYYY-MM-DDTHH": the hour key of every rollup row; sorts like time. */
export const hourKey = (ms) => new Date(ms).toISOString().slice(0, 13);
const isoOf = (ms) => new Date(ms).toISOString();
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

export function sha256Hex(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

// ─── watermark ────────────────────────────────────────────────────────────────

/** Start (ms) of the first hour NOT yet rolled up, or null when nothing has been rolled. */
export function getWatermarkMs(db) {
  const row = db.get(`SELECT value FROM usageRollupMeta WHERE name = ?`, [META_NAME]);
  const ms = row?.value ? Date.parse(row.value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function setWatermark(db, ms) {
  db.run(
    `INSERT INTO usageRollupMeta(name, value) VALUES(?, ?)
     ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
    [META_NAME, isoOf(ms)]
  );
}

// ─── rolling one hour ─────────────────────────────────────────────────────────

const TOKENS_OK = "CASE WHEN json_valid(tokens) THEN tokens END";
const META_OK = "CASE WHEN json_valid(meta) THEN meta END";
const COST_NANO = `CASE WHEN COALESCE(costNanoUsd, 0) != 0 THEN ROUND(costNanoUsd)
                        ELSE ROUND(COALESCE(cost, 0) * 1e9) END`;
const PROMPT = `COALESCE(promptTokens, json_extract(tk, '$.prompt_tokens'), json_extract(tk, '$.input_tokens'), 0)`;
const COMPLETION = `COALESCE(completionTokens, json_extract(tk, '$.completion_tokens'), json_extract(tk, '$.output_tokens'), 0)`;

function rollProviderHour(db, fromIso, toIso, hour) {
  // Same rules as getProviderUsageSummary's raw path: platform denials are not provider
  // usage; a blank provider is "unknown"; typed token columns win over the tokens JSON.
  //
  // Widened to (provider, connectionId) (spec admin-usage-views "Provider cache ratio and
  // per-connection breakdown"): '' = no recorded connection, same convention as
  // usageRollupKey's rawHash/apiKeyId. cacheRead/cacheCreation/vendorCostNano/
  // pricedRequests are plain per-group sums — a true MAX-of-request figure (peakTokS) is
  // safely distributive over this split (max of per-connection maxima = the provider's
  // max), but peakTpm/peakRpm are max of a PER-MINUTE SUM across connections, which is NOT
  // distributive that way (two connections busy in the same minute must be summed before
  // the minute max is taken) — so those two stay computed at the provider level, unchanged,
  // and are simply duplicated onto every connection row of that (hour, provider).
  const filter = `timestamp >= ? AND timestamp < ? AND COALESCE(provider, '') != 'platform'`;
  const totals = db.all(
    `WITH h AS (
       SELECT COALESCE(NULLIF(provider, ''), 'unknown') AS prov, COALESCE(connectionId, '') AS conn,
              timestamp, promptTokens, completionTokens, costNanoUsd, cost, vendorCostNanoUsd,
              ${TOKENS_OK} AS tk, ${META_OK} AS mt
         FROM usageHistory WHERE ${filter}
     ), x AS (
       SELECT prov, conn, timestamp, ${PROMPT} AS pin, ${COMPLETION} AS pout, ${COST_NANO} AS costNano,
              COALESCE(json_extract(tk, '$.cached_tokens'), json_extract(tk, '$.cache_read_input_tokens'),
                       json_extract(tk, '$.prompt_tokens_details.cached_tokens'), 0) AS cr,
              COALESCE(json_extract(tk, '$.cache_creation_input_tokens'), 0) AS cc,
              vendorCostNanoUsd,
              json_extract(mt, '$.latencyMs') AS lat
         FROM h
     )
     SELECT prov AS provider, conn AS connectionId, COUNT(*) AS requests, SUM(pin) AS input, SUM(pout) AS output,
            SUM(cr) AS cacheRead, SUM(cc) AS cacheCreation,
            SUM(costNano) AS costNano,
            SUM(COALESCE(vendorCostNanoUsd, 0)) AS vendorCostNano,
            SUM(CASE WHEN vendorCostNanoUsd IS NOT NULL THEN 1 ELSE 0 END) AS priced,
            MAX(CASE WHEN lat > 0 AND pout > 0 THEN pout * 1000.0 / lat END) AS peakTokS,
            MAX(timestamp) AS lastTs
       FROM x GROUP BY prov, conn`,
    [fromIso, toIso]
  );
  if (totals.length === 0) return;
  const peaks = new Map(db.all(
    `WITH h AS (
       SELECT COALESCE(NULLIF(provider, ''), 'unknown') AS prov, timestamp, promptTokens, completionTokens,
              ${TOKENS_OK} AS tk
         FROM usageHistory WHERE ${filter}
     ), m AS (
       SELECT prov, SUBSTR(timestamp, 1, 16) AS minute,
              SUM(${PROMPT} + ${COMPLETION}) AS tok, COUNT(*) AS req
         FROM h GROUP BY prov, minute
     )
     SELECT prov AS provider, MAX(tok) AS peakTpm, MAX(req) AS peakRpm FROM m GROUP BY prov`,
    [fromIso, toIso]
  ).map((r) => [r.provider, r]));

  for (const row of totals) {
    const peak = peaks.get(row.provider) || {};
    db.run(
      `INSERT OR REPLACE INTO usageRollupProvider(hour, provider, connectionId, requests, input, output, cacheRead, cacheCreation, costNano, vendorCostNano, pricedRequests, peakTpm, peakRpm, peakTokS, lastTs)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [hour, row.provider, row.connectionId, row.requests, row.input || 0, row.output || 0,
        row.cacheRead || 0, row.cacheCreation || 0,
        Math.round(row.costNano || 0), Math.round(row.vendorCostNano || 0), row.priced || 0,
        peak.peakTpm || 0, peak.peakRpm || 0, row.peakTokS || 0, row.lastTs]
    );
  }
}

function rollKeyHour(db, fromIso, toIso, hour) {
  // Same rules as getUsageByOwner's raw path (no provider filter: platform denials count).
  const groups = db.all(
    `WITH h AS (
       SELECT apiKeyId, apiKey, model, timestamp, promptTokens, completionTokens, costNanoUsd, cost,
              vendorCostNanoUsd, ${TOKENS_OK} AS tk, ${META_OK} AS mt
         FROM usageHistory WHERE timestamp >= ? AND timestamp < ?
     ), x AS (
       SELECT apiKeyId, apiKey, timestamp,
              COALESCE(NULLIF(json_extract(mt, '$.requestedModel'), ''), NULLIF(model, ''), 'unknown') AS m,
              ${PROMPT} AS pin, ${COMPLETION} AS pout,
              COALESCE(json_extract(tk, '$.cached_tokens'), json_extract(tk, '$.cache_read_input_tokens'),
                       json_extract(tk, '$.prompt_tokens_details.cached_tokens'), 0) AS cr,
              COALESCE(json_extract(tk, '$.cache_creation_input_tokens'), 0) AS cc,
              ${COST_NANO} AS costNano,
              vendorCostNanoUsd,
              json_extract(mt, '$.cacheEstimated') AS ce
         FROM h
     )
     SELECT apiKeyId, apiKey, m, COUNT(*) AS n, SUM(pin) AS pin, SUM(pout) AS pout, SUM(cr) AS cr, SUM(cc) AS cc,
            SUM(costNano) AS costNano, MAX(timestamp) AS lastTs,
            MAX(CASE WHEN ce = 1 AND cr > 0 THEN 1 ELSE 0 END) AS est,
            SUM(COALESCE(vendorCostNanoUsd, 0)) AS vendorCostNano,
            SUM(CASE WHEN vendorCostNanoUsd IS NOT NULL THEN 1 ELSE 0 END) AS priced
       FROM x GROUP BY COALESCE(apiKeyId, ''), COALESCE(apiKey, ''), m`,
    [fromIso, toIso]
  );
  for (const g of groups) {
    db.run(
      `INSERT OR REPLACE INTO usageRollupKey(hour, apiKeyId, rawHash, model, requests, input, output, cacheRead, cacheCreation, costNano, vendorCostNano, pricedRequests, est, lastTs)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      // '' = absent, so the primary key never holds NULL. The raw key is hashed, not stored.
      [hour, g.apiKeyId || "", g.apiKey ? sha256Hex(g.apiKey) : "", g.m, g.n, g.pin || 0, g.pout || 0,
        g.cr || 0, g.cc || 0, Math.round(g.costNano || 0), Math.round(g.vendorCostNano || 0), g.priced || 0, g.est ? 1 : 0, g.lastTs]
    );
  }

  // Peak per-minute tokens / requests per OWNER, with the owner resolved now (the key's
  // user when that user exists, '__unknown' for a key whose user is gone, '__admin' for an
  // admin key or keyless traffic) — the same rule as getUsageByOwner's ownerIdOfKey. An
  // owner change after this hour was rolled up does not rewrite its peaks.
  const peaks = db.all(
    `WITH h AS (
       SELECT apiKeyId, apiKey, timestamp, promptTokens, completionTokens, ${TOKENS_OK} AS tk
         FROM usageHistory WHERE timestamp >= ? AND timestamp < ?
     ), r AS (
       SELECT h.timestamp,
              COALESCE(h.promptTokens, json_extract(h.tk, '$.prompt_tokens'), json_extract(h.tk, '$.input_tokens'), 0)
              + COALESCE(h.completionTokens, json_extract(h.tk, '$.completion_tokens'), json_extract(h.tk, '$.output_tokens'), 0) AS tok,
              CASE
                WHEN k1.id IS NOT NULL OR k2.id IS NOT NULL THEN
                  CASE WHEN COALESCE(CASE WHEN k1.id IS NOT NULL THEN k1.userId ELSE k2.userId END, '') = '' THEN '__admin'
                       WHEN u.id IS NOT NULL THEN u.id
                       ELSE '__unknown' END
                WHEN COALESCE(NULLIF(h.apiKeyId, ''), NULLIF(h.apiKey, '')) IS NULL THEN '__admin'
                ELSE '__unknown'
              END AS owner
         FROM h
         LEFT JOIN apiKeys k1 ON h.apiKeyId IS NOT NULL AND h.apiKeyId != '' AND k1.id = h.apiKeyId
         LEFT JOIN apiKeys k2 ON k1.id IS NULL AND h.apiKey IS NOT NULL AND h.apiKey != '' AND k2.key = h.apiKey
         LEFT JOIN users u ON u.id = CASE WHEN k1.id IS NOT NULL THEN k1.userId ELSE k2.userId END
     ), m AS (
       SELECT owner, SUBSTR(timestamp, 1, 16) AS minute, SUM(tok) AS tok, COUNT(*) AS req
         FROM r GROUP BY owner, minute
     )
     SELECT owner, MAX(tok) AS peakTpm, MAX(req) AS peakRpm FROM m GROUP BY owner`,
    [fromIso, toIso]
  );
  for (const p of peaks) {
    db.run(
      `INSERT OR REPLACE INTO usageRollupOwnerPeak(hour, owner, peakTpm, peakRpm) VALUES(?, ?, ?, ?)`,
      [hour, p.owner, p.peakTpm || 0, p.peakRpm || 0]
    );
  }
}

/**
 * Roll up one hour step. Returns false when nothing is left to roll (the watermark has
 * reached the last complete hour, or there are no rows at all).
 *
 * An hour with no rows is skipped without writing anything: the watermark jumps to the
 * next hour that has rows, so a quiet installation does not walk 1,440 empty hours.
 */
export function advanceOneHourSync(db, nowMs = Date.now()) {
  const limit = hourStart(nowMs - ROLLUP_LAG_MS); // hours before this have ended + lag
  let wm = getWatermarkMs(db);
  if (wm == null) {
    const first = db.get(`SELECT MIN(timestamp) AS t FROM usageHistory`);
    const firstMs = first?.t ? Date.parse(first.t) : NaN;
    if (!Number.isFinite(firstMs)) return false;
    wm = hourStart(firstMs);
  }
  if (wm > limit) {
    // The clock ran ahead and was corrected: hours at or after `limit` were rolled too early.
    db.transaction(() => invalidateRollupFromSync(db, isoOf(limit)));
    return false;
  }
  if (wm === limit) return false;

  const next = db.get(`SELECT MIN(timestamp) AS t FROM usageHistory WHERE timestamp >= ?`, [isoOf(wm)]);
  const nextMs = next?.t ? Date.parse(next.t) : NaN;
  if (!Number.isFinite(nextMs) || hourStart(nextMs) >= limit) {
    // Nothing between here and the last complete hour.
    db.transaction(() => setWatermark(db, limit));
    return false;
  }
  const hourMs = Math.max(wm, hourStart(nextMs));
  if (hourMs > wm) {
    db.transaction(() => setWatermark(db, hourMs));
    return true;
  }

  const hour = hourKey(hourMs);
  const fromIso = isoOf(hourMs);
  const toIso = isoOf(hourMs + HOUR_MS);
  db.transaction(() => {
    // Idempotent: a re-roll after an invalidation replaces the hour's rows.
    db.run(`DELETE FROM usageRollupProvider WHERE hour = ?`, [hour]);
    db.run(`DELETE FROM usageRollupKey WHERE hour = ?`, [hour]);
    db.run(`DELETE FROM usageRollupOwnerPeak WHERE hour = ?`, [hour]);
    rollProviderHour(db, fromIso, toIso, hour);
    rollKeyHour(db, fromIso, toIso, hour);
    setWatermark(db, hourMs + HOUR_MS);
  });
  return true;
}

/**
 * Catch the rollup up in the background: one hour per turn of the event loop, so a long
 * backfill (the first run over 60 days) never holds the server. One loop at a time per
 * process; calling again while it runs returns the same promise.
 */
export function scheduleRollup(db, { now = Date.now } = {}) {
  if (!globalThis.__usageRollupRun) globalThis.__usageRollupRun = { running: null };
  const state = globalThis.__usageRollupRun;
  if (state.running) return state.running;
  const run = async () => {
    try {
      while (advanceOneHourSync(db, now())) await yieldToLoop();
    } catch (error) {
      // A failed roll leaves the watermark where it was: queries just read more raw rows.
      console.error("[usageRollup] failed:", error?.message || error);
    }
  };
  // Started from a microtask, AFTER the assignment: an immediately-finished loop (nothing
  // to roll) would otherwise clear `running` before it was set and leave it stuck.
  state.running = Promise.resolve().then(run).finally(() => { state.running = null; });
  return state.running;
}

// ─── invalidation and retention ───────────────────────────────────────────────

// Bumped whenever rolled rows are thrown away. A read that yields between slices compares it
// before and after: if it moved, rows it had not read yet may be gone, so it reads raw.
function epochState() {
  if (!globalThis.__usageRollupEpoch) globalThis.__usageRollupEpoch = { n: 0 };
  return globalThis.__usageRollupEpoch;
}
export const rollupEpoch = () => epochState().n;
function bumpRollupEpoch() { epochState().n += 1; }

/**
 * Forget everything from the hour containing `timestamp` onwards, so the next roll
 * recomputes it from the raw rows. Used when raw rows were deleted (a customer wiping their
 * request log): the rollup must not keep numbers the raw table no longer supports.
 */
export function invalidateRollupFromSync(db, timestamp) {
  const ms = Date.parse(timestamp);
  if (!Number.isFinite(ms)) return;
  bumpRollupEpoch();
  const start = hourStart(ms);
  const hour = hourKey(start);
  db.run(`DELETE FROM usageRollupProvider WHERE hour >= ?`, [hour]);
  db.run(`DELETE FROM usageRollupKey WHERE hour >= ?`, [hour]);
  db.run(`DELETE FROM usageRollupOwnerPeak WHERE hour >= ?`, [hour]);
  const wm = getWatermarkMs(db);
  if (wm != null && wm > start) setWatermark(db, start);
}

/** Drop rolled hours older than the retention cut-off, like the raw rows they summarise. */
export function pruneRollupSync(db, cutoffIso) {
  const ms = Date.parse(cutoffIso);
  if (!Number.isFinite(ms)) return;
  const hour = hourKey(hourStart(ms));
  db.run(`DELETE FROM usageRollupProvider WHERE hour < ?`, [hour]);
  db.run(`DELETE FROM usageRollupKey WHERE hour < ?`, [hour]);
  db.run(`DELETE FROM usageRollupOwnerPeak WHERE hour < ?`, [hour]);
}

// ─── planning a range ─────────────────────────────────────────────────────────

/**
 * Split [startMs, endMs] (either may be null = open) into whole rolled hours and the raw
 * edges. `endMs` is inclusive, like the raw queries. Returns
 *   { rollup: { fromHour, toHour } | null, raw: [{ startDate?, endDate? }] }
 * where each raw entry is an ISO range for the sliced raw reader, and toHour is exclusive.
 */
export function planRollupRange(db, startMs, endMs, { useRollup = true } = {}) {
  const whole = [{ startDate: startMs == null ? undefined : isoOf(startMs), endDate: endMs == null ? undefined : isoOf(endMs) }];
  if (!useRollup) return { rollup: null, raw: whole };
  const wm = getWatermarkMs(db);
  if (wm == null) return { rollup: null, raw: whole };

  let start = startMs;
  if (start == null) {
    const first = db.get(`SELECT MIN(timestamp) AS t FROM usageHistory`);
    start = first?.t ? Date.parse(first.t) : NaN;
    if (!Number.isFinite(start)) return { rollup: null, raw: whole };
  }
  const fullFrom = ceilHour(start);
  // Never trust a watermark past the last complete hour by the clock (it could have been
  // written while the host clock ran ahead): rows below it would be invisible.
  const fullTo = Math.min(wm, hourStart(Date.now() - ROLLUP_LAG_MS), endMs == null ? Infinity : hourStart(endMs + 1));
  if (!(fullFrom < fullTo)) return { rollup: null, raw: whole };

  const raw = [];
  if (start < fullFrom) raw.push({ startDate: isoOf(start), endDate: isoOf(fullFrom - 1) });
  if (endMs == null || fullTo <= endMs) {
    raw.push({ startDate: isoOf(fullTo), endDate: endMs == null ? undefined : isoOf(endMs) });
  }
  return { rollup: { fromHour: hourKey(fullFrom), toHour: hourKey(fullTo) }, raw };
}

// ─── reading ──────────────────────────────────────────────────────────────────

const ROLLUP_SLICE_HOURS = 48;

/**
 * Hand a rolled hour range [fromHour, toHour) to `fn` in slices of 48 hours, yielding to the
 * event loop between them. One GROUP BY over a month of key rows is a single synchronous
 * call (over a second at a million rows); in slices no stall lasts longer than one slice.
 * Every reader's output is associative (sums, maxima), so the caller just folds the slices.
 */
export async function forEachRollupSlice({ fromHour, toHour }, fn, hoursPerSlice = ROLLUP_SLICE_HOURS) {
  const fromMs = Date.parse(`${fromHour}:00:00.000Z`);
  const toMs = Date.parse(`${toHour}:00:00.000Z`);
  for (let at = fromMs; at < toMs; at += hoursPerSlice * HOUR_MS) {
    fn({ fromHour: hourKey(at), toHour: hourKey(Math.min(at + hoursPerSlice * HOUR_MS, toMs)) });
    if (at + hoursPerSlice * HOUR_MS < toMs) await yieldToLoop();
  }
}


export function readProviderRollup(db, { fromHour, toHour }) {
  return db.all(
    `SELECT provider, SUM(requests) AS requests, SUM(input) AS input, SUM(output) AS output, SUM(costNano) AS costNano,
            SUM(cacheRead) AS cacheRead, SUM(cacheCreation) AS cacheCreation,
            SUM(vendorCostNano) AS vendorCostNano, SUM(pricedRequests) AS pricedRequests,
            MAX(peakTpm) AS peakTpm, MAX(peakRpm) AS peakRpm, MAX(peakTokS) AS peakTokS, MAX(lastTs) AS lastTs,
            MAX(CASE WHEN lastTs IS NULL THEN hour END) AS unfilledHour
       FROM usageRollupProvider WHERE hour >= ? AND hour < ? GROUP BY provider`,
    [fromHour, toHour]
  );
}

/**
 * Per (provider, connection) breakdown over a rolled hour range (spec admin-usage-views
 * "Provider cache ratio and per-connection breakdown"). connectionId '' = no recorded
 * connection on those requests — surfaced as its own row, like any other connection.
 */
export function readProviderConnectionRollup(db, { fromHour, toHour }) {
  return db.all(
    `SELECT provider, connectionId, SUM(requests) AS requests, SUM(input) AS input, SUM(output) AS output,
            SUM(cacheRead) AS cacheRead, SUM(cacheCreation) AS cacheCreation, SUM(costNano) AS costNano,
            SUM(vendorCostNano) AS vendorCostNano, SUM(pricedRequests) AS pricedRequests,
            MAX(lastTs) AS lastTs
       FROM usageRollupProvider WHERE hour >= ? AND hour < ? GROUP BY provider, connectionId`,
    [fromHour, toHour]
  );
}

// ─── provider lastTs backfill ─────────────────────────────────────────────────
// Provider hours rolled before `usageRollupProvider.lastTs` existed have no last-request
// time. They are filled IN PLACE from the raw rows of that one hour, newest hour first, one
// hour per turn of the event loop. Nothing else is touched: the key and owner-peak rollups
// (the Users tab) and the watermark stay as they are. Readers stay exact meanwhile: an
// unfilled hour is looked up in the raw rows (hourLastTsByProviderSync, once per hour).

/**
 * Fill lastTs for the newest unfilled provider hour older than `beforeHour` (exclusive;
 * null = no bound). Returns that hour, or null when none is left. One indexed scan of one
 * hour of raw rows; an hour whose raw rows are gone keeps NULL and is skipped by the cursor.
 */
export function backfillProviderLastTsStepSync(db, beforeHour = null) {
  const row = beforeHour == null
    ? db.get(`SELECT MAX(hour) AS h FROM usageRollupProvider WHERE lastTs IS NULL`)
    : db.get(`SELECT MAX(hour) AS h FROM usageRollupProvider WHERE lastTs IS NULL AND hour < ?`, [beforeHour]);
  const hour = row?.h;
  if (!hour) return null;
  const latest = hourLastTsByProviderSync(db, hour);
  db.transaction(() => {
    for (const [provider, lastTs] of latest) {
      db.run(
        `UPDATE usageRollupProvider SET lastTs = ? WHERE hour = ? AND provider = ? AND lastTs IS NULL`,
        [lastTs, hour, provider]
      );
    }
  });
  return hour;
}

/**
 * The newest raw request of every provider inside one hour, as Map(provider → ISO): ONE
 * scan of that hour on idx_uh_ts, grouped inside SQLite, whatever the number of providers.
 * Same provider rule as rollProviderHour.
 */
export function hourLastTsByProviderSync(db, hour) {
  const fromMs = Date.parse(`${hour}:00:00.000Z`);
  const rows = db.all(
    `SELECT COALESCE(NULLIF(provider, ''), 'unknown') AS provider, MAX(timestamp) AS lastTs
       FROM usageHistory
      WHERE timestamp >= ? AND timestamp < ? AND COALESCE(provider, '') != 'platform'
      GROUP BY COALESCE(NULLIF(provider, ''), 'unknown')`,
    [isoOf(fromMs), isoOf(fromMs + HOUR_MS)]
  );
  return new Map(rows.map((r) => [r.provider, r.lastTs]));
}

/**
 * Fill every unfilled provider hour in the background, once per process: one loop at a
 * time, a single hour per turn of the event loop; after a complete pass later calls return
 * at once (every hour rolled since then is written with its lastTs).
 */
export function scheduleProviderLastTsBackfill(db) {
  if (!globalThis.__providerLastTsBackfill) globalThis.__providerLastTsBackfill = { running: null, done: false };
  const state = globalThis.__providerLastTsBackfill;
  if (state.running) return state.running;
  if (state.done) return Promise.resolve();
  const run = async () => {
    try {
      let cursor = null;
      for (;;) {
        cursor = backfillProviderLastTsStepSync(db, cursor);
        if (cursor == null) break;
        await yieldToLoop();
      }
      state.done = true;
    } catch (error) {
      // Left unfilled: readers fall back to raw rows for those hours; the next call retries.
      console.error("[usageRollup] provider lastTs backfill failed:", error?.message || error);
    }
  };
  state.running = Promise.resolve().then(run).finally(() => { state.running = null; });
  return state.running;
}


export function readKeyRollup(db, { fromHour, toHour }) {
  return db.all(
    `SELECT apiKeyId, rawHash, model AS m, SUM(requests) AS n, SUM(input) AS pin, SUM(output) AS pout,
            SUM(cacheRead) AS cr, SUM(cacheCreation) AS cc, SUM(costNano) AS costNano,
            SUM(vendorCostNano) AS vendorCostNano, SUM(pricedRequests) AS pricedRequests,
            MAX(lastTs) AS lastTs, MAX(est) AS est
       FROM usageRollupKey WHERE hour >= ? AND hour < ? GROUP BY apiKeyId, rawHash, model`,
    [fromHour, toHour]
  );
}

export function readOwnerPeakRollup(db, { fromHour, toHour }) {
  return db.all(
    `SELECT owner, MAX(peakTpm) AS peakTpm, MAX(peakRpm) AS peakRpm
       FROM usageRollupOwnerPeak WHERE hour >= ? AND hour < ? GROUP BY owner`,
    [fromHour, toHour]
  );
}
