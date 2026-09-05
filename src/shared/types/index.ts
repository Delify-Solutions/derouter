/**
 * Shared TypeScript types matching the Rust JSON API shapes.
 * These mirror the serde-serializable structs in derouter-rs/src/db/repos/.
 */

// ===== Auth =====

export interface AuthStatus {
  requireLogin: boolean;
  authMode: string;
  ssoType: string;
  oidcConfigured: boolean;
  oidcLoginLabel: string;
  samlConfigured: boolean;
  samlLoginLabel: string;
  hasPassword: boolean;
  displayName: string;
  loginMethod: string;
  authenticated: boolean;
  oidcName: string | null;
  oidcEmail: string | null;
  oidcLogin: boolean;
  samlName: string | null;
  samlEmail: string | null;
  samlLogin: boolean;
}

export interface LoginResponse {
  success: boolean;
  mustChangePassword?: boolean;
  error?: string;
  retryAfter?: number;
  resetHint?: string;
  remainingBeforeLock?: number;
}

// ===== Provider Connections =====

export interface ProviderConnection {
  id: string;
  provider: string;
  authType: string;
  name: string | null;
  email: string | null;
  priority: number | null;
  isActive: boolean;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderListResponse {
  connections: ProviderConnection[];
}

// ===== API Keys =====

export interface ApiKey {
  id: string;
  key: string;
  name: string | null;
  machineId: string | null;
  isActive: boolean;
  createdAt: string;
  groupId: string | null;
  rpm: number | null;
  tpm: number | null;
  budgetUsd: number | null;
  resetWindow: string | null;
  expiresAt: string | null;
  allowedModels: string[] | null;
  windowStartedAt: string | null;
  windowCostUsd: number;
  updatedAt: string | null;
}

export interface KeyListResponse {
  keys: ApiKey[];
}

// ===== Combos =====

export interface Combo {
  id: string;
  name: string;
  kind: string | null;
  models: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ComboListResponse {
  combos: Combo[];
}

export interface ComboTestResult {
  ok: boolean;
  latencyMs: number;
  status: number;
  content: string;
  error?: string;
}

// ===== Key Groups =====

export interface KeyGroup {
  id: string;
  name: string;
  isActive: boolean;
  rpm: number | null;
  tpm: number | null;
  budgetUsd: number | null;
  resetWindow: string | null;
  allowedModels: string[] | null;
  priceOverrides: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GroupListResponse {
  groups: KeyGroup[];
}

// ===== Pricing =====

export type PricingMap = Record<string, Record<string, PricingFields>>;

export interface PricingFields {
  input?: number;
  output?: number;
  cached?: number;
  reasoning?: number;
  cache_creation?: number;
}

// ===== Settings =====

export interface Settings {
  comboStrategy?: string;
  comboStrategies?: Record<string, unknown>;
  requireLogin?: boolean;
  requireApiKey?: boolean;
  authMode?: string;
  enableObservability?: boolean;
  tunnelUrl?: string;
  tunnelDashboardAccess?: boolean;
  tailscaleUrl?: string;
  mitmRouterBaseUrl?: string;
  oidcIssuerUrl?: string;
  oidcClientId?: string;
  oidcLoginLabel?: string;
  samlEntryPoint?: string;
  samlLoginLabel?: string;
  outboundProxyEnabled?: boolean;
  outboundProxyUrl?: string;
  outboundNoProxy?: string;
  comboStickyRoundRobinLimit?: number;
  stickyRoundRobinLimit?: number;
  providerStrategies?: Record<string, unknown>;
  quotaVisibility?: Record<string, unknown>;
  // Derived fields
  oidcConfigured?: boolean;
  hasPassword?: boolean;
  enableRequestLogs?: boolean;
  enableTranslator?: boolean;
  [key: string]: unknown;
}

// ===== Usage =====

export interface UsageStats {
  totalRequests: number;
  totalInput: number;
  totalOutput: number;
  totalCost: number;
  activeKeys: number;
  activeCombos: number;
  activeProviders: number;
}

export interface RequestDetail {
  id: string;
  provider?: string;
  model?: string;
  requestedModel?: string;
  connectionId?: string;
  apiKey?: string;
  timestamp: string;
  status?: string;
  latency: Record<string, unknown>;
  tokens: Record<string, unknown>;
  request?: Record<string, unknown> | { redacted: true };
  providerRequest?: Record<string, unknown> | { redacted: true };
  providerResponse?: Record<string, unknown> | { redacted: true };
  response?: Record<string, unknown> | { redacted: true };
}

export interface Pagination {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface RequestDetailsResponse {
  details: RequestDetail[];
  pagination: Pagination;
}

export interface UsageHistoryRow {
  timestamp: string;
  provider?: string;
  model: string;
  resolvedModel?: string;
  requestedModel?: string;
  connectionId?: string;
  apiKeyMasked?: string;
  endpoint?: string;
  cost: number;
  status: string;
  tokens: Record<string, unknown>;
}

export interface RequestLogsResponse {
  logs: string[];
  pagination: Pagination;
}

export interface KeyUsageRow {
  id: string;
  name: string;
  maskedKey: string;
  group: string;
  rpmLimit: number | null;
  rpmLive: number;
  tpmLimit: number | null;
  tpmLive: number;
  budgetLimit: number | null;
  budgetSpent: number;
  budgetPct: number;
  budgetOver: boolean;
  peakTpm: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  cost: number;
  modelsCount: number;
  isActive: boolean;
  expiresAt: string;
  models: ModelSummary[];
}

export interface ModelSummary {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  requests: number;
  cost: number;
}

// ===== Public Usage =====

export interface PublicKeyUsage {
  name: string | null;
  active: boolean;
  groupId: string | null;
  groupName: string | null;
  allowedModels: string[] | null;
  rpm: number | null;
  tpm: number | null;
  budgetUsd: number | null;
  resetWindow: string | null;
  windowStartedAt: string;
  windowCostUsd: number;
  windowRequests: number;
  remainingBudgetUsd: number | null;
  resetAt: string | null;
  expiresAt: string | null;
  limitCount: {
    requests: number;
    tokens: number;
  };
}

// ===== Proxy Pools (Phase 2) =====

export interface ProxyPool {
  id: string;
  isActive: boolean;
  testStatus: string | null;
  name: string;
  proxyUrl: string | null;
  noProxy: string | null;
  type: string | null;
  strictProxy: boolean | null;
  lastTestedAt: string | null;
  lastError: string | null;
  usageCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProxyPoolListResponse {
  proxyPools: ProxyPool[];
}

export interface ProxyPoolTestResult {
  ok: boolean;
  status: number;
  statusText: string;
  error: string | null;
  elapsedMs: number;
  testedAt: string;
}

// ===== Provider Nodes (Phase 2) =====

export interface ProviderNode {
  id: string;
  type: string | null;
  name: string | null;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderNodeListResponse {
  nodes: ProviderNode[];
}

export interface ProviderNodeValidateResult {
  ok: boolean;
  errors?: string[];
}

// ===== Models Catalog (Phase 2) =====

export interface ModelCaps {
  vision: boolean;
  search: boolean;
  reasoning: boolean;
  contextWindow: number;
  maxOutput: number;
}

export interface ModelCatalogEntry {
  provider: string;
  model: string;
  fullModel: string;
  routedModel: string;
  alias: string | null;
  caps: ModelCaps;
  custom?: boolean;
  disabled?: boolean;
}

export interface ModelCatalogResponse {
  models: ModelCatalogEntry[];
}

export interface ModelAliasMap {
  [fullModel: string]: string;
}

export interface ModelAliasResponse {
  aliases: ModelAliasMap;
}

export interface CustomModel {
  providerAlias: string;
  id: string;
  type: string;
  name: string | null;
  caps: Record<string, boolean> | null;
}

export interface CustomModelListResponse {
  models: CustomModel[];
}

export interface DisabledModelsMap {
  [provider: string]: string[];
}

export interface DisabledModelsResponse {
  disabled: DisabledModelsMap;
}

// ===== System / Version / Health (Phase 2) =====

export interface SystemVersion {
  currentVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
}

export interface HealthStatus {
  ok: boolean;
  db: string;
  version: string;
  uptimeSeconds: number;
}

export interface LocaleInfo {
  locales: string[];
  current: string;
}

// ===== Usage Chart / Summary / Providers (Phase 2) =====

export interface UsageChartPoint {
  timestamp: string;
  requests: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageChartResponse {
  points: UsageChartPoint[];
}

export interface UsageKeySummary {
  keyId: string;
  keyName: string | null;
  maskedKey: string;
  requests: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  rpm: number | null;
  tpm: number | null;
  budgetUsd: number | null;
  resetWindow: string | null;
  allowedModels: string[] | null;
  isActive: boolean;
}

export interface UsageKeySummaryResponse {
  keys: UsageKeySummary[];
}

export interface UsageByProvider {
  provider: string;
  providerName: string | null;
  requests: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageByProviderResponse {
  providers: UsageByProvider[];
}

export interface UsageLogsResponse {
  logs: UsageHistoryRow[];
}

export interface UsageConnectionResponse {
  connectionId: string;
  connection: Record<string, unknown>;
  usage: Record<string, unknown>;
}

// ===== Database Export/Import (Phase 2) =====

export interface DatabaseExport {
  settings?: Record<string, unknown>;
  providerConnections?: ProviderConnection[];
  combos?: Combo[];
  apiKeys?: ApiKey[];
  keyGroups?: KeyGroup[];
  pricing?: PricingMap;
  proxyPools?: ProxyPool[];
  providerNodes?: ProviderNode[];
  [key: string]: unknown;
}

// ===== Provider Info (canonical — used by providers pages, media-providers, shared components) =====

export interface ProviderInfo {
  id?: string;
  name?: string;
  color?: string;
  textIcon?: string;
  apiType?: string;
  baseUrl?: string;
  type?: string;
  authModes?: string[];
  authType?: string;
  authHint?: string;
  website?: string;
  noAuth?: boolean;
  hidden?: boolean;
  deprecated?: boolean;
  deprecationNotice?: string;
  notice?: { text?: string; apiKeyUrl?: string; signupUrl?: string };
  modelsFetcher?: { url: string; type: string } | null;
  serviceKinds?: string[];
  priority?: number;
  hasFree?: boolean;
  passthroughModels?: boolean;
  hasOAuth?: boolean;
  [key: string]: unknown;
}

// ===== CLI Tools / MITM Tools (canonical — used by cli-tools pages and constants) =====

export interface CliTool {
  id: string;
  name: string;
  description: string;
  image?: string;
  color?: string;
  icon?: string;
  configType?: string;
  requiresExternalUrl?: boolean;
  requiresCloud?: boolean;
  envVars?: Record<string, string>;
  modelAliases?: string[];
  settingsFile?: string;
  defaultModels?: Array<{
    id: string;
    name: string;
    alias: string;
    envKey?: string;
    defaultValue?: string;
    mandatory?: boolean;
    contextLength?: number;
    rateMultiplier?: number;
    isTopLevel?: boolean;
  }>;
  notes?: Array<{ type: string; text: string }>;
  guideSteps?: Array<{
    step: number;
    title: string;
    desc?: string;
    value?: string;
    copyable?: boolean;
    type?: string;
    docsUrl?: string;
  }>;
  codeBlock?: { language: string; code: string };
  docsUrl?: string;
  defaultCommand?: string;
  installUrl?: string;
  mitmDomain?: string;
  [key: string]: unknown;
}

export interface MitmTool {
  id: string;
  name: string;
  image: string;
  color: string;
  description: string;
  configType: string;
  mitmDomain: string;
  modelAliases?: string[];
  defaultModels: Array<{
    id: string;
    name: string;
    alias: string;
    mandatory?: boolean;
    contextLength?: number;
    rateMultiplier?: number;
    envKey?: string;
    defaultValue?: string;
    isTopLevel?: boolean;
  }>;
  [key: string]: unknown;
}

// ===== Phase 3: CLI Tools / MCP / Media / Tunnel / Pxpipe / Translator / Headroom / OAuth =====

export interface CliToolStatus {
  installed: boolean;
  settings?: Record<string, unknown> | null;
  message?: string;
  hasderouter?: boolean;
  settingsPath?: string;
  error?: string;
  [key: string]: unknown;
}

export interface CliToolSettings {
  [key: string]: unknown;
}

export interface CliToolsAllStatusesResponse {
  statuses: Record<string, CliToolStatus>;
}

export interface McpPlugin {
  id: string;
  name: string;
  command?: string | null;
  args?: string[] | null;
  env?: Record<string, string> | null;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface MediaVoice {
  id: string;
  name?: string | null;
  language?: string | null;
  gender?: string | null;
  [key: string]: unknown;
}

export interface TunnelStatus {
  url: string | null;
  type: string | null;
  active: boolean;
  dashboardAccess?: boolean;
  [key: string]: unknown;
}

export interface PxpipeStatus {
  enabled: boolean;
  url: string | null;
  [key: string]: unknown;
}

export type TranslatorFormat = string;

export interface HeadroomStatus {
  enabled: boolean;
  [key: string]: unknown;
}

export interface OAuthImportResult {
  success: boolean;
  error?: string;
  connectionId?: string;
  [key: string]: unknown;
}

export interface TranslatorDetectResult {
  provider: string;
  model: string;
  sourceFormat: string;
  targetFormat: string;
  [key: string]: unknown;
}

export interface TranslatorSession {
  combos: Array<{ id: string; name: string; models: string[] }>;
  [key: string]: unknown;
}
