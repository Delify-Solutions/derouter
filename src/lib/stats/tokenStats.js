// Token usage statistics for the admin "Thống kê" page (change usage-analytics).
//
// One question, answered in SQL: how many requests and tokens (input, output,
// cached), at what cost, per time bucket and per model / provider / customer,
// over a chosen range. Buckets are Vietnam local time (UTC+7, no DST). Rows of the
// `platform` pseudo-provider (requests refused by key limits) are left out: they
// moved no tokens.
//
// Async, adapter first, relative imports only (tests import it directly). Read in
// time slices (own loop below, not usageRepo.js's forEachUsageSlice — kept local
// so this read-only report never risks the billing-adjacent rollup backfill that
// shares that helper) so a wide range never runs as one giant synchronous scan
// that freezes the event loop for every other request on the server (the exact
// failure the sibling /dashboard/usage page had before its own rollup fix —
// see memory usage-dashboard-perf). A short in-process cache then absorbs
// repeat loads of the same filters, the same way statsFilterOptionsCachedSync
// already does below.

export const GRANULARITIES = ["hour", "day", "week", "month"];
export const GROUP_BYS = ["model", "upstream", "provider", "user"];
export const MAX_BUCKETS = 750;
/** Days of request rows kept (usageRepo prunes older ones); ledger charges stay. */
export const RETENTION_DAYS = Number.parseInt(process.env.LOG_RETENTION_DAYS || "60", 10) || 60;
const TZ = "+7 hours";
const TZ_MS = 7 * 3600 * 1000;

const BUCKET_SQL = {
  hour: (col) => `strftime('%Y-%m-%d %H:00', ${col}, '${TZ}')`,
  day: (col) => `date(${col}, '${TZ}')`,
  // Weeks start on Monday: step back 6 days, then forward to the next Monday.
  week: (col) => `date(${col}, '${TZ}', '-6 days', 'weekday 1')`,
  month: (col) => `strftime('%Y-%m', ${col}, '${TZ}')`,
};

// The account a request belongs to: the owner stored on the row (written since
// this change), else its key's owner, the legacy raw-key match, the tombstone of
// a key deleted in the last day, and finally the account its charge was taken
// from (older rows whose key and tombstone are both gone).
const OWNER_SQL = `COALESCE(u.userId, k1.userId, k2.userId, dk.userId,
  (SELECT c0.userId FROM creditLedger c0 WHERE c0.usageId = u.id LIMIT 1))`;
const REQUESTED_SQL = "COALESCE(json_extract(u.meta, '$.requestedModel'), '')";
const GROUP_SQL = {
  model: REQUESTED_SQL,
  upstream: "COALESCE(u.model, '')",
  provider: "COALESCE(u.provider, '')",
  user: `COALESCE(${OWNER_SQL}, '')`,
};
const INPUT_SQL = "COALESCE(u.promptTokens, json_extract(u.tokens, '$.prompt_tokens'), json_extract(u.tokens, '$.input_tokens'), 0)";
const OUTPUT_SQL = "COALESCE(u.completionTokens, json_extract(u.tokens, '$.completion_tokens'), json_extract(u.tokens, '$.output_tokens'), 0)";
const CACHED_SQL = "COALESCE(json_extract(u.tokens, '$.cached_tokens'), json_extract(u.tokens, '$.cache_read_input_tokens'), 0)";
const COST_SQL = "COALESCE(u.costNanoUsd, CAST(ROUND(COALESCE(u.cost, 0) * 1000000000) AS INTEGER), 0)";

const USAGE_FROM = `usageHistory u
  LEFT JOIN apiKeys k1 ON k1.id = u.apiKeyId
  LEFT JOIN apiKeys k2 ON u.apiKeyId IS NULL AND u.apiKey IS NOT NULL AND k2.key = u.apiKey
  LEFT JOIN deletedApiKeys dk ON k1.id IS NULL AND dk.apiKeyId = u.apiKeyId`;

function toMs(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms : null;
}

/** Local (UTC+7) calendar parts of an instant. */
function localParts(ms) {
  const d = new Date(ms + TZ_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), day: d.getUTCDate(), h: d.getUTCHours(), wd: d.getUTCDay() };
}
const pad = (n) => String(n).padStart(2, "0");

/** The bucket key of an instant, as the SQL above writes it. */
export function bucketKeyOf(ms, granularity) {
  const p = localParts(ms);
  if (granularity === "hour") return `${p.y}-${pad(p.m + 1)}-${pad(p.day)} ${pad(p.h)}:00`;
  if (granularity === "day") return `${p.y}-${pad(p.m + 1)}-${pad(p.day)}`;
  if (granularity === "month") return `${p.y}-${pad(p.m + 1)}`;
  const back = (p.wd + 6) % 7; // days since Monday
  const monday = localParts(ms - back * 86400000);
  return `${monday.y}-${pad(monday.m + 1)}-${pad(monday.day)}`;
}

/** Every bucket key from `fromMs` to `toMs`, in order. */
export function bucketKeys(fromMs, toMs, granularity) {
  const step = { hour: 3600000, day: 86400000, week: 86400000 }[granularity];
  const keys = [];
  const seen = new Set();
  if (granularity === "month") {
    let { y, m } = localParts(fromMs);
    const end = localParts(toMs);
    while (y < end.y || (y === end.y && m <= end.m)) {
      keys.push(`${y}-${pad(m + 1)}`);
      m += 1;
      if (m > 11) { m = 0; y += 1; }
      if (keys.length > MAX_BUCKETS) break;
    }
    return keys;
  }
  for (let t = fromMs; t <= toMs; t += step) {
    const key = bucketKeyOf(t, granularity);
    if (!seen.has(key)) { seen.add(key); keys.push(key); }
    if (keys.length > MAX_BUCKETS) break;
  }
  const last = bucketKeyOf(toMs, granularity);
  if (!seen.has(last)) keys.push(last);
  return keys;
}

/**
 * Validate the query. @returns {{ ok: true, value } | { ok: false, error }}
 * Defaults: the last 7 days, by day, grouped by model.
 */
export function parseStatsQuery(input = {}, now = Date.now()) {
  const to = toMs(input.to) ?? now;
  const from = toMs(input.from) ?? to - 7 * 86400000;
  if (from >= to) return { ok: false, error: "Thời điểm bắt đầu phải trước thời điểm kết thúc" };
  if (to - from > 400 * 86400000) return { ok: false, error: "Khoảng thời gian tối đa 400 ngày" };
  const granularity = GRANULARITIES.includes(input.granularity) ? input.granularity : "day";
  const groupBy = GROUP_BYS.includes(input.groupBy) ? input.groupBy : "model";
  const buckets = bucketKeys(from, to, granularity);
  if (buckets.length > MAX_BUCKETS) {
    return { ok: false, error: `Quá nhiều mốc (${MAX_BUCKETS} tối đa): chọn đơn vị lớn hơn hoặc khoảng ngắn hơn` };
  }
  const text = (value, max = 200) => (typeof value === "string" ? value.trim().slice(0, max) : "");
  return {
    ok: true,
    value: {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      granularity,
      groupBy,
      buckets,
      userId: text(input.userId, 64),
      provider: text(input.provider, 100),
      model: text(input.model, 200),
      top: Math.min(10, Math.max(1, Number.parseInt(input.top, 10) || 6)),
    },
  };
}

// Every filter EXCEPT the time range: the range is applied per slice by the
// loops below instead, so the full range is never scanned in one query.
function usageExtraWhere(q) {
  const conds = ["COALESCE(u.provider, '') != 'platform'"];
  const params = [];
  if (q.userId) { conds.push(`${OWNER_SQL} = ?`); params.push(q.userId); }
  if (q.provider) { conds.push("u.provider = ?"); params.push(q.provider); }
  if (q.model) { conds.push(`(${REQUESTED_SQL} = ? OR u.model = ?)`); params.push(q.model, q.model); }
  return { where: conds.join(" AND "), params };
}

// Same width usageRepo.js's own usage-slicing uses (USAGE_SLICE_MS): wide enough
// that a 90-day range (this page's longest preset) is ~720 slices, not
// thousands, narrow enough that one slice's scan is never heavy regardless of
// how much history the table holds.
const SLICE_MS = 3 * 60 * 60 * 1000;
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Runs `sql` once per [from, to) time slice (the last slice closes with <=,
 * matching what a single unsliced query over the whole range would have done),
 * yielding to the event loop between slices, and calls `onRows` with each
 * slice's result. `timeParams(sliceFromIso, sliceToIso, isLast)` returns the
 * slice's own two time-bound parameters, placed wherever the caller's SQL needs
 * them — the two queries here bind the range differently (plain columns vs. a
 * COALESCE expression, with or without an extra non-sliced lower-bound hint), so
 * this does not assume a fixed parameter shape the way a one-size helper would.
 */
async function forEachSlice(db, { fromMs, toMs, sliceMs = SLICE_MS, sql, timeParams, extraParams = [] }, onRows) {
  for (let sliceStart = fromMs; sliceStart < toMs; sliceStart += sliceMs) {
    const sliceEnd = Math.min(sliceStart + sliceMs, toMs);
    const isLast = sliceEnd >= toMs;
    const sliceFrom = new Date(sliceStart).toISOString();
    const sliceTo = new Date(sliceEnd).toISOString();
    const rows = db.all(sql(isLast), [...timeParams(sliceFrom, sliceTo, isLast), ...extraParams]);
    onRows(rows);
    if (!isLast) await yieldToLoop();
  }
}

const ZERO = () => ({ requests: 0, errors: 0, input: 0, output: 0, cached: 0, costNanoUsd: 0, chargedNanoUsd: 0 });

function addInto(target, row) {
  target.requests += Number(row.requests) || 0;
  target.errors += Number(row.errors) || 0;
  target.input += Number(row.input) || 0;
  target.output += Number(row.output) || 0;
  target.cached += Number(row.cached) || 0;
  target.costNanoUsd += Number(row.cost) || 0;
}

/**
 * The statistics for one validated query (parseStatsQuery's value).
 *
 * @returns {{
 *   query, totals, series: Array<{ bucket, ...metrics, byGroup: Record<string, number> }>,
 *   groups: Array<{ key, label, ...metrics, total, share }>, topKeys: string[]
 * }}
 *   Metrics: requests, errors, input, output, cached (tokens), costNanoUsd (the
 *   request's price), chargedNanoUsd (credit actually taken from customers).
 *   `byGroup` holds total tokens per top group, plus "__other".
 */
export async function tokenStats(db, q) {
  const bucket = BUCKET_SQL[q.granularity]("u.timestamp");
  const group = GROUP_SQL[q.groupBy];
  const { where: extraWhere, params: extraParams } = usageExtraWhere(q);

  const totals = ZERO();
  const byGroup = new Map();
  const byBucket = new Map(q.buckets.map((key) => [key, { bucket: key, ...ZERO(), groupTokens: new Map() }]));
  const groupOf = (key) => {
    if (!byGroup.has(key)) byGroup.set(key, { key, ...ZERO() });
    return byGroup.get(key);
  };
  const bucketOf = (key) => {
    if (!byBucket.has(key)) byBucket.set(key, { bucket: key, ...ZERO(), groupTokens: new Map() });
    return byBucket.get(key);
  };

  const fromMs = Date.parse(q.from);
  const toMs = Date.parse(q.to);

  await forEachSlice(db, {
    fromMs, toMs,
    sql: (isLast) => `SELECT ${bucket} AS bucket, ${group} AS grp,
            COUNT(*) AS requests,
            SUM(CASE WHEN COALESCE(u.status, 'ok') NOT IN ('ok', 'success', '499') THEN 1 ELSE 0 END) AS errors,
            SUM(${INPUT_SQL}) AS input, SUM(${OUTPUT_SQL}) AS output, SUM(${CACHED_SQL}) AS cached,
            SUM(${COST_SQL}) AS cost
       FROM ${USAGE_FROM}
      WHERE u.timestamp >= ? AND u.timestamp ${isLast ? "<=" : "<"} ? AND ${extraWhere}
      GROUP BY bucket, grp`,
    timeParams: (from, to) => [from, to],
    extraParams,
  }, (rows) => {
    for (const row of rows) {
      addInto(totals, row);
      addInto(groupOf(row.grp), row);
      const b = bucketOf(row.bucket);
      addInto(b, row);
      const tokens = (Number(row.input) || 0) + (Number(row.output) || 0);
      b.groupTokens.set(row.grp, (b.groupTokens.get(row.grp) || 0) + tokens);
    }
  });

  // Credit taken from customers: the charge rows of the ledger, tied to their
  // request when there is one. Grouped the same way; a charge with no request
  // row falls under "" (unknown) for model and provider.
  // A charge belongs to its request's time (a back-charge is written later than
  // the request): the same instant both filters and buckets it. A charge is never
  // written before its request, so a back-charge's own createdAt can land long
  // after its request's own bucket (days later, even past the overall range) — the
  // output window [q.from, q.to] below is therefore a FIXED filter on that
  // computed instant, applied the same way on every iteration, never the thing
  // we slice by. What we slice by instead is c.createdAt itself (indexed,
  // monotonic): each row is visited exactly once as its own slice scrolls from
  // q.from up to "now" (a charge can never be created after the instant this
  // query runs), instead of the whole range being rescanned once per request-time
  // slice above — that quadratic rescan was the actual freeze: every one of the
  // ~50-150 request-time slices re-read the entire charge history since q.from.
  // Unlimited plans ledger their spend as charges that take no credit: left out.
  const chargeAt = "COALESCE(u.timestamp, c.createdAt)";
  const chargeBucket = BUCKET_SQL[q.granularity](chargeAt);
  const chargeGroup = q.groupBy === "user" ? "COALESCE(c.userId, '')" : group;
  const chargeExtraConds = ["json_extract(c.meta, '$.unlimited') IS NOT 1"];
  const chargeExtraParams = [];
  if (q.userId) { chargeExtraConds.push("c.userId = ?"); chargeExtraParams.push(q.userId); }
  if (q.provider) { chargeExtraConds.push("u.provider = ?"); chargeExtraParams.push(q.provider); }
  if (q.model) { chargeExtraConds.push(`(${REQUESTED_SQL} = ? OR u.model = ?)`); chargeExtraParams.push(q.model, q.model); }

  await forEachSlice(db, {
    fromMs, toMs: Math.max(toMs, Date.now()),
    sql: (isLast) => `SELECT ${chargeBucket} AS bucket, ${chargeGroup} AS grp, SUM(-c.deltaNanoUsd) AS charged
       FROM creditLedger c
       LEFT JOIN usageHistory u ON u.id = c.usageId
       LEFT JOIN apiKeys k1 ON k1.id = u.apiKeyId
       LEFT JOIN apiKeys k2 ON u.apiKeyId IS NULL AND u.apiKey IS NOT NULL AND k2.key = u.apiKey
       LEFT JOIN deletedApiKeys dk ON k1.id IS NULL AND dk.apiKeyId = u.apiKeyId
      WHERE c.kind = 'charge'
        AND c.createdAt >= ? AND c.createdAt ${isLast ? "<=" : "<"} ?
        AND ${chargeAt} >= ? AND ${chargeAt} <= ?
        AND ${chargeExtraConds.join(" AND ")}
      GROUP BY bucket, grp`,
    timeParams: (from, to) => [from, to, q.from, q.to],
    extraParams: chargeExtraParams,
  }, (rows) => {
    for (const row of rows) {
      const amount = Number(row.charged) || 0;
      totals.chargedNanoUsd += amount;
      groupOf(row.grp).chargedNanoUsd += amount;
      bucketOf(row.bucket).chargedNanoUsd += amount;
    }
  });

  const allTokens = totals.input + totals.output;
  const labels = labelsFor(db, q.groupBy, [...byGroup.keys()]);
  const groups = [...byGroup.values()]
    .map((g) => ({
      ...g,
      label: labels.get(g.key) ?? (g.key || "(không rõ)"),
      total: g.input + g.output,
      share: allTokens > 0 ? (g.input + g.output) / allTokens : 0,
    }))
    .sort((a, b) => b.total - a.total || b.requests - a.requests || b.chargedNanoUsd - a.chargedNanoUsd);

  const topKeys = groups.filter((g) => g.total > 0).slice(0, q.top).map((g) => g.key);
  const topSet = new Set(topKeys);
  const series = [...byBucket.values()]
    .sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0))
    .map(({ groupTokens, ...b }) => {
      const split = {};
      let other = 0;
      for (const [key, value] of groupTokens) {
        if (topSet.has(key)) split[key] = value;
        else other += value;
      }
      if (other > 0) split.__other = other;
      return { ...b, byGroup: split };
    });

  // Request rows older than the retention are pruned (ledger charges are not):
  // the page says so instead of showing silent zeros.
  const retainedFrom = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();
  return {
    query: q, totals: { ...totals, total: allTokens }, series, groups, topKeys,
    retention: { days: RETENTION_DAYS, truncated: q.from < retainedFrom, retainedFrom },
  };
}

// Same 5-minute window as statsFilterOptionsCachedSync below, keyed by every
// field that changes the result (not just the range): two admins — or one
// flipping between tabs — asking the same question moments apart get the
// answer without another full sliced scan.
const statsCache = new Map();

/** tokenStats, cached. */
export async function tokenStatsCached(db, q, now = Date.now()) {
  const key = [q.from, q.to, q.granularity, q.groupBy, q.userId, q.provider, q.model, q.top].join("|");
  const hit = statsCache.get(key);
  if (hit && now - hit.at < 5 * 60 * 1000) return hit.value;
  const value = await tokenStats(db, q);
  if (statsCache.size > 50) statsCache.clear();
  statsCache.set(key, { at: now, value });
  return value;
}

/** Display names: the account e-mail for users; the key itself otherwise. */
function labelsFor(db, groupBy, keys) {
  const out = new Map();
  if (groupBy !== "user") return out;
  const ids = keys.filter(Boolean);
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = db.all(`SELECT id, email FROM users WHERE id IN (${chunk.map(() => "?").join(", ")})`, chunk);
    for (const row of rows) out.set(row.id, row.email);
  }
  for (const id of ids) if (!out.has(id)) out.set(id, `${id.slice(0, 8)}… (đã xóa)`);
  out.set("", "Admin / không có chủ");
  return out;
}

// Filter choices are the same for every click within a range: kept 5 minutes per
// (day of from, day of to), so changing the breakdown does not rescan.
const optionsCache = new Map();

/** Filter choices for the page, cached. */
export async function statsFilterOptionsCached(db, range, now = Date.now()) {
  const key = `${range.from.slice(0, 13)}|${range.to.slice(0, 13)}`;
  const hit = optionsCache.get(key);
  if (hit && now - hit.at < 5 * 60 * 1000) return hit.value;
  const value = await statsFilterOptions(db, range);
  if (optionsCache.size > 50) optionsCache.clear();
  optionsCache.set(key, { at: now, value });
  return value;
}

// Filter choices for the page: distinct providers and models seen in the range.
// Sliced the same way tokenStats() above slices its own scan (same SLICE_MS,
// yielding to the event loop between slices): this used to run as one
// unsliced `json_extract` scan over the whole range — unindexed, and (unlike
// tokenStats' own queries) not sliced at all — which blocked the single Node
// event loop for as long as a wide, uncached range took to scan, freezing
// every other request on the server. The exact failure class documented
// above for /dashboard/usage before its rollup fix (see memory
// usage-dashboard-perf), just reached by this page's own separate query.
export async function statsFilterOptions(db, { from, to }) {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const providers = new Set();
  const models = new Set();
  await forEachSlice(db, {
    fromMs, toMs,
    sql: (isLast) => `SELECT DISTINCT provider AS provider,
            COALESCE(json_extract(meta, '$.requestedModel'), model) AS m
       FROM usageHistory
      WHERE timestamp >= ? AND timestamp ${isLast ? "<=" : "<"} ? AND COALESCE(provider, '') != 'platform'`,
    timeParams: (sliceFrom, sliceTo) => [sliceFrom, sliceTo],
  }, (rows) => {
    for (const row of rows) {
      if (row.provider) providers.add(row.provider);
      if (row.m) models.add(row.m);
    }
  });
  return {
    providers: [...providers].sort().slice(0, 200),
    models: [...models].sort().slice(0, 500),
  };
}
