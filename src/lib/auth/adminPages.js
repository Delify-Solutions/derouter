// Single source of truth for every admin dashboard page key (spec admin-accounts
// "Admin page permission matrix"). The sidebar filters its entries by this list,
// dashboardGuard.js resolves a request path to a key via it, and every
// permission-checked API route imports a key straight out of PAGE_KEYS — so a new
// page cannot be added to the nav without also being added to enforcement.
//
// Relative imports only (consumed by plain `node --test`, no `@/` alias).

/** @typedef {{ key: string, label: string, pathPrefix: string }} AdminPage */

/** @type {AdminPage[]} */
export const ADMIN_PAGES = [
  { key: "dashboard", label: "Trang chủ", pathPrefix: "/dashboard" },
  { key: "endpoint", label: "Endpoint & Key", pathPrefix: "/dashboard/endpoint" },
  { key: "users", label: "Người dùng", pathPrefix: "/dashboard/users" },
  { key: "groups", label: "Groups", pathPrefix: "/dashboard/groups" },
  { key: "pricing", label: "Pricing", pathPrefix: "/dashboard/pricing" },
  { key: "plans", label: "Plans", pathPrefix: "/dashboard/plans" },
  { key: "orders", label: "Orders", pathPrefix: "/dashboard/orders" },
  { key: "providers", label: "Providers", pathPrefix: "/dashboard/providers" },
  { key: "basic-chat", label: "Basic Chat", pathPrefix: "/dashboard/basic-chat" },
  { key: "combos", label: "Combo & Vision Adapter", pathPrefix: "/dashboard/combos" },
  { key: "usage", label: "Usage", pathPrefix: "/dashboard/usage" },
  { key: "stats", label: "Thống kê", pathPrefix: "/dashboard/stats" },
  { key: "quota", label: "Quota Tracker", pathPrefix: "/dashboard/quota" },
  { key: "token-saver", label: "Token Saver", pathPrefix: "/dashboard/token-saver" },
  { key: "pxpipe", label: "PXPIPE", pathPrefix: "/dashboard/pxpipe" },
  { key: "cli-tools", label: "CLI Tools", pathPrefix: "/dashboard/cli-tools" },
  { key: "gift-codes", label: "Gift codes", pathPrefix: "/dashboard/gift-codes" },
  { key: "affiliates", label: "Affiliate", pathPrefix: "/dashboard/affiliates" },
  { key: "payments", label: "Thanh toán", pathPrefix: "/dashboard/payments" },
  { key: "content", label: "Nội dung", pathPrefix: "/dashboard/content" },
  { key: "announcements", label: "Thông báo", pathPrefix: "/dashboard/announcements" },
  { key: "storage", label: "CDN ảnh", pathPrefix: "/dashboard/storage" },
  { key: "telegram", label: "Telegram", pathPrefix: "/dashboard/telegram" },
  { key: "media-providers", label: "Media Providers", pathPrefix: "/dashboard/media-providers" },
  { key: "mitm", label: "MITM", pathPrefix: "/dashboard/mitm" },
  { key: "proxy-pools", label: "Proxy Pools", pathPrefix: "/dashboard/proxy-pools" },
  { key: "customer-skills", label: "Skill khách hàng", pathPrefix: "/dashboard/customer-skills" },
  { key: "dsh-plugins", label: "Plugin DSH", pathPrefix: "/dashboard/dsh-plugins" },
  { key: "errors", label: "Nhật ký lỗi", pathPrefix: "/dashboard/errors" },
  { key: "console-log", label: "Console Log", pathPrefix: "/dashboard/console-log" },
  { key: "translator", label: "Translator", pathPrefix: "/dashboard/translator" },
  { key: "profile", label: "Cài đặt", pathPrefix: "/dashboard/profile" },
  { key: "admin-accounts", label: "Tài khoản Admin", pathPrefix: "/dashboard/admin-accounts" },
];

export const PAGE_KEYS = Object.freeze(ADMIN_PAGES.map((p) => p.key));

const BY_KEY = new Map(ADMIN_PAGES.map((p) => [p.key, p]));

export function isKnownPageKey(key) {
  return BY_KEY.has(key);
}

export function getPageByKey(key) {
  return BY_KEY.get(key) || null;
}

/**
 * Resolve a `/dashboard/**` request path to its page key. Longest prefix wins so
 * `/dashboard/media-providers/tts` resolves to `media-providers`, not the bare
 * `/dashboard` (home) entry. Returns null for a path under no known page (treated
 * as not-found rather than silently allowed).
 */
export function resolvePageKeyFromPath(pathname) {
  if (typeof pathname !== "string") return null;
  let best = null;
  for (const page of ADMIN_PAGES) {
    if (page.pathPrefix === "/dashboard") {
      if (pathname === "/dashboard") {
        if (!best) best = page;
      }
      continue;
    }
    if (pathname === page.pathPrefix || pathname.startsWith(`${page.pathPrefix}/`)) {
      if (!best || page.pathPrefix.length > best.pathPrefix.length) best = page;
    }
  }
  return best ? best.key : null;
}
