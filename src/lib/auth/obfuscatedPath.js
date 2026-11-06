// Percent-encoded characters that never need encoding in a path (letters, digits,
// "-", ".", "_", "~") plus an encoded "/" or "\", or a raw backslash.
//
// The guard (src/dashboardGuard.js) compares the pathname as raw text while the
// router decodes it before picking a route, so `/%61pi/settings` would skip every
// `/api/` rule and still be served by /api/settings. Standard clients
// (encodeURIComponent, every HTTP library) never produce these sequences, so the
// guard refuses them instead of decoding and re-checking.
const OBFUSCATED_PATH = /%(?:3[0-9]|4[1-9a-f]|5[0-9a]|6[1-9a-f]|7[0-9a]|2[def]|5[cf]|7e)|\\/i;

export function isObfuscatedPath(pathname) {
  return OBFUSCATED_PATH.test(String(pathname || ""));
}
