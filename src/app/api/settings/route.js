import { NextResponse } from "next/server";
import { getSettings, updateSettings, getKeyGroupById } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { resetComboRotation } from "open-sse/services/combo.js";
import { hasValidCliToken, isLocalRequest } from "@/dashboardGuard";
import bcrypt from "bcryptjs";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const SETTINGS_RESPONSE_HEADERS = {
  "Cache-Control": "no-store"
};

// Secrets must never be mass-assigned from request body (CWE-915)
const PROTECTED_SETTING_KEYS = ["password", "mitmSudoEncrypted"];

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

    const settings = await updateSettings(body);

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
