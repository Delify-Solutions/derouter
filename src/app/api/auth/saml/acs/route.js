import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSettings } from "@/lib/localDb";
import {
  getSamlBaseUrl,
  isSamlConfigured,
  pickSamlDisplayName,
  pickSamlEmail,
  validateSamlResponse,
} from "@/lib/auth/saml.js";
import { setDashboardAuthCookie } from "@/lib/auth/dashboardSession";
import { checkLock, recordFail, recordSuccess, getClientIp, adminIpBucket } from "@/lib/auth/loginLimiter";
import { notifyAdminLogin } from "@/lib/notify/telegram";
import { getRequestIp, getRequestUserAgent } from "@/lib/auth/clientIp.js";

export async function POST(request) {
  const settings = await getSettings();
  const origin = getSamlBaseUrl(request, settings);
  // Admin-only bucket, shared with the admin password login.
  const bucket = adminIpBucket(getClientIp(request));
  const limiterKey = bucket.key;

  const lock = checkLock(limiterKey);
  if (lock.locked) {
    return NextResponse.redirect(
      new URL(
        `/admin/ss?error=${encodeURIComponent(`Too many failed attempts. Try again in ${lock.retryAfter}s.`)}`,
        origin
      )
    );
  }

  const cookieStore = await cookies();
  const storedRequestId = cookieStore.get("saml_state")?.value || "";

  // Always clear saml_state cookie after attempt
  cookieStore.delete("saml_state");

  // No saml_state cookie means this POST was not preceded by /api/auth/saml/start
  // in this browser. Such an assertion is either unsolicited (attacker-initiated
  // login) or a replay; refuse it before touching the SAML library.
  if (!storedRequestId) {
    recordFail(limiterKey, { maxFails: bucket.maxFails });
    return NextResponse.json(
      { error: "Missing SAML state" },
      { status: 403, headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    const formData = await request.formData();
    const SAMLResponse = formData.get("SAMLResponse");

    if (!SAMLResponse) {
      recordFail(limiterKey, { maxFails: bucket.maxFails });
      return NextResponse.redirect(new URL("/admin/ss?error=saml_missing_response", origin));
    }

    if (!isSamlConfigured(settings)) {
      recordFail(limiterKey, { maxFails: bucket.maxFails });
      return NextResponse.redirect(new URL("/admin/ss?error=saml_not_configured", origin));
    }

    const profile = await validateSamlResponse(request, { SAMLResponse }, storedRequestId, settings);

    const samlEmail = pickSamlEmail(profile, settings) || null;
    const samlName = pickSamlDisplayName(profile, settings) || "SAML user";

    recordSuccess(limiterKey);

    await setDashboardAuthCookie(cookieStore, request, {
      saml: true,
      samlEmail,
      samlName,
    });
    notifyAdminLogin({
      method: "saml",
      ip: getRequestIp(request),
      userAgent: getRequestUserAgent(request),
      identity: samlEmail,
    }).catch(() => {});

    return NextResponse.redirect(new URL("/dashboard", origin));
  } catch (error) {
    recordFail(limiterKey, { maxFails: bucket.maxFails });
    return NextResponse.redirect(
      new URL(`/admin/ss?error=${encodeURIComponent(error.message || "saml_acs_failed")}`, origin)
    );
  }
}
