import { getSettings } from "@/lib/localDb";
import { sendMail, buildVerificationEmail, buildResetEmail } from "@/lib/mail/mailer";
import { createVerification, replaceVerification } from "@/lib/db/repos/userRepo.js";
import { safeNext } from "@/shared/utils/safeNext";

// Shared pieces of the customer onboarding flow: where links point, and what the
// verification / reset mail looks like. Kept out of the route handlers so the
// resend route and the registration route cannot drift apart.

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

export const VERIFICATION_PURPOSE = "verify_email";
export const RESET_PURPOSE = "reset_password";

/**
 * Public origin for links in mail. `settings.publicBaseUrl` wins (the deployment
 * behind a proxy knows its own address); otherwise derive it from the request so a
 * fresh install works without configuration.
 */
export function resolveBaseUrl(request, settings) {
  const configured = typeof settings?.publicBaseUrl === "string" ? settings.publicBaseUrl.trim() : "";
  if (configured) return configured.replace(/\/+$/, "");
  try {
    const url = new URL(request.url);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "";
  }
}

export function siteNameOf(settings) {
  const name = typeof settings?.siteName === "string" ? settings.siteName.trim() : "";
  return name || "derouter";
}

export function verificationLink(token, request, settings, next = null) {
  const base = resolveBaseUrl(request, settings);
  const link = `${base}/verify-email?token=${encodeURIComponent(token)}`;
  // The post-login target rides along so the visitor lands on the plan they
  // picked. Validated again on the way in AND on the way out, so a crafted
  // `next` in the signup body cannot turn the mail into an open redirect.
  const safe = safeNext(next);
  return safe ? `${link}&next=${encodeURIComponent(safe)}` : link;
}

export function resetLink(token, request, settings) {
  const base = resolveBaseUrl(request, settings);
  return `${base}/login?token=${encodeURIComponent(token)}`;
}

/**
 * Issue a fresh verification token and mail it. When a previous token exists
 * (`replace: true`) the outstanding ones are dropped first, so a resend does not
 * leave several live links behind.
 * Returns the token (callers need it only for logging) — the mail result is
 * intentionally swallowed: registration must not leak transport state.
 */
export async function sendVerificationEmail({ user, request, settings, replace = false, next = null }) {
  const issue = replace ? replaceVerification : createVerification;
  const { token } = await issue({
    userId: user.id,
    purpose: VERIFICATION_PURPOSE,
    ttlMs: VERIFICATION_TTL_MS,
  });

  const siteName = siteNameOf(settings);
  const link = verificationLink(token, request, settings, next);
  const message = buildVerificationEmail({ email: user.email, link, siteName });
  const result = await sendMail({ to: user.email, ...message });
  if (!result.ok) {
    // The transcript on disk holds the link; log only the reason, never the token,
    // so a log reader cannot take over the account.
    console.error(`[register] verification mail not delivered (${result.reason}) for user ${user.id}`);
  }
  return token;
}

export async function sendResetEmail({ user, request, settings }) {
  const { token } = await replaceVerification({
    userId: user.id,
    purpose: RESET_PURPOSE,
    ttlMs: RESET_TTL_MS,
  });

  const siteName = siteNameOf(settings);
  const link = resetLink(token, request, settings);
  const message = buildResetEmail({ email: user.email, link, siteName });
  const result = await sendMail({ to: user.email, ...message });
  if (!result.ok) {
    console.error(`[register] reset mail not delivered (${result.reason}) for user ${user.id}`);
  }
  return token;
}

/** Settings needed by the whole flow, with a safe fallback. */
export async function loadAccountSettings() {
  try {
    return await getSettings();
  } catch {
    return {};
  }
}

// The policy itself lives in a dependency-free module so `node --test` can assert
// its exact message; re-exported here because every existing caller imports it from
// this path.
export { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, validatePassword } from "./passwordPolicy.js";
