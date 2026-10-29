// SePay provider: webhook verification, webhook/API row normalization, polling
// (design D2/D3/D7).
//
// Field names follow the public docs as of 2026-10
// (developer.sepay.vn/en/sepay-webhooks/tich-hop-webhook and
// developer.sepay.vn/en/sepay-api/v2/giao-dich/danh-sach):
//
//   webhook body  { id, gateway, transactionDate, accountNumber, subAccount, code,
//                   content, transferType, description, transferAmount,
//                   accumulated, referenceCode }
//   auth header   Authorization: Apikey <key>      (the "API Key" webhook mode)
//   v2 API        GET https://userapi.sepay.vn/v2/transactions,
//                 Authorization: Bearer <token>, rows { id (UUID), transaction_date,
//                 account_number, transfer_type, amount_in, amount_out, ... }
//
// Differences from design D3 as originally written, all verified against those
// docs and recorded in design.md:
//   * `direction` comes from `transferType` (webhook) / `transfer_type` (v2 API)
//     and the API reports amounts per direction (`amount_in`/`amount_out`) rather
//     than one signed figure;
//   * `content` on the v2 API row is `transaction_content`, and the API's `id` is a
//     UUID — the webhook's numeric `id` and the API's UUID are different values for
//     the same transfer, which is why polling stores its own dedup key
//     (`sepay-api:<id>`) while the webhook keeps `<id>`.
//
// Relative imports only: `node --test` loads this module directly.
import crypto from "node:crypto";
import { fetchWithTimeout, providerMessage, readJson, sanitizeMessage } from "./http.js";

export const SEPAY_API_BASE = "https://userapi.sepay.vn";
export const SEPAY_TRANSACTIONS_PATH = "/v2/transactions";

/**
 * Constant-time comparison of an `Authorization` header against the provider's
 * webhook key. Accepts only the documented `Apikey <key>` form.
 *
 * Lengths are compared first because `timingSafeEqual` throws on unequal buffers;
 * that leaks only the key's length, which is public (a 32-byte base64url value we
 * generate ourselves).
 *
 * @param {string|null|undefined} header
 * @param {string|null|undefined} webhookKey
 * @returns {boolean}
 */
export function verifyWebhookAuth(header, webhookKey) {
  if (typeof header !== "string" || typeof webhookKey !== "string") return false;
  if (!webhookKey) return false;

  const match = /^Apikey\s+(.+)$/i.exec(header.trim());
  if (!match) return false;

  const given = Buffer.from(match[1].trim(), "utf8");
  const expected = Buffer.from(webhookKey, "utf8");
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(given, expected);
}

/**
 * SePay's `YYYY-MM-DD HH:mm:ss` is Vietnam time (UTC+7, no DST). Converting to ISO
 * UTC here keeps every stored instant comparable with orders' ISO timestamps.
 */
export function sepayDateToIso(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  // Already ISO-ish with a zone: trust it.
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text)) {
    const parsed = Date.parse(text.replace(" ", "T"));
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(text);
  if (!match) return null;
  const [, y, mo, d, h, mi, s = "00"] = match;
  const ms = Date.UTC(
    Number(y), Number(mo) - 1, Number(d),
    Number(h) - 7, Number(mi), Number(s)
  );
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Integer đồng from a v2 amount field (already an integer) or a v1 decimal string. */
function vndAmount(value) {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(Math.abs(value)) : 0;
  if (typeof value !== "string" || !value.trim()) return 0;
  const cleaned = value.replace(/[,\s]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(Math.abs(n)) : 0;
}

/**
 * Normalize one SePay transaction — webhook body or v2 API row — to the shape in
 * design D3: `{ externalId, direction, amount, currency, content, occurredAt, raw }`.
 *
 * `externalId` is `String(id)` for both sources; the caller decides which prefix
 * (if any) keeps a webhook and an API poll from colliding on the same transfer.
 *
 * @param {object} payload
 * @returns {{externalId: string, direction: "in"|"out", amount: number, currency: "VND",
 *            content: string, occurredAt: string|null, accountNumber: string|null,
 *            raw: object}|null} null when the row carries no usable id
 */
export function normalizeSepayTransaction(payload) {
  if (!payload || typeof payload !== "object") return null;
  const id = payload.id;
  if (id == null || String(id).trim() === "") return null;

  const transferType = String(payload.transferType ?? payload.transfer_type ?? "").toLowerCase();
  // The webhook states direction; the v2 API states it too but also splits the
  // amount per direction, so fall back to the split when the flag is absent.
  const direction = transferType === "in" || transferType === "out"
    ? transferType
    : vndAmount(payload.amount_in) > 0 && vndAmount(payload.amount_out) === 0
      ? "in"
      : "out";

  const amount = payload.transferAmount != null
    ? vndAmount(payload.transferAmount)
    : direction === "in"
      ? vndAmount(payload.amount_in)
      : vndAmount(payload.amount_out);

  const content = String(
    payload.content ?? payload.transaction_content ?? payload.description ?? ""
  );
  const accountNumber = payload.accountNumber ?? payload.account_number ?? null;

  return {
    externalId: String(id).trim(),
    direction,
    amount,
    currency: "VND",
    content,
    occurredAt: sepayDateToIso(
      payload.transactionDate ?? payload.transaction_date ?? null
    ),
    accountNumber: accountNumber == null ? null : String(accountNumber),
    raw: payload,
  };
}

/**
 * Poll the v2 transaction list.
 *
 * @param {{config?: object, secrets?: object, fetchImpl?: Function, now?: () => number,
 *          lookbackHours?: number, limit?: number, baseUrl?: string}} params
 * @returns {Promise<{ok: true, transactions: object[]} | {ok: false, error: string}>}
 */
export async function fetchSepayTransactions({
  config = {},
  secrets = {},
  fetchImpl,
  now = () => Date.now(),
  lookbackHours = 24,
  limit = 100,
  baseUrl = SEPAY_API_BASE,
} = {}) {
  const token = typeof secrets.apiToken === "string" ? secrets.apiToken.trim() : "";
  // The API token is the only credential this fetcher holds; the webhook key never
  // travels with a poll, so it is not in scope here.
  const scope = { secrets: [token] };
  if (!token) return { ok: false, error: "sepay: chưa có API token để đọc giao dịch" };

  const to = new Date(now());
  const from = new Date(to.getTime() - Math.max(1, Number(lookbackHours) || 24) * 3600_000);
  const isoLocal = (date) => {
    // SePay expects `YYYY-MM-DD HH:mm:ss`; sending UTC keeps the window honest
    // even though their parser is timezone-naive about it (their docs say
    // Vietnam time). An hour of slack at each edge covers the difference.
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  };

  const params = new URLSearchParams({
    transaction_date_from: isoLocal(new Date(from.getTime() - 3600_000)),
    transaction_date_to: isoLocal(new Date(to.getTime() + 3600_000)),
    transfer_type: "in",
    transaction_date_sort: "desc",
    per_page: String(Math.min(Math.max(1, Number(limit) || 100), 100)),
  });

  const base = String(baseUrl || SEPAY_API_BASE).replace(/\/+$/, "");
  const url = `${base}${SEPAY_TRANSACTIONS_PATH}?${params.toString()}`;

  const fetched = await fetchWithTimeout(fetchImpl, url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!fetched.ok) return { ok: false, error: sanitizeMessage(`sepay: ${fetched.error}`, scope) };

  const { response } = fetched;
  const body = await readJson(response);
  const status = Number(response?.status ?? 0);

  if (status && (status < 200 || status >= 300)) {
    const detail = providerMessage(body, undefined, scope.secrets);
    return { ok: false, error: sanitizeMessage(`sepay: HTTP ${status}${detail ? ` — ${detail}` : ""}`, scope) };
  }
  if (body == null) return { ok: false, error: sanitizeMessage("sepay: phản hồi không phải JSON", scope) };

  const rows = Array.isArray(body) ? body : Array.isArray(body.data) ? body.data : null;
  if (!rows) {
    const detail = providerMessage(body, undefined, scope.secrets);
    return { ok: false, error: sanitizeMessage(`sepay: phản hồi không hợp lệ${detail ? ` — ${detail}` : ""}`, scope) };
  }

  const transactions = [];
  for (const row of rows) {
    const tx = normalizeSepayTransaction(row);
    if (!tx) continue;
    // API rows are namespaced so the same transfer seen through the webhook (a
    // numeric id) and through polling (a UUID) cannot both be stored.
    transactions.push({ ...tx, externalId: `sepay-api:${tx.externalId}` });
  }
  return { ok: true, transactions };
}
