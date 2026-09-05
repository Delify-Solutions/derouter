import pkg from "../../../package.json" with { type: "json" };

// App configuration
export const APP_CONFIG = {
  name: "derouter Proxy",
  description: "AI Infrastructure Management",
  version: pkg.version,
} as const;

// GitHub configuration
export const GITHUB_CONFIG = {
  changelogUrl: "#",
  donateUrl: "#",
} as const;

// Updater configuration
export const UPDATER_CONFIG = {
  npmPackageName: "derouter",
  installCmd: "npm i -g derouter",
  installCmdLatest: "npm i -g derouter@latest --prefer-online",
  shutdownCountdownSec: 3,
  exitDelayMs: 500,
  statusPort: 20129,
  statusPollIntervalMs: 1000,
  statusLogTailLines: 8,
  installRetries: 3,
  installRetryDelayMs: 5000,
  lingerAfterDoneMs: 30000,
  waitForExitMinMs: 5000,
  waitForExitMaxMs: 20000,
  waitForExitCheckMs: 500,
  appPort: 20128,
} as const;

// Theme configuration
export const THEME_CONFIG = {
  storageKey: "theme",
  defaultTheme: "system", // "light" | "dark" | "system"
} as const;

// Subscription
export const SUBSCRIPTION_CONFIG = {
  price: 1.0,
  currency: "USD",
  interval: "month",
  planName: "Pro Plan",
} as const;

// API endpoints
export const API_ENDPOINTS = {
  users: "/api/users",
  providers: "/api/providers",
  payments: "/api/payments",
  auth: "/api/auth",
} as const;

export const CONSOLE_LOG_CONFIG = {
  maxLines: 200,
  pollIntervalMs: 1000,
} as const;

// Client-side store TTL: how long fetched data stays fresh before re-fetching
export const CLIENT_STORE_TTL_MS = 60000;

// Quota auto-ping: keep 5h windows warm by sending a tiny request right after reset.
interface ProviderPingConfig {
  settingsKey: string;
  quotaKey: string;
  pingModel: string;
  pingText: string;
  pingMaxTokens?: number;
  pingWhenResetAtSlides?: boolean;
  resetAtDriftMs?: number;
  minPingIntervalMs?: number;
  skipWhenBlockingQuotaExhausted?: boolean;
  pingInstructions?: string;
  pingReasoningEffort?: string;
}

interface ProvidersPingConfig {
  claude: ProviderPingConfig;
  codex: ProviderPingConfig;
}

export const QUOTA_AUTOPING_CONFIG = {
  tickIntervalMs: 60000,
  pingLeadMs: 5000,
  refreshAheadMs: 300000,
  failureCooldownMs: 900000,
  providers: {
    claude: {
      settingsKey: "claudeAutoPing",
      quotaKey: "session (5h)",
      pingModel: "claude-haiku-4-5-20251001",
      pingText: "hi",
      pingMaxTokens: 1,
    },
    codex: {
      settingsKey: "codexAutoPing",
      quotaKey: "session",
      pingWhenResetAtSlides: true,
      resetAtDriftMs: 30000,
      minPingIntervalMs: 600000,
      skipWhenBlockingQuotaExhausted: true,
      pingModel: "gpt-5.5",
      pingText: "hi",
      pingInstructions: "Reply with OK.",
      pingReasoningEffort: "none",
    },
  } as ProvidersPingConfig,
} as const;

// Re-export from providers for backward compatibility
export {
  FREE_PROVIDERS,
  OAUTH_PROVIDERS,
  APIKEY_PROVIDERS,
  WEB_COOKIE_PROVIDERS,
  AI_PROVIDERS,
  AUTH_METHODS,
} from "./providers";

// Re-export from models for backward compatibility
export {
  PROVIDER_MODELS,
  AI_MODELS,
} from "./models";
