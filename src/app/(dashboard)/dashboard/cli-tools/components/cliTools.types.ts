/**
 * Local TypeScript types for cli-tools components.
 * Re-exports CliTool from @/shared/types for canonical definition.
 */

export type { CliTool } from "@/shared/types";

/** Status payload returned by /api/cli-tools/{tool} endpoints (Rust). */
export interface CliToolStatus {
  installed?: boolean;
  hasderouter?: boolean;
  hasBackup?: boolean;
  config?: string | Record<string, unknown> | Array<Record<string, unknown>> | null;
  settings?: Record<string, unknown>;
  error?: string;
  exaMcpEnabled?: boolean;
  agents?: Array<{ id: string; name?: string; currentModel?: string; agentDir?: boolean }>;
  // OpenCode-specific
  opencode?: { models?: string[]; activeModel?: string };
  // Cowork-specific
  cowork?: {
    models?: string[];
    baseUrl?: string;
    plugins?: Array<Record<string, unknown>>;
    localPlugins?: string[];
    customPlugins?: Array<Record<string, unknown>>;
  };
  defaultPlugins?: Array<Record<string, unknown>>;
  localStdioPlugins?: Array<Record<string, unknown>>;
  envApiKey?: string;
  // Copilot-specific
  currentUrl?: string;
  // MITM-specific
  running?: boolean;
  certExists?: boolean;
  certTrusted?: boolean;
  dnsConfigured?: boolean;
  dnsStatus?: Record<string, unknown>;
  isWin?: boolean;
  isAdmin?: boolean;
  hasCachedPassword?: boolean;
  needsSudoPassword?: boolean;
  mitmRouterBaseUrl?: string;
  [key: string]: unknown;
}

/** Response from /api/cli-tools/all-statuses */
export interface CliToolsAllStatusesResponse {
  [toolId: string]: CliToolStatus;
}

/** A model option returned by provider model enumeration. */
export interface AvailableModel {
  value: string;
  label: string;
  provider: string;
  alias: string;
  connectionName: string | null;
  modelId: string;
}

/** Result of matchKnownEndpoint. */
export type EndpointMatchResult = boolean;

/** Options for matchKnownEndpoint. */
export interface EndpointMatchOptions {
  tunnelPublicUrl?: string | null;
  tailscaleUrl?: string | null;
  cloudUrl?: string | null;
}

/** A saved endpoint preset (localStorage). */
export interface EndpointPreset {
  name: string;
  baseUrl: string;
  apiKey?: string;
}

/** A saved API key preset (localStorage). */
export interface KeyPreset {
  name: string;
  key: string;
}

/** Message state for tool cards. */
export interface ToolMessage {
  type: "success" | "error";
  text: string;
}
