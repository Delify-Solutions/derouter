// web2m provider: a token-in-URL bank-history API (design D2/D3).
//
// There are no public docs for web2m. The behaviour ported here is exactly what
// `reference/topsubre-php/processing/payment/bank.php` does today
// (`fetchWeb2mTransactions`, `processWeb2mBank`), which is the only description of
// this API that exists:
//
//   GET ${apiBase}/${token}                          urlStyle "token"
//   GET ${apiBase}/${password}/${accountNumber}/${token}  urlStyle "password_account_token"
//   -> { transactions: [ { transactionID, type: "IN"|"OUT", amount,
//                          description, transactionDate? }, ... ] }
//
// The URL contains the credential, so it MUST never reach an error string, a log
// line or `paymentProviders.lastError`: every failure below returns a message built
// from a status code or a classified transport reason only.
//
// Relative imports only: `node --test` loads this module directly.
import { fetchWithTimeout, readJson, sanitizeMessage } from "./http.js";

/**
 * Build the history URL for a provider.
 *
 * Throws only on a missing credential or base URL — never echoes the token.
 *
 * @param {{config?: object, secrets?: object}} params
 * @returns {string}
 */
export function buildWeb2mUrl({ config = {}, secrets = {} } = {}) {
  const apiBase = String(config.apiBase || "").trim().replace(/\/+$/, "");
  if (!apiBase) throw new Error("web2m: chưa cấu hình API base URL");

  const token = String(secrets.token ?? "").trim();
  if (!token) throw new Error("web2m: chưa cấu hình token");

  const style = config.urlStyle === "password_account_token" ? "password_account_token" : "token";
  if (style === "password_account_token") {
    const password = String(secrets.password ?? "").trim();
    const accountNumber = String(config.accountNumber ?? "").trim();
    if (!password) throw new Error("web2m: kiểu URL này cần mật khẩu ngân hàng");
    if (!accountNumber) throw new Error("web2m: chưa cấu hình số tài khoản");
    // encodeURIComponent keeps a password containing `/` or `?` from changing the
    // path shape; web2m decodes the segment server-side.
    return `${apiBase}/${encodeURIComponent(password)}/${encodeURIComponent(accountNumber)}/${encodeURIComponent(token)}`;
  }
  return `${apiBase}/${encodeURIComponent(token)}`;
}

/**
 * Normalize one web2m history row (design D3).
 *
 * `transactionID` loses its spaces because web2m returns ids like
 * "FT24012 345678" and the same transfer is quoted differently in different rows.
 *
 * @param {object} item
 * @returns {object|null}
 */
export function normalizeWeb2mTransaction(item) {
  if (!item || typeof item !== "object") return null;

  const rawId = item.transactionID ?? item.transactionId ?? item.id ?? "";
  const externalId = String(rawId).replace(/\s+/g, "");
  if (!externalId) return null;

  const rawAmount = item.amount;
  const numeric = typeof rawAmount === "number"
    ? rawAmount
    : Number(String(rawAmount ?? "").replace(/[,\s]/g, ""));
  const amount = Number.isFinite(numeric) ? Math.round(Math.abs(numeric)) : 0;

  const type = String(item.type ?? "").toUpperCase();
  // Anything that is not explicitly inbound is outbound: an unknown direction must
  // never be treated as money arriving.
  const direction = type === "IN" ? "in" : "out";

  const occurredAt = toIso(item.transactionDate ?? item.transaction_date ?? null);

  return {
    externalId,
    direction,
    amount,
    currency: "VND",
    content: String(item.description ?? item.content ?? ""),
    occurredAt,
    // web2m's documented row shape has no account number; the provider config
    // names the account the URL is scoped to.
    accountNumber: null,
    raw: item,
  };
}

function toIso(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const ms = Number(value);
    // Heuristic used across providers: 10 digits = seconds, 13 = milliseconds.
    const normalized = ms > 9_999_999_999 ? ms : ms * 1000;
    const date = new Date(normalized);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  const text = String(value);
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text)) {
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(text);
  if (match) {
    const [, y, mo, d, h, mi, s = "00"] = match;
    // web2m quotes Vietnam time, like every Vietnamese bank feed.
    const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h) - 7, Number(mi), Number(s));
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * Poll web2m.
 *
 * @returns {Promise<{ok: true, transactions: object[]} | {ok: false, error: string}>}
 */
export async function fetchWeb2mTransactions({ config = {}, secrets = {}, fetchImpl, limit = 100 } = {}) {
  // The URL itself carries the token and, in the second style, the bank password.
  // Both are in scope for every message this function can produce.
  const scope = { secrets: [secrets.token, secrets.password, config.accountNumber] };
  let url;
  try {
    url = buildWeb2mUrl({ config, secrets });
  } catch (error) {
    // The throw messages above are ours and contain no credential.
    return { ok: false, error: sanitizeMessage(error?.message || "web2m: cấu hình chưa đủ", scope) };
  }

  const fetched = await fetchWithTimeout(fetchImpl, url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  // NEVER include `url` here: it carries the token or the bank password.
  if (!fetched.ok) return { ok: false, error: sanitizeMessage(`web2m: ${fetched.error}`, scope) };

  const { response } = fetched;
  const status = Number(response?.status ?? 0);
  const body = await readJson(response);

  if (status && (status < 200 || status >= 300)) {
    return { ok: false, error: sanitizeMessage(`web2m: HTTP ${status}`, scope) };
  }
  if (!body || !Array.isArray(body.transactions)) {
    // A well-formed empty answer is `{transactions: []}`; anything else is an
    // outage and must surface as an error rather than as "no payments".
    return { ok: false, error: "web2m: phản hồi không hợp lệ" };
  }

  const transactions = [];
  for (const item of body.transactions) {
    const tx = normalizeWeb2mTransaction(item);
    if (!tx) continue;
    transactions.push(tx);
    if (transactions.length >= Math.max(1, Number(limit) || 100)) break;
  }
  return { ok: true, transactions };
}
