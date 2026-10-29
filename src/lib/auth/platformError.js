// One place for every denial the router produces itself (design D11).
//
// Upstream provider errors keep their own body untouched — they are relayed as the
// provider sent them. These are the proxy's own verdicts (bad key, expired key,
// suspended account, model outside the group, rate limit, quota, plan window), and
// they all share one OpenAI-compatible shape with a stable machine-readable `code`
// so a client can branch on it instead of pattern-matching a message.
//
// Relative imports only: this module is imported directly by tests under plain
// `node --test`, where the `@/` alias does not exist.

const MS = { second: 1000, minute: 60_000, hour: 3_600_000 };

/**
 * `type` is derived from the status, exactly like `buildErrorBody` in
 * open-sse/utils/error.js, except that the codes here are explicit rather than
 * inferred from a sentence.
 */
function typeForStatus(status) {
  switch (Number(status)) {
    case 401: return "authentication_error";
    case 402: return "insufficient_quota";
    case 403: return "permission_error";
    case 429: return "rate_limit_error";
    default: return "api_error";
  }
}

/**
 * Body for a platform denial.
 *
 * @param {{ status:number, code:string, message:string, resetAt?:string|null }} denial
 * @returns {{ error: { message:string, type:string, code:string, resetAt?:string } }}
 */
export function platformErrorBody({ status, code, message, resetAt = null }) {
  const error = {
    message: String(message ?? ""),
    type: typeForStatus(status),
    code: String(code ?? "error"),
  };
  // Only present when there is a real instant to point at: an absent field is
  // clearer than one that is explicitly null for codes that never reset.
  if (resetAt) error.resetAt = resetAt;
  return { error };
}

/**
 * `Response` for a platform denial: JSON, CORS-open (LLM clients call this from
 * their own processes), and `Retry-After` in whole seconds when known.
 */
export function platformErrorResponse({ status, code, message, resetAt = null, retryAfterSec = null }) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };
  if (retryAfterSec != null && Number.isFinite(Number(retryAfterSec))) {
    headers["Retry-After"] = String(Math.max(1, Math.ceil(Number(retryAfterSec))));
  }
  return new Response(JSON.stringify(platformErrorBody({ status, code, message, resetAt })), {
    status: Number(status) || 403,
    headers,
  });
}

/**
 * Human relative wait in Vietnamese: "1 giờ 12 phút", "45 phút", "30 giây".
 * Used by the plan-limit message, where the customer needs to know when to retry
 * without opening a dashboard.
 */
export function relativeWaitVi(ms) {
  const total = Math.max(0, Math.ceil(Number(ms) || 0));
  if (total <= MS.minute) {
    // Sub-minute waits read as seconds — "1 phút" for a 30-second wait would make
    // the customer retry too late.
    return `${Math.max(1, Math.ceil(total / MS.second))} giây`;
  }

  const hours = Math.floor(total / MS.hour);
  const minutes = Math.round((total % MS.hour) / MS.minute);

  // Rounding minutes up to 60 would read as "1 giờ 60 phút"; carry it instead.
  if (minutes >= 60) return `${hours + 1} giờ`;
  if (hours > 0) return minutes > 0 ? `${hours} giờ ${minutes} phút` : `${hours} giờ`;
  return `${minutes} phút`;
}

/** Exact customer-facing messages (design D11). One place, so they cannot drift. */
export const PLATFORM_MESSAGES = {
  invalid_api_key: "API key không hợp lệ hoặc đã bị tắt.",
  key_expired: "API key đã hết hạn.",
  account_suspended: "Tài khoản đang bị khoá — liên hệ admin.",
  account_unverified: "Tài khoản chưa xác minh email.",
  group_missing: "Tài khoản chưa được gán nhóm hợp lệ — liên hệ admin.",
  rate_limit_rpm: "Vượt giới hạn RPM của nhóm, thử lại sau 60 giây.",
  rate_limit_tpm: "Vượt giới hạn TPM của nhóm, thử lại sau 60 giây.",
  budget_exhausted: "Key đã dùng hết ngân sách.",
  insufficient_quota: "Hết quota — mua gói hoặc nhập mã quà tặng tại /account/plans.",
};

/** `Model <model> không nằm trong nhóm của bạn.` */
export function modelNotAllowedMessage(model) {
  return `Model ${model} không nằm trong nhóm của bạn.`;
}

/** `Các gói đang chạm hạn mức, mở lại sau <relativeWaitVi>.` */
export function planLimitMessage(resetAt) {
  const wait = resetAt ? relativeWaitVi(new Date(resetAt).getTime() - Date.now()) : relativeWaitVi(0);
  return `Các gói đang chạm hạn mức, mở lại sau ${wait}.`;
}

/**
 * Record a platform denial in request history: one `requestDetails` row plus one
 * `usageHistory` row with `provider: "platform"`, so the admin details tab can
 * explain WHY a request was rejected and the key holder's history shows it.
 *
 * Fully defensive: logging must never be able to break the deny path, so every
 * failure (including a missing module on a partial install) is swallowed.
 */
export async function logPlatformDenial({ apiKey, model, status, message, resetAt = null }) {
  try {
    const { saveRequestDetail } = await import("../usageDb.js");
    const { buildRequestDetail, saveUsageError } = await import("../../../open-sse/handlers/chatCore/requestDetail.js");
    const statusText = String(status);
    saveRequestDetail(buildRequestDetail({
      provider: null,
      model: model || null,
      apiKey,
      status: statusText,
      errorSource: "platform",
      response: { error: message, resetAt: resetAt ?? undefined },
    }, { latency: { ttft: 0, total: 0 }, tokens: { prompt_tokens: 0, completion_tokens: 0 } })).catch(() => {});
    saveUsageError({
      provider: "platform",
      model: model || "unknown",
      apiKey,
      requestedModel: model || null,
      status: statusText,
      errorSource: "platform",
    }).catch(() => {});
  } catch {
    /* usage logging must never break the deny path */
  }
}
