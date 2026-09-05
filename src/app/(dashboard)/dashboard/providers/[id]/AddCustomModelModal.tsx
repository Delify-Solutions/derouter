"use client";

import { useState, useEffect } from "react";
import { Button, Modal, Toggle } from "@/shared/components";
import { CAPACITY_META } from "@/shared/constants/models";

interface CapsMap {
  [key: string]: boolean;
}

type TestStatus = "testing" | "ok" | "error" | null;

interface AddCustomModelModalProps {
  isOpen: boolean;
  providerAlias: string;
  providerDisplayAlias: string;
  onSave: (modelId: string, caps: CapsMap) => Promise<void>;
  onClose: () => void;
}

const defaultCaps = (): CapsMap =>
  Object.fromEntries(Object.keys(CAPACITY_META).map((key) => [key, false]));

export default function AddCustomModelModal({ isOpen, providerAlias, providerDisplayAlias: _providerDisplayAlias, onSave, onClose }: AddCustomModelModalProps) {
  const [modelId, setModelId] = useState("");
  const [caps, setCaps] = useState<CapsMap>(defaultCaps);
  const [testStatus, setTestStatus] = useState<TestStatus>(null);
  const [testError, setTestError] = useState("");
  const [saving, setSaving] = useState(false);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) { setModelId(""); setCaps(defaultCaps()); setTestStatus(null); setTestError(""); }
  }, [isOpen]);

  // Strip provider's own alias prefix (e.g. "cc/model" -> "model" for cc provider)
  const stripAlias = (id: string): string => {
    const prefix = `${providerAlias}/`;
    return id.startsWith(prefix) ? id.slice(prefix.length) : id;
  };

  const handleTest = async (): Promise<void> => {
    const cleanId = stripAlias(modelId.trim());
    if (!cleanId) return;
    setTestStatus("testing");
    setTestError("");
    try {
      const res = await fetch("/api/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: `${providerAlias}/${cleanId}` }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      setTestStatus(data.ok ? "ok" : "error");
      setTestError(data.error || "");
    } catch (err) {
      setTestStatus("error");
      setTestError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSave = async (): Promise<void> => {
    const cleanId = stripAlias(modelId.trim());
    if (!cleanId || saving) return;
    setSaving(true);
    try {
      await onSave(cleanId, caps);
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") handleTest();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add Custom Model">
      <div className="flex flex-col gap-4">
        <div>
          <label className="text-sm font-medium mb-1.5 block">Model ID</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={modelId}
              onChange={(e) => { setModelId(e.target.value); setTestStatus(null); setTestError(""); }}
              onKeyDown={handleKeyDown}
              placeholder="e.g. claude-opus-4-5"
              className="flex-1 px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
              autoFocus
            />
            <Button
              variant="secondary"
              icon="science"
              loading={testStatus === "testing"}
              onClick={handleTest}
              disabled={!modelId.trim() || testStatus === "testing"}
            >
              {testStatus === "testing" ? "Testing..." : "Test"}
            </Button>
          </div>
          <p className="text-xs text-text-muted mt-1">
            Sent to provider as: <code className="font-mono bg-sidebar px-1 rounded">{stripAlias(modelId.trim()) || "model-id"}</code>
          </p>
        </div>

        <div>
          <label className="text-sm font-medium mb-1.5 block">Capabilities</label>
          <div className="flex flex-wrap gap-4">
            {Object.entries(CAPACITY_META).map(([key, meta]) => {
              const metaObj = meta as { label: string; desc: string };
              return (
                <Toggle
                  key={key}
                  checked={!!caps[key]}
                  onChange={(v: boolean) => setCaps((prev) => ({ ...prev, [key]: v }))}
                  label={metaObj.label}
                  description={metaObj.desc}
                  size="sm"
                />
              );
            })}
          </div>
        </div>

        {/* Test result */}
        {testStatus === "ok" && (
          <div className="flex items-center gap-2 text-sm text-green-600">
            <span className="material-symbols-outlined text-base">check_circle</span>
            Model is reachable
          </div>
        )}
        {testStatus === "error" && (
          <div className="flex items-start gap-2 text-sm text-red-500">
            <span className="material-symbols-outlined text-base shrink-0">cancel</span>
            <span>{testError || "Model not reachable"}</span>
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <Button onClick={onClose} variant="ghost" fullWidth size="sm">Cancel</Button>
          <Button
            onClick={handleSave}
            fullWidth
            size="sm"
            disabled={!modelId.trim() || saving}
          >
            {saving ? "Adding..." : "Add Model"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
