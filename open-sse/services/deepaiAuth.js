// DeepAI Code sign-in helpers (pure: no `@/` or bare open-sse imports, so tests can load them).
//
// Browser sign-in ends on a loopback callback with a one-time code (RFC 8252 style, no
// PKCE). The code is exchanged for a long-lived api_key — no refresh token, no expiry.
import { createHash, randomBytes } from "node:crypto";

export const DEEPAI_SIGN_IN_URL = "https://api.deepai.org/deepai_code/desktop_auth/";
export const DEEPAI_EXCHANGE_URL = "https://api.deepai.org/deepai_code/desktop_auth/exchange/";
const EXCHANGE_TIMEOUT_MS = 20_000;

/** The desktop app uses a 64-char hex state; reuse that shape. */
export function newDeepAIState() {
  return randomBytes(32).toString("hex");
}

export function buildDeepAISignInUrl(config, redirectUri, state) {
  let port = "";
  try { port = new URL(redirectUri).port; } catch { /* handled below */ }
  if (!port) throw new Error("DeepAI sign-in needs a loopback callback port");
  const url = new URL(config?.signInUrl || DEEPAI_SIGN_IN_URL);
  url.search = new URLSearchParams({ state, port }).toString();
  return url.href;
}

export async function exchangeDeepAICode(config, code) {
  const oneTimeCode = String(code || "").trim();
  if (!oneTimeCode || oneTimeCode.length > 4096) throw new Error("Missing DeepAI sign-in code");

  const response = await fetch(config?.exchangeUrl || DEEPAI_EXCHANGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ code: oneTimeCode }),
    redirect: "error",
    signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      response.status === 400 || response.status === 401
        ? "DeepAI sign-in link expired or was already used; start sign-in again"
        : response.status === 429
          ? "Too many DeepAI sign-in attempts; wait a moment and retry"
          : `DeepAI sign-in exchange failed (${response.status})`
    );
  }
  const data = await response.json().catch(() => null);
  if (!data || typeof data.api_key !== "string" || !data.api_key || /[\r\n]/.test(data.api_key)) {
    throw new Error("DeepAI returned an invalid sign-in response");
  }
  return {
    access_token: data.api_key,
    username: typeof data.username === "string" ? data.username : "",
    is_pro: data.is_pro === true,
  };
}

export function mapDeepAITokens(tokens) {
  // Without a username the key's own digest identifies the account, so signing in again
  // with the same key still updates one connection instead of adding a duplicate.
  const label = tokens.username || createHash("sha256").update(tokens.access_token).digest("hex").slice(0, 10);
  return {
    accessToken: tokens.access_token,
    refreshToken: null,
    expiresIn: null,
    // DeepAI exposes no email; connection de-duplication keys on email + username, so a
    // stable label (same convention as kimchi) lets a re-login update the same account.
    email: `deepai-user-${label}`,
    name: tokens.username || `DeepAI ${label}`,
    displayName: tokens.username || undefined,
    providerSpecificData: {
      authMethod: "oauth",
      username: tokens.username,
      isPro: tokens.is_pro,
    },
  };
}
