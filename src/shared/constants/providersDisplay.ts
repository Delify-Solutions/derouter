// UI display config — all providers derive from registry.display.
import REGISTRY from "open-sse/providers/registry/index.js";

export const RISK_NOTICE = "⚠️ Risk Notice: This provider uses a subscription/OAuth session not officially licensed for proxy/router use. Account may be restricted or banned. Use at your own risk.";

interface DisplayConfig {
  deprecationNotice?: string;
  [key: string]: unknown;
}

// Resolve "RISK_NOTICE" token → real notice text (registry stores token to avoid import cycle)
const resolveDisplay = (d: DisplayConfig): DisplayConfig =>
  d.deprecationNotice === "RISK_NOTICE" ? { ...d, deprecationNotice: RISK_NOTICE } : d;

interface RegistryEntry {
  id: string;
  display?: DisplayConfig;
}

export const PROVIDER_DISPLAY: Record<string, DisplayConfig> = Object.fromEntries(
  (REGISTRY as RegistryEntry[])
    .filter((r) => r.display)
    .map((r) => [r.id, resolveDisplay(r.display as DisplayConfig)]),
);
