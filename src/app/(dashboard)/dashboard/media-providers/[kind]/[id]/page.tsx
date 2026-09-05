"use client";

import { useParams, notFound, useRouter } from "next/navigation";
import Link from "next/link";
import { useState, useEffect, type CSSProperties, type ReactElement } from "react";
import { Card, Badge, Button, AddCustomEmbeddingModal, NoAuthProxyCard, ProviderInfoCard, type ProviderConfig } from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { MEDIA_PROVIDER_KINDS, AI_PROVIDERS, isCustomEmbeddingProvider } from "@/shared/constants/providers";
import ConnectionsCard from "@/app/(dashboard)/dashboard/providers/components/ConnectionsCard";
import ModelsCard from "@/app/(dashboard)/dashboard/providers/components/ModelsCard";
import { KIND_EXAMPLE_CONFIG } from "./components/exampleShared";
import { EmbeddingExampleCard } from "./components/EmbeddingExampleCard";
import { TtsExampleCard } from "./components/TtsExampleCard";
import { GenericExampleCard } from "./components/GenericExampleCard";
import { SttExampleCard } from "./components/SttExampleCard";
import { apiGet, apiDelete } from "@/shared/api/client";
import type { ProviderNode, ProviderNodeListResponse } from "@/shared/types";

interface ProviderInfo {
  id: string;
  name: string;
  color?: string;
  textIcon?: string;
  noAuth?: boolean;
  serviceKinds?: string[];
  deprecated?: boolean;
  notice?: {
    text?: string;
    apiKeyUrl?: string;
  };
  kindNotice?: Record<string, string>;
  searchConfig?: unknown;
  fetchConfig?: unknown;
  ttsConfig?: unknown;
  sttConfig?: unknown;
  embeddingConfig?: unknown;
  searchViaChat?: { defaultModel?: string; pricingUrl?: string; freeTier?: boolean };
}

interface CustomNodeExt {
  id?: string;
  name?: string;
  type?: string;
  prefix?: string;
  baseUrl?: string;
}

// MediaProviderDetailPage
export default function MediaProviderDetailPage(): ReactElement | null {
  const { kind, id } = useParams<{ kind: string; id: string }>();
  const router = useRouter();
  const kindConfig = MEDIA_PROVIDER_KINDS.find((k) => k.id === kind);
  const isCustom = isCustomEmbeddingProvider(id) && kind === "embedding";

  const handleDeleteCustom = async () => {
    if (!confirm("Delete this Custom Embedding node?")) return;
    try {
      await apiDelete(`/api/provider-nodes/${id}`);
      router.push(`/dashboard/media-providers/${kind}`);
    } catch (error) {
      console.log("Error deleting custom embedding node:", error);
    }
  };

  const [customNode, setCustomNode] = useState<CustomNodeExt | null>(null);
  const [customLoading, setCustomLoading] = useState(isCustom);
  const [showEditModal, setShowEditModal] = useState(false);

  // Fetch custom node info from API for custom embedding nodes
  useEffect(() => {
    if (!isCustom) return;
    let cancelled = false;
    apiGet<ProviderNodeListResponse>("/api/provider-nodes")
      .then((d) => {
        if (cancelled) return;
        const node = (d.nodes || []).find((n: ProviderNode) => n.id === id) as CustomNodeExt | undefined;
        setCustomNode(node || null);
        setCustomLoading(false);
      })
      .catch(() => { if (!cancelled) setCustomLoading(false); });
    return () => { cancelled = true; };
  }, [id, isCustom]);

  if (!kindConfig) return notFound();

  const builtInProvider = AI_PROVIDERS[id] as ProviderInfo | undefined;

  // For custom embedding nodes, build a synthetic provider object
  const provider: ProviderInfo | null = isCustom
    ? (customNode ? { id, name: customNode.name || "Custom Embedding", color: "#6366F1", textIcon: "CE" } : null)
    : (builtInProvider || null);

  if (!isCustom && !builtInProvider) return notFound();
  if (isCustom && !customLoading && !customNode) return notFound();
  if (isCustom && customLoading) {
    return <div className="text-text-muted text-sm py-12 text-center">Loading...</div>;
  }

  const kinds = isCustom ? ["embedding"] : (provider?.serviceKinds ?? ["llm"]);
  if (!isCustom && !kinds.includes(kind)) return notFound();

  return (
    <div className="flex flex-col gap-8">
      {/* Back */}
      <div>
        <Link
          href={`/dashboard/media-providers/${kind}`}
          className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-primary transition-colors mb-4"
        >
          <span className="material-symbols-outlined text-lg">arrow_back</span>
          {kindConfig.label}
        </Link>

        {/* Header */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
          <div className="size-12 rounded-lg flex items-center justify-center shrink-0" style={{ backgroundColor: `${provider!.color}15` } as CSSProperties}>
            <ProviderIcon
              src={`/providers/${provider!.id}.png`}
              providerId={provider!.id}
              alt={provider!.name}
              size={48}
              className="object-contain rounded-lg max-w-[48px] max-h-[48px]"
              fallbackText={provider!.textIcon || provider!.id.slice(0, 2).toUpperCase()}
              fallbackColor={provider!.color}
            />
          </div>
          <div className="flex-1">
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <h1 className="text-3xl font-semibold tracking-tight">{provider!.name}</h1>
              {!isCustom && provider!.notice?.apiKeyUrl && (
                <a
                  href={provider!.notice.apiKeyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                >
                  <span className="material-symbols-outlined text-sm">open_in_new</span>
                  Get API Key
                </a>
              )}
            </div>
            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              {isCustom && <Badge variant="default" size="sm">Custom · {customNode?.prefix}</Badge>}
              {kinds.map((k) => (
                <Badge key={k} variant={k === kind ? "primary" : "default"} size="sm">
                  {k.toUpperCase()}
                </Badge>
              ))}
            </div>
          </div>
          {isCustom && (
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
              <Button size="sm" variant="secondary" icon="edit" onClick={() => setShowEditModal(true)}>
                Edit
              </Button>
              <Button size="sm" variant="secondary" icon="delete" onClick={handleDeleteCustom}>
                Delete
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Kind-specific notice (e.g. codex/image requires Plus) */}
      {!isCustom && provider!.kindNotice?.[kind] && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-400">
          <span className="material-symbols-outlined text-[20px] mt-0.5">warning</span>
          <p className="text-sm">{provider!.kindNotice[kind]}</p>
        </div>
      )}

      {/* Provider notice text (only when there's actual text content) */}
      {!isCustom && provider!.notice?.text && !provider!.deprecated && (
        <div className="flex flex-col gap-2 rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2 sm:flex-row sm:items-center">
          <span className="material-symbols-outlined text-[16px] text-blue-500 shrink-0">info</span>
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-blue-600 dark:text-blue-400">{provider!.notice.text}</p>
          {provider!.notice.apiKeyUrl && (
            <a
              href={provider!.notice.apiKeyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex justify-center rounded bg-blue-500 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-600 sm:py-0.5"
            >
              Get API Key →
            </a>
          )}
        </div>
      )}

      {/* Connections */}
      {!isCustom && provider!.noAuth ? (
        <NoAuthProxyCard providerId={id} />
      ) : (
        <ConnectionsCard providerId={id} isOAuth={false} />
      )}

      {/* Models - hidden for tts/webSearch/webFetch (provider IS the model); custom uses prefix as alias */}
      {kind !== "tts" && kind !== "webSearch" && kind !== "webFetch" && (
        <ModelsCard
          providerId={id}
          kindFilter={kind}
          providerAliasOverride={isCustom ? customNode?.prefix : undefined}
        />
      )}

      {/* Provider Info — config-driven, supports searchConfig, fetchConfig, ttsConfig, embeddingConfig, searchViaChat */}
      {!isCustom && (provider!.searchConfig || provider!.fetchConfig || provider!.ttsConfig || provider!.sttConfig || provider!.embeddingConfig || provider!.searchViaChat) && (
        <ProviderInfoCard
          config={
            (kind === "webFetch" ? provider!.fetchConfig
              : kind === "tts" ? provider!.ttsConfig
              : kind === "stt" ? provider!.sttConfig
              : kind === "embedding" ? provider!.embeddingConfig
              : provider!.searchConfig || { mode: "chat-completions", defaultModel: provider!.searchViaChat?.defaultModel, pricingUrl: provider!.searchViaChat?.pricingUrl, freeTier: provider!.searchViaChat?.freeTier }) as ProviderConfig | null | undefined
          }
          provider={provider!}
          title={`${kindConfig.label} Config`}
        />
      )}

      {/* Example — per kind */}
      {kind === "embedding" && (
        <EmbeddingExampleCard providerId={id} customAlias={customNode?.prefix} />
      )}
      {kind === "tts" && <TtsExampleCard providerId={id} />}
      {kind === "stt" && !isCustom && <SttExampleCard providerId={id} />}
      {!isCustom && KIND_EXAMPLE_CONFIG[kind] && <GenericExampleCard providerId={id} kind={kind} />}

      {isCustom && (
        <AddCustomEmbeddingModal
          isOpen={showEditModal}
          node={customNode}
          onClose={() => setShowEditModal(false)}
          onCreated={undefined}
          onSaved={(updated: CustomNodeExt) => {
            setCustomNode(updated);
            setShowEditModal(false);
          }}
        />
      )}
    </div>
  );
}
