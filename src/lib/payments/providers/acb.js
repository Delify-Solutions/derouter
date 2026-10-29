// ACB mobile-app client — port of
// `reference/topsubre-php/processing/payment/acb-lib.php` (design D10).
//
// ACB publishes no API docs for this surface. Everything below mirrors what
// `acb-lib.php` actually does, including the parts that look odd, because they are
// what works against the live app today:
//
//   login          POST /mb/v2/auth/tokens   { clientId, username, password, deviceId }
//                  success  = response has `accessToken`
//   history        GET  /mb/legacy/ss/cs/person/transaction-history/list
//                       ?account=&transactionType=ALL&from=<ms>&to=<ms>&min=&max=
//   notifications  GET  /mb/legacy/ss/cs/bankservice/v2/notifications
//                       ?page=0&size=<n>&language=en     (sent with app version 3.52.0)
//
// Token lifecycle (the part worth restating): one cached token is reused until ACB
// refuses it. `isTokenExpiredResponse` recognises all three refusals the app shows —
// a body with an `exp` key, `message === "Unauthorized"`, or a bare 401 with a
// non-JSON body (which `CURL2` turned into `{message: "Unauthorized"}`). On a
// refusal the token is dropped, the login runs ONCE more and the call is retried
// ONCE. A second refusal is an error, never a loop.
//
// Signal handling is deliberate: `null` means "token expired, caller knows", and a
// non-null failure is an error. That distinction is what keeps a real outage from
// being reported as "no transactions".
//
// Relative imports only: `node --test` loads this module directly.
import crypto from "node:crypto";
import { fetchWithTimeout, readJson, readText, sanitizeMessage, secretValues } from "./http.js";

export const ACB_DEFAULT_BASE_URL = "https://apiapp.acb.com.vn";

export const ACB_ROUTES = {
  login: "/mb/v2/auth/tokens",
  history: "/mb/legacy/ss/cs/person/transaction-history/list",
  notifications: "/mb/legacy/ss/cs/bankservice/v2/notifications",
};

// App identity constants from acb-lib.php's constructor. They are ACB app
// constants, not account credentials, but they are still read from provider
// config / environment so an app update can be applied without a code change.
export const ACB_DEFAULTS = {
  clientId: "iuSuHYVufIUuNIREV0FB9EoLn9kHsDbm",
  apiKey: "CQk6S5usauGmMgMYLGqCuDtgtqIM8FI1",
  deviceId: "E80CFFC6-F3CF-4718-B274-97DAFE0BE365",
  appVersion: "3.50.0",
  // Notifications are fetched with a newer version than the rest, exactly as the
  // reference does (`buildHeaders($token, '3.52.0')`).
  notificationsAppVersion: "3.52.0",
};

const HISTORY_LOOKBACK_DAYS = 30;
const HISTORY_MAX_ROWS = 100;

/**
 * Resolve the app identity: provider config overrides, then environment, then the
 * documented defaults.
 *
 * @param {object} config provider `config` JSON
 * @param {object} [env]
 */
export function resolveAcbIdentity(config = {}, env = process.env) {
  const pick = (value, envKey, fallback) => {
    if (typeof value === "string" && value.trim()) return value.trim();
    const fromEnv = env?.[envKey];
    if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
    return fallback;
  };
  return {
    clientId: pick(config.clientId, "ACB_CLIENT_ID", ACB_DEFAULTS.clientId),
    apiKey: pick(config.appApiKey ?? config.apiKey, "ACB_API_KEY", ACB_DEFAULTS.apiKey),
    deviceId: pick(config.deviceId, "ACB_DEVICE_ID", ACB_DEFAULTS.deviceId),
    appVersion: pick(config.appVersion, "ACB_APP_VERSION", ACB_DEFAULTS.appVersion),
  };
}

/**
 * Headers for every ACB call (design D10). `Host` is intentionally not set: fetch
 * derives it from the URL, and a stale one breaks a per-test base URL.
 *
 * @param {{identity: object, token?: string|null, appVersion?: string, now?: () => number}} params
 * @returns {Record<string,string>}
 */
export function buildAcbHeaders({ identity = {}, token = null, appVersion, now } = {}) {
  const resolved = {
    apiKey: identity.apiKey ?? ACB_DEFAULTS.apiKey,
    deviceId: identity.deviceId ?? ACB_DEFAULTS.deviceId,
    appVersion: identity.appVersion ?? ACB_DEFAULTS.appVersion,
  };
  const requestId = uuidV4();
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "User-Agent": "ACB-MBA/9 CFNetwork/1399 Darwin/22.1.0",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "vi",
    "Cache-Control": "no-cache",
    apikey: resolved.apiKey,
    "x-app-version": appVersion ?? resolved.appVersion,
    "x-device-id": resolved.deviceId,
    // The app's conversation id is "<uuid>-<sequence>-".
    "x-conversation-id": `${requestId}-1-`,
    "x-request-id": requestId,
  };
  if (typeof token === "string" && token.trim()) headers.Authorization = `bearer ${token.trim()}`;
  return headers;
}

/** ACB says "your token is done" in three different ways (see header comment). */
export function isTokenExpiredResponse(body) {
  if (!body || typeof body !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(body, "exp")) return true;
  if (typeof body.message === "string" && body.message === "Unauthorized") return true;
  return false;
}

/** The history service is refused for accounts ACB does not allow to use it. */
export function isForbiddenServiceResponse(body) {
  return Boolean(body) && typeof body === "object" && body.message === "You cannot consume this service";
}

/**
 * The customer's memo lives after `transaction:`; keep only that, trimmed of the
 * spaces and asterisks banks pad it with.
 *
 * @param {string} description
 * @returns {string}
 */
export function extractMemo(description) {
  const text = String(description ?? "");
  const parts = text.split(/transaction:/i);
  const tail = parts.length > 1 ? parts.slice(1).join("transaction:") : text;
  return tail.trim().replace(/^[*\s]+|[*\s]+$/g, "");
}

/**
 * Direction and amount of a notification row.
 *
 * Direction: `(VND) -` or a debit keyword means money out; anything else is in —
 * the same default as the reference, which errs toward showing the payment to the
 * admin rather than hiding it.
 *
 * Amount: an `amount` field wins; otherwise the figure after `(VND) +`/`(VND) -`,
 * whose Vietnamese formatting uses both `,` and `.` as separators.
 *
 * @param {object} notification
 * @returns {{direction: "in"|"out", amount: number}} amount in đồng
 */
export function parseNotification(notification) {
  if (!notification || typeof notification !== "object") return { direction: "in", amount: 0 };

  const text = `${notification.title ?? ""} ${notification.message ?? ""}`.trim();
  const marker = /\(VND\)\s*([+-])/.exec(text);
  let direction;
  if (marker) {
    direction = marker[1] === "-" ? "out" : "in";
  } else {
    const lower = text.toLowerCase();
    direction = /ghi nợ|debit|debited/.test(lower) ? "out" : "in";
  }

  const fromField = Number(notification.amount);
  let amount = 0;
  if (Number.isFinite(fromField) && fromField !== 0) {
    amount = Math.round(Math.abs(fromField));
  } else {
    const numeric = /\(VND\)\s*[+-]\s*([\d.,]+)/.exec(text);
    if (numeric) {
      const digits = numeric[1].replace(/[.,]/g, "");
      const parsed = Number(digits);
      if (Number.isFinite(parsed)) amount = Math.round(parsed);
    }
  }
  return { direction, amount };
}

/**
 * Normalize one history row (design D3).
 *
 * @param {object} row
 * @returns {object|null}
 */
export function normalizeAcbHistoryRow(row) {
  if (!row || typeof row !== "object") return null;

  const rawId = row.id ?? row.transactionNumber ?? row.transactionID ?? "";
  const externalId = String(rawId).replace(/\s+/g, "");
  if (!externalId) return null;

  const type = String(row.type ?? "IN").toUpperCase();
  const direction = type === "OUT" ? "out" : "in";

  const numeric = Number(row.amount);
  const amount = Number.isFinite(numeric) ? Math.round(Math.abs(numeric)) : 0;

  return {
    externalId,
    direction,
    amount,
    currency: "VND",
    content: extractMemo(row.description ?? ""),
    occurredAt: toIso(row.postingDate ?? row.transactionDate ?? null),
    accountNumber: row.account == null ? null : String(row.account),
    raw: row,
  };
}

/**
 * Normalize one notification into the same shape, with the `n:` prefix that keeps
 * a notification apart from a history row of the same transfer (design D3).
 *
 * @param {object} notification
 * @param {string} [accountNumber]
 * @returns {object|null}
 */
export function normalizeAcbNotification(notification, accountNumber = "") {
  if (!notification || typeof notification !== "object") return null;

  const id = notification.id;
  if (id == null || String(id).trim() === "") return null;

  const { direction, amount } = parseNotification(notification);
  const content = extractMemo(notification.message ?? notification.title ?? "");

  return {
    externalId: `n:${String(id).replace(/\s+/g, "")}`,
    direction,
    amount,
    currency: "VND",
    content,
    occurredAt: toIso(notification.createdAt),
    accountNumber: accountNumber || null,
    raw: notification,
  };
}

function toIso(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n > 9_999_999_999 ? n : n * 1000;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function uuidV4() {
  const bytes = crypto.randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Fingerprint of everything that must invalidate a cached token when it changes
 * (design D1). A token minted for one device/account pair is not valid for
 * another, so reusing it would look like "ACB refused the login".
 */
export function acbCredentialFingerprint({ username = "", password = "", deviceId = "", baseUrl = "" } = {}) {
  return crypto
    .createHash("sha256")
    .update(`${username}|${password}|${deviceId}|${baseUrl}`, "utf8")
    .digest("hex");
}

/** Decode or text-parse one ACB response into `{ body, httpStatus, rawText }`. */
async function readAcbResponse(response) {
  const httpStatus = Number(response?.status ?? 0);
  const body = await readJson(response);
  if (body && typeof body === "object") return { body, httpStatus, rawText: null };
  const rawText = await readText(response);
  return { body: null, httpStatus, rawText };
}

/**
 * A bare 401 with a non-JSON body means the token is gone; the reference's `CURL2`
 * converted exactly this into `{message: "Unauthorized"}`.
 */
function expiredByStatus(body, httpStatus) {
  if (body && typeof body === "object") return false;
  return httpStatus === 401;
}

/**
 * Read an account's recent transactions.
 *
 * @param {{
 *   config?: object,
 *   secrets?: object,
 *   fetchImpl?: Function,
 *   now?: () => number,
 *   tokenStore?: { get(): Promise<string|null>|string|null, set(token: string): any, clear(): any },
 *   rows?: number,
 *   env?: object,
 *   dispatcher?: object,
 * }} params
 * @returns {Promise<{ok: true, transactions: object[], source: "history"|"notifications"}
 *                 | {ok: false, error: string}>}
 */
export async function fetchAcbTransactions({
  config = {},
  secrets = {},
  fetchImpl,
  now = () => Date.now(),
  tokenStore = null,
  rows = HISTORY_MAX_ROWS,
  env = process.env,
  dispatcher = null,
} = {}) {
  const username = String(secrets.username ?? "").trim();
  const password = String(secrets.password ?? "").trim();
  const accountNumber = String(config.accountNumber ?? "").trim();
  if (!username || !password) {
    return { ok: false, error: "acb: thiếu tên đăng nhập hoặc mật khẩu internet banking" };
  }
  if (!accountNumber) return { ok: false, error: "acb: chưa cấu hình số tài khoản" };

  // Identity has to be resolved before the redaction scope can include it: ACB
  // echoes the device id and apikey back in its refusals.
  const identity = resolveAcbIdentity(config, env);
  const scope = { secrets: [...secretValues(secrets), identity.deviceId, identity.apiKey] };
  const scoped = (value, extra = []) => sanitizeMessage(value, {
    secrets: [...scope.secrets, ...extra.filter((entry) => typeof entry === "string" && entry)],
  });

  const baseUrl = String(config.baseUrl || env?.ACB_BASE_URL || ACB_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fingerprint = acbCredentialFingerprint({
    username,
    password,
    deviceId: identity.deviceId,
    baseUrl,
  });

  const proxy = String(secrets.proxyUrl ?? "").trim();
  let fetchDispatcher = dispatcher;
  if (!fetchDispatcher && proxy) {
    // undici is a Next.js dependency already; importing it lazily keeps this module
    // free of a hard dependency for tests and for providers without a proxy.
    const resolved = await resolveProxyDispatcher(proxy);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    fetchDispatcher = resolved.dispatcher;
  }

  const doFetch = async (url, init) => {
    const opts = { ...init };
    if (fetchDispatcher) opts.dispatcher = fetchDispatcher;
    return fetchWithTimeout(fetchImpl, url, opts);
  };

  /** One login. Returns the token or an error message (never echoing credentials). */
  const login = async () => {
    const url = `${baseUrl}${ACB_ROUTES.login}`;
    const fetched = await doFetch(url, {
      method: "POST",
      headers: buildAcbHeaders({ identity }),
      body: JSON.stringify({
        clientId: identity.clientId,
        username,
        password,
        deviceId: identity.deviceId,
      }),
    });
    if (!fetched.ok) return { ok: false, error: scoped(`Đăng nhập ACB thất bại: ${fetched.error}`) };

    const { body } = await readAcbResponse(fetched.response);
    const token = body && typeof body === "object" ? body.accessToken : null;
    if (typeof token === "string" && token.trim()) return { ok: true, token: token.trim() };

    const detail = body && typeof body === "object"
      ? body.error ?? body.message ?? ""
      : "";
    return {
      ok: false,
      error: scoped(`Đăng nhập ACB thất bại${detail ? `: ${detail}` : ""}`),
    };
  };

  const cached = tokenStore ? await tokenStore.get() : null;
  // A cached token carrying a different fingerprint was minted for other
  // credentials; using it would only produce a refusal.
  let token = isUsableCachedToken(cached, fingerprint) ? cached.token : "";
  let freshLogin = false;
  if (!token) {
    if (cached && tokenStore) await tokenStore.clear();
    const loggedIn = await login();
    if (!loggedIn.ok) return { ok: false, error: loggedIn.error };
    token = loggedIn.token;
    freshLogin = true;
    if (tokenStore) await tokenStore.set(token);
  }

  const to = now();
  const from = to - HISTORY_LOOKBACK_DAYS * 86_400_000;

  /**
   * One attempt with `token`. Result kinds:
   *   { kind: "expired" }   ACB refused the token
   *   { kind: "ok", transactions, source }
   *   { kind: "error", error }
   */
  const attempt = async (activeToken) => {
    const historyUrl = `${baseUrl}${ACB_ROUTES.history}?${new URLSearchParams({
      account: accountNumber,
      transactionType: "ALL",
      from: String(from),
      to: String(to),
      min: "",
      max: "",
    }).toString()}`;
    // `min`/`max` are sent empty on purpose (the reference does), but an empty
    // value in URLSearchParams still yields `min=&max=`, which ACB accepts.
    const historyFetch = await doFetch(historyUrl, {
      method: "GET",
      headers: buildAcbHeaders({ identity, token: activeToken }),
    });
    if (!historyFetch.ok) return { kind: "error", error: scoped(`ACB: ${historyFetch.error}`, [activeToken]) };

    const history = await readAcbResponse(historyFetch.response);
    if (isTokenExpiredResponse(history.body) || expiredByStatus(history.body, history.httpStatus)) {
      return { kind: "expired" };
    }

    const historyRows = history.body && Array.isArray(history.body.data) ? history.body.data : null;
    if (historyRows && historyRows.length > 0) {
      const transactions = normalizeRows(historyRows, rows);
      if (transactions.length || historyRows.length === 0) {
        return { kind: "ok", transactions, source: "history" };
      }
      // Every row failed to normalize (no ids at all). Treat it as a refusal to
      // read rather than silently reporting "no payments".
      return { kind: "error", error: "ACB: phản hồi lịch sử giao dịch không hợp lệ" };
    }

    // Empty or blocked history → notifications (design D10 fallback).
    const notifyUrl = `${baseUrl}${ACB_ROUTES.notifications}?${new URLSearchParams({
      page: "0",
      size: String(Math.max(1, Number(rows) || HISTORY_MAX_ROWS)),
      language: "en",
    }).toString()}`;
    const notifyFetch = await doFetch(notifyUrl, {
      method: "GET",
      headers: buildAcbHeaders({
        identity,
        token: activeToken,
        appVersion: ACB_DEFAULTS.notificationsAppVersion,
      }),
    });
    if (!notifyFetch.ok) return { kind: "error", error: scoped(`ACB: ${notifyFetch.error}`, [activeToken]) };

    const notify = await readAcbResponse(notifyFetch.response);
    if (isTokenExpiredResponse(notify.body) || expiredByStatus(notify.body, notify.httpStatus)) {
      return { kind: "expired" };
    }

    if (notify.body && Number(notify.body.codeStatus) === 200 && Array.isArray(notify.body.data)) {
      const selected = selectNotificationsForAccount(notify.body.data, accountNumber);
      // Normalized as NOTIFICATIONS, not through the history mapper: a
      // notification's `id` would otherwise be read as a transaction id and lose
      // the `n:` prefix that keeps it distinct from the history row of the same
      // transfer.
      const transactions = normalizeNotifications(selected, rows, accountNumber);
      return { kind: "ok", transactions, source: "notifications" };
    }

    // History answered with an explicit empty list: genuinely no transactions.
    if (historyRows) return { kind: "ok", transactions: [], source: "history" };

    // Anything else is a failure, not "no transactions" — an outage must not look
    // like a quiet account.
    const detail = describeFailure(history.body);
    return {
      kind: "error",
      error: scoped(`ACB: ${detail || "phản hồi không hợp lệ"}`),
    };
  };

  let result = await attempt(token);

  if (result.kind === "expired" && !freshLogin) {
    // Recover exactly once: drop the cached token, log in again, retry once.
    if (tokenStore) await tokenStore.clear();
    const relogin = await login();
    if (!relogin.ok) return { ok: false, error: relogin.error };
    token = relogin.token;
    freshLogin = true;
    if (tokenStore) await tokenStore.set(token);
    result = await attempt(token);
  }

  if (result.kind === "expired") {
    return { ok: false, error: "Token ACB bị từ chối sau khi đăng nhập lại" };
  }
  if (result.kind === "error") return { ok: false, error: result.error };

  return { ok: true, transactions: result.transactions, source: result.source };
}

function isUsableCachedToken(cached, fingerprint) {
  if (!cached || typeof cached !== "object") return false;
  if (typeof cached.token !== "string" || !cached.token.trim()) return false;
  return cached.fingerprint === fingerprint;
}

function normalizeRows(rows, limit) {
  return sortAndLimit(rows.map((row) => normalizeAcbHistoryRow(row)).filter(Boolean), limit);
}

function normalizeNotifications(notifications, limit, accountNumber) {
  return sortAndLimit(
    notifications.map((notification) => normalizeAcbNotification(notification, accountNumber)).filter(Boolean),
    limit
  );
}

/** Newest first, so "the last N" is the first N (the reference sorts the same way). */
function sortAndLimit(transactions, limit) {
  const sorted = transactions.slice().sort((a, b) => {
    const left = a.occurredAt ? Date.parse(a.occurredAt) : 0;
    const right = b.occurredAt ? Date.parse(b.occurredAt) : 0;
    return right - left;
  });
  return sorted.slice(0, Math.max(1, Number(limit) || HISTORY_MAX_ROWS));
}

/**
 * Keep only the notifications that mention this account, measured on digits only
 * (ACB formats the account number differently in title and message). When nothing
 * matches, keep them all — the reference's behaviour, and the safer one: the
 * reconciliation rules still refuse anything that does not match an order.
 */
export function selectNotificationsForAccount(notifications, accountNumber) {
  const list = Array.isArray(notifications) ? notifications : [];
  const digits = String(accountNumber ?? "").replace(/\D+/g, "");
  if (!digits) return list;

  const matched = list.filter((notification) => {
    let serialized;
    try {
      serialized = JSON.stringify(notification);
    } catch {
      serialized = String(notification);
    }
    return serialized.replace(/\D+/g, "").includes(digits);
  });
  return matched.length ? matched : list;
}

function describeFailure(body) {
  if (!body || typeof body !== "object") return "";
  for (const key of ["error", "message", "description"]) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * Build an undici ProxyAgent for `http://user:pass@host:port`.
 *
 * A bad proxy URL is an error rather than a silent direct connection: a request
 * sent from the server's own IP is exactly what a proxy is there to avoid.
 */
async function resolveProxyDispatcher(proxyUrl) {
  let url;
  try {
    url = new URL(proxyUrl);
  } catch {
    return { ok: false, error: "acb: proxy URL không hợp lệ" };
  }
  if (!/^https?:$/.test(url.protocol)) {
    return { ok: false, error: "acb: proxy URL phải là http hoặc https" };
  }
  try {
    const { ProxyAgent } = await import("undici");
    return { ok: true, dispatcher: new ProxyAgent(proxyUrl) };
  } catch {
    return { ok: false, error: "acb: không khởi tạo được proxy (undici không có sẵn)" };
  }
}
