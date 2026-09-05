"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { CardSkeleton } from "@/shared/components";
import { CLI_TOOLS } from "@/shared/constants/cliTools";
import { getModelsByProviderId, PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import {
  ClaudeToolCard, CodexToolCard, DroidToolCard, OpenClawToolCard,
  HermesToolCard, DefaultToolCard, OpenCodeToolCard, CoworkToolCard,
  CopilotToolCard, ClineToolCard, KiloToolCard, DeepSeekTuiToolCard,
  JcodeToolCard, GrokBuildToolCard,
} from "../components";
import type { AvailableModel } from "../components/cliTools.types";
import type { ApiKey, ProviderConnection, Settings } from "@/shared/types";

const CLOUD_URL = process.env.NEXT_PUBLIC_CLOUD_URL;

interface ToolDetailClientProps {
  toolId: string;
  machineId: string;
}

export default function ToolDetailClient({ toolId }: ToolDetailClientProps) {
  const tool = CLI_TOOLS[toolId as keyof typeof CLI_TOOLS];
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [modelMappings, setModelMappings] = useState<Record<string, Record<string, string>>>({});
  const [cloudEnabled, setCloudEnabled] = useState(false);
  const [tunnelEnabled, setTunnelEnabled] = useState(false);
  const [tunnelPublicUrl, setTunnelPublicUrl] = useState("");
  const [tailscaleEnabled, setTailscaleEnabled] = useState(false);
  const [tailscaleUrl, setTailscaleUrl] = useState("");
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [provRes, settingsRes, tunnelRes, keysRes] = await Promise.all([
          fetch("/api/providers"),
          fetch("/api/settings"),
          fetch("/api/tunnel/status"),
          fetch("/api/keys"),
        ]);
        if (!mounted) return;
        if (provRes.ok) {
          const data: { connections?: ProviderConnection[] } = await provRes.json();
          setConnections(data.connections || []);
        }
        if (settingsRes.ok) {
          const data: Settings = await settingsRes.json();
          setCloudEnabled(!!data.cloudEnabled);
        }
        if (tunnelRes.ok) {
          const data: {
            tunnel?: { enabled?: boolean; settingsEnabled?: boolean; publicUrl?: string };
            tailscale?: { enabled?: boolean; settingsEnabled?: boolean; tunnelUrl?: string };
          } = await tunnelRes.json();
          setTunnelEnabled(!!(data.tunnel?.enabled || data.tunnel?.settingsEnabled));
          setTunnelPublicUrl(data.tunnel?.publicUrl || "");
          setTailscaleEnabled(!!(data.tailscale?.enabled || data.tailscale?.settingsEnabled));
          setTailscaleUrl(data.tailscale?.tunnelUrl || "");
        }
        if (keysRes.ok) {
          const data: { keys?: ApiKey[] } = await keysRes.json();
          setApiKeys(data.keys || []);
        }
      } catch (error) {
        console.log("Error loading tool data:", error);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const getActiveProviders = (): ProviderConnection[] => connections.filter(c => c.isActive !== false);

  const getAllAvailableModels = (): AvailableModel[] => {
    const activeProviders = getActiveProviders();
    const models: AvailableModel[] = [];
    const seenModels = new Set<string>();
    activeProviders.forEach(conn => {
      const alias = PROVIDER_ID_TO_ALIAS[conn.provider] || conn.provider;
      const providerModels = getModelsByProviderId(conn.provider);
      providerModels.forEach((m: { id: string; name?: string }) => {
        const modelValue = `${alias}/${m.id}`;
        if (!seenModels.has(modelValue)) {
          seenModels.add(modelValue);
          models.push({ value: modelValue, label: `${alias}/${m.id}`, provider: conn.provider, alias, connectionName: conn.name, modelId: m.id });
        }
      });

      // openai/anthropic-compatible providers are registered with a random UUID (e.g.
      // "openai-compatible-chat-<uuid>") that has no entry in the static PROVIDER_MODELS
      // catalog, so `getModelsByProviderId` returns []. Routing still works because the
      // request path uses the connection's own model config, but `hasActiveProviders`
      // below would flip to false and disable the Apply button. Fall back to the
      // connection's own models so these providers are usable from CLI tool pages.
      if (providerModels.length === 0) {
        const connData = conn.data as Record<string, unknown>;
        const prefix = (connData.prefix as string) || alias;
        const fallbackModels: Array<{ id: string; name: string }> = [];
        const connRecord = conn as unknown as Record<string, unknown>;
        if (connRecord.defaultModel) {
          // defaultModel is not in the type but runtime connections have it
          const dm = connRecord.defaultModel as string | undefined;
          if (dm) fallbackModels.push({ id: dm, name: dm });
        }
        const customModels = (connData.customModels as Array<{ id: string; name?: string }> | undefined) || [];
        customModels.forEach(m => {
          if (m?.id && !fallbackModels.some(f => f.id === m.id)) fallbackModels.push({ id: m.id, name: m.name || m.id });
        });
        if (fallbackModels.length === 0 && connRecord.testStatus === "active") {
          // Provider is confirmed reachable but exposes no model info anywhere;
          // still let the user apply so they aren't stuck on a permanently disabled button.
          fallbackModels.push({ id: "model-id", name: `${prefix}/model-id` });
        }
        fallbackModels.forEach(m => {
          const modelValue = `${prefix}/${m.id}`;
          if (!seenModels.has(modelValue)) {
            seenModels.add(modelValue);
            models.push({ value: modelValue, label: `${prefix}/${m.id}`, provider: conn.provider, alias: prefix, connectionName: conn.name, modelId: m.id });
          }
        });
      }
    });
    return models;
  };

  const handleModelMappingChange = useCallback((tId: string, alias: string, target: string) => {
    setModelMappings(prev => {
      if (prev[tId]?.[alias] === target) return prev;
      return { ...prev, [tId]: { ...prev[tId], [alias]: target } };
    });
  }, []);

  const getBaseUrl = (): string => {
    if (tunnelEnabled && tunnelPublicUrl) return tunnelPublicUrl;
    if (cloudEnabled && CLOUD_URL) return CLOUD_URL;
    if (typeof window !== "undefined") return window.location.origin;
    return "http://localhost:20128";
  };

  const renderToolCard = (): React.ReactNode => {
    const availableModels = getAllAvailableModels();
    const hasActiveProviders = availableModels.length > 0;
    const commonProps = {
      tool,
      isExpanded: true,
      onToggle: () => {},
      baseUrl: getBaseUrl(),
      apiKeys,
      tunnelEnabled,
      tunnelPublicUrl,
      tailscaleEnabled,
      tailscaleUrl,
    };

    switch (toolId) {
      case "claude":
        return <ClaudeToolCard {...commonProps} activeProviders={getActiveProviders()} modelMappings={modelMappings[toolId] || {}} onModelMappingChange={(a: string, t: string) => handleModelMappingChange(toolId, a, t)} hasActiveProviders={hasActiveProviders} cloudEnabled={cloudEnabled} />;
      case "codex":
        return <CodexToolCard {...commonProps} activeProviders={getActiveProviders()} cloudEnabled={cloudEnabled} />;
      case "opencode":
        return <OpenCodeToolCard {...commonProps} activeProviders={getActiveProviders()} cloudEnabled={cloudEnabled} />;
      case "cowork":
        return <CoworkToolCard {...commonProps} activeProviders={getActiveProviders()} hasActiveProviders={hasActiveProviders} cloudEnabled={cloudEnabled} cloudUrl={CLOUD_URL} tunnelEnabled={tunnelEnabled} tunnelPublicUrl={tunnelPublicUrl} tailscaleEnabled={tailscaleEnabled} tailscaleUrl={tailscaleUrl} />;
      case "droid":
        return <DroidToolCard {...commonProps} activeProviders={getActiveProviders()} hasActiveProviders={hasActiveProviders} cloudEnabled={cloudEnabled} />;
      case "openclaw":
        return <OpenClawToolCard {...commonProps} activeProviders={getActiveProviders()} hasActiveProviders={hasActiveProviders} cloudEnabled={cloudEnabled} />;
      case "hermes":
        return <HermesToolCard {...commonProps} activeProviders={getActiveProviders()} hasActiveProviders={hasActiveProviders} cloudEnabled={cloudEnabled} />;
      case "copilot":
        return <CopilotToolCard {...commonProps} activeProviders={getActiveProviders()} cloudEnabled={cloudEnabled} />;
      case "cline":
        return <ClineToolCard {...commonProps} activeProviders={getActiveProviders()} cloudEnabled={cloudEnabled} />;
      case "kilo":
        return <KiloToolCard {...commonProps} activeProviders={getActiveProviders()} cloudEnabled={cloudEnabled} />;
      case "deepseek-tui":
        return <DeepSeekTuiToolCard {...commonProps} activeProviders={getActiveProviders()} hasActiveProviders={hasActiveProviders} cloudEnabled={cloudEnabled} />;
      case "jcode":
        return <JcodeToolCard {...commonProps} activeProviders={getActiveProviders()} hasActiveProviders={hasActiveProviders} cloudEnabled={cloudEnabled} />;
      case "grok-build":
        return <GrokBuildToolCard tool={tool} isExpanded={true} onToggle={() => {}} apiKeys={apiKeys} tunnelEnabled={tunnelEnabled} tunnelPublicUrl={tunnelPublicUrl} tailscaleEnabled={tailscaleEnabled} tailscaleUrl={tailscaleUrl} activeProviders={getActiveProviders()} hasActiveProviders={hasActiveProviders} cloudEnabled={cloudEnabled} />;
      default:
        return <DefaultToolCard toolId={toolId} {...commonProps} activeProviders={getActiveProviders()} cloudEnabled={cloudEnabled} tunnelEnabled={tunnelEnabled} />;
    }
  };

  // Guard removed/unknown tools (e.g. disabled Cowork) to avoid crash on direct URL.
  if (!tool) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-1 sm:px-0">
        <Link href="/dashboard/cli-tools" className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-primary w-fit">
          <span className="material-symbols-outlined text-[18px]">arrow_back</span>
          Back to CLI Tools
        </Link>
        <p className="text-sm text-text-muted">Tool not found or disabled.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-1 sm:px-0">
      <Link href="/dashboard/cli-tools" className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-primary w-fit">
        <span className="material-symbols-outlined text-[18px]">arrow_back</span>
        Back to CLI Tools
      </Link>
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-text-main sm:text-2xl">{tool.name}</h1>
        <p className="text-sm text-text-muted">{tool.description}</p>
      </div>
      {loading ? <CardSkeleton /> : renderToolCard()}
    </div>
  );
}
