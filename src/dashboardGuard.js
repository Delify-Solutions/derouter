import { NextResponse } from "next/server";
import { getSettings, validateApiKey } from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";
import { verifyUserToken } from "@/lib/auth/userSession";
import { hasTrustedPeerHeaders } from "@/lib/auth/trustedPeer";
import { safeEqual } from "@/lib/auth/internalHeaders";

const CLI_TOKEN_HEADER = "x-dr-cli-token";
const CLI_TOKEN_SALT = "dr-cli-auth";

let cachedCliToken = null;
async function getCliToken() {
  if (!cachedCliToken) cachedCliToken = await getConsistentMachineId(CLI_TOKEN_SALT);
  return cachedCliToken;
}

// Exported for API routes that grant extra trust to the local CLI (e.g. the
// first-time password branch of /api/settings).
export async function hasValidCliToken(request) {
  const token = request.headers.get(CLI_TOKEN_HEADER);
  if (!token) return false;
  return safeEqual(token, await getCliToken());
}

// Public API paths — no auth required (LLM API has its own key auth inside handler).
const PUBLIC_API_PATHS = [
  "/api/health",
  "/api/init",
  "/api/locale",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/status",
  "/api/auth/oidc",
  "/api/auth/saml",
  "/api/version",
  "/api/settings/require-login",
  "/api/usage/key",
  // Customer signup/login/verification. These authenticate themselves; the
  // /api/account/* surface behind them is NOT public.
  "/api/public",
  // SePay webhook (design D7). It authenticates with the provider's own webhook key
  // (constant-time compare) because SePay is not a browser session; every other
  // /api/payments/* route stays behind the admin JWT.
  "/api/payments/sepay/webhook",
];

// Public pages for customer accounts. The admin entry point stays hidden at
// /admin/ss, so these render the tenant-facing forms only.
// Public pages. `/docs` is operator-written documentation for customers and must
// be readable without a session — it is the page the landing CTA points at.
const PUBLIC_PAGE_PATHS = ["/login", "/register", "/verify-email", "/docs"];

// Public top-level prefixes (LLM API endpoints with their own API key auth).
// Keep root-level rewrites here too: middleware runs before Next.js rewrites.
const PUBLIC_PREFIXES = ["/v1", "/v1beta", "/api/v1", "/api/v1beta", "/codex", "/responses"];

// Always require JWT token regardless of requireLogin setting
const ALWAYS_PROTECTED = [
  "/api/shutdown",
  "/api/settings/database",
  "/api/version/shutdown",
  "/api/version/update",
  "/api/oauth/cursor/auto-import",
  "/api/oauth/kiro/auto-import",
];

// Routes that spawn child processes or read host secrets — restrict to localhost.
const LOCAL_ONLY_PATHS = [
  "/api/cli-tools/cowork-settings",
  // Probes a client-supplied URL server-side; keep it off the network.
  "/api/cli-tools/cowork-mcp-tools",
  "/api/cli-tools/antigravity-mitm",
  "/api/mcp/",
  "/api/tunnel/tailscale-install",
  "/api/tunnel/tailscale-enable",
  "/api/tunnel/tailscale-disable",
  "/api/tunnel/tailscale-check",
  "/api/tunnel/enable",
  "/api/tunnel/disable",
  "/api/oauth/cursor/auto-import",
  "/api/oauth/kiro/auto-import",
  "/api/auth/reset-password",
  "/api/headroom/start",
  "/api/headroom/stop",
  "/api/headroom/proxy",
];

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

// Accepts a Host header, a URL hostname or a raw socket address. Splitting on the first
// colon only works for IPv4 and would reduce every IPv6 form to "", so a dual-stack
// listener handing back ::ffff:127.0.0.1 would not read as loopback.
function isLoopbackHostname(h) {
  if (!h) return false;
  let name = String(h).trim().toLowerCase();
  if (name.startsWith("[")) {
    const end = name.indexOf("]");
    if (end === -1) return false;
    name = name.slice(1, end);
  } else if (name.indexOf(":") !== -1 && name.indexOf(":") === name.lastIndexOf(":")) {
    name = name.slice(0, name.indexOf(":"));
  }
  if (name.startsWith("::ffff:")) name = name.slice(7);
  return LOOPBACK_HOSTS.has(name);
}

function isLoopbackPeer(request) {
  if (hasTrustedPeerHeaders(request)) {
    return isLoopbackHostname(request.headers.get("x-dr-real-ip"));
  }
  // Bare `next dev` forks its server, so the wrapper never loads and no peer address
  // reaches us. Host is spoofable, so this stays confined to development.
  if (process.env.NODE_ENV === "development") {
    return isLoopbackHostname(request.headers.get("host"));
  }
  return false;
}

export function isLocalRequest(request) {
  // Stamped by custom-server.js when forwarding headers exist: request came through
  // a reverse proxy, so the loopback socket is the proxy hop, not the end-user.
  if (request.headers.get("x-dr-via-proxy")) return false;
  if (!isLoopbackPeer(request)) return false;
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (!isLoopbackHostname(new URL(origin).hostname)) return false;
    } catch { return false; }
  }
  return true;
}

// Hide admin UI: unauthenticated access to / or /dashboard returns 404.
// The login form lives only at the secret path /admin/ss.
function notFound() {
  return NextResponse.json({ error: "Not Found" }, { status: 404 });
}

function isPublicLlmApi(pathname) {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function extractApiKey(request) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  const apiKeyHeader = request.headers.get("x-api-key");
  if (apiKeyHeader) return apiKeyHeader;
  const googleApiKeyHeader = request.headers.get("x-goog-api-key");
  if (googleApiKeyHeader) return googleApiKeyHeader;
  return request.nextUrl.searchParams?.get("key") || null;
}

async function hasValidApiKey(request) {
  const apiKey = extractApiKey(request);
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}

async function canAccessPublicLlmApi(request) {
  if (isLocalRequest(request)) return true;
  if (await hasValidCliToken(request)) return true;
  return await hasValidApiKey(request);
}

async function canAccessLocalOnlyRoute(request) {
  if (await hasValidCliToken(request)) return true;
  // Browser on the host machine: loopback peer + loopback Origin (blocks tunnel/CSRF)
  // plus a dashboard JWT.
  if (isLocalRequest(request) && await isAuthenticated(request)) return true;
  return false;
}

async function hasValidToken(request) {
  const token = request.cookies.get("auth_token")?.value;
  return await verifyDashboardAuthToken(token);
}

// Customer session: the `user_token` cookie or a Bearer token. Signed with a
// different key than the admin JWT, so the two can never be swapped.
async function hasValidUserToken(request) {
  const token = request.cookies.get("user_token")?.value;
  if (token) {
    if (await verifyUserToken(token)) return true;
  }
  const header = request.headers.get("authorization");
  if (header?.startsWith("Bearer ")) {
    return !!(await verifyUserToken(header.slice(7).trim()));
  }
  return false;
}

// Read settings directly from DB to avoid self-fetch deadlock in proxy
async function loadSettings() {
  try {
    return await getSettings();
  } catch {
    return null;
  }
}

async function isAuthenticated(request) {
  // JWT only. The relaxed-login setting used to bypass this and turned the toggle
  // into "no auth at all"; that setting now only affects the LLM surface, which
  // authenticates requests with its own API keys.
  return await hasValidToken(request);
}

function isPublicApi(pathname) {
  if (isPublicLlmApi(pathname)) return true;
  return PUBLIC_API_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export const __test__ = {
  isLocalRequest,
  isPublicLlmApi,
  extractApiKey,
  canAccessPublicLlmApi,
  canAccessLocalOnlyRoute,
};

export async function proxy(request) {
  const { pathname } = request.nextUrl;

  // Local-only gate for spawn-capable / host-secret routes.
  if (LOCAL_ONLY_PATHS.some((p) => pathname.startsWith(p))) {
    if (!(await canAccessLocalOnlyRoute(request))) {
      return NextResponse.json({ error: "Local only: CLI token required" }, { status: 403 });
    }
  }

  // Always protected - require valid JWT or local CLI token (machineId-based)
  if (ALWAYS_PROTECTED.some((p) => pathname.startsWith(p))) {
    if (await hasValidCliToken(request) || await hasValidToken(request))
      return NextResponse.next();
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (isPublicLlmApi(pathname)) {
    if (await canAccessPublicLlmApi(request)) return NextResponse.next();
    return NextResponse.json({ error: "API key required for remote API access" }, { status: 401 });
  }

  // Deny-by-default for /api/* — public allow-list bypasses, everything else requires auth.
  if (pathname.startsWith("/api/")) {
    if (isPublicApi(pathname)) return NextResponse.next();

    // Customer account API: `user_token` only. Checked before the admin JWT/CLI
    // branch so an admin session can never reach a tenant's account surface.
    // Handlers re-check the session (defence in depth).
    if (pathname.startsWith("/api/account")) {
      if (await hasValidUserToken(request)) return NextResponse.next();
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (await hasValidCliToken(request) || await isAuthenticated(request))
      return NextResponse.next();

    // Fresh-install bootstrap: with no password hash stored there is no credential
    // to authenticate with, so the only way to set one is a loopback browser.
    // Loopback peer + loopback Origin already exclude tunnels and CSRF; nothing
    // remote can reach this branch. A settings read failure fails closed.
    if (
      pathname === "/api/settings" &&
      (request.method === "PATCH" || request.method === "POST") &&
      isLocalRequest(request)
    ) {
      const settings = await loadSettings();
      if (settings && !settings.password) return NextResponse.next();
    }

    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Customer account pages: the layout owns the redirect message; the guard only
  // enforces that a valid customer token exists.
  if (pathname.startsWith("/account")) {
    if (await hasValidUserToken(request)) return NextResponse.next();
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Public customer pages. Checked before the admin 404 rules below so /login is
  // reachable for customers while the admin entry point stays at /admin/ss.
  if (PUBLIC_PAGE_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  // Protect all dashboard routes
  if (pathname.startsWith("/dashboard")) {
    let tunnelDashboardAccess = true;

    try {
      const settings = await loadSettings();
      if (settings) {
        // Note: settings.requireLogin is intentionally NOT honored for the
        // dashboard UI here — it only relaxes /api/* access above. The
        // admin shell is never served without a valid JWT.
        tunnelDashboardAccess = settings.tunnelDashboardAccess === true;

        // Block tunnel/tailscale access if disabled (redirect to login)
        if (!tunnelDashboardAccess) {
          const host = (request.headers.get("host") || "").split(":")[0].toLowerCase();
          const tunnelHost = settings.tunnelUrl ? new URL(settings.tunnelUrl).hostname.toLowerCase() : "";
          const tailscaleHost = settings.tailscaleUrl ? new URL(settings.tailscaleUrl).hostname.toLowerCase() : "";
          if ((tunnelHost && host === tunnelHost) || (tailscaleHost && host === tailscaleHost)) {
            return notFound();
          }
        }
      }
    } catch {
      // On error, keep defaults (require login, block tunnel)
    }

    // Always require a valid JWT for dashboard UI pages, even when
    // requireLogin=false. The flag only relaxes /api/* access (LLM API
    // still works without a browser session); the admin UI must never
    // be served unauthenticated (otherwise the shell/layout leaks).
    const token = request.cookies.get("auth_token")?.value;
    if (token) {
      if (await verifyDashboardAuthToken(token)) {
        return NextResponse.next();
      } else {
        return notFound();
      }
    }

    return notFound();
  }

  // `/` is the public landing page. src/app/page.js is a server component that
  // redirects authenticated sessions itself (admin cookie → /dashboard, customer
  // cookie → /account) and renders the landing page for everyone else, so the
  // middleware only has to let the request through. `/landing` is a permanent
  // redirect to `/` issued by its own page and falls through to the same result.
  if (pathname === "/") {
    return NextResponse.next();
  }

  // /login, /register and /verify-email are customer pages, already let through
  // by PUBLIC_PAGE_PATHS above. The admin entry point remains the hidden
  // /admin/ss path.

  // Public usage check page (?key= deep link, then stripped) — no admin login
  // required. The page fetches /api/usage/key (public) with the user's key.
  if (pathname === "/usage") {
    return NextResponse.next();
  }

  return NextResponse.next();
}
