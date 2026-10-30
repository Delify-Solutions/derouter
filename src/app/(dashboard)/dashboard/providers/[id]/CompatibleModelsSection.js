"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Button } from "@/shared/components";
import PreviewThumb from "@/shared/components/PreviewThumb";
import { getProviderCustomModelRows } from "@/shared/utils/providerCustomModels";
import { guessModelKind } from "@/lib/models/modelKind";

const KIND_LABEL = { llm: "Text", image: "Image" };
function CompatibleModelRow({ modelId, fullModel, kind, copied, onCopy, onDeleteAlias, onTest, onChangeKind, result, isTesting }) {
  const status = result?.status;
  const borderColor = status === "ok"
    ? "border-green-500/40"
    : status === "error"
    ? "border-red-500/40"
    : "border-border";

  const iconColor = status === "ok"
    ? "#22c55e"
    : status === "error"
    ? "#ef4444"
    : undefined;

  return (
    <div className={`flex flex-col gap-2 p-3 rounded-lg border ${borderColor} hover:bg-sidebar/50`}>
      <div className="flex items-center gap-3">
        <span
          className="material-symbols-outlined text-base text-text-muted"
          style={iconColor ? { color: iconColor } : undefined}
        >
          {status === "ok" ? "check_circle" : status === "error" ? "cancel" : kind === "image" ? "image" : "smart_toy"}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <p className="text-sm font-medium truncate">{modelId}</p>
            {/* Changing the type re-records the model, so the test, the combo picker and
                the public model list all agree on what it is. */}
            {onChangeKind ? (
              <select
                aria-label={`Type of ${modelId}`}
                value={kind}
                onChange={(e) => onChangeKind(e.target.value)}
                className="shrink-0 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-muted"
              >
                <option value="llm">{KIND_LABEL.llm}</option>
                <option value="image">{KIND_LABEL.image}</option>
              </select>
            ) : (
              <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-muted">{KIND_LABEL[kind]}</span>
            )}
          </div>
          <div className="flex items-center gap-1 mt-1">
            <code className="text-xs text-text-muted font-mono bg-sidebar px-1.5 py-0.5 rounded">{fullModel}</code>
            <div className="relative group/btn">
              <button
                onClick={() => onCopy(fullModel, `model-${modelId}`)}
                className="p-0.5 hover:bg-sidebar rounded text-text-muted hover:text-primary"
              >
                <span className="material-symbols-outlined text-sm">
                  {copied === `model-${modelId}` ? "check" : "content_copy"}
                </span>
              </button>
              <span className="pointer-events-none absolute top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
                {copied === `model-${modelId}` ? "Copied!" : "Copy"}
              </span>
            </div>
          </div>
        </div>
        {onTest && (
          <button
            onClick={onTest}
            disabled={isTesting}
            className="flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-xs text-text-muted hover:bg-sidebar hover:text-primary disabled:opacity-60"
          >
            <span className="material-symbols-outlined text-sm" style={isTesting ? { animation: "spin 1s linear infinite" } : undefined}>
              {isTesting ? "progress_activity" : "science"}
            </span>
            {isTesting ? "Testing..." : kind === "image" ? "Test (1 image)" : "Test"}
          </button>
        )}
        <button
          onClick={onDeleteAlias}
          className="p-1 hover:bg-red-50 rounded text-red-500"
          title="Remove model"
        >
          <span className="material-symbols-outlined text-sm">delete</span>
        </button>
      </div>

      {result && (
        <div role="status" className="flex items-start gap-3 pl-8 text-xs">
          <div className="min-w-0 flex-1">
            <p className={status === "ok" ? "text-green-600 dark:text-green-400" : "text-red-500"}>
              {status === "ok"
                ? `OK · ${result.kind === "image" ? "image generated" : "replied"} in ${(result.latencyMs / 1000).toFixed(1)}s`
                : `Failed${result.latencyMs ? ` after ${(result.latencyMs / 1000).toFixed(1)}s` : ""}`}
            </p>
            {status === "error" && result.error && <p className="mt-0.5 break-words text-text-muted">{result.error}</p>}
            {status === "ok" && result.kind !== "image" && result.content && (
              <p className="mt-0.5 break-words text-text-muted">&ldquo;{result.content.slice(0, 160)}&rdquo;</p>
            )}
          </div>
          {status === "ok" && result.preview && (
            <PreviewThumb src={result.preview} className="h-16 w-16 rounded border border-border object-cover" />
          )}
        </div>
      )}
    </div>
  );
}

export default function CompatibleModelsSection({ providerStorageAlias, providerDisplayAlias, modelAliases, customModels, copied, onCopy, onDeleteAlias, onAddCustomModel, onDeleteCustomModel, connections, isAnthropic }) {
  const [newModel, setNewModel] = useState("");
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [newKind, setNewKind] = useState("llm");
  const [kindTouched, setKindTouched] = useState(false);
  const [testingModelId, setTestingModelId] = useState(null);
  const [testResults, setTestResults] = useState({});

  const handleTestModel = async (modelId, kind) => {
    if (testingModelId) return;
    // An image test generates one real image on the upstream account, so ask first.
    if (kind === "image" && !window.confirm("This test generates one real image and uses your upstream quota. Continue?")) return;
    setTestingModelId(modelId);
    try {
      const res = await fetch("/api/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: `${providerStorageAlias}/${modelId}`, kind }),
      });
      const data = await res.json().catch(() => ({ ok: false, error: "Invalid response from test endpoint" }));
      setTestResults((prev) => ({ ...prev, [modelId]: { ...data, kind: data.kind || kind, status: data.ok ? "ok" : "error" } }));
    } catch {
      setTestResults((prev) => ({ ...prev, [modelId]: { status: "error", error: "Network error", kind } }));
    } finally {
      setTestingModelId(null);
    }
  };

  // Both kinds live on one node (an OpenAI-compatible gateway often serves text and
  // image models), so list every custom model and show its type.
  const allModels = getProviderCustomModelRows({
    customModels,
    modelAliases,
    providerAlias: providerStorageAlias,
    type: null,
  });

  const handleAdd = async () => {
    if (!newModel.trim() || adding) return;
    const modelId = newModel.trim();
    if (allModels.some((model) => model.id === modelId)) {
      alert("Model already exists for this provider.");
      return;
    }

    setAdding(true);
    try {
      await onAddCustomModel(modelId, newKind);
      setNewModel("");
      setKindTouched(false);
      setNewKind("llm");
    } catch (error) {
      console.error("Error adding model:", error);
    } finally {
      setAdding(false);
    }
  };

  const handleImport = async () => {
    if (importing) return;
    const activeConnection = connections.find((conn) => conn.isActive !== false);
    if (!activeConnection) return;

    setImporting(true);
    try {
      const res = await fetch(`/api/providers/${activeConnection.id}/models`);
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Failed to import models");
        return;
      }
      const models = data.models || [];
      if (models.length === 0) {
        alert("No models returned from /models.");
        return;
      }
      let importedCount = 0;
      for (const model of models) {
        const modelId = model.id || model.name || model.model;
        if (!modelId) continue;
        if (allModels.some((entry) => entry.id === modelId)) continue;
        await onAddCustomModel(modelId, guessModelKind(modelId));
        importedCount += 1;
      }
      if (importedCount === 0) {
        alert("No new models were added.");
      }
    } catch (error) {
      console.error("Error importing models:", error);
    } finally {
      setImporting(false);
    }
  };

  const canImport = connections.some((conn) => conn.isActive !== false);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-muted">
        Add {isAnthropic ? "Anthropic" : "OpenAI"}-compatible models manually or import them from the /models endpoint.
      </p>

      <div className="flex items-end gap-2 flex-wrap">
        <div className="flex-1 min-w-[240px]">
          <label htmlFor="new-compatible-model-input" className="text-xs text-text-muted mb-1 block">Model ID</label>
          <input
            id="new-compatible-model-input"
            type="text"
            value={newModel}
            onChange={(e) => {
              setNewModel(e.target.value);
              if (!kindTouched) setNewKind(guessModelKind(e.target.value));
            }}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            placeholder={isAnthropic ? "claude-3-opus-20240229" : "gpt-4o"}
            className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
          />
        </div>
        <div>
          <label htmlFor="new-compatible-model-kind" className="text-xs text-text-muted mb-1 block">Type</label>
          <select
            id="new-compatible-model-kind"
            value={newKind}
            onChange={(e) => { setNewKind(e.target.value); setKindTouched(true); }}
            className="px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
          >
            <option value="llm">{KIND_LABEL.llm}</option>
            <option value="image">{KIND_LABEL.image}</option>
          </select>
        </div>
        <Button size="sm" icon="add" onClick={handleAdd} disabled={!newModel.trim() || adding}>
          {adding ? "Adding..." : "Add"}
        </Button>
        <Button size="sm" variant="secondary" icon="download" onClick={handleImport} disabled={!canImport || importing}>
          {importing ? "Importing..." : "Import from /models"}
        </Button>
      </div>

      {!canImport && (
        <p className="text-xs text-text-muted">
          Add a connection to enable importing models.
        </p>
      )}

      {allModels.length > 0 && (
        <div className="flex flex-col gap-3">
          {allModels.map(({ id, alias, source, type }) => {
            const kind = type === "image" ? "image" : "llm";
            return (
              <CompatibleModelRow
                key={`${source}-${providerStorageAlias}/${id}`}
                modelId={id}
                fullModel={`${providerDisplayAlias}/${id}`}
                kind={kind}
                copied={copied}
                onCopy={onCopy}
                onDeleteAlias={() => source === "custom" ? onDeleteCustomModel(id, kind) : onDeleteAlias(alias)}
                onChangeKind={source === "custom" ? async (next) => {
                  if (next === kind) return;
                  await onAddCustomModel(id, next);
                  await onDeleteCustomModel(id, kind);
                } : undefined}
                onTest={connections.length > 0 ? () => handleTestModel(id, kind) : undefined}
                result={testResults[id]}
                isTesting={testingModelId === id}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

CompatibleModelsSection.propTypes = {
  providerStorageAlias: PropTypes.string.isRequired,
  providerDisplayAlias: PropTypes.string.isRequired,
  modelAliases: PropTypes.object.isRequired,
  customModels: PropTypes.arrayOf(PropTypes.object),
  copied: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  onDeleteAlias: PropTypes.func.isRequired,
  onAddCustomModel: PropTypes.func.isRequired,
  onDeleteCustomModel: PropTypes.func.isRequired,
  connections: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    isActive: PropTypes.bool,
  })).isRequired,
  isAnthropic: PropTypes.bool,
};
