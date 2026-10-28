import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir";
import { getSettings } from "@/lib/localDb";

// Outbound mail.
//
// Transport note (deliberate v1 decision): nodemailer is NOT a dependency of this
// project and SMTP-over-socket is not implemented here. The supported transport is
// an HTTP relay:
//
//   POST <smtpRelayUrl>
//   Authorization: Bearer <smtpRelayToken>   (only when the token is set)
//   Content-Type: application/json
//   { "to", "from", "subject", "text", "html" }
//
// Any local mail bridge that accepts that shape works (an SMTP→HTTP shim, a
// transactional-mail API with a thin adapter, or a small worker). When no relay is
// configured — which is the fresh-install case — nothing is sent, but every message
// is still written to <DATA_DIR>/logs/mail/ as a readable .txt transcript so the
// operator can recover a lost verification link instead of being locked out.
//
// sendMail never throws. Callers get `{ ok, reason?, file? }` and decide what to
// tell the user; the verification flow stays usable with ok:false because the
// link is on disk.

const MAIL_LOG_DIR = path.join(DATA_DIR, "logs", "mail");
const RELAY_TIMEOUT_MS = 10_000;

function mailLogDir() {
  try {
    fs.mkdirSync(MAIL_LOG_DIR, { recursive: true, mode: 0o700 });
  } catch {
    // Read-only data dir: the log write below will fail and be reported.
  }
  return MAIL_LOG_DIR;
}

function safeFilenamePart(value) {
  return String(value || "mail")
    .replace(/[^a-zA-Z0-9._@-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "mail";
}

function writeTranscript({ to, from, subject, text, html, delivery }) {
  try {
    const dir = mailLogDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `${stamp}-${safeFilenamePart(to)}.txt`);
    const lines = [
      `Date: ${new Date().toISOString()}`,
      `From: ${from || "(unset)"}`,
      `To: ${to || "(unset)"}`,
      `Subject: ${subject || "(unset)"}`,
      `Delivery: ${delivery || "not sent"}`,
      "",
      "--- text/plain ---",
      text || "",
      "",
    ];
    if (html) {
      lines.push("--- text/html ---", html, "");
    }
    fs.writeFileSync(file, lines.join("\n"), { mode: 0o600 });
    return file;
  } catch {
    return null;
  }
}

async function loadMailSettings() {
  try {
    return (await getSettings()) || {};
  } catch {
    return {};
  }
}

/**
 * Send one message. Returns `{ ok, reason?, file? }`.
 * `reason` is one of: "smtp_not_configured", "relay_failed", "invalid_payload".
 */
export async function sendMail({ to, subject, text, html, from } = {}) {
  if (!to || !subject || (!text && !html)) {
    return { ok: false, reason: "invalid_payload" };
  }

  const settings = await loadMailSettings();
  const relayUrl = typeof settings.smtpRelayUrl === "string" ? settings.smtpRelayUrl.trim() : "";
  const relayToken = typeof settings.smtpRelayToken === "string" ? settings.smtpRelayToken.trim() : "";
  const sender = from || (typeof settings.smtpFrom === "string" && settings.smtpFrom.trim()) || "no-reply@localhost";
  // "Configured" means an HTTP relay exists. smtpFrom alone is not a transport.
  const host = typeof settings.smtpHost === "string" ? settings.smtpHost.trim() : "";

  if (!relayUrl) {
    // No transport. Still leave a recoverable copy on disk.
    const file = writeTranscript({
      to, from: sender, subject, text, html,
      delivery: host
        ? `not sent — smtpHost set but no smtpRelayUrl (raw SMTP is not supported)`
        : "not sent — no relay configured",
    });
    return { ok: false, reason: "smtp_not_configured", ...(file ? { file } : {}) };
  }

  let failure = null;
  try {
    const headers = { "Content-Type": "application/json" };
    if (relayToken) headers.Authorization = `Bearer ${relayToken}`;
    const res = await fetch(relayUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ to, from: sender, subject, text: text || "", html: html || "" }),
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      failure = `relay responded ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`;
    }
  } catch (error) {
    failure = error?.name === "TimeoutError"
      ? `relay timed out after ${RELAY_TIMEOUT_MS}ms`
      : `relay request failed: ${error?.message || "unknown error"}`;
  }

  const file = writeTranscript({
    to, from: sender, subject, text, html,
    delivery: failure ? `FAILED — ${failure}` : `delivered to relay ${relayUrl}`,
  });

  if (failure) {
    return { ok: false, reason: "relay_failed", ...(file ? { file } : {}) };
  }
  return { ok: true, ...(file ? { file } : {}) };
}

// ── Message builders ────────────────────────────────────────────────────────
// Plain, honest copy. No marketing, no exclamation marks, no greeting theatre.

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlShell(siteName, bodyLines, link, linkLabel) {
  const paragraphs = bodyLines.map((line) => `<p>${escapeHtml(line)}</p>`).join("\n    ");
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<body style=\"font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#09090b;line-height:1.5\">",
    `  <p style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#71717a;margin:0 0 16px">${escapeHtml(siteName)}</p>`,
    `    ${paragraphs}`,
    `  <p><a href="${escapeHtml(link)}" style="display:inline-block;border:1px solid #16a34a;padding:10px 18px;color:#16a34a;text-decoration:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;letter-spacing:.08em;text-transform:uppercase">${escapeHtml(linkLabel)}</a></p>`,
    `  <p style="color:#71717a;font-size:13px">If the button does not work, open this link:</p>`,
    `  <p style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all">${escapeHtml(link)}</p>`,
    "</body>",
    "</html>",
  ].join("\n");
}

export function buildVerificationEmail({ email, link, siteName = "derouter" } = {}) {
  const subject = `Verify your email address for ${siteName}`;
  const text = [
    `You are receiving this because ${email || "this address"} was used to create an account on ${siteName}.`,
    "",
    "Open this link to verify the address. It can be used once:",
    link,
    "",
    "The link expires in 24 hours. If you did not create an account, ignore this message and nothing will happen.",
  ].join("\n");
  const html = htmlShell(
    siteName,
    [
      `You are receiving this because ${email || "this address"} was used to create an account on ${siteName}.`,
      "Open the link below to verify the address. It can be used once and expires in 24 hours.",
      "If you did not create an account, ignore this message and nothing will happen.",
    ],
    link,
    "Verify email",
  );
  return { subject, text, html };
}

export function buildResetEmail({ email, link, siteName = "derouter" } = {}) {
  const subject = `Reset your password for ${siteName}`;
  const text = [
    `A password reset was requested for ${email || "this address"} on ${siteName}.`,
    "",
    "Open this link to choose a new password. It can be used once:",
    link,
    "",
    "The link expires in 1 hour. If you did not request this, ignore this message — the current password stays valid.",
  ].join("\n");
  const html = htmlShell(
    siteName,
    [
      `A password reset was requested for ${email || "this address"} on ${siteName}.`,
      "Open the link below to choose a new password. It can be used once and expires in 1 hour.",
      "If you did not request this, ignore this message. The current password stays valid.",
    ],
    link,
    "Reset password",
  );
  return { subject, text, html };
}
