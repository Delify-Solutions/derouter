// Docs page slug rules. Kept free of any database import so both the repo layer
// (contentRepo) and the start-up seeder (billing/bootstrap, which must stay
// driver-free) can share them.

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Slugs that would shadow a real route or an existing static asset. Pages are
 * served at /docs/<slug>, so `codex` (the Codex CLI page) does not collide with
 * the /codex proxy route and is allowed.
 */
export const RESERVED_SLUGS = new Set([
  "api", "dashboard", "account", "login", "register", "verify-email", "admin",
  "usage", "landing", "docs", "callback", "v1", "v1beta", "responses",
]);

export function validateSlug(slug) {
  const value = typeof slug === "string" ? slug.trim() : "";
  if (!value) return "Đường dẫn không được để trống";
  if (!SLUG_RE.test(value)) {
    return "Đường dẫn chỉ dùng chữ thường, số và dấu gạch ngang (tối đa 64 ký tự)";
  }
  if (RESERVED_SLUGS.has(value)) return `"${value}" trùng với một đường dẫn hệ thống`;
  return null;
}
