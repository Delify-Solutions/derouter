/**
 * Deploy (deploy.com) balance — the prepaid credit the account actually bills against.
 *
 * Two credentials, two planes:
 *   - GET https://ajax-portal.deploy.com/api/profile
 *       Cookie: hive-portal-production=…
 *     → data.personal_organization.organization_id (or default_organization)
 *   - GET https://ajax-portal.deploy.com/api/organization/{orgId}/balance
 *     → data.payment_model, data.billing_info.balance (USD as a decimal string)
 *
 * The Secret Key does not open either path: the portal answers 401 to a Bearer key
 * and wants the portal session cookie. That is why the cookie is a second field on
 * the connection and why a key-only connection gets a message instead of a fake bar.
 *
 * A zero balance is not just a number here: Deploy answers every inference call with
 * HTTP 405 "Your Organization is currently paused…" once the balance is used up, so
 * the row doubles as the reason a model went dark.
 *
 * Nothing secret is logged: the cookie header and the response body (which carries the
 * account name and email) never reach a log line.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { normalizeCookieHeaderInput } from "../../utils/webCookieAuth.js";
import { toFiniteNumber } from "./shared.js";

export const DEPLOY_PORTAL_ORIGIN = "https://ajax-portal.deploy.com";
const PROFILE_PATH = "/api/profile";
const ORGANIZATION_PATH = "/api/organization";
const COOKIE_NAME = "hive-portal-production";

// Local test routing: an explicit process opt-in, loopback only — never a URL taken
// from a request or from stored connection data.
function portalOrigin() {
  const override = process.env.DEPLOY_LOCAL_TEST_ORIGIN;
  return override && /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(override)
    ? override
    : DEPLOY_PORTAL_ORIGIN;
}

/**
 * The cookie header for the portal, from whatever the operator pasted:
 * a bare value, `name=value`, a full DevTools blob, or a cookie-editor JSON array.
 * @returns {string} "" when there is nothing usable
 */
export function deployCookieHeader(rawCookie) {
  const raw = typeof rawCookie === "string" ? rawCookie.trim() : "";
  if (!raw) return "";
  let header = "";
  try {
    header = normalizeCookieHeaderInput(raw);
  } catch {
    // Malformed cookie JSON is not a crash: an unreadable cookie is no cookie.
    return "";
  }
  if (!header) return "";
  // A bare session value has no "=", so it is not a name=value pair yet.
  if (!header.includes("=")) return `${COOKIE_NAME}=${header}`;
  return header;
}

/** The organization id the balance path needs, from a /api/profile answer. */
export function deployOrganizationId(profile) {
  const data = profile?.data ?? profile;
  const id = data?.personal_organization?.organization_id
    ?? data?.default_organization?.organization_id
    ?? null;
  if (id === null || id === undefined) return null;
  const asString = String(id).trim();
  return /^[0-9]+$/.test(asString) ? asString : null;
}

/**
 * The quota row for one /balance answer. Kept pure so the shape is testable without
 * a network: `balance` is USD, and it is a prepaid purse, not a rate window — there is
 * no reset, so the bar shows the balance and the text names the number.
 */
export function deployQuotaFromBalance(balanceData) {
  const data = balanceData?.data ?? balanceData;
  const raw = data?.billing_info?.balance;
  const balance = toFiniteNumber(raw, NaN);
  if (!Number.isFinite(balance)) return null;
  const paymentModel = typeof data?.payment_model === "string" ? data.payment_model : "";
  return {
    plan: "Deploy",
    paymentModel,
    quota: {
      name: "Balance (USD)",
      // A prepaid balance has no allotment to measure against, so used/total are not
      // a ratio: the row is the number itself. 100% while there is money, 0% at zero.
      used: 0,
      total: balance,
      remainingPercentage: balance > 0 ? 100 : 0,
      resetAt: null,
      unlimited: false,
      isCreditBalance: true,
      currency: "USD",
      balance,
      paymentModel,
    },
  };
}

async function portalGet(origin, path, cookieHeader, proxyOptions, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await proxyAwareFetch(`${origin}${path}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Cookie: cookieHeader,
      },
      signal: controller.signal,
    }, proxyOptions);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string|null|undefined} apiKey  Deploy Secret Key (unused by the portal, kept for the signature)
 * @param {object|null} providerSpecificData  carries `cookie` and/or a pinned `organizationId`
 * @param {object|null} proxyOptions
 */
export async function getDeployUsage(apiKey = null, providerSpecificData = null, proxyOptions = null) {
  const psd = providerSpecificData && typeof providerSpecificData === "object" ? providerSpecificData : {};
  const cookieHeader = deployCookieHeader(psd.cookie);
  if (!cookieHeader) {
    return {
      plan: "Deploy",
      message:
        "Deploy không mở số dư bằng Secret Key. Dán cookie phiên của portal "
        + "(hive-portal-production=… trong DevTools của portal.deploy.com) vào kết nối này "
        + "để xem số dư còn lại.",
    };
  }

  const origin = portalOrigin();
  try {
    let organizationId = typeof psd.organizationId === "string" && /^[0-9]+$/.test(psd.organizationId.trim())
      ? psd.organizationId.trim()
      : null;

    if (!organizationId) {
      const profileRes = await portalGet(origin, PROFILE_PATH, cookieHeader, proxyOptions);
      if (profileRes.status === 401 || profileRes.status === 403) {
        return { plan: "Deploy", message: "Cookie phiên portal của Deploy đã hết hạn. Dán lại cookie mới." };
      }
      if (!profileRes.ok) {
        return { plan: "Deploy", message: `Deploy portal trả lỗi ${profileRes.status} khi đọc hồ sơ.` };
      }
      const profile = await profileRes.json().catch(() => null);
      organizationId = deployOrganizationId(profile);
      if (!organizationId) {
        return { plan: "Deploy", message: "Tài khoản Deploy này không có organization nào để đọc số dư." };
      }
    }

    const balanceRes = await portalGet(
      origin,
      `${ORGANIZATION_PATH}/${organizationId}/balance`,
      cookieHeader,
      proxyOptions,
    );
    if (balanceRes.status === 401 || balanceRes.status === 403) {
      return { plan: "Deploy", message: "Cookie phiên portal của Deploy đã hết hạn. Dán lại cookie mới." };
    }
    if (!balanceRes.ok) {
      return { plan: "Deploy", message: `Deploy portal trả lỗi ${balanceRes.status} khi đọc số dư.` };
    }
    const balanceData = await balanceRes.json().catch(() => null);
    const parsed = deployQuotaFromBalance(balanceData);
    if (!parsed) {
      return { plan: "Deploy", message: "Deploy không trả về số dư cho organization này." };
    }

    const quotas = { [parsed.quota.name]: parsed.quota };
    // A zero purse is the one state worth spelling out: it is why inference 405s.
    if (parsed.quota.balance <= 0) {
      return { plan: `${parsed.plan} (hết số dư)`, quotas };
    }
    return { plan: parsed.plan, quotas };
  } catch (error) {
    const aborted = error?.name === "AbortError";
    return {
      plan: "Deploy",
      message: aborted
        ? "Deploy portal không trả lời kịp. Thử lại sau."
        : `Deploy portal lỗi: ${error?.message || "không rõ nguyên nhân"}`,
    };
  }
}
