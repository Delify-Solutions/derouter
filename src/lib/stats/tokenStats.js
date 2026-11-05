// Token usage statistics for the admin "Thống kê" page (change usage-analytics).
//
// One question, answered in SQL: how many requests and tokens (input, output,
// cached), at what cost, per time bucket and per model / provider / customer,
// over a chosen range. Buckets are Vietnam local time (UTC+7, no DST). Rows of the
// `platform` pseudo-provider (requests refused by key limits) are left out: they
// moved no tokens.
//
// Synchronous, adapter first, relative imports only (tests import it directly).

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

function usageWhere(q) {
  const conds = ["u.timestamp >= ?", "u.timestamp <= ?", "COALESCE(u.provider, '') != 'platform'"];
  const params = [q.from, q.to];
  if (q.userId) { conds.push(`${OWNER_SQL} = ?`); params.push(q.userId); }
  if (q.provider) { conds.push("u.provider = ?"); params.push(q.provider); }
  if (q.model) { conds.push(`(${REQUESTED_SQL} = ? OR u.model = ?)`); params.push(q.model, q.model); }
  return { where: conds.join(" AND "), params };
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
export function tokenStatsSync(db, q) {
  const bucket = BUCKET_SQL[q.granularity]("u.timestamp");
  const group = GROUP_SQL[q.groupBy];
  const { where, params } = usageWhere(q);

  const rows = db.all(
    `SELECT ${bucket} AS bucket, ${group} AS grp,
            COUNT(*) AS requests,
            SUM(CASE WHEN u.status = 'error' THEN 1 ELSE 0 END) AS errors,
            SUM(${INPUT_SQL}) AS input, SUM(${OUTPUT_SQL}) AS output, SUM(${CACHED_SQL}) AS cached,
            SUM(${COST_SQL}) AS cost
       FROM ${USAGE_FROM}
      WHERE ${where}
      GROUP BY bucket, grp`,
    params
  );

  // Credit taken from customers: the charge rows of the ledger, tied to their
  // request when there is one. Grouped the same way; a charge with no request
  // row falls under "" (unknown) for model and provider.
  // A charge belongs to its request's time (a back-charge is written later than
  // the request): the same instant both filters and buckets it. A charge is never
  // written before its request, so `c.createdAt >= from` only narrows the scan.
  // Unlimited plans ledger their spend as charges that take no credit: left out.
  const chargeAt = "COALESCE(u.timestamp, c.createdAt)";
  const chargeBucket = BUCKET_SQL[q.granularity](chargeAt);
  const chargeGroup = q.groupBy === "user" ? "COALESCE(c.userId, '')" : group;
  const chargeConds = [
    "c.kind = 'charge'", "c.createdAt >= ?", `${chargeAt} >= ?`, `${chargeAt} <= ?`,
    "json_extract(c.meta, '$.unlimited') IS NOT 1",
  ];
  const chargeParams = [q.from, q.from, q.to];
  if (q.userId) { chargeConds.push("c.userId = ?"); chargeParams.push(q.userId); }
  if (q.provider) { chargeConds.push("u.provider = ?"); chargeParams.push(q.provider); }
  if (q.model) { chargeConds.push(`(${REQUESTED_SQL} = ? OR u.model = ?)`); chargeParams.push(q.model, q.model); }
  const charges = db.all(
    `SELECT ${chargeBucket} AS bucket, ${chargeGroup} AS grp, SUM(-c.deltaNanoUsd) AS charged
       FROM creditLedger c
       LEFT JOIN usageHistory u ON u.id = c.usageId
       LEFT JOIN apiKeys k1 ON k1.id = u.apiKeyId
       LEFT JOIN apiKeys k2 ON u.apiKeyId IS NULL AND u.apiKey IS NOT NULL AND k2.key = u.apiKey
       LEFT JOIN deletedApiKeys dk ON k1.id IS NULL AND dk.apiKeyId = u.apiKeyId
      WHERE ${chargeConds.join(" AND ")}
      GROUP BY bucket, grp`,
    chargeParams
  );

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
  for (const row of rows) {
    addInto(totals, row);
    addInto(groupOf(row.grp), row);
    const b = bucketOf(row.bucket);
    addInto(b, row);
    const tokens = (Number(row.input) || 0) + (Number(row.output) || 0);
    b.groupTokens.set(row.grp, (b.groupTokens.get(row.grp) || 0) + tokens);
  }
  for (const row of charges) {
    const amount = Number(row.charged) || 0;
    totals.chargedNanoUsd += amount;
    groupOf(row.grp).chargedNanoUsd += amount;
    bucketOf(row.bucket).chargedNanoUsd += amount;
  }

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
export function statsFilterOptionsCachedSync(db, range, now = Date.now()) {
  const key = `${range.from.slice(0, 13)}|${range.to.slice(0, 13)}`;
  const hit = optionsCache.get(key);
  if (hit && now - hit.at < 5 * 60 * 1000) return hit.value;
  const value = statsFilterOptionsSync(db, range);
  if (optionsCache.size > 50) optionsCache.clear();
  optionsCache.set(key, { at: now, value });
  return value;
}

/** Filter choices for the page: providers and models seen in the range. */
export function statsFilterOptionsSync(db, { from, to }) {
  const providers = db.all(
    `SELECT DISTINCT provider FROM usageHistory
      WHERE timestamp >= ? AND timestamp <= ? AND provider IS NOT NULL AND provider != 'platform'
      ORDER BY provider LIMIT 200`,
    [from, to]
  ).map((row) => row.provider);
  const models = db.all(
    `SELECT DISTINCT COALESCE(json_extract(meta, '$.requestedModel'), model) AS m FROM usageHistory
      WHERE timestamp >= ? AND timestamp <= ? AND COALESCE(provider, '') != 'platform'
      ORDER BY m LIMIT 500`,
    [from, to]
  ).map((row) => row.m).filter(Boolean);
  return { providers, models };
}
