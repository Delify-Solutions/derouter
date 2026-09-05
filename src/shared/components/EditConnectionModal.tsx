"use client";

import React, { useState, useEffect } from "react";
import Modal from "@/shared/components/Modal";
import Input from "@/shared/components/Input";
import Button from "@/shared/components/Button";
import Badge from "@/shared/components/Badge";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider, AI_PROVIDERS } from "@/shared/constants/providers";
import Select from "@/shared/components/Select";
import { apiPost } from "@/shared/api/client";
import type { ProxyPool as ProxyPoolBase } from "@/shared/types";

interface ProxyPool {
  id: string;
  name: string;
  proxyUrl?: string | null;
  noProxy?: string | null;
  isActive?: boolean | null;
}

interface ProviderSpecificData {
  azureEndpoint?: string;
  apiVersion?: string;
  deployment?: string;
  organization?: string;
  accountId?: string;
  region?: string;
  [key: string]: unknown;
}

interface Connection {
  id?: string;
  name?: string | null;
  email?: string | null;
  priority?: number | null;
  authType?: string;
  provider?: string;
  providerSpecificData?: ProviderSpecificData;
  isActive?: boolean;
}

interface AzureData {
  azureEndpoint: string;
  apiVersion: string;
  deployment: string;
  organization: string;
}

interface CloudflareData {
  accountId: string;
}

interface FormData {
  name: string;
  priority: number;
  apiKey: string;
}

interface ValidateResponse {
  valid?: boolean;
  error?: string;
}

interface TestResponse {
  valid?: boolean;
  error?: string;
}

interface SaveUpdates {
  name: string;
  priority: number;
  apiKey?: string;
  testStatus?: string;
  lastError?: string | null;
  lastErrorAt?: string | null;
  providerSpecificData?: ProviderSpecificData;
  [key: string]: unknown;
}

interface RegionOption {
  id: string;
  label: string;
}

export interface EditConnectionModalProps {
  isOpen: boolean;
  connection?: Connection | null;
  proxyPools?: ProxyPool[];
  onSave: (updates: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}

export default function EditConnectionModal({ isOpen, connection, proxyPools, onSave, onClose }: EditConnectionModalProps) {
  const [formData, setFormData] = useState<FormData>({
    name: "",
    priority: 1,
    apiKey: "",
  });
  const [azureData, setAzureData] = useState<AzureData>({
    azureEndpoint: "",
    apiVersion: "2024-10-01-preview",
    deployment: "",
    organization: "",
  });
  const [cloudflareData, setCloudflareData] = useState<CloudflareData>({ accountId: "" });
  const [region, setRegion] = useState<string>("");
  const [testing, setTesting] = useState<boolean>(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [validating, setValidating] = useState<boolean>(false);
  const [validationResult, setValidationResult] = useState<string | null>(null);
  const [saving, setSaving] = useState<boolean>(false);

  useEffect(() => {
    if (connection) {
      setFormData({
        name: connection.name || "",
        priority: connection.priority || 1,
        apiKey: "",
      });
      // Load Azure-specific data if present
      if (connection.provider === "azure" && connection.providerSpecificData) {
        setAzureData({
          azureEndpoint: connection.providerSpecificData.azureEndpoint || "",
          apiVersion: connection.providerSpecificData.apiVersion || "2024-10-01-preview",
          deployment: connection.providerSpecificData.deployment || "",
          organization: connection.providerSpecificData.organization || "",
        });
      }
      if (connection.provider === "cloudflare-ai" && connection.providerSpecificData) {
        setCloudflareData({ accountId: connection.providerSpecificData.accountId || "" });
      }
      // Load region for providers that support it (e.g. xiaomi-tokenplan)
      const providerCfg = AI_PROVIDERS?.[connection.provider || ""];
      const providerRegionsList = (providerCfg?.regions as Array<{ id?: string }> | undefined);
      if (providerRegionsList) {
        const savedRegion = connection.providerSpecificData?.region || (providerCfg?.defaultRegion as string | undefined) || providerRegionsList[0]?.id || "";
        setRegion(savedRegion);
      }
      setTestResult(null);
      setValidationResult(null);
    }
  }, [connection]);

  const isOAuth = connection?.authType === "oauth";
  const isAzure = connection?.provider === "azure";
  const isCloudflareAi = connection?.provider === "cloudflare-ai";
  const isCompatible = connection
    ? (isOpenAICompatibleProvider(connection.provider || "") || isAnthropicCompatibleProvider(connection.provider || ""))
    : false;
  const providerRegions: RegionOption[] | null = connection ? ((AI_PROVIDERS?.[connection.provider || ""]?.regions as RegionOption[] | undefined) || null) : null;

  // Build providerSpecificData for region-aware providers
  const buildRegionSpecificData = (): ProviderSpecificData | undefined => {
    if (providerRegions && region) return { ...((connection?.providerSpecificData) || {}), region };
    return undefined;
  };

  const handleTest = async (): Promise<void> => {
    if (!connection?.provider || !connection?.id) return;
    setTesting(true);
    setTestResult(null);
    try {
      const data = await apiPost<TestResponse>(`/api/providers/${connection.id}/test`);
      setTestResult(data.valid ? "success" : "failed");
    } catch {
      setTestResult("failed");
    } finally {
      setTesting(false);
    }
  };

  const handleValidate = async (): Promise<void> => {
    if (!connection?.provider || !formData.apiKey) return;
    setValidating(true);
    setValidationResult(null);
    try {
      const data = await apiPost<ValidateResponse>("/api/providers/validate", {
        provider: connection.provider,
        apiKey: formData.apiKey,
        ...(isAzure ? { providerSpecificData: azureData } : {}),
        ...(isCloudflareAi ? { providerSpecificData: cloudflareData } : {}),
        ...(providerRegions ? { providerSpecificData: buildRegionSpecificData() } : {}),
      });
      setValidationResult(data.valid ? "success" : "failed");
    } catch {
      setValidationResult("failed");
    } finally {
      setValidating(false);
    }
  };

  const handleSubmit = async (): Promise<void> => {
    if (!connection) return;
    setSaving(true);
    try {
      const updates: SaveUpdates = {
        name: formData.name,
        priority: formData.priority,
      };
      if (!isOAuth && formData.apiKey) {
        updates.apiKey = formData.apiKey;
        let isValid = validationResult === "success";
        if (!isValid) {
          try {
            setValidating(true);
            setValidationResult(null);
            const data = await apiPost<ValidateResponse>("/api/providers/validate", {
              provider: connection.provider,
              apiKey: formData.apiKey,
              ...(isAzure ? { providerSpecificData: azureData } : {}),
              ...(isCloudflareAi ? { providerSpecificData: cloudflareData } : {}),
              ...(providerRegions ? { providerSpecificData: buildRegionSpecificData() } : {}),
            });
            isValid = !!data.valid;
            setValidationResult(isValid ? "success" : "failed");
          } catch {
            setValidationResult("failed");
          } finally {
            setValidating(false);
          }
        }
        if (isValid) {
          updates.testStatus = "active";
          updates.lastError = null;
          updates.lastErrorAt = null;
        }
      }

      // Add Azure-specific data if this is an Azure connection
      if (isAzure) {
        updates.providerSpecificData = {
          azureEndpoint: azureData.azureEndpoint,
          apiVersion: azureData.apiVersion,
          deployment: azureData.deployment,
          organization: azureData.organization,
        };
      }
      if (isCloudflareAi) {
        updates.providerSpecificData = { accountId: cloudflareData.accountId };
      }
      // Persist updated region for region-aware providers
      if (providerRegions && region) {
        updates.providerSpecificData = buildRegionSpecificData();
      }

      await onSave(updates);
    } finally {
      setSaving(false);
    }
  };

  if (!connection) return null;

  return (
    <Modal isOpen={isOpen} title="Edit Connection" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Input
          label="Name"
          value={formData.name}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, name: e.target.value })}
          placeholder={isOAuth ? "Account name" : "Production Key"}
        />
        {isOAuth && connection.email && (
          <div className="bg-sidebar/50 p-3 rounded-lg">
            <p className="text-sm text-text-muted mb-1">Email</p>
            <p className="font-medium">{connection.email}</p>
          </div>
        )}
        <Input
          label="Priority"
          type="number"
          value={formData.priority}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, priority: Number.parseInt(e.target.value, 10) || 1 })}
        />

        {!isOAuth && (
          <>
            <div className="flex gap-2">
              <Input
                label="API Key"
                type="password"
                value={formData.apiKey}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, apiKey: e.target.value })}
                placeholder="Enter new API key"
                hint="Leave blank to keep the current API key."
                className="flex-1"
              />
              <div className="pt-6">
                <Button onClick={handleValidate} disabled={!formData.apiKey || validating || saving} variant="secondary">
                  {validating ? "Checking..." : "Check"}
                </Button>
              </div>
            </div>
            {validationResult && (
              <Badge variant={validationResult === "success" ? "success" : "error"}>
                {validationResult === "success" ? "Valid" : "Invalid"}
              </Badge>
            )}
          </>
        )}

        {isAzure && (
          <div className="bg-sidebar/50 p-4 rounded-lg border border-accent/20">
            <h3 className="font-semibold mb-3 text-sm">Azure OpenAI Configuration</h3>
            <div className="flex flex-col gap-3">
              <Input
                label="Azure Endpoint"
                value={azureData.azureEndpoint}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAzureData({ ...azureData, azureEndpoint: e.target.value })}
                placeholder="https://your-resource.openai.azure.com"
                hint="Your Azure OpenAI resource endpoint URL"
              />
              <Input
                label="Deployment Name"
                value={azureData.deployment}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAzureData({ ...azureData, deployment: e.target.value })}
                placeholder="gpt-4"
                hint="The deployment name in your Azure resource"
              />
              <Input
                label="API Version"
                value={azureData.apiVersion}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAzureData({ ...azureData, apiVersion: e.target.value })}
                placeholder="2024-10-01-preview"
                hint="Azure OpenAI API version to use"
              />
              <Input
                label="Organization"
                value={azureData.organization}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAzureData({ ...azureData, organization: e.target.value })}
                placeholder="Organization ID"
                hint="Required for billing"
              />
            </div>
          </div>
        )}

        {providerRegions && (
          <Select
            label="Region"
            value={region}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setRegion(e.target.value)}
            options={providerRegions.map((r: RegionOption) => ({ value: r.id, label: r.label }))}
          />
        )}

        {!isCompatible && !isAzure && !isCloudflareAi && (
          <div className="flex items-center gap-3">
            <Button onClick={handleTest} variant="secondary" disabled={testing}>
              {testing ? "Testing..." : "Test Connection"}
            </Button>
            {testResult && (
              <Badge variant={testResult === "success" ? "success" : "error"}>
                {testResult === "success" ? "Valid" : "Failed"}
              </Badge>
            )}
          </div>
        )}

        <div className="flex gap-2">
          <Button onClick={handleSubmit} fullWidth disabled={saving}>{saving ? "Saving..." : "Save"}</Button>
          <Button onClick={onClose} variant="ghost" fullWidth>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}
