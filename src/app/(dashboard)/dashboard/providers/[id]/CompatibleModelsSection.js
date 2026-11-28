"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Badge, Button } from "@/shared/components";
import PreviewThumb from "@/shared/components/PreviewThumb";
import { getProviderCustomModelRows } from "@/shared/utils/providerCustomModels";
import { guessModelKind } from "@/lib/models/modelKind";

const KIND_LABEL = { llm: "Text", image: "Image" };
function CompatibleModelRow({ modelId, fullModel, kind, copied, onCopy, onDeleteAlias, onTest, onChangeKind, result, isTesting, onEditVendorCost, hasVendorCost }) {
  const status = result?.status;
  const borderColor = status === "ok"
    ? "border-vx-success/40"
    : status === "error"
    ? "border-vx-danger/40"
    : "border-vx-border";

  const iconColor = status === "ok"
    ? "var(--vx-success)"
    : status === "error"
    ? "var(--vx-danger)"
    : undefined;

  return (
    <div className={`flex flex-col gap-2 p-3 rounded-vx-md border ${borderColor} hover:bg-vx-surface-2/60`}>
      <div className="flex items-center gap-3">
        <span
          className="material-symbols-outlined text-base text-vx-text-muted"
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
                className="shrink-0 rounded-vx-sm border border-vx-border bg-vx-surface px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-vx-text-muted"
              >
                <option value="llm">{KIND_LABEL.llm}</option>
                <option value="image">{KIND_LABEL.image}</option>
              </select>
            ) : (
              <Badge size="sm" className="shrink-0">{KIND_LABEL[kind]}</Badge>
            )}
          </div>
          <div className="flex items-center gap-1 mt-1">
            <code className="text-xs text-vx-text-muted font-mono bg-vx-surface-2 px-1.5 py-0.5 rounded-vx-sm">{fullModel}</code>
            <div className="relative group/btn">
              <button
                onClick={() => onCopy(fullModel, `model-${modelId}`)}
                className="p-0.5 hover:bg-vx-surface-2 rounded-vx-sm text-vx-text-muted hover:text-vx-primary"
              >
                <span className="material-symbols-outlined text-sm">
                  {copied === `model-${modelId}` ? "check" : "content_copy"}
                </span>
              </button>
              <span className="pointer-events-none absolute top-5 left-1/2 -translate-x-1/2 text-[10px] text-vx-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
                {copied === `model-${modelId}` ? "Copied!" : "Copy"}
              </span>
            </div>
          </div>
        </div>
        {onEditVendorCost && (
          <div className="relative shrink-0 group/btn">
            <button
              onClick={onEditVendorCost}
              className="rounded-vx-sm p-1 text-vx-text-muted hover:bg-vx-surface-2 hover:text-vx-primary"
            >
              {/* Distinct glyph (not just colour) marks whether this model already has a
                  vendor cost set — ui-dna.md "no colour-only status". */}
              <span className="material-symbols-outlined text-sm">{hasVendorCost ? "payments" : "add_card"}</span>
            </button>
            <span className="pointer-events-none absolute mt-1 top-6 left-1/2 -translate-x-1/2 text-[10px] text-vx-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
              {hasVendorCost ? "Sửa giá vốn" : "Thêm giá vốn"}
            </span>
          </div>
        )}
        {onTest && (
          <button
            onClick={onTest}
            disabled={isTesting}
            className="flex shrink-0 items-center gap-1 rounded-vx-sm border border-vx-border px-2 py-1 text-xs text-vx-text-muted hover:bg-vx-surface-2 hover:text-vx-primary disabled:opacity-60"
          >
            <span className="material-symbols-outlined text-sm" style={isTesting ? { animation: "spin 1s linear infinite" } : undefined}>
              {isTesting ? "progress_activity" : "science"}
            </span>
            {isTesting ? "Testing..." : kind === "image" ? "Test (1 image)" : "Test"}
          </button>
        )}
        <button
          onClick={onDeleteAlias}
          className="p-1 hover:bg-vx-danger/10 rounded-vx-sm text-vx-danger"
          title="Remove model"
        >
          <span className="material-symbols-outlined text-sm">delete</span>
        </button>
      </div>

      {result && (
        <div role="status" className="flex items-start gap-3 pl-8 text-xs">
          <div className="min-w-0 flex-1">
            <p className={status === "ok" ? "text-vx-success" : "text-vx-danger"}>
              {status === "ok"
                ? `OK · ${result.kind === "image" ? "image generated" : "replied"} in ${(result.latencyMs / 1000).toFixed(1)}s`
                : `Failed${result.latencyMs ? ` after ${(result.latencyMs / 1000).toFixed(1)}s` : ""}`}
            </p>
            {status === "error" && result.error && <p className="mt-0.5 break-words text-vx-text-muted">{result.error}</p>}
            {status === "ok" && result.kind !== "image" && result.content && (
              <p className="mt-0.5 break-words text-vx-text-muted">&ldquo;{result.content.slice(0, 160)}&rdquo;</p>
            )}
          </div>
          {status === "ok" && result.preview && (
            <PreviewThumb src={result.preview} className="h-16 w-16 rounded-vx-sm border border-vx-border object-cover" />
          )}
        </div>
      )}
    </div>
  );
}

export default function CompatibleModelsSection({ providerStorageAlias, providerDisplayAlias, modelAliases, customModels, copied, onCopy, onDeleteAlias, onAddCustomModel, onDeleteCustomModel, connections, isAnthropic, onEditVendorCost, vendorCostModelIds }) {
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
      <p className="text-sm text-vx-text-muted">
        Add {isAnthropic ? "Anthropic" : "OpenAI"}-compatible models manually or import them from the /models endpoint.
      </p>

      <div className="flex items-end gap-2 flex-wrap">
        <div className="flex-1 min-w-[240px]">
          <label htmlFor="new-compatible-model-input" className="text-xs text-vx-text-muted mb-1 block">Model ID</label>
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
            className="w-full px-3 py-2.5 text-sm border border-vx-border rounded-vx-md bg-vx-surface focus:outline-none focus:border-vx-primary focus:ring-2 focus:ring-vx-primary/15"
          />
        </div>
        <div>
          <label htmlFor="new-compatible-model-kind" className="text-xs text-vx-text-muted mb-1 block">Type</label>
          <select
            id="new-compatible-model-kind"
            value={newKind}
            onChange={(e) => { setNewKind(e.target.value); setKindTouched(true); }}
            className="px-3 py-2.5 text-sm border border-vx-border rounded-vx-md bg-vx-surface focus:outline-none focus:border-vx-primary focus:ring-2 focus:ring-vx-primary/15"
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
        <p className="text-xs text-vx-text-muted">
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
                onEditVendorCost={onEditVendorCost ? () => onEditVendorCost(id) : undefined}
                hasVendorCost={vendorCostModelIds ? vendorCostModelIds.has(id) : false}
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
  onEditVendorCost: PropTypes.func,
  vendorCostModelIds: PropTypes.instanceOf(Set),
};

CompatibleModelRow.propTypes = {
  modelId: PropTypes.string.isRequired,
  fullModel: PropTypes.string.isRequired,
  kind: PropTypes.string.isRequired,
  copied: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  onDeleteAlias: PropTypes.func.isRequired,
  onTest: PropTypes.func,
  onChangeKind: PropTypes.func,
  result: PropTypes.object,
  isTesting: PropTypes.bool,
  onEditVendorCost: PropTypes.func,
  hasVendorCost: PropTypes.bool,
};
