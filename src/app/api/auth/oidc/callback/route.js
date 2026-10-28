import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  exchangeOidcCode,
  fetchOidcDiscovery,
  getOidcRuntimeConfig,
  getPublicOrigin,
  isSameOriginCallback,
  pickOidcDisplayName,
  pickOidcEmail,
  verifyOidcIdToken,
  verifyOidcState,
} from "@/lib/auth/oidc";
import { setDashboardAuthCookie } from "@/lib/auth/dashboardSession";

function clearOidcCookies(cookieStore) {
  cookieStore.delete("oidc_state");
  cookieStore.delete("oidc_nonce");
  cookieStore.delete("oidc_code_verifier");
}

export async function GET(request) {
  const url = new URL(request.url);
  const publicOrigin = getPublicOrigin(request);
  const error = url.searchParams.get("error");
  if (error) {
    return NextResponse.redirect(new URL(`/admin/ss?error=${encodeURIComponent(error)}`, publicOrigin));
  }

  // Login CSRF guard: the state token below only proves the cookie matches, while
  // the Origin/Referer check proves the navigation started from our own page.
  if (!isSameOriginCallback(request, publicOrigin)) {
    return NextResponse.redirect(new URL("/admin/ss?error=oidc_cross_origin", publicOrigin));
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return NextResponse.redirect(new URL("/admin/ss?error=oidc_missing_code", publicOrigin));
  }

  const cookieStore = await cookies();
  const storedState = cookieStore.get("oidc_state")?.value;
  const storedNonce = cookieStore.get("oidc_nonce")?.value;
  const codeVerifier = cookieStore.get("oidc_code_verifier")?.value;

  if (!storedNonce || !codeVerifier || !verifyOidcState(storedState, state)) {
    clearOidcCookies(cookieStore);
    return NextResponse.redirect(new URL("/admin/ss?error=oidc_invalid_state", publicOrigin));
  }

  try {
    const config = await getOidcRuntimeConfig();
    if (!config) {
      clearOidcCookies(cookieStore);
      return NextResponse.redirect(new URL("/admin/ss?error=oidc_not_configured", publicOrigin));
    }

    const discovery = await fetchOidcDiscovery(config.issuerUrl);
    const discoveredIssuer = discovery.issuer || config.issuerUrl;
    const redirectUri = `${publicOrigin}/api/auth/oidc/callback`;
    const tokenData = await exchangeOidcCode({
      tokenEndpoint: discovery.token_endpoint,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      redirectUri,
      codeVerifier,
    });

    if (!tokenData.id_token) {
      throw new Error("OIDC provider did not return an id_token");
    }

    const payload = await verifyOidcIdToken({
      idToken: tokenData.id_token,
      issuer: discoveredIssuer,
      audience: config.clientId,
      jwksUri: discovery.jwks_uri,
      nonce: storedNonce,
    });

    clearOidcCookies(cookieStore);
    await setDashboardAuthCookie(cookieStore, request, {
      oidc: true,
      oidcSub: payload.sub || null,
      oidcEmail: pickOidcEmail(payload) || null,
      oidcName: pickOidcDisplayName(payload),
    });

    return NextResponse.redirect(new URL("/dashboard", publicOrigin));
  } catch (error) {
    clearOidcCookies(cookieStore);
    return NextResponse.redirect(new URL(`/admin/ss?error=${encodeURIComponent(error.message || "oidc_callback_failed")}`, publicOrigin));
  }
}
