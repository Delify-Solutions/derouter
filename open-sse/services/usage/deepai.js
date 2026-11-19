/**
 * DeepAI Code usage — the account's Theos allowance.
 *
 * GET /deepai_code/theos (the same call the desktop app's "Check balance" makes) answers
 * { enabled, balance, granted, refresh_at, lane_version, check_in }:
 *   - balance:    Theos left
 *   - granted:    the allowance granted per refresh period (the app shows it as
 *                 "Daily allowance: N Theos" and the bar as balance / granted "% left")
 *   - refresh_at: when the allowance is granted again
 *   - enabled:    false when the account has no Theos allowance
 * Amounts arrive as numbers or numeric strings (app v0.3.40, allowanceAmount()).
 */

import { fetchDeepAIAllowance, fetchDeepAIIsPro, isDeepAIModelMetered, resolveDeepAIModels } from "../deepaiClient.js";
import { parseResetTime } from "./shared.js";

function amount(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())) return Number(value.trim());
  return null;
}

/** The quota panel's view of a /theos body (exported for tests). */
export function deepaiUsageFromTheos(body, { isPro = null } = {}) {
  const plan = isPro === true ? "DeepAI Pro" : isPro === false ? "DeepAI Free" : "DeepAI";
  if (!body || typeof body !== "object") {
    return { plan, message: "DeepAI không trả về số dư Theos." };
  }
  if (body.enabled === false) {
    return { plan, message: "Tài khoản DeepAI này không có hạn mức Theos." };
  }
  const balance = amount(body.balance);
  if (balance === null) {
    return { plan, message: "Đã kết nối DeepAI nhưng không có số dư Theos." };
  }
  const granted = amount(body.granted);
  const resetAt = typeof body.refresh_at === "string" ? parseResetTime(body.refresh_at) : null;
  const left = Math.max(0, balance);

  if (granted !== null && granted > 0) {
    // A balance above the grant (carried over or topped up) reads as a full bar, as in the app.
    const total = Math.max(granted, left);
    const used = Math.max(0, total - left);
    return {
      plan,
      quotas: {
        Theos: {
          used,
          total,
          remaining: left,
          percentage: Math.round((used / total) * 100),
          colorPercentage: Math.round((left / total) * 100),
          percentageIsUsed: true,
          resetAt,
          unlimited: false,
        },
      },
    };
  }

  // No grant size: a bar has nothing to measure against, so the balance is stated as text.
  return {
    plan,
    message: `Còn ${left.toLocaleString("en-US")} Theos (DeepAI không báo hạn mức cấp mỗi kỳ).`,
  };
}

/**
 * @param {string|null|undefined} apiKey  the DeepAI api_key (stored as accessToken)
 * @param {object|null} providerSpecificData
 * @param {object|null} proxyOptions
 */
export async function getDeepAIUsage(apiKey, providerSpecificData = null, proxyOptions = null) {
  if (!apiKey || typeof apiKey !== "string") {
    return { message: "Tài khoản DeepAI chưa đăng nhập. Kết nối lại để xem số dư Theos." };
  }
  const [body, livePro, catalog] = await Promise.all([
    fetchDeepAIAllowance(apiKey, proxyOptions),
    fetchDeepAIIsPro(apiKey, proxyOptions),
    resolveDeepAIModels({ apiKey }, { proxyOptions }).catch(() => null),
  ]);
  // The live entitlement wins; the flag stored at sign-in is the fallback.
  const storedPro = typeof providerSpecificData?.isPro === "boolean" ? providerSpecificData.isPro : null;
  const isPro = livePro ?? storedPro;
  const models = catalog?.source === "static" ? null : deepaiModelSummary(catalog?.models);
  if (!body) {
    return {
      plan: isPro === true ? "DeepAI Pro" : isPro === false ? "DeepAI Free" : "DeepAI",
      message: "Không đọc được số dư Theos của DeepAI. Thử lại sau.",
      ...(models ? { deepaiModels: models } : {}),
    };
  }
  const usage = deepaiUsageFromTheos(body, { isPro });
  return models ? { ...usage, deepaiModels: models } : usage;
}

/** Which of the account's catalog models are free and which spend Theos (exported for tests). */
export function deepaiModelSummary(models) {
  if (!Array.isArray(models) || models.length === 0) return null;
  const free = [];
  const metered = [];
  for (const model of models) {
    const spends = isDeepAIModelMetered(model);
    if (spends === false) free.push(model.id);
    else if (spends === true) metered.push(model.theosPerRequest ? `${model.id} (${model.theosPerRequest})` : model.id);
  }
  return { free, metered };
}
