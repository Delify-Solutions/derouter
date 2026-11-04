import { NextResponse } from "next/server";
import { getSettings, updateSettings, getKeyGroupById, activateUnverifiedUsers, getGiftCodeById } from "@/lib/localDb";
import { validateAffiliateSettings } from "@/lib/affiliate/settings.js";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { resetComboRotation } from "open-sse/services/combo.js";
import { hasValidCliToken, isLocalRequest } from "@/dashboardGuard";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import {
  SESSIONS_VALID_AFTER_KEY,
  revokeAllDashboardSessionsValue,
  getDashboardAuthSession,
  setDashboardAuthCookie,
} from "@/lib/auth/dashboardSession";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SETTINGS_RESPONSE_HEADERS = {
  "Cache-Control": "no-store"
};

// Secrets must never be mass-assigned from request body (CWE-915)
// The session cut-off is only ever moved by a password change below.
const PROTECTED_SETTING_KEYS = ["password", "mitmSudoEncrypted", SESSIONS_VALID_AFTER_KEY];

export async function GET() {
  try {
    const settings = await getSettings();
    const { password, oidcClientSecret, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);
    
    const enableRequestLogs = process.env.ENABLE_REQUEST_LOGS === "true";
    const enableTranslator = process.env.ENABLE_TRANSLATOR === "true";
    
    return NextResponse.json({ 
      ...safeSettings, 
      enableRequestLogs,
      enableTranslator,
      hasPassword: !!password
    }, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();
    // Set by a password change: the session to re-issue once old ones are revoked.
    let reissueCookieFor = null;

    // Strip protected secrets before any internal handling sets them
    for (const key of PROTECTED_SETTING_KEYS) delete body[key];

    // The default customer group must name an existing ACTIVE group. Accepting an
    // unknown or inactive id would leave new signups unattached until the next boot
    // repaired them, which looks like "registration silently ignored my setting".
    if (Object.prototype.hasOwnProperty.call(body, "defaultUserGroupId")) {
      const requested = typeof body.defaultUserGroupId === "string" ? body.defaultUserGroupId.trim() : "";
      if (requested) {
        const group = await getKeyGroupById(requested);
        if (!group || !group.isActive) {
          return NextResponse.json(
            { error: "Nhóm mặc định phải là một nhóm đang hoạt động" },
            { status: 400, headers: SETTINGS_RESPONSE_HEADERS }
          );
        }
        body.defaultUserGroupId = requested;
      } else {
        body.defaultUserGroupId = "";
      }
    }

    // Telegram Mini App used to link customer accounts (spec telegram-link): both
    // names end up in a t.me URL, so only Telegram's own alphabet is accepted.
    for (const [key, label] of [["telegramBotUsername", "Bot username"], ["telegramMiniAppName", "Mini App short name"]]) {
      if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
      const value = typeof body[key] === "string" ? body[key].trim().replace(/^@/, "") : "";
      if (value && !/^[A-Za-z0-9_]{1,64}$/.test(value)) {
        return NextResponse.json(
          { error: `${label} chỉ gồm chữ, số và dấu gạch dưới` },
          { status: 400, headers: SETTINGS_RESPONSE_HEADERS }
        );
      }
      body[key] = key === "telegramMiniAppName" ? value || "link" : value;
    }

    // If updating password, hash it
    if (body.newPassword) {
      const settings = await getSettings();
      const currentHash = settings.password;

      // Verify current password if it exists
      if (currentHash) {
        if (!body.currentPassword) {
          return NextResponse.json({ error: "Current password required" }, { status: 400 });
        }
        const isValid = await bcrypt.compare(body.currentPassword, currentHash);
        if (!isValid) {
          return NextResponse.json({ error: "Invalid current password" }, { status: 401 });
        }
      } else {
        // First password ever set. Loopback is mandatory (the guard already requires
        // it when no hash exists); the CLI token is accepted as an equivalent proof
        // for headless installs. A remote caller can never reach this branch.
        const localOk = isLocalRequest(request) || await hasValidCliToken(request);
        if (!localOk) {
          return NextResponse.json(
            { error: "Local access required to set the initial password" },
            { status: 403 }
          );
        }
      }

      const salt = await bcrypt.genSalt(10);
      body.password = await bcrypt.hash(body.newPassword, salt);
      // Sign out every dashboard session issued so far; the caller gets a fresh
      // cookie after the update so changing the password does not log them out.
      reissueCookieFor = await getDashboardAuthSession((await cookies()).get("auth_token")?.value);
      body[SESSIONS_VALID_AFTER_KEY] = revokeAllDashboardSessionsValue();
      delete body.newPassword;
      delete body.currentPassword;
    }

    if (Object.prototype.hasOwnProperty.call(body, "oidcClientSecret")) {
      if (!body.oidcClientSecret || !String(body.oidcClientSecret).trim()) {
        delete body.oidcClientSecret;
      }
    }

    // Payment settings (spec payment-provider-admin "Payment settings"). Validated
    // here rather than only in the UI: the prefix ends up inside a UNIQUE index and
    // a regex, so an invalid one would silently make every code unmatchable.
    if (Object.prototype.hasOwnProperty.call(body, "paymentCodePrefix")) {
      const prefix = typeof body.paymentCodePrefix === "string" ? body.paymentCodePrefix.trim().toUpperCase() : "";
      if (!/^[A-Z]{2,6}$/.test(prefix)) {
        return NextResponse.json(
          { error: "Tiền tố mã thanh toán phải là 2–6 chữ cái in hoa" },
          { status: 400, headers: SETTINGS_RESPONSE_HEADERS }
        );
      }
      body.paymentCodePrefix = prefix;
    }

    if (Object.prototype.hasOwnProperty.call(body, "paymentOrderTtlMinutes")) {
      const ttl = Number(body.paymentOrderTtlMinutes);
      if (!Number.isInteger(ttl) || ttl < 10 || ttl > 1440) {
        return NextResponse.json(
          { error: "Thời hạn đơn thanh toán phải là số nguyên từ 10 đến 1440 phút" },
          { status: 400, headers: SETTINGS_RESPONSE_HEADERS }
        );
      }
      body.paymentOrderTtlMinutes = ttl;
    }

    if (Object.prototype.hasOwnProperty.call(body, "allowManualOrders")) {
      if (typeof body.allowManualOrders !== "boolean") {
        return NextResponse.json(
          { error: "allowManualOrders phải là true hoặc false" },
          { status: 400, headers: SETTINGS_RESPONSE_HEADERS }
        );
      }
    }

    // Affiliate program settings (spec affiliate-program "Program settings").
    // Validated here rather than only in the page: an out-of-range rate would
    // otherwise be stored and applied to every future commission.
    const affiliatePatch = validateAffiliateSettings(body);
    if (affiliatePatch.error) {
      return NextResponse.json(
        { error: affiliatePatch.error },
        { status: 400, headers: SETTINGS_RESPONSE_HEADERS }
      );
    }
    Object.assign(body, affiliatePatch.value);

    // The default referral gift must be an existing new-user code (design D7).
    if (
      Object.prototype.hasOwnProperty.call(body, "affiliateDefaultGiftCodeId") &&
      body.affiliateDefaultGiftCodeId
    ) {
      const gift = await getGiftCodeById(body.affiliateDefaultGiftCodeId);
      if (!gift || Number(gift.newUserOnly) !== 1) {
        return NextResponse.json(
          { error: "Chỉ chọn được mã người mới (bắt buộc liên kết Telegram)" },
          { status: 400, headers: SETTINGS_RESPONSE_HEADERS }
        );
      }
    }

    const settings = await updateSettings(body);
    if (reissueCookieFor) {
      const { authenticated, iat, exp, ...claims } = reissueCookieFor;
      await setDashboardAuthCookie(await cookies(), request, claims);
    }

    // Switching verification off must also release accounts that signed up while it
    // was on: their status was fixed at creation and nothing else would clear it.
    if (body.requireEmailVerification === false) {
      await activateUnverifiedUsers();
    }

    // Apply outbound proxy settings immediately (no restart required)
    if (
      Object.prototype.hasOwnProperty.call(body, "outboundProxyEnabled") ||
      Object.prototype.hasOwnProperty.call(body, "outboundProxyUrl") ||
      Object.prototype.hasOwnProperty.call(body, "outboundNoProxy")
    ) {
      applyOutboundProxyEnv(settings);
    }

    // Invalidate combo rotation state when strategy settings change
    if (
      Object.prototype.hasOwnProperty.call(body, "comboStrategy") ||
      Object.prototype.hasOwnProperty.call(body, "comboStickyRoundRobinLimit") ||
      Object.prototype.hasOwnProperty.call(body, "comboStrategies")
    ) {
      resetComboRotation();
    }

    if (
      Object.prototype.hasOwnProperty.call(body, "claudeAutoPing") ||
      Object.prototype.hasOwnProperty.call(body, "codexAutoPing")
    ) {
      // Keep the scheduler absent when no account opted in; load its provider graph only on demand.
      import("@/shared/services/quotaAutoPing")
        .then(({ configureQuotaAutoPing }) => {
          configureQuotaAutoPing(settings);
        })
        .catch((error) => console.warn("[AutoPing] settings update failed:", error.message));
    }

    const { password, oidcClientSecret, ...safeSettings } = settings;
    safeSettings.oidcConfigured = !!(safeSettings.oidcIssuerUrl && safeSettings.oidcClientId && oidcClientSecret);
    return NextResponse.json(safeSettings, { headers: SETTINGS_RESPONSE_HEADERS });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
