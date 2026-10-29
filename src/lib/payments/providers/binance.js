// Binance Pay provider: HMAC-signed transaction history (design D2/D3).
//
// Endpoint per the public docs (developers.binance.com/legacy-docs/pay/rest-api):
//   GET https://api.binance.com/sapi/v1/pay/transactions
//   headers X-MBX-APIKEY: <key>
//   query   startTime, endTime, limit, recvWindow, timestamp, signature
//   body    { code: "000000", message: "success", success: true, data: [
//               { orderType, transactionId, transactionTime /*ms*/,
//                 amount /*signed decimal string*/, currency,
//                 fundsDetail: [{ currency, amount }], payerInfo, receiverInfo } ] }
//
// Verified against those docs, with no field renames needed relative to design D3.
//
// The signature is HMAC-SHA256 over the exact query string that is sent, so this
// module builds the query ONCE and uses the same string for signing and for the
// URL — anything that re-encodes it would invalidate the signature.
//
// Relative imports only: `node --test` loads this module directly.
import crypto from "node:crypto";
import { parseDecimalToNano } from "../amounts.js";
import { fetchWithTimeout, providerMessage, readJson, sanitizeMessage } from "./http.js";

export const BINANCE_API_BASE = "https://api.binance.com";
export const BINANCE_TRANSACTIONS_PATH = "/sapi/v1/pay/transactions";

/**
 * Hex HMAC-SHA256 of `query` keyed by `secret` — exactly what Binance's
 * `signature` parameter is.
 *
 * @param {string} query
 * @param {string} secret
 * @returns {string}
 */
export function signQuery(query, secret) {
  return crypto.createHmac("sha256", String(secret ?? "")).update(String(query ?? ""), "utf8").digest("hex");
}

/** Stable, RFC3986-ish query string (sorted keys, so the same params sign identically). */
export function buildQuery(params) {
  const entries = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

/**
 * Normalize one Binance Pay transaction row.
 *
 * Returns null for a row that carries no USDT value: paying in BNB must not be
 * read as that many USDT, so such a row is "ignored" rather than mispriced
 * (design D3, ported from `binance_processor_extract_paid_amount`).
 *
 * @param {object} item
 * @returns {object|null}
 */
export function normalizeBinanceTransaction(item) {
  if (!item || typeof item !== "object") return null;

  const externalId = String(item.transactionId ?? "").trim();
  if (!externalId) return null;

  const signedAmount = typeof item.amount === "number" ? item.amount : Number(item.amount);
  const direction = Number.isFinite(signedAmount) && signedAmount > 0 ? "in" : "out";

  const currency = String(item.currency ?? "").toUpperCase();
  let nano = null;

  // Prefer the row's own amount only when it is already USDT. A mixed-asset
  // payment lists the USDT line in fundsDetail; using the top-level amount would
  // credit 0.0001 (BTC) as 0.0001 USDT.
  if (currency === "USDT" || currency === "") {
    nano = absNano(item.amount);
  }
  if (nano == null) {
    const funds = Array.isArray(item.fundsDetail) ? item.fundsDetail : [];
    const usdtLine = funds.find((fund) => String(fund?.currency ?? "").toUpperCase() === "USDT");
    if (usdtLine) nano = absNano(usdtLine.amount);
  }
  if (nano == null) return null;

  return {
    externalId,
    direction,
    amount: nano,
    currency: "USDT",
    content: String(item.note ?? item.merchantTradeNo ?? ""),
    occurredAt: toIso(item.transactionTime),
    accountNumber: null,
    raw: item,
  };
}

function toIso(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Binance Pay documents milliseconds; tolerate seconds from an old sandbox.
  const ms = n > 9_999_999_999 ? n : n * 1000;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * Nano-units of an amount that may be a decimal string ("23.72469206") or a
 * number. Always positive: Binance carries direction in the sign, and the
 * normalized transaction carries it in `direction`.
 */
function absNano(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return parseDecimalToNano(String(Math.abs(value)));
  }
  const text = String(value).trim().replace(/^\+/, "").replace(/^-/, "");
  return parseDecimalToNano(text);
}

/**
 * Poll the Binance Pay history.
 *
 * @param {{config?: object, secrets?: object, fetchImpl?: Function, now?: () => number,
 *          lookbackDays?: number, limit?: number, baseUrl?: string}} params
 * @returns {Promise<{ok: true, transactions: object[]} | {ok: false, error: string}>}
 */
export async function fetchBinanceTransactions({
  config = {},
  secrets = {},
  fetchImpl,
  now = () => Date.now(),
  lookbackDays = 3,
  limit = 100,
  baseUrl = BINANCE_API_BASE,
} = {}) {
  const apiKey = String(secrets.apiKey ?? "").trim();
  const apiSecret = String(secrets.apiSecret ?? "").trim();
  // Every message below is passed through sanitizeMessage with THESE values, so a
  // body echoing the key back (`"(bad request … key=ABC)"`) cannot leak it, no
  // matter which label the API used.
  const scope = { secrets: [apiKey, apiSecret] };
  if (!apiKey || !apiSecret) return { ok: false, error: "binance: thiếu API key hoặc API secret" };

  const endMs = now();
  const startMs = endMs - Math.max(1, Number(lookbackDays) || 3) * 86_400_000;

  const params = {
    endTime: endMs,
    limit: Math.min(Math.max(1, Number(limit) || 100), 100),
    recvWindow: 10_000,
    startTime: startMs,
    timestamp: endMs,
  };
  const query = buildQuery(params);
  const signature = signQuery(query, apiSecret);
  const base = String(baseUrl || BINANCE_API_BASE).replace(/\/+$/, "");
  const url = `${base}${BINANCE_TRANSACTIONS_PATH}?${query}&signature=${signature}`;

  const fetched = await fetchWithTimeout(fetchImpl, url, {
    method: "GET",
    headers: { "X-MBX-APIKEY": apiKey, Accept: "application/json" },
  });
  // The URL carries the signature; it must never appear in an error.
  if (!fetched.ok) return { ok: false, error: sanitizeMessage(`binance: ${fetched.error}`, scope) };

  const { response } = fetched;
  const status = Number(response?.status ?? 0);
  const body = await readJson(response);

  if (status && (status < 200 || status >= 300)) {
    // Binance errors carry { code: -1022, msg: "Signature for this request is not valid." }
    const code = body && typeof body.code === "number" ? body.code : null;
    const detail = providerMessage(body, ["msg", "message"], scope.secrets);
    const suffix = code != null || detail
      ? ` (${[code != null ? `code ${code}` : null, detail || null].filter(Boolean).join(", ")})`
      : "";
    return { ok: false, error: sanitizeMessage(`binance: HTTP ${status}${suffix}`, scope) };
  }
  if (!body || typeof body !== "object") {
    return { ok: false, error: sanitizeMessage("binance: phản hồi không phải JSON", scope) };
  }

  // Binance answers 200 with code != "000000" for some failures.
  const code = body.code != null ? String(body.code) : null;
  if (code && code !== "000000" && code !== "0") {
    const detail = providerMessage(body, ["message", "msg"], scope.secrets);
    return { ok: false, error: sanitizeMessage(`binance: lỗi ${code}${detail ? ` — ${detail}` : ""}`, scope) };
  }

  const rows = Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : null;
  if (!rows) return { ok: false, error: sanitizeMessage("binance: phản hồi không hợp lệ", scope) };

  const transactions = [];
  for (const row of rows) {
    const tx = normalizeBinanceTransaction(row);
    // A non-USDT row is dropped here: storing it as USDT would credit the wrong
    // amount, and marking it needs_review would page the admin about a crypto
    // payment the operator never offered.
    if (!tx) continue;
    transactions.push(tx);
  }
  return { ok: true, transactions };
}
