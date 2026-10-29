// Safe post-authentication redirect target (design D17).
//
// `/login?next=…` and `/register?next=…` exist so a visitor who picked a plan on the
// landing page comes back to it after signing up. The value is attacker-controlled
// in the general case, so it must not be able to leave the account area:
//
//   * must be a string,
//   * must be "/account" or start with "/account/" (the only place a post-auth
//     redirect may land),
//   * must not contain "//" (protocol-relative → another host),
//   * must not contain "\\" (browsers normalise it to "/", so "\\evil.com" escapes),
//   * must not contain ":" (a scheme, or a port in a nested absolute URL).
//
// Everything else (a query string, a fragment, nested paths) is allowed, which is
// what `/account/plans?plan=go` needs.
//
// Returns the value unchanged when valid, or null so the caller can fall back to
// "/account". Pure and dependency-free: tests import it directly.
export function safeNext(value) {
  if (typeof value !== "string") return null;
  // "/account" exactly, or "/account/" + anything: "/accounting" also starts with
  // the word but is a different page.
  if (value !== "/account" && !value.startsWith("/account/") && !value.startsWith("/account?")) return null;
  if (value.includes("//")) return null;
  if (value.includes("\\")) return null;
  if (value.includes(":")) return null;
  return value;
}

export default safeNext;
