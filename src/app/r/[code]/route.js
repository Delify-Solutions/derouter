// GET /r/<CODE> — the referral link (design D6, spec "Referral link redirect").
//
// Public by design (PUBLIC_PAGE_PATHS in dashboardGuard.js): the visitor has no
// cookie and no account yet. A valid code sets `dr_ref` and sends the visitor to
// the register form; anything else redirects there without a cookie.
//
// Relative imports only would be wrong here — this is a Next route, where the `@/`
// alias resolves; `src/lib/affiliate/*` itself stays driver-free.
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAdapter } from "@/lib/db/driver.js";
import { normalizeReferralCode } from "@/lib/affiliate/codes.js";
import { resolveReferrerSync, recordClickSync, shouldCountClick } from "@/lib/affiliate/core.js";
import { readAffiliateSettingsSync } from "@/lib/affiliate/settings.js";
import { CLICK_LIMIT, REF_COOKIE } from "@/lib/affiliate/constants.js";
import { checkLimits, getClientIp } from "@/lib/auth/actionLimiter.js";
import { getPublicOrigin } from "@/lib/auth/oidc.js";

export const dynamic = "force-dynamic";

// A RELATIVE Location on purpose. In a route handler `request.url` carries the
// server's own listen address, which in Docker is `0.0.0.0:20127`; an absolute
// redirect built from it sent every referral visitor to an unreachable host.
// Browsers resolve a relative Location against the address they actually used,
// whatever proxy sits in between.
function redirectTo(path, { cookie = null } = {}) {
  const response = new NextResponse(null, {
    status: 302,
    headers: { Location: path, "Cache-Control": "no-store" },
  });
  if (cookie) response.cookies.set(cookie);
  return response;
}

export async function GET(request, { params }) {
  const { code } = await params;
  const normalized = normalizeReferralCode(code);
  if (!normalized) return redirectTo("/register");

  const db = await getAdapter();
  const settings = readAffiliateSettingsSync(db);
  const referrerId = resolveReferrerSync(db, normalized, { settings });
  if (!referrerId) {
    // Unknown code, blocked affiliate, deleted account or program off: one
    // behaviour, so the difference is not observable.
    return redirectTo("/register");
  }

  const cookieStore = await cookies();
  const existing = normalizeReferralCode(cookieStore.get(REF_COOKIE)?.value);

  // Count at most once per browser per code: a repeat click of the same link does
  // not inflate the figure, a newer valid link does.
  if (shouldCountClick(existing, normalized)) {
    const ip = getClientIp(request);
    const gate = checkLimits([{ bucket: `affiliate-click:${ip}`, ...CLICK_LIMIT }]);
    if (gate.allowed) {
      try {
        db.transaction(() => recordClickSync(db, referrerId));
      } catch {
        // The click counter must never break the redirect.
      }
    }
  }

  const days = Math.max(1, Math.floor(Number(settings.affiliateCookieDays) || 30));
  // Same reason as above: the scheme the visitor used, not the listen address's.
  const secure = getPublicOrigin(request).startsWith("https:");
  return redirectTo(`/register?ref=${encodeURIComponent(normalized)}`, {
    cookie: {
      name: REF_COOKIE,
      value: normalized,
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure,
      maxAge: days * 86400,
    },
  });
}
