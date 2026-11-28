import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { cookies } from "next/headers";
import { setDashboardAuthCookie } from "@/lib/auth/dashboardSession";
import { isOidcConfigured } from "@/lib/auth/oidc";
import { isSamlConfigured } from "@/lib/auth/saml.js";
import { checkLock, recordFail, recordSuccess, getClientIp, adminIpBucket } from "@/lib/auth/loginLimiter";
import { isLocalRequest } from "@/dashboardGuard";
import { notifyAdminLogin } from "@/lib/notify/telegram";
import { getRequestIp, getRequestUserAgent } from "@/lib/auth/clientIp.js";
import { verifyAdminCredentials } from "@/lib/auth/adminUsers";

const RESET_HINT = "Forgot password? Reset to default via derouter CLI → Settings → Reset Password to Default.";
const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

function isTunnelRequest(request, settings) {
  const host = (request.headers.get("host") || "").split(":")[0].toLowerCase();
  const tunnelHost = settings.tunnelUrl ? new URL(settings.tunnelUrl).hostname.toLowerCase() : "";
  const tailscaleHost = settings.tailscaleUrl ? new URL(settings.tailscaleUrl).hostname.toLowerCase() : "";
  return (tunnelHost && host === tunnelHost) || (tailscaleHost && host === tailscaleHost);
}

export async function POST(request) {
  try {
    const ip = getClientIp(request);
    // Admin-only bucket: a customer login success can never clear it.
    const bucket = adminIpBucket(ip);
    const lock = checkLock(bucket.key);
    if (lock.locked) {
      return NextResponse.json(
        { error: `Too many failed attempts. Try again in ${lock.retryAfter}s. ${RESET_HINT}`, retryAfter: lock.retryAfter, resetHint: RESET_HINT },
        { status: 429, headers: { "Retry-After": String(lock.retryAfter) } }
      );
    }

    // Per-account login (spec admin-accounts "Per-account login"): username +
    // password instead of a password alone.
    const { username, password } = await request.json();
    const settings = await getSettings();

    // Block login via tunnel/tailscale if dashboard access is disabled
    if (isTunnelRequest(request, settings) && settings.tunnelDashboardAccess !== true) {
      return NextResponse.json({ error: "Dashboard access via tunnel is disabled" }, { status: 403 });
    }

    if (settings.authMode === "sso" || settings.authMode === "saml" || settings.authMode === "oidc") {
      const ssoType = settings.ssoType || (settings.authMode === "saml" ? "saml" : "oidc");
      if (ssoType === "saml" && isSamlConfigured(settings)) {
        return NextResponse.json({ error: "Password login is disabled. Use SAML SSO sign in." }, { status: 403 });
      }
      if (ssoType === "oidc" && isOidcConfigured(settings)) {
        return NextResponse.json({ error: "Password login is disabled. Use OIDC sign in." }, { status: 403 });
      }
    }

    // Unknown username and wrong password answer identically (spec "Unknown
    // username"): verifyAdminCredentials pays the same bcrypt cost either way.
    const result = await verifyAdminCredentials(username, password);

    if (result.disabled) {
      // Spec "Disable revokes access immediately": a clear, distinct message —
      // still counts as a failed attempt against the lockout bucket.
      recordFail(bucket.key, { maxFails: bucket.maxFails });
      return NextResponse.json(
        { error: "Tài khoản này đã bị vô hiệu hoá. Liên hệ Super Admin." },
        { status: 403 }
      );
    }

    if (!result.ok) {
      const { remainingBeforeLock } = recordFail(bucket.key, { maxFails: bucket.maxFails });
      const postLock = checkLock(bucket.key);
      if (postLock.locked) {
        return NextResponse.json(
          { error: `Too many failed attempts. Try again in ${postLock.retryAfter}s. ${RESET_HINT}`, retryAfter: postLock.retryAfter, resetHint: RESET_HINT },
          { status: 429, headers: { "Retry-After": String(postLock.retryAfter) } }
        );
      }
      return NextResponse.json(
        { error: `Invalid username or password. ${remainingBeforeLock} attempt(s) left before lockout.`, remainingBeforeLock },
        { status: 401 }
      );
    }

    recordSuccess(bucket.key);
    const { account } = result;

    // Legacy fresh-install bootstrap (unchanged behavior, design.md Migration Plan
    // step 2): the Super Admin's password has never been set for real and this is
    // a remote request — withhold any session exactly as the single-password flow
    // always did. A remote attacker must not be able to authenticate with the
    // publicly-known default password and then, e.g., disable auth entirely.
    const legacyMustChange =
      account.role === "super_admin" &&
      result.legacyDefaultPassword &&
      !process.env.INITIAL_PASSWORD &&
      !isLocalRequest(request);
    if (legacyMustChange) {
      return NextResponse.json(
        {
          success: false,
          error: "Default password must be changed before remote access. Change it from the local machine (or set INITIAL_PASSWORD).",
          mustChangePassword: true,
        },
        { status: 403, headers: NO_STORE_HEADERS }
      );
    }

    // Per-account forced reset (spec "Forced change on first login" / "Self-service
    // password change"): withhold the session until POST /api/auth/force-password-reset
    // proves the current (temporary) password and sets a real one.
    if (account.mustChangePassword) {
      return NextResponse.json(
        { success: false, mustChangePassword: true, username: account.username },
        { headers: NO_STORE_HEADERS }
      );
    }

    const cookieStore = await cookies();
    // The admin and customer sessions are independent cookies signed with
    // different keys, and every route reads exactly one of them, so signing in as
    // admin leaves a customer session on this browser untouched.
    await setDashboardAuthCookie(cookieStore, request, {
      adminUserId: account.id,
      username: account.username,
      role: account.role,
    });
    // Every admin sign-in is announced to the admin chat (spec telegram-notify).
    notifyAdminLogin({
      method: "password",
      ip: getRequestIp(request),
      userAgent: getRequestUserAgent(request),
      identity: account.username,
    }).catch(() => {});

    return NextResponse.json({ success: true, mustChangePassword: false }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
