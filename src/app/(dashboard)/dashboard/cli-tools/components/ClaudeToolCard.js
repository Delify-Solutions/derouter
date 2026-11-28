"use client";

import { useState, useEffect, useRef } from "react";
import { Card, Button, Badge, Toast, ModelSelectModal, ManualConfigModal, Tooltip } from "@/shared/components";
import Image from "next/image";
import BaseUrlSelect from "./BaseUrlSelect";
import { rememberEndpoint } from "./cliEndpointPresets";
import ApiKeySelect from "./ApiKeySelect";
import { matchKnownEndpoint } from "./cliEndpointMatch";

const CLOUD_URL = process.env.NEXT_PUBLIC_CLOUD_URL;

// Context window presets. UI shows the round number; the value written is nudged
// down 2K to stay safely under the upstream hard cap.
const CONTEXT_OPTIONS = [
  { label: "Default", value: "" },
  { label: "200K", value: "198000" },
  { label: "300K", value: "298000" },
  { label: "500K", value: "498000" },
  { label: "1M", value: "998000" },
];

export default function ClaudeToolCard({
  tool,
  isExpanded,
  onToggle,
  activeProviders,
  modelMappings,
  onModelMappingChange,
  baseUrl,
  hasActiveProviders,
  apiKeys,
  cloudEnabled,
  initialStatus,
  tunnelEnabled,
  tunnelPublicUrl,
  tailscaleEnabled,
  tailscaleUrl,
}) {
  const [claudeStatus, setClaudeStatus] = useState(initialStatus || null);
  const [checkingClaude, setCheckingClaude] = useState(false);
  const [applying, setApplying] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [message, setMessage] = useState(null);
  const [showInstallGuide, setShowInstallGuide] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [currentEditingAlias, setCurrentEditingAlias] = useState(null);
  const [selectedApiKey, setSelectedApiKey] = useState("");
  const [modelAliases, setModelAliases] = useState({});
  const [showManualConfigModal, setShowManualConfigModal] = useState(false);
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [ccFilterNaming, setCcFilterNaming] = useState(false);
  const [exaMcpEnabled, setExaMcpEnabled] = useState(false);
  const [maxContextTokens, setMaxContextTokens] = useState("");
  const hasInitializedModels = useRef(false);

  const currentBaseUrl = claudeStatus?.settings?.env?.ANTHROPIC_BASE_URL || "";

  const getConfigStatus = () => {
    if (!claudeStatus?.installed) return null;
    const currentUrl = claudeStatus.settings?.env?.ANTHROPIC_BASE_URL;
    if (!currentUrl) return "not_configured";
    if (matchKnownEndpoint(currentUrl, { tunnelPublicUrl, tailscaleUrl, cloudUrl: cloudEnabled ? CLOUD_URL : null })) return "configured";
    return "other";
  };

  const configStatus = getConfigStatus();

  useEffect(() => {
    if (apiKeys?.length > 0 && !selectedApiKey) {
      setSelectedApiKey(apiKeys[0].key);
    }
  }, [apiKeys, selectedApiKey]);

  useEffect(() => {
    if (initialStatus) {
      setClaudeStatus(initialStatus);
      setExaMcpEnabled(!!initialStatus.exaMcpEnabled);
    }
  }, [initialStatus]);

  useEffect(() => {
    const v = claudeStatus?.settings?.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
    setMaxContextTokens(v || "");
  }, [claudeStatus?.settings?.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS]);

  async function checkClaudeStatus() {
    setCheckingClaude(true);
    try {
      const res = await fetch("/api/cli-tools/claude-settings");
      const data = await res.json();
      setClaudeStatus(data);
      setExaMcpEnabled(!!data.exaMcpEnabled);
    } catch (error) {
      setClaudeStatus({ installed: false, error: error.message });
    } finally {
      setCheckingClaude(false);
    }
  };

  async function fetchModelAliases() {
    try {
      const res = await fetch("/api/models/alias");
      const data = await res.json();
      if (res.ok) setModelAliases(data.aliases || {});
    } catch (error) {
      console.error("Error fetching model aliases:", error);
    }
  };

  useEffect(() => {
    if (!isExpanded) return;
    // Deferred by one microtask so both fetches run outside the effect body;
    // they still fire together, as before.
    Promise.resolve().then(() => {
      if (!claudeStatus) checkClaudeStatus();
      fetchModelAliases();
    }).catch(() => {});
    // `claudeStatus` is a one-shot guard: listing it as a dependency would
    // refetch the alias map every time the status changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isExpanded]);

  useEffect(() => {
    fetch("/api/settings").then(r => r.json()).then(data => {
      setCcFilterNaming(!!data.ccFilterNaming);
    }).catch(() => {});
  }, []);

  const handleCcFilterNamingToggle = async (e) => {
    const value = e.target.checked;
    setCcFilterNaming(value);
    await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ccFilterNaming: value }),
    }).catch(() => {});
  };

  useEffect(() => {
    if (claudeStatus?.installed && !hasInitializedModels.current) {
      hasInitializedModels.current = true;
      const env = claudeStatus.settings?.env || {};

      tool.defaultModels.forEach((model) => {
        if (model.envKey) {
          const value = env[model.envKey] || model.defaultValue || "";
          // Only sync initial values from file once
          if (value) {
            onModelMappingChange(model.alias, value);
          }
        }
      });
      // Restore key from settings.json; ApiKeySelect matches it against saved presets
      const tokenFromFile = env.ANTHROPIC_AUTH_TOKEN;
      if (tokenFromFile) {
        setSelectedApiKey(tokenFromFile);
      }
    }
  }, [claudeStatus, apiKeys, tool.defaultModels, onModelMappingChange]);

  const getEffectiveBaseUrl = () => {
    const url = customBaseUrl || baseUrl;
    return url.endsWith("/v1") ? url : `${url}/v1`;
  };

  const getDisplayUrl = () => {
    const url = customBaseUrl || baseUrl;
    return url.endsWith("/v1") ? url : `${url}/v1`;
  };

  const handleApplySettings = async () => {
    setApplying(true);
    setMessage(null);
    try {
      const env = { ANTHROPIC_BASE_URL: getEffectiveBaseUrl() };

      // Get key from dropdown, fallback to first key or sk_derouter for localhost
      const keyToUse = selectedApiKey?.trim()
        || (apiKeys?.length > 0 ? apiKeys[0].key : null)
        || (!cloudEnabled ? "sk_derouter" : null);

      if (keyToUse) {
        env.ANTHROPIC_AUTH_TOKEN = keyToUse;
      }

      tool.defaultModels.forEach((model) => {
        const targetModel = modelMappings[model.alias];
        if (targetModel && model.envKey) env[model.envKey] = targetModel;
      });
      if (maxContextTokens) {
        env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = maxContextTokens;
      }
      const res = await fetch("/api/cli-tools/claude-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ env, exaMcpEnabled, maxContextTokens }),
      });
      const data = await res.json();
      if (res.ok) {
        // Remember the endpoint so it stays selectable next time
        rememberEndpoint(getEffectiveBaseUrl(), { tunnelPublicUrl, tailscaleUrl });
        setMessage({ type: "success", text: "Settings applied successfully!" });
        setClaudeStatus(prev => ({ ...prev, hasBackup: true, settings: { ...prev?.settings, env }, exaMcpEnabled }));
      } else {
        setMessage({ type: "error", text: data.error || "Failed to apply settings" });
      }
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setApplying(false);
    }
  };

  const handleResetSettings = async () => {
    setRestoring(true);
    setMessage(null);
    try {
      const res = await fetch("/api/cli-tools/claude-settings", { method: "DELETE" });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: "Settings reset successfully!" });
        tool.defaultModels.forEach((model) => onModelMappingChange(model.alias, model.defaultValue || ""));
        setSelectedApiKey("");
        setExaMcpEnabled(false);
        setMaxContextTokens("");
      } else {
        setMessage({ type: "error", text: data.error || "Failed to reset settings" });
      }
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setRestoring(false);
    }
  };

  const openModelSelector = (alias) => {
    setCurrentEditingAlias(alias);
    setModalOpen(true);
  };

  const handleModelSelect = (model) => {
    if (currentEditingAlias) onModelMappingChange(currentEditingAlias, model.value);
  };

  // Generate settings.json content for manual copy
  const getManualConfigs = () => {
    const keyToUse = (selectedApiKey && selectedApiKey.trim())
      ? selectedApiKey
      : (!cloudEnabled ? "sk_derouter" : "<API_KEY_FROM_DASHBOARD>");
    const env = { ANTHROPIC_BASE_URL: getEffectiveBaseUrl(), ANTHROPIC_AUTH_TOKEN: keyToUse };
    tool.defaultModels.forEach((model) => {
      const targetModel = modelMappings[model.alias];
      if (targetModel && model.envKey) env[model.envKey] = targetModel;
    });
    if (maxContextTokens) {
      env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = maxContextTokens;
    }

    return [
      {
        filename: "~/.claude/settings.json",
        content: JSON.stringify({ hasCompletedOnboarding: true, env }, null, 2),
      },
    ];
  };

  return (
    <Card padding="xs" className="overflow-hidden">
      <div className="flex items-start justify-between gap-3 hover:cursor-pointer sm:items-center" onClick={onToggle}>
        <div className="flex min-w-0 items-center gap-3">
          <div className="size-8 flex items-center justify-center shrink-0">
            <Image src="/providers/claude.png" alt={tool.name} width={32} height={32} className="size-8 object-contain rounded-vx-md" sizes="32px" onError={(e) => { e.target.style.display = "none"; }} loading="lazy" decoding="async" />
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 className="font-medium text-sm">{tool.name}</h3>
              {configStatus === "configured" && <Badge variant="success" size="xs" dot>Connected</Badge>}
              {configStatus === "not_configured" && <Badge variant="warning" size="xs" dot>Not configured</Badge>}
              {configStatus === "other" && <Badge variant="info" size="xs" dot>Other</Badge>}
            </div>
            <p className="text-xs text-vx-text-muted truncate">{tool.description}</p>
          </div>
        </div>
        <span className={`material-symbols-outlined text-vx-text-muted text-[20px] transition-transform ${isExpanded ? "rotate-180" : ""}`}>expand_more</span>
      </div>

      {isExpanded && (
        <div className="mt-4 pt-4 border-t border-vx-border flex flex-col gap-4">
          {checkingClaude && (
            <div className="flex items-center gap-2 text-vx-text-muted">
              <span className="material-symbols-outlined animate-spin">progress_activity</span>
              <span>Checking Claude CLI...</span>
            </div>
          )}

          {!checkingClaude && claudeStatus && !claudeStatus.installed && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-3 p-4 rounded-vx-md bg-vx-warning/10 border border-vx-warning/30">
                <div className="flex items-start gap-3">
                  <span className="material-symbols-outlined text-vx-warning">warning</span>
                  <div className="flex-1">
                    <p className="font-medium text-vx-warning">Claude CLI not detected locally</p>
                    <p className="text-sm text-vx-text-muted">Manual configuration is still available if derouter is deployed on a remote server.</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 pl-9">
                  <Button variant="warning" size="sm" onClick={() => setShowManualConfigModal(true)}>
                    <span className="material-symbols-outlined text-[18px] mr-1">content_copy</span>
                    Manual Config
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setShowInstallGuide(!showInstallGuide)}>
                    <span className="material-symbols-outlined text-[18px] mr-1">{showInstallGuide ? "expand_less" : "help"}</span>
                    {showInstallGuide ? "Hide" : "How to Install"}
                  </Button>
                </div>
              </div>
              {showInstallGuide && (
                <Card.Section>
                  <h4 className="font-medium mb-3 text-vx-text">Installation Guide</h4>
                  <div className="space-y-3 text-sm">
                    <div>
                      <p className="text-vx-text-muted mb-1">macOS / Linux / Windows:</p>
                      <code className="block px-3 py-2 bg-vx-surface-2 rounded-vx-sm font-mono text-xs text-vx-text">npm install -g @anthropic-ai/claude-code</code>
                    </div>
                    <p className="text-vx-text-muted">After installation, run <code className="px-1 bg-vx-surface-2 rounded-vx-sm text-vx-text">claude</code> to verify.</p>
                  </div>
                </Card.Section>
              )}
            </div>
          )}

          {!checkingClaude && claudeStatus?.installed && (
            <>
              <div className="flex flex-col gap-2">
                {/* Endpoint (selector) */}
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-vx-text sm:text-right sm:text-sm">Select Endpoint</span>
                  <span className="material-symbols-outlined hidden text-vx-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <BaseUrlSelect
                    value={customBaseUrl || getDisplayUrl()}
                    onChange={setCustomBaseUrl}
                    requiresExternalUrl={tool.requiresExternalUrl}
                    tunnelEnabled={tunnelEnabled}
                    tunnelPublicUrl={tunnelPublicUrl}
                    tailscaleEnabled={tailscaleEnabled}
                    tailscaleUrl={tailscaleUrl}
                    currentUrl={currentBaseUrl}
                  />
                </div>

                {/* Current configured */}
                {claudeStatus?.settings?.env?.ANTHROPIC_BASE_URL && (
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                    <span className="text-xs font-semibold text-vx-text sm:text-right sm:text-sm">Current</span>
                    <span className="material-symbols-outlined hidden text-vx-text-muted text-[14px] sm:inline">arrow_forward</span>
                    <span className="min-w-0 truncate rounded-vx-sm bg-vx-surface-2 px-2 py-2 text-xs text-vx-text-muted sm:py-1.5">
                      {claudeStatus.settings.env.ANTHROPIC_BASE_URL}
                    </span>
                  </div>
                )}

                {/* API Key */}
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-vx-text sm:text-right sm:text-sm">API Key</span>
                  <span className="material-symbols-outlined hidden text-vx-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <ApiKeySelect value={selectedApiKey} onChange={setSelectedApiKey} apiKeys={apiKeys} cloudEnabled={cloudEnabled} />
                </div>

                {/* Model Mappings */}
                {tool.defaultModels.map((model) => (
                  <div key={model.alias} className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                    <span className="text-xs font-semibold text-vx-text sm:text-right sm:text-sm">{model.name}</span>
                    <span className="material-symbols-outlined hidden text-vx-text-muted text-[14px] sm:inline">arrow_forward</span>
                    <div className="relative w-full min-w-0">
                      <input type="text" value={modelMappings[model.alias] || ""} onChange={(e) => onModelMappingChange(model.alias, e.target.value)} placeholder="provider/model-id" className="w-full min-w-0 pl-2 pr-7 py-2 bg-vx-surface rounded-vx-sm border border-vx-border text-xs focus:outline-none focus:ring-1 focus:ring-vx-primary/50 sm:py-1.5" />
                      {modelMappings[model.alias] && <button onClick={() => onModelMappingChange(model.alias, "")} className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-vx-text-muted hover:text-vx-danger rounded-vx-sm transition-colors" title="Clear"><span className="material-symbols-outlined text-[14px]">close</span></button>}
                    </div>
                    <Button size="sm" variant="light-outline" onClick={() => openModelSelector(model.alias)} disabled={!hasActiveProviders} className="w-full sm:w-auto whitespace-nowrap sm:shrink-0">Select Model</Button>
                  </div>
                ))}

                {/* Context Window */}
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-vx-text sm:text-right sm:text-sm">Context window</span>
                  <span className="material-symbols-outlined hidden text-vx-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <select value={maxContextTokens} onChange={(e) => setMaxContextTokens(e.target.value)} className="w-full min-w-0 px-2 py-2 bg-vx-surface rounded-vx-sm border border-vx-border text-xs text-vx-text focus:outline-none focus:ring-1 focus:ring-vx-primary/50 sm:py-1.5">
                    {CONTEXT_OPTIONS.map((opt) => (
                      <option key={opt.label} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>

                {/* CC Filter Naming */}
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-vx-text sm:text-right sm:text-sm">Filter naming</span>
                  <span className="material-symbols-outlined hidden text-vx-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input type="checkbox" checked={ccFilterNaming} onChange={handleCcFilterNamingToggle} className="w-3.5 h-3.5 accent-vx-primary cursor-pointer" />
                    <span className="text-xs text-vx-text-muted">Filter naming requests</span>
                    <Tooltip text="Intercepts Claude Code's topic-naming requests and returns a fake response locally, saving API tokens.">
                      <span className="material-symbols-outlined text-vx-text-muted text-[14px] cursor-help">info</span>
                    </Tooltip>
                  </label>
                </div>

                {/* Exa MCP — ~/.claude.json mcpServers (not settings.json) */}
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-vx-text sm:text-right sm:text-sm">Web Search</span>
                  <span className="material-symbols-outlined hidden text-vx-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input type="checkbox" checked={exaMcpEnabled} onChange={(e) => setExaMcpEnabled(e.target.checked)} className="w-3.5 h-3.5 accent-vx-primary cursor-pointer" />
                    <span className="text-xs text-vx-text-muted">Exa MCP</span>
                    <Tooltip text="Injects Exa MCP into ~/.claude.json so non-Claude models gain web search. Restart Claude Code after Apply.">
                      <span className="material-symbols-outlined text-vx-text-muted text-[14px] cursor-help">info</span>
                    </Tooltip>
                  </label>
                </div>
              </div>

              {message && (
                <Toast type={message.type} message={message.text} dismissible={false} />
              )}

              <div className="grid grid-cols-1 gap-2 sm:flex sm:items-center">
                <Button variant="primary" size="sm" onClick={handleApplySettings} disabled={!hasActiveProviders} loading={applying}>
                  <span className="material-symbols-outlined text-[14px] mr-1">save</span>Apply
                </Button>
                <Button variant="outline" size="sm" onClick={handleResetSettings} disabled={!claudeStatus?.hasderouter} loading={restoring}>
                  <span className="material-symbols-outlined text-[14px] mr-1">restore</span>Reset
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShowManualConfigModal(true)}>
                  <span className="material-symbols-outlined text-[14px] mr-1">content_copy</span>Manual Config
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {modalOpen && (
        <ModelSelectModal isOpen={modalOpen} onClose={() => setModalOpen(false)} onSelect={handleModelSelect} selectedModel={currentEditingAlias ? modelMappings[currentEditingAlias] : null} activeProviders={activeProviders} modelAliases={modelAliases} title={`Select model for ${currentEditingAlias}`} />
      )}

      <ManualConfigModal
        isOpen={showManualConfigModal}
        onClose={() => setShowManualConfigModal(false)}
        title="Claude CLI - Manual Configuration"
        configs={getManualConfigs()}
      />
    </Card>
  );
}
