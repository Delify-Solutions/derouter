"use client";

import { useState, useEffect, useRef } from "react";
import { Card, Button, Badge, ModelSelectModal, ManualConfigModal } from "@/shared/components";
import Image from "next/image";
import BaseUrlSelect from "./BaseUrlSelect";
import { rememberEndpoint } from "./cliEndpointPresets";
import ApiKeySelect from "./ApiKeySelect";
import { matchKnownEndpoint } from "./cliEndpointMatch";

export default function JcodeToolCard({
  tool,
  isExpanded,
  onToggle,
  baseUrl,
  hasActiveProviders,
  apiKeys,
  activeProviders,
  cloudEnabled,
  initialStatus,
  tunnelEnabled,
  tunnelPublicUrl,
  tailscaleEnabled,
  tailscaleUrl,
}) {
  const [jcodeStatus, setJcodeStatus] = useState(initialStatus || null);
  const [checkingJcode, setCheckingJcode] = useState(false);
  const [applying, setApplying] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [message, setMessage] = useState(null);
  const [selectedApiKey, setSelectedApiKey] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [modelAliases, setModelAliases] = useState({});
  const [showManualConfigModal, setShowManualConfigModal] = useState(false);
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const hasInitializedModel = useRef(false);

  const currentBaseUrl = jcodeStatus?.config?.providers?.["derouter"]?.base_url || "";

  const getConfigStatus = () => {
    if (!jcodeStatus?.installed) return null;
    if (!jcodeStatus?.hasderouter) return "not_configured";
    const currentProvider = jcodeStatus.config?.providers?.["derouter"];
    if (!currentProvider) return "not_configured";
    return matchKnownEndpoint(currentProvider.base_url, { tunnelPublicUrl, tailscaleUrl }) ? "configured" : "other";
  };

  const configStatus = getConfigStatus();

  useEffect(() => {
    if (apiKeys?.length > 0 && !selectedApiKey) {
      setSelectedApiKey(apiKeys[0].key);
    }
  }, [apiKeys, selectedApiKey]);

  useEffect(() => {
    if (initialStatus) setJcodeStatus(initialStatus);
  }, [initialStatus]);

  useEffect(() => {
    if (isExpanded) {
      if (!jcodeStatus) checkJcodeStatus();
      fetchModelAliases();
    }
    // `jcodeStatus` is a one-shot guard: listing it as a dependency would refetch the
    // alias map every time the status changes, so it is deliberately omitted.
  }, [isExpanded]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (jcodeStatus?.installed && !hasInitializedModel.current) {
      hasInitializedModel.current = true;
      const provider = jcodeStatus.config?.providers?.["derouter"];
      if (provider) {
        if (provider.default_model) {
          setSelectedModel(provider.default_model);
        }
        // Try to match API key from env file
        const envApiKey = jcodeStatus.envApiKey;
        if (envApiKey && apiKeys?.some(k => k.key === envApiKey)) {
          setSelectedApiKey(envApiKey);
        }
      }
    }
  }, [jcodeStatus, apiKeys]);

  async function checkJcodeStatus() {
    setCheckingJcode(true);
    try {
      const res = await fetch("/api/cli-tools/jcode-settings");
      const data = await res.json();
      setJcodeStatus(data);
    } catch (error) {
      setJcodeStatus({ installed: false, error: error.message });
    } finally {
      setCheckingJcode(false);
    }
  };

  const normalizeLocalhost = (url) => url.replace("://localhost", "://127.0.0.1");

  const getLocalBaseUrl = () => {
    if (typeof window !== "undefined") {
      return normalizeLocalhost(window.location.origin);
    }
    return "http://127.0.0.1:20128";
  };

  const getEffectiveBaseUrl = () => {
    const url = customBaseUrl || getLocalBaseUrl();
    return url.endsWith("/v1") ? url : `${url}/v1`;
  };

  const getDisplayUrl = () => {
    const url = customBaseUrl || getLocalBaseUrl();
    return url.endsWith("/v1") ? url : `${url}/v1`;
  };

  const handleApplySettings = async () => {
    setApplying(true);
    setMessage(null);
    try {
      const keyToUse = selectedApiKey?.trim()
        || (apiKeys?.length > 0 ? apiKeys[0].key : null)
        || (!cloudEnabled ? "sk_derouter" : null);

      const res = await fetch("/api/cli-tools/jcode-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: getEffectiveBaseUrl(),
          apiKey: keyToUse,
          models: selectedModel ? [selectedModel] : [],
        }),
      });
      const data = await res.json();
      if (res.ok) {
        // Remember the endpoint so it stays selectable next time
        rememberEndpoint(getEffectiveBaseUrl(), { tunnelPublicUrl, tailscaleUrl });
        setMessage({ type: "success", text: "Settings applied successfully!" });
        checkJcodeStatus();
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
      const res = await fetch("/api/cli-tools/jcode-settings", { method: "DELETE" });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: "Settings reset successfully!" });
        setSelectedModel("");
        setSelectedApiKey("");
        checkJcodeStatus();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to reset settings" });
      }
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setRestoring(false);
    }
  };

  const handleModelSelect = (model) => {
    setSelectedModel(model.value);
    setModalOpen(false);
  };

  const getManualConfigs = () => {
    const keyToUse = (selectedApiKey && selectedApiKey.trim())
      ? selectedApiKey
      : (!cloudEnabled ? "sk_derouter" : "<API_KEY_FROM_DASHBOARD>");

    const configToml = `[providers.derouter]
type = "openai-compatible"
base_url = "${getEffectiveBaseUrl()}"
auth = "bearer"
api_key_env = "JCODE_DEROUTER_API_KEY"
env_file = "provider-derouter.env"
default_model = "${selectedModel || "cc/claude-opus-4-7"}"
requires_api_key = true

[[providers.derouter.models]]
id = "${selectedModel || "cc/claude-opus-4-7"}"`;

    const envContent = `JCODE_DEROUTER_API_KEY="${keyToUse}"`;

    return [
      {
        filename: "~/.jcode/config.toml",
        content: configToml,
      },
      {
        filename: "~/.config/jcode/provider-derouter.env",
        content: envContent,
      },
    ];
  };

  return (
    <Card padding="xs" className="overflow-hidden">
      <div className="flex items-start justify-between gap-3 hover:cursor-pointer sm:items-center" onClick={onToggle}>
        <div className="flex min-w-0 items-center gap-3">
          <div className="size-8 flex items-center justify-center shrink-0">
            <Image src={tool.image || "/providers/jcode.png"} alt={tool.name} width={32} height={32} className="size-8 object-contain rounded-vx-lg" sizes="32px" onError={(e) => { e.target.style.display = "none"; }} loading="lazy" decoding="async" />
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 className="font-medium text-sm">{tool.name}</h3>
              {configStatus === "configured" && <Badge variant="success" size="xs">Connected</Badge>}
              {configStatus === "not_configured" && <Badge variant="warning" size="xs">Not configured</Badge>}
              {configStatus === "other" && <Badge variant="info" size="xs">Other</Badge>}
            </div>
            <p className="text-xs text-vx-text-muted truncate">{tool.description}</p>
          </div>
        </div>
        <span className={`material-symbols-outlined text-vx-text-muted text-[20px] transition-transform ${isExpanded ? "rotate-180" : ""}`}>expand_more</span>
      </div>

      {isExpanded && (
        <div className="mt-4 pt-4 border-t border-vx-border flex flex-col gap-4">
          {checkingJcode && (
            <div className="flex items-center gap-2 text-vx-text-muted">
              <span className="material-symbols-outlined animate-spin">progress_activity</span>
              <span>Checking jcode CLI...</span>
            </div>
          )}

          {!checkingJcode && jcodeStatus && !jcodeStatus.installed && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-3 p-4 bg-vx-warning/10 border border-vx-warning/30 rounded-vx-lg">
                <div className="flex items-start gap-3">
                  <span className="material-symbols-outlined text-vx-warning">warning</span>
                  <div className="flex-1">
                    <p className="font-medium text-vx-warning">jcode CLI not detected locally</p>
                    <p className="text-sm text-vx-text-muted mt-1">Install jcode to enable automatic configuration:</p>
                    <code className="block mt-2 p-2 bg-vx-page rounded-vx-md text-xs font-mono text-vx-text">
                      curl -fsSL https://raw.githubusercontent.com/1jehuang/jcode/master/scripts/install.sh | bash
                    </code>
                    <p className="text-sm text-vx-text-muted mt-2">Manual configuration is still available if derouter is deployed on a remote server.</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 pl-9">
                  <Button variant="warning-outline" size="sm" icon="content_copy" onClick={() => setShowManualConfigModal(true)}>
                    Manual Config
                  </Button>
                </div>
              </div>
            </div>
          )}

          {!checkingJcode && jcodeStatus?.installed && (
            <>
              <div className="flex flex-col gap-2">
                {/* Info notes */}
                {tool.notes && tool.notes.length > 0 && (
                  <div className="flex flex-col gap-2 mb-2">
                    {tool.notes.map((note, idx) => (
                      <div key={idx} className={`flex items-start gap-2 p-2 rounded-vx-md text-xs ${
                        note.type === "info" ? "bg-vx-info/10 text-vx-info" :
                        note.type === "warning" ? "bg-vx-warning/10 text-vx-warning" :
                        "bg-vx-surface-3 text-vx-text-muted"
                      }`}>
                        <span className="material-symbols-outlined text-[14px] mt-0.5">
                          {note.type === "info" ? "info" : note.type === "warning" ? "warning" : "help"}
                        </span>
                        <span>{note.text}</span>
                      </div>
                    ))}
                  </div>
                )}

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
                {jcodeStatus?.config?.providers?.["derouter"]?.base_url && (
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                    <span className="text-xs font-semibold text-vx-text sm:text-right sm:text-sm">Current</span>
                    <span className="material-symbols-outlined hidden text-vx-text-muted text-[14px] sm:inline">arrow_forward</span>
                    <span className="min-w-0 truncate rounded-vx-md bg-vx-page px-2 py-2 text-xs text-vx-text-muted sm:py-1.5">
                      {jcodeStatus.config.providers["derouter"].base_url}
                    </span>
                  </div>
                )}

                {/* API Key */}
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-vx-text sm:text-right sm:text-sm">API Key</span>
                  <span className="material-symbols-outlined hidden text-vx-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <ApiKeySelect value={selectedApiKey} onChange={setSelectedApiKey} apiKeys={apiKeys} cloudEnabled={cloudEnabled} />
                </div>

                {/* Default Model */}
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-vx-text sm:text-right sm:text-sm">Default Model</span>
                  <span className="material-symbols-outlined hidden text-vx-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <div className="relative w-full min-w-0">
                    <input type="text" value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)} placeholder="cc/claude-opus-4-7" className="w-full min-w-0 pl-2 pr-7 py-2 bg-vx-surface rounded-vx-md border border-vx-border text-xs text-vx-text focus:outline-none focus:border-vx-primary focus:ring-2 focus:ring-vx-primary/15 sm:py-1.5" />
                    {selectedModel && <button onClick={() => setSelectedModel("")} className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-vx-text-muted hover:text-vx-danger rounded-vx-sm transition-colors" title="Clear"><span className="material-symbols-outlined text-[14px]">close</span></button>}
                  </div>
                  <Button type="button" variant="light-outline" size="sm" onClick={() => setModalOpen(true)} disabled={!hasActiveProviders} className="w-full sm:w-auto whitespace-nowrap">Select</Button>
                </div>

                {/* Usage hint */}
                <div className="flex flex-col gap-1 p-3 bg-vx-info/5 border border-vx-info/20 rounded-vx-lg">
                  <p className="text-xs font-medium text-vx-info">Usage:</p>
                  <code className="text-xs font-mono text-vx-text-muted">jcode --provider-profile derouter</code>
                  <code className="text-xs font-mono text-vx-text-muted">jcode --provider-profile derouter --model {selectedModel || "cc/claude-opus-4-7"}</code>
                </div>
              </div>

              {message && (
                <div className={`flex items-center gap-2 px-2 py-1.5 rounded-vx-md text-xs ${message.type === "success" ? "bg-vx-success/10 text-vx-success" : "bg-vx-danger/10 text-vx-danger"}`}>
                  <span className="material-symbols-outlined text-[14px]">{message.type === "success" ? "check_circle" : "error"}</span>
                  <span>{message.text}</span>
                </div>
              )}

              <div className="grid grid-cols-1 gap-2 sm:flex sm:items-center">
                <Button variant="primary" size="sm" icon="save" onClick={handleApplySettings} disabled={!selectedModel} loading={applying}>
                  Apply
                </Button>
                <Button variant="outline" size="sm" icon="restore" onClick={handleResetSettings} disabled={!jcodeStatus?.hasderouter} loading={restoring}>
                  Reset
                </Button>
                <Button variant="ghost" size="sm" icon="content_copy" onClick={() => setShowManualConfigModal(true)}>
                  Manual Config
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {modalOpen && (
        <ModelSelectModal
          isOpen={modalOpen}
          onClose={() => setModalOpen(false)}
          onSelect={handleModelSelect}
          selectedModel={selectedModel}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          title="Select Model for jcode"
        />
      )}

      <ManualConfigModal
        isOpen={showManualConfigModal}
        onClose={() => setShowManualConfigModal(false)}
        title="jcode - Manual Configuration"
        configs={getManualConfigs()}
      />
    </Card>
  );
}
