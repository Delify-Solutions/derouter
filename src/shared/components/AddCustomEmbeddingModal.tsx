"use client";

import React, { useState, useEffect } from "react";
import { Modal, Input, Button, Badge } from "@/shared/components";
import { apiGet, apiPost, apiPut } from "@/shared/api/client";
import type { ProviderNode } from "@/shared/types";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

interface EmbeddingNode {
  id?: string;
  name?: string;
  prefix?: string;
  baseUrl?: string;
  type?: string;
}

interface EmbeddingFormData {
  name: string;
  prefix: string;
  baseUrl: string;
}

interface ValidationResult {
  valid: boolean;
  error?: string;
  dimensions?: number;
}

interface EmbeddingPayload {
  name: string;
  prefix: string;
  baseUrl: string;
  type?: string;
}

interface ValidatePayload {
  baseUrl: string;
  apiKey: string;
  type: string;
  modelId?: string;
}

interface NodeCreateResponse {
  node?: EmbeddingNode;
  error?: string;
}

interface NodeValidateResponse {
  valid?: boolean;
  error?: string;
  dimensions?: number;
}

export interface AddCustomEmbeddingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated?: (node: EmbeddingNode) => void;
  onSaved?: (node: EmbeddingNode) => void;
  node?: EmbeddingNode | null;
}

// Dual-mode modal: edit when `node` provided, add otherwise
export default function AddCustomEmbeddingModal({ isOpen, onClose, onCreated, onSaved, node }: AddCustomEmbeddingModalProps) {
  const isEdit = !!node;
  const [formData, setFormData] = useState<EmbeddingFormData>({
    name: "",
    prefix: "",
    baseUrl: DEFAULT_BASE_URL,
  });
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [checkKey, setCheckKey] = useState<string>("");
  const [checkModelId, setCheckModelId] = useState<string>("");
  const [validating, setValidating] = useState<boolean>(false);
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setValidationResult(null);
    setCheckKey("");
    setCheckModelId("");
    if (isEdit && node) {
      setFormData({
        name: node.name || "",
        prefix: node.prefix || "",
        baseUrl: node.baseUrl || DEFAULT_BASE_URL,
      });
    } else {
      setFormData({ name: "", prefix: "", baseUrl: DEFAULT_BASE_URL });
    }
  }, [isOpen, isEdit, node]);

  const handleSubmit = async (): Promise<void> => {
    if (!formData.name.trim() || !formData.prefix.trim() || !formData.baseUrl.trim()) return;
    setSubmitting(true);
    try {
      const payload: EmbeddingPayload = {
        name: formData.name,
        prefix: formData.prefix,
        baseUrl: formData.baseUrl,
      };
      if (!isEdit) payload.type = "custom-embedding";

      const data = isEdit && node?.id
        ? await apiPut<NodeCreateResponse>(`/api/provider-nodes/${node.id}`, payload)
        : await apiPost<NodeCreateResponse>("/api/provider-nodes", payload);

      if (data.node) {
        if (isEdit) onSaved?.(data.node);
        else onCreated?.(data.node);
      }
    } catch (error) {
      console.log("Error saving custom embedding node:", error);
    } finally {
      setSubmitting(false);
    }
  };

  const handleValidate = async (): Promise<void> => {
    setValidating(true);
    try {
      const payload: ValidatePayload = {
        baseUrl: formData.baseUrl,
        apiKey: checkKey,
        type: "custom-embedding",
        modelId: checkModelId.trim() || undefined,
      };
      const data = await apiPost<NodeValidateResponse>("/api/provider-nodes/validate", payload);
      setValidationResult({
        valid: !!data.valid,
        error: data.error,
        dimensions: data.dimensions,
      });
    } catch {
      setValidationResult({ valid: false, error: "Network error" });
    } finally {
      setValidating(false);
    }
  };

  const renderValidationResult = (): React.ReactNode => {
    if (!validationResult) return null;
    const { valid, error, dimensions } = validationResult;
    if (valid) {
      return (
        <>
          <Badge variant="success">Valid</Badge>
          {dimensions && <span className="text-sm text-text-muted">{dimensions} dims</span>}
        </>
      );
    }
    return (
      <div className="flex flex-col gap-1">
        <Badge variant="error">Invalid</Badge>
        {error && <span className="text-sm text-red-500">{error}</span>}
      </div>
    );
  };

  return (
    <Modal isOpen={isOpen} title={isEdit ? "Edit Custom Embedding" : "Add Custom Embedding"} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Input
          label="Name"
          value={formData.name}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, name: e.target.value })}
          placeholder="Voyage AI"
          hint="Required. A friendly label for this embedding provider."
        />
        <Input
          label="Prefix"
          value={formData.prefix}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, prefix: e.target.value })}
          placeholder="voyage"
          hint="Required. Used as the provider prefix for model IDs (e.g. voyage/voyage-3)."
        />
        <Input
          label="Base URL"
          value={formData.baseUrl}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, baseUrl: e.target.value })}
          placeholder="https://api.voyageai.com/v1"
          hint="Most embedding APIs are OpenAI-compatible: Voyage, Cohere, Jina, Mistral, Together..."
        />
        <Input
          label="API Key (for Check)"
          type="password"
          value={checkKey}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCheckKey(e.target.value)}
        />
        <Input
          label="Model ID (for Check)"
          value={checkModelId}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCheckModelId(e.target.value)}
          placeholder="e.g. voyage-3, embed-english-v3.0, text-embedding-3-small"
          hint="Required for validation. Will send a test embeddings request."
        />
        <div className="flex items-center gap-3">
          <Button
            onClick={handleValidate}
            disabled={!checkKey || !checkModelId.trim() || validating || !formData.baseUrl.trim()}
            variant="secondary"
          >
            {validating ? "Checking..." : "Check"}
          </Button>
          {renderValidationResult()}
        </div>
        <div className="flex gap-2">
          <Button
            onClick={handleSubmit}
            fullWidth
            disabled={!formData.name.trim() || !formData.prefix.trim() || !formData.baseUrl.trim() || submitting}
          >
            {submitting ? (isEdit ? "Saving..." : "Creating...") : (isEdit ? "Save" : "Create")}
          </Button>
          <Button onClick={onClose} variant="ghost" fullWidth>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}
