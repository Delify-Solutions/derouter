"use client";

import { useState, useEffect } from "react";
import { MITM_TOOLS } from "@/shared/constants/cliTools";
import { getModelsByProviderId } from "@/shared/constants/models";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";
import { apiGet } from "@/shared/api/client";
import type { ProviderListResponse, KeyListResponse, ModelAliasResponse, Settings } from "@/shared/types";
import { MitmServerCard, MitmToolCard } from "@/app/(dashboard)/dashboard/cli-tools/components";

interface MitmStatus {
  running: boolean;
  certExists: boolean;
  dnsStatus: Record<string, boolean>;
  hasCachedPassword: boolean;
  needsSudoPassword?: boolean;
  isWin?: boolean;
  [key: string]: unknown;
}

interface MitmTool {
  id: string;
  name: string;
  image?: string;
  color?: string;
  description?: string;
  configType?: string;
  mitmDomain?: string;
  [key: string]: unknown;
}

// The cli-tools components are untyped .js — accept loose props.
interface MitmToolCardProps {
  tool: MitmTool;
  isExpanded: boolean;
  onToggle: () => void;
  serverRunning: boolean;
  dnsActive: boolean;
  hasCachedPassword: boolean;
  needsSudoPassword: boolean;
  isWin: boolean;
  apiKeys: Array<Record<string, unknown>>;
  activeProviders: ProviderListResponse["connections"];
  hasActiveProviders: boolean;
  modelAliases: ModelAliasResponse["aliases"];
  cloudEnabled: boolean;
  onDnsChange: (data: { dnsStatus?: Record<string, boolean> }) => void;
}

type MitmToolCardComponent = React.ComponentType<MitmToolCardProps>;

type MitmServerCardComponent = React.ComponentType<{
  apiKeys: Array<Record<string, unknown>>;
  cloudEnabled: boolean;
  onStatusChange: (status: MitmStatus) => void;
}>;

export default function MitmPageClient() {
  const [connections, setConnections] = useState<ProviderListResponse["connections"]>([]);
  const [apiKeys, setApiKeys] = useState<Array<Record<string, unknown>>>([]);
  const [modelAliases, setModelAliases] = useState<ModelAliasResponse["aliases"]>({});
  const [cloudEnabled, setCloudEnabled] = useState(false);
  const [expandedTool, setExpandedTool] = useState<string | null>(null);
  const [mitmStatus, setMitmStatus] = useState<MitmStatus>({
    running: false,
    certExists: false,
    dnsStatus: {},
    hasCachedPassword: false,
  });

  useEffect(() => {
    fetchConnections();
    fetchApiKeys();
    fetchAliases();
    fetchCloudSettings();
  }, []);

  const fetchConnections = async () => {
    try {
      const data = await apiGet<ProviderListResponse>("/api/providers");
      setConnections(data.connections || []);
    } catch { /* ignore */ }
  };

  const fetchApiKeys = async () => {
    try {
      const data = await apiGet<KeyListResponse>("/api/keys");
      setApiKeys((data.keys || []) as unknown as Array<Record<string, unknown>>);
    } catch { /* ignore */ }
  };

  const fetchAliases = async () => {
    try {
      const data = await apiGet<ModelAliasResponse>("/api/models/alias");
      setModelAliases(data.aliases || {});
    } catch { /* ignore */ }
  };

  const fetchCloudSettings = async () => {
    try {
      const data = await apiGet<Settings>("/api/settings");
      setCloudEnabled((data.cloudEnabled as boolean) || false);
    } catch { /* ignore */ }
  };

  const getActiveProviders = () => connections.filter(c => c.isActive !== false);

  const hasActiveProviders = () => {
    const active = getActiveProviders();
    return active.some(conn =>
      getModelsByProviderId(conn.provider).length > 0 ||
      isOpenAICompatibleProvider(conn.provider) ||
      isAnthropicCompatibleProvider(conn.provider)
    );
  };

  const mitmTools = Object.entries(MITM_TOOLS) as [string, MitmTool][];

  const MitmServerCardTyped = MitmServerCard as unknown as MitmServerCardComponent;
  const MitmToolCardTyped = MitmToolCard as unknown as MitmToolCardComponent;

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
        <span className="material-symbols-outlined text-[16px] text-yellow-500 mt-0.5 shrink-0">warning</span>
        <p className="text-xs text-red-600 dark:text-yellow-400 leading-relaxed">
          ⚠️ MITM intercepts HTTPS traffic of IDE tools (Antigravity, GitHub Copilot, Kiro) via local CA to redirect requests to your providers. May violate ToS → account ban. Use at your own risk.
        </p>
      </div>

      {/* MITM Server Card */}
      <MitmServerCardTyped
        apiKeys={apiKeys}
        cloudEnabled={cloudEnabled}
        onStatusChange={setMitmStatus}
      />

      {/* Tool Cards */}
      <div className="grid gap-3 sm:gap-4">
        {mitmTools.map(([toolId, tool]) => (
          <MitmToolCardTyped
            key={toolId}
            tool={tool}
            isExpanded={expandedTool === toolId}
            onToggle={() => setExpandedTool(expandedTool === toolId ? null : toolId)}
            serverRunning={mitmStatus.running}
            dnsActive={mitmStatus.dnsStatus?.[toolId] || false}
            hasCachedPassword={mitmStatus.hasCachedPassword || false}
            needsSudoPassword={mitmStatus.needsSudoPassword !== false}
            isWin={mitmStatus.isWin === true}
            apiKeys={apiKeys}
            activeProviders={getActiveProviders()}
            hasActiveProviders={hasActiveProviders()}
            modelAliases={modelAliases}
            cloudEnabled={cloudEnabled}
            onDnsChange={(data: { dnsStatus?: Record<string, boolean> }) =>
              setMitmStatus(prev => ({ ...prev, dnsStatus: data.dnsStatus ?? prev.dnsStatus }))
            }
          />
        ))}
      </div>
    </div>
  );
}
