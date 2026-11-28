"use client";

import { useState, useEffect, useRef } from "react";
import { Card, Button, Badge, ModelSelectModal, ManualConfigModal } from "@/shared/components";
import Image from "next/image";
import BaseUrlSelect from "./BaseUrlSelect";
import { rememberEndpoint } from "./cliEndpointPresets";
import ApiKeySelect from "./ApiKeySelect";
import { matchKnownEndpoint } from "./cliEndpointMatch";

export default function CopilotToolCard({ tool, isExpanded, onToggle, baseUrl, apiKeys, activeProviders, cloudEnabled, initialStatus, tunnelEnabled, tunnelPublicUrl, tailscaleEnabled, tailscaleUrl }) {
  const [status, setStatus] = useState(initialStatus || null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [message, setMessage] = useState(null);
  const [selectedApiKey, setSelectedApiKey] = useState("");
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [modelAliases, setModelAliases] = useState({});
  const [showManualConfigModal, setShowManualConfigModal] = useState(false);
  const [selectedModels, setSelectedModels] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const selectedModelsRef = useRef([]);

  useEffect(() => {
    selectedModelsRef.current = selectedModels;
  }, [selectedModels]);

  useEffect(() => {
    if (apiKeys?.length > 0 && !selectedApiKey) {
      setSelectedApiKey(apiKeys[0].key);
    }
  }, [apiKeys, selectedApiKey]);

  useEffect(() => {
    if (initialStatus) setStatus(initialStatus);
  }, [initialStatus]);

  useEffect(() => {
    if (isExpanded) {
      if (!status) checkStatus();
      fetchModelAliases();
    }
    // `status` is a one-shot guard: listing it as a dependency would refetch the
    // alias map every time the status changes, so it is deliberately omitted.
  }, [isExpanded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pre-fill from existing config
  useEffect(() => {
    if (status?.config && Array.isArray(status.config) && selectedModels.length === 0) {
      const entry = status.config.find((e) => e.name === "derouter");
      if (entry?.models?.length > 0) {
        setSelectedModels(entry.models.map((m) => m.id));
      }
    }
    // `selectedModels.length` is a guard: once non-empty the body is a no-op.
  }, [status, selectedModels.length]);

  async function fetchModelAliases() {
    try {
      const res = await fetch("/api/models/alias");
      const data = await res.json();
      if (res.ok) setModelAliases(data.aliases || {});
    } catch (error) {
      console.error("Error fetching model aliases:", error);
    }
  };

  const saveModels = async (models) => {
    try {
      const keyToUse = (selectedApiKey && selectedApiKey.trim())
        ? selectedApiKey
        : (!cloudEnabled ? "sk_derouter" : selectedApiKey);
      await fetch("/api/cli-tools/copilot-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: getEffectiveBaseUrl(), apiKey: keyToUse, models }),
      });
    } catch (error) {
      console.error("Error saving models:", error);
    }
  };

  const currentBaseUrl = status?.currentUrl || "";

  const getConfigStatus = () => {
    if (!status) return null;
    if (!status.hasderouter) return "not_configured";
    const url = status.currentUrl || "";
    return matchKnownEndpoint(url, { tunnelPublicUrl, tailscaleUrl }) ? "configured" : "other";
  };

  const configStatus = getConfigStatus();

  const getEffectiveBaseUrl = () => {
    const url = customBaseUrl || baseUrl;
    return url.endsWith("/v1") ? url : `${url}/v1`;
  };

  const getDisplayUrl = () => customBaseUrl || `${baseUrl}/v1`;

  const removeModel = (id) => setSelectedModels((prev) => prev.filter((m) => m !== id));

  async function checkStatus() {
    setChecking(true);
    try {
      const res = await fetch("/api/cli-tools/copilot-settings");
      const data = await res.json();
      setStatus(data);
    } catch (error) {
      setStatus({ error: error.message });
    } finally {
      setChecking(false);
    }
  };

  const handleApply = async () => {
    setApplying(true);
    setMessage(null);
    try {
      const keyToUse = (selectedApiKey && selectedApiKey.trim())
        ? selectedApiKey
        : (!cloudEnabled ? "sk_derouter" : selectedApiKey);

      const res = await fetch("/api/cli-tools/copilot-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: getEffectiveBaseUrl(), apiKey: keyToUse, models: selectedModels }),
      });
      const data = await res.json();
      if (res.ok) {
        // Remember the endpoint so it stays selectable next time
        rememberEndpoint(getEffectiveBaseUrl(), { tunnelPublicUrl, tailscaleUrl });
        setMessage({ type: "success", text: data.message || "Settings applied! Reload VS Code." });
        checkStatus();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to apply settings" });
      }
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setApplying(false);
    }
  };

  const handleReset = async () => {
    setRestoring(true);
    setMessage(null);
    try {
      const res = await fetch("/api/cli-tools/copilot-settings", { method: "DELETE" });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: "Settings reset successfully!" });
        setSelectedModels([]);
        checkStatus();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to reset settings" });
      }
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setRestoring(false);
    }
  };

  const getManualConfigs = () => {
    const keyToUse = (selectedApiKey && selectedApiKey.trim())
      ? selectedApiKey
      : (!cloudEnabled ? "sk_derouter" : "<API_KEY_FROM_DASHBOARD>");
    const effectiveBaseUrl = getEffectiveBaseUrl();
    const modelsToShow = selectedModels.length > 0 ? selectedModels : ["provider/model-id"];

    return [{
      filename: "~/Library/Application Support/Code/User/chatLanguageModels.json",
      content: JSON.stringify([{
        name: "derouter",
        vendor: "azure",
        apiKey: keyToUse,
        models: modelsToShow.map((id) => ({
          id, name: id,
          url: `${effectiveBaseUrl}/chat/completions#models.ai.azure.com`,
          toolCalling: true, vision: false,
          maxInputTokens: 128000, maxOutputTokens: 16000,
        })),
      }], null, 2),
    }];
  };

  return (
    <Card padding="xs" className="overflow-hidden">
      <div className="flex items-start justify-between gap-3 hover:cursor-pointer sm:items-center" onClick={onToggle}>
        <div className="flex min-w-0 items-center gap-3">
          <div className="size-8 flex items-center justify-center shrink-0">
            <Image src="/providers/copilot.png" alt={tool.name} width={32} height={32} className="size-8 object-contain rounded-vx-lg" sizes="32px" onError={(e) => { e.target.style.display = "none"; }} loading="lazy" decoding="async" />
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
          {checking && (
            <div className="flex items-center gap-2 text-vx-text-muted">
              <span className="material-symbols-outlined animate-spin">progress_activity</span>
              <span>Checking Copilot config...</span>
            </div>
          )}

          {!checking && (
            <>
              <div className="flex items-start gap-3 p-3 bg-vx-info/10 border border-vx-info/30 rounded-vx-lg">
                <span className="material-symbols-outlined text-vx-info text-lg">info</span>
                <div className="text-xs text-vx-info">
                  <p className="font-medium">Writes to <code className="px-1 bg-vx-page rounded-vx-sm">chatLanguageModels.json</code></p>
                  <p className="mt-0.5 opacity-80">Reload VS Code after applying for changes to take effect.</p>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                {/* Endpoint */}
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

                {/* API Key */}
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-vx-text sm:text-right sm:text-sm">API Key</span>
                  <span className="material-symbols-outlined hidden text-vx-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <ApiKeySelect value={selectedApiKey} onChange={setSelectedApiKey} apiKeys={apiKeys} cloudEnabled={cloudEnabled} />
                </div>

                {/* Models */}
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr] sm:items-start sm:gap-2">
                  <span className="w-32 shrink-0 text-sm font-semibold text-vx-text text-right pt-1">Models</span>
                  <span className="material-symbols-outlined text-vx-text-muted text-[14px] mt-1.5">arrow_forward</span>
                  <div className="flex-1 flex flex-col gap-2">
                    <div className="flex flex-wrap gap-1.5 min-h-[28px] px-2 py-1.5 bg-vx-surface rounded-vx-md border border-vx-border">
                      {selectedModels.length === 0 ? (
                        <span className="text-xs text-vx-text-muted">No models selected</span>
                      ) : (
                        selectedModels.map((model) => (
                          <span key={model} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-vx-sm text-xs bg-vx-surface-3 text-vx-text-muted border border-transparent hover:border-vx-border">
                            {model}
                            <button onClick={(e) => { e.stopPropagation(); removeModel(model); }} className="ml-0.5 hover:text-vx-danger">
                              <span className="material-symbols-outlined text-[12px]">close</span>
                            </button>
                          </span>
                        ))
                      )}
                    </div>
                    <div>
                      <Button type="button" variant="light-outline" size="sm" onClick={() => setModalOpen(true)} disabled={!activeProviders?.length}>Add Model</Button>
                    </div>
                  </div>
                </div>
              </div>

              {message && (
                <div className={`flex items-center gap-2 px-2 py-1.5 rounded-vx-md text-xs ${message.type === "success" ? "bg-vx-success/10 text-vx-success" : "bg-vx-danger/10 text-vx-danger"}`}>
                  <span className="material-symbols-outlined text-[14px]">{message.type === "success" ? "check_circle" : "error"}</span>
                  <span>{message.text}</span>
                </div>
              )}

              <div className="grid grid-cols-1 gap-2 sm:flex sm:items-center">
                <Button variant="primary" size="sm" icon="save" onClick={handleApply} disabled={selectedModels.length === 0} loading={applying}>
                  Apply
                </Button>
                <Button variant="outline" size="sm" icon="restore" onClick={handleReset} disabled={!status?.hasderouter} loading={restoring}>
                  Reset
                </Button>
                <Button variant="ghost" size="sm" icon="content_copy" onClick={() => setShowManualConfigModal(true)} disabled={selectedModels.length === 0}>
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
          onClose={() => {
            setModalOpen(false);
            saveModels(selectedModelsRef.current);
          }}
          onSelect={(model) => {
            if (!selectedModels.includes(model.value)) {
              setSelectedModels([...selectedModels, model.value]);
            }
          }}
          onDeselect={(model) => {
            setSelectedModels(selectedModels.filter(m => m !== model.value));
          }}
          selectedModel={null}
          activeProviders={activeProviders}
          modelAliases={modelAliases}
          addedModelValues={selectedModels}
          closeOnSelect={false}
          title="Add Model for GitHub Copilot"
        />
      )}

      <ManualConfigModal
        isOpen={showManualConfigModal}
        onClose={() => setShowManualConfigModal(false)}
        title="GitHub Copilot - Manual Configuration"
        configs={getManualConfigs()}
      />
    </Card>
  );
}
