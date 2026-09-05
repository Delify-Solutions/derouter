"use client";

import React, { useState, useMemo, useEffect } from "react";
import Modal from "./Modal";
import ProviderIcon from "./ProviderIcon";
import CapacityBadges from "./CapacityBadges";
import { useModelCaps } from "@/shared/hooks/useModelCaps";
import { getModelsByProviderId, getModelKind, CAPACITY_META } from "@/shared/constants/models";
import { OAUTH_PROVIDERS, APIKEY_PROVIDERS, FREE_PROVIDERS, FREE_TIER_PROVIDERS, AI_PROVIDERS, isOpenAICompatibleProvider, isAnthropicCompatibleProvider, getProviderAlias } from "@/shared/constants/providers";
import { apiGet } from "@/shared/api/client";
import type { Combo, ProviderNode, CustomModel, CustomModelListResponse, DisabledModelsResponse, ModelAliasResponse, ComboListResponse, ProviderNodeListResponse } from "@/shared/types";

// Provider order: OAuth first, then Free Tier, then API Key (matches dashboard/providers)
const PROVIDER_ORDER = [
  ...Object.keys(OAUTH_PROVIDERS),
  ...Object.keys(FREE_PROVIDERS),
  ...Object.keys(FREE_TIER_PROVIDERS),
  ...Object.keys(APIKEY_PROVIDERS),
];

// Providers that need no auth — always show in model selector
const NO_AUTH_PROVIDER_IDS = Object.keys(FREE_PROVIDERS).filter((id: string) => FREE_PROVIDERS[id].noAuth);

interface ActiveProvider {
  provider: string;
  id?: string;
  name?: string | null;
  providerSpecificData?: Record<string, unknown>;
}

interface ModelEntry {
  id: string;
  name: string;
  value: string;
  kind?: string | null;
  isCustom?: boolean;
  isPlaceholder?: boolean;
}

interface GroupEntry {
  name: string;
  alias?: string;
  color?: string;
  models: ModelEntry[];
  isCustom?: boolean;
  hasModels?: boolean;
}

interface ModelSelectProp {
  id: string;
  name: string;
  value: string;
}

export interface ModelSelectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (model: ModelEntry | ModelSelectProp) => void;
  onDeselect?: (model: ModelEntry | ModelSelectProp) => void;
  selectedModel?: string | null;
  activeProviders?: ActiveProvider[];
  title?: string;
  modelAliases?: Record<string, string>;
  kindFilter?: string | null;
  capFilter?: string | null;
  addedModelValues?: string[];
  closeOnSelect?: boolean;
}

export default function ModelSelectModal({
  isOpen,
  onClose,
  onSelect,
  onDeselect,
  selectedModel,
  activeProviders = [],
  title = "Select Model",
  modelAliases = {},
  kindFilter = null,
  capFilter = null,
  addedModelValues = [],
  closeOnSelect = true,
}: ModelSelectModalProps) {
  // Filter activeProviders by serviceKinds when kindFilter set (e.g. "webSearch", "webFetch")
  const filteredActiveProviders = useMemo<ActiveProvider[]>(() => {
    if (!kindFilter) return activeProviders;
    return activeProviders.filter((p: ActiveProvider) => {
      const info = AI_PROVIDERS[p.provider];
      const kinds = info?.serviceKinds || ["llm"];
      return kinds.includes(kindFilter);
    });
  }, [activeProviders, kindFilter]);
  const { getCaps } = useModelCaps();
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [combos, setCombos] = useState<Combo[]>([]);
  const [providerNodes, setProviderNodes] = useState<ProviderNode[]>([]);
  const [customModels, setCustomModels] = useState<CustomModel[]>([]);
  const [disabledModels, setDisabledModels] = useState<Record<string, string[]>>({});
  const [cursorModels, setCursorModels] = useState<ModelEntry[]>([]);

  // Cursor exposes the usable catalog per account. Keep the static catalog only
  // as a fallback, since it quickly becomes stale and different accounts can
  // have different model entitlements.
  const cursorConnectionIds = useMemo(() => activeProviders
    .filter((provider: ActiveProvider) => provider.provider === "cursor" && provider.id)
    .map((provider: ActiveProvider) => provider.id)
    .filter((id): id is string => !!id),
    [activeProviders],
  );

  useEffect(() => {
    if (!isOpen || cursorConnectionIds.length === 0) {
      setCursorModels([]);
      return undefined;
    }

    let cancelled = false;
    Promise.all(cursorConnectionIds.map(async (connectionId: string) => {
      const response = await fetch(`/api/providers/${connectionId}/models`, { cache: "no-store" });
      if (!response.ok) return [];
      const data: { models?: ModelEntry[] } = await response.json();
      return Array.isArray(data.models) ? data.models : [];
    }))
      .then((modelLists: ModelEntry[][]) => {
        if (cancelled) return;
        const seen = new Set<string>();
        setCursorModels(modelLists.flat().filter((model: ModelEntry) => {
          if (!model?.id || seen.has(model.id)) return false;
          seen.add(model.id);
          return true;
        }));
      })
      .catch((error: unknown) => {
        // Do not hide the static fallback when the account catalog is unavailable.
        console.warn("Unable to load Cursor models for selector:", error);
        if (!cancelled) setCursorModels([]);
      });

    return () => { cancelled = true; };
  }, [isOpen, cursorConnectionIds]);

  const fetchCombos = async (): Promise<void> => {
    try {
      const data = await apiGet<ComboListResponse>("/api/combos");
      setCombos(data.combos || []);
    } catch (error) {
      console.error("Error fetching combos:", error);
      setCombos([]);
    }
  };

  useEffect(() => {
    if (isOpen) fetchCombos();
  }, [isOpen]);

  const fetchProviderNodes = async (): Promise<void> => {
    try {
      const data = await apiGet<ProviderNodeListResponse>("/api/provider-nodes");
      setProviderNodes(data.nodes || []);
    } catch (error) {
      console.error("Error fetching provider nodes:", error);
      setProviderNodes([]);
    }
  };

  useEffect(() => {
    if (isOpen) fetchProviderNodes();
  }, [isOpen]);

  const fetchCustomModels = async (): Promise<void> => {
    try {
      const data = await apiGet<CustomModelListResponse>("/api/models/custom");
      setCustomModels(data.models || []);
    } catch (error) {
      console.error("Error fetching custom models:", error);
      setCustomModels([]);
    }
  };

  useEffect(() => {
    if (isOpen) fetchCustomModels();
  }, [isOpen]);

  const fetchDisabledModels = async (): Promise<void> => {
    try {
      const data = await apiGet<DisabledModelsResponse>("/api/models/disabled");
      setDisabledModels(data.disabled || {});
    } catch (error) {
      console.error("Error fetching disabled models:", error);
      setDisabledModels({});
    }
  };

  useEffect(() => {
    if (isOpen) fetchDisabledModels();
  }, [isOpen]);

  const allProviders = useMemo(() => ({ ...OAUTH_PROVIDERS, ...FREE_PROVIDERS, ...FREE_TIER_PROVIDERS, ...APIKEY_PROVIDERS }), []);

  // Group models by provider with priority order
  const groupedModels = useMemo<Record<string, GroupEntry>>(() => {
    const groups: Record<string, GroupEntry> = {};

    // Kinds where the provider IS the model (no per-model selection needed)
    const PROVIDER_AS_MODEL_KINDS = new Set(["webSearch", "webFetch"]);
    // Kinds that map directly to model.type field
    const TYPED_KINDS = new Set(["image", "tts", "stt", "embedding", "imageToText"]);
    // For these kinds, providers without hardcoded models can still be picked (provider-as-model fallback)
    const ALLOW_PROVIDER_FALLBACK_KINDS = new Set(["tts", "image", "webFetch"]);

    // Filter a models[] array by kindFilter (keep only matching kind)
    const filterByKind = (models: ModelEntry[]): ModelEntry[] => {
      // No kindFilter means the LLM selector. Keep custom models visible because
      // user-added models may have typed capabilities (for example imageToText)
      // while still being valid chat/combo targets.
      if (!kindFilter) return models.filter((m: ModelEntry) => m.isPlaceholder || m.isCustom || !getModelKind(m) || getModelKind(m) === "llm");
      if (!TYPED_KINDS.has(kindFilter)) return models;
      return models.filter((m: ModelEntry) => m.isPlaceholder || getModelKind(m) === kindFilter);
    };

    // Get all active provider IDs from connections (filtered by kindFilter if set)
    const activeConnectionIds = filteredActiveProviders.map((p: ActiveProvider) => p.provider);

    // No-auth providers: filter by kindFilter as well
    const noAuthIds = kindFilter
      ? NO_AUTH_PROVIDER_IDS.filter((id: string) => (AI_PROVIDERS[id]?.serviceKinds || ["llm"]).includes(kindFilter))
      : NO_AUTH_PROVIDER_IDS;

    // Only show connected providers (including both standard and custom)
    const providerIdsToShow = new Set<string>([
      ...activeConnectionIds,  // Only connected providers
      ...noAuthIds,            // No-auth providers (kind-filtered)
    ]);

    // Sort by PROVIDER_ORDER
    const sortedProviderIds = [...providerIdsToShow].sort((a: string, b: string) => {
      const indexA = PROVIDER_ORDER.indexOf(a);
      const indexB = PROVIDER_ORDER.indexOf(b);
      return (indexA === -1 ? 999 : indexA) - (indexB === -1 ? 999 : indexB);
    });

    sortedProviderIds.forEach((providerId: string) => {
      const alias = getProviderAlias(providerId);
      const providerInfo = allProviders[providerId] || { name: providerId, color: "#666" };
      const isCustomProvider = isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId);

      // For provider-as-model kinds (webSearch/webFetch): emit a single entry where value === providerId
      if (kindFilter && PROVIDER_AS_MODEL_KINDS.has(kindFilter)) {
        groups[providerId] = {
          name: providerInfo.name || providerId,
          alias,
          color: providerInfo.color,
          models: [{ id: providerId, name: providerInfo.name || providerId, value: providerId }],
        };
        return;
      }

      if (providerInfo.passthroughModels) {
        const aliasModels: ModelEntry[] = Object.entries(modelAliases)
          .filter(([, fullModel]: [string, string]) => fullModel.startsWith(`${alias}/`))
          .map(([aliasName, fullModel]: [string, string]) => ({
            id: fullModel.replace(`${alias}/`, ""),
            name: aliasName,
            value: fullModel,
          }));
        const customRegisteredModels: ModelEntry[] = customModels
          .filter((m: CustomModel) => m.providerAlias === alias)
          .map((m: CustomModel) => ({
            id: m.id,
            name: m.name || m.id,
            value: `${alias}/${m.id}`,
            kind: getModelKind(m),
            isCustom: true,
          }));

        // For typed kinds, only include hardcoded typed models (aliases are typically LLM-only and lack type info)
        let combined: ModelEntry[] = aliasModels;
        if (kindFilter && TYPED_KINDS.has(kindFilter)) {
          const registeredTyped = customRegisteredModels.filter((m: ModelEntry) => getModelKind(m) === kindFilter);
          combined = [
            ...registeredTyped,
            ...getModelsByProviderId(providerId)
            .filter((m: Record<string, unknown>) => getModelKind(m) === kindFilter)
            .map((m: Record<string, unknown>) => ({ id: m.id as string, name: m.name as string, value: `${alias}/${m.id as string}`, kind: getModelKind(m) }))
            .filter((m: ModelEntry) => !registeredTyped.some((registered) => registered.value === m.value)),
          ];
          // Fallback: provider-as-model when no hardcoded models match (tts/image/webFetch only)
          if (combined.length === 0 && ALLOW_PROVIDER_FALLBACK_KINDS.has(kindFilter)) {
            const supports = (providerInfo.serviceKinds || ["llm"]).includes(kindFilter);
            if (supports) combined = [{ id: providerId, name: providerInfo.name || providerId, value: alias }];
          }
        } else {
          // LLM/null kind: merge hardcoded models (e.g. mimo-free → mimo-auto) with user-added models
          const registeredLlms = customRegisteredModels.filter((m: ModelEntry) => !getModelKind(m) || getModelKind(m) === "llm");
          const seen = new Set<string>([...aliasModels, ...registeredLlms].map((m: ModelEntry) => m.value));
          const hardcoded = getModelsByProviderId(providerId)
            .filter((m: Record<string, unknown>) => !getModelKind(m) || getModelKind(m) === "llm")
            .map((m: Record<string, unknown>) => ({ id: m.id as string, name: m.name as string, value: `${alias}/${m.id as string}`, kind: getModelKind(m) }))
            .filter((m: ModelEntry) => !seen.has(m.value));
          combined = [...registeredLlms, ...aliasModels.filter((m: ModelEntry) => !registeredLlms.some((registered) => registered.value === m.value)), ...hardcoded];
        }

        if (combined.length > 0) {
          // Check for custom name from providerNodes (for compatible providers)
          const matchedNode = providerNodes.find((node: ProviderNode) => node.id === providerId);
          const displayName = matchedNode?.name || providerInfo.name || providerId;

          groups[providerId] = {
            name: displayName,
            alias: alias,
            color: providerInfo.color,
            models: combined,
          };
        }
      } else if (isCustomProvider) {
        // Custom (openai/anthropic-compatible) providers are LLM-only — skip for typed media kinds
        if (kindFilter && TYPED_KINDS.has(kindFilter)) return;
        // Find connection object to get prefix synchronously without waiting for providerNodes fetch
        const connection = activeProviders.find((p: ActiveProvider) => p.provider === providerId);
        const matchedNode = providerNodes.find((node: ProviderNode) => node.id === providerId);
        const displayName = matchedNode?.name || connection?.name || providerInfo.name || providerId;
        const nodePrefix = (connection?.providerSpecificData?.prefix as string) || matchedNode?.data?.prefix as string || providerId;

        // Aliases are stored using the raw providerId as key (e.g. "openai-compatible-chat-<uuid>/glm-4.7"),
        // so we must filter by providerId, not by the display prefix.
        const nodeModels: ModelEntry[] = Object.entries(modelAliases)
          .filter(([, fullModel]: [string, string]) => fullModel.startsWith(`${providerId}/`))
          .map(([aliasName, fullModel]: [string, string]) => ({
            id: fullModel.replace(`${providerId}/`, ""),
            name: aliasName,
            value: `${nodePrefix}/${fullModel.replace(`${providerId}/`, "")}`,
          }));

        // Merge custom models registered via /api/models/custom for this provider
        // providerAlias in DB uses the raw providerId, not the display prefix
        const registeredCustom = customModels
          .filter((m: CustomModel) => m.providerAlias === providerId)
          .map((m: CustomModel) => ({
            id: m.id,
            name: m.name || m.id,
            value: `${nodePrefix}/${m.id}`,
            isCustom: true,
          }));
        const seen = new Set<string>(nodeModels.map((m: ModelEntry) => m.value));
        const mergedModels = [...nodeModels, ...registeredCustom.filter((m: ModelEntry) => !seen.has(m.value))];

        // Always show compatible providers that are connected, even with no aliases.
        // When no aliases exist, show a placeholder so users know it's available.
        const modelsToShow = mergedModels.length > 0 ? mergedModels : [{
          id: `__placeholder__${providerId}`,
          name: `${nodePrefix}/model-id`,
          value: `${nodePrefix}/model-id`,
          isPlaceholder: true,
        }];

        groups[providerId] = {
          name: displayName,
          alias: nodePrefix,
          color: providerInfo.color,
          models: modelsToShow,
          isCustom: true,
          hasModels: mergedModels.length > 0,
        };
      } else {
        const hardcodedModels = providerId === "cursor" && cursorModels.length > 0
          ? cursorModels
          : getModelsByProviderId(providerId).map((m: Record<string, unknown>) => ({ id: m.id as string, name: m.name as string, kind: getModelKind(m) as string }));
        const hardcodedIds = new Set<string>(hardcodedModels.map((m: ModelEntry) => m.id));

        // Custom models: if no hardcoded models (e.g. openrouter), show all aliases for this provider
        // Otherwise only show aliases where aliasName === modelId ("Add Model" button pattern)
        const hasHardcoded = hardcodedModels.length > 0;
        const customAliasModels: ModelEntry[] = Object.entries(modelAliases)
          .filter(([aliasName, fullModel]: [string, string]) =>
            fullModel.startsWith(`${alias}/`) &&
            (hasHardcoded ? aliasName === fullModel.replace(`${alias}/`, "") : true) &&
            !hardcodedIds.has(fullModel.replace(`${alias}/`, ""))
          )
          .map(([aliasName, fullModel]: [string, string]) => {
            const modelId = fullModel.replace(`${alias}/`, "");
            return { id: modelId, name: aliasName, value: fullModel, isCustom: true };
          });

        // Custom models registered via /api/models/custom (provider "Add Model" button)
        const customAliasIds = new Set<string>(customAliasModels.map((m: ModelEntry) => m.id));
        const customRegisteredModels = customModels
          .filter((m: CustomModel) => m.providerAlias === alias && !hardcodedIds.has(m.id) && !customAliasIds.has(m.id))
          .map((m: CustomModel) => ({ id: m.id, name: m.name || m.id, value: `${alias}/${m.id}`, isCustom: true }));

        const merged: ModelEntry[] = [
          ...hardcodedModels.map((m: ModelEntry) => ({ id: m.id, name: m.name, value: `${alias}/${m.id}`, kind: m.kind || null })),
          ...customAliasModels,
          ...customRegisteredModels,
        ];
        // Dedupe by value (alias may equal hardcoded id, causing React key collision)
        const seen = new Set<string>();
        let allModels = filterByKind(merged.filter((m: ModelEntry) => {
          if (seen.has(m.value)) return false;
          seen.add(m.value);
          return true;
        }));

        // Provider-as-model fallback: providers that support the kind but have no hardcoded models
        // can still be picked (value = providerAlias). Skips embedding (always needs model).
        if (allModels.length === 0 && kindFilter && ALLOW_PROVIDER_FALLBACK_KINDS.has(kindFilter)) {
          const supports = (providerInfo.serviceKinds || ["llm"]).includes(kindFilter);
          if (supports) {
            allModels = [{ id: providerId, name: providerInfo.name || providerId, value: alias }];
          }
        }

        if (allModels.length > 0) {
          groups[providerId] = {
            name: providerInfo.name || providerId,
            alias: alias,
            color: providerInfo.color,
            models: allModels,
          };
        }
      }
    });

    // Filter out disabled models per provider (disabled keyed by storage alias OR providerId)
    Object.entries(groups).forEach(([providerId, group]: [string, GroupEntry]) => {
      const aliasKey = getProviderAlias(providerId);
      const disabledIds = new Set<string>([
        ...(disabledModels[aliasKey] || []),
        ...(disabledModels[providerId] || []),
      ]);
      if (disabledIds.size === 0) return;
      group.models = group.models.filter((m: ModelEntry) => !disabledIds.has(m.id));
      if (group.models.length === 0) delete groups[providerId];
    });

    return groups;
  }, [filteredActiveProviders, modelAliases, allProviders, providerNodes, customModels, disabledModels, kindFilter, activeProviders, cursorModels]);

  // Filter combos by search query (and hide combos when kindFilter is set — combos are LLM-only by design)
  const filteredCombos = useMemo<Combo[]>(() => {
    if (kindFilter || capFilter) return [];
    if (!searchQuery.trim()) return combos;
    const query = searchQuery.toLowerCase();
    return combos.filter((c: Combo) => c.name.toLowerCase().includes(query));
  }, [combos, searchQuery, kindFilter]);

  // Sort models alphabetically, with added models floated to top
  const sortModels = (models: ModelEntry[]): ModelEntry[] => {
    const added = models.filter((m: ModelEntry) => addedModelValues.includes(m.value)).sort((a, b) => a.name.localeCompare(b.name));
    const rest = models.filter((m: ModelEntry) => !addedModelValues.includes(m.value)).sort((a, b) => a.name.localeCompare(b.name));
    return [...added, ...rest];
  };

  // Filter models by search query
  const filteredGroups = useMemo<Record<string, GroupEntry>>(() => {
    const query = searchQuery.trim().toLowerCase();

    const filtered: Record<string, GroupEntry> = {};
    Object.entries(groupedModels).forEach(([providerId, group]: [string, GroupEntry]) => {
      let models = group.models;
      // Filter by input-modality capability (vision/pdf/audioInput/videoInput).
      if (capFilter) {
        models = models.filter((m: ModelEntry) => (getCaps(m.value) as Record<string, boolean> | null)?.[capFilter] === true);
        if (models.length === 0) return;
      }
      if (query) {
        const providerNameMatches = group.name.toLowerCase().includes(query);
        models = models.filter(
          (m: ModelEntry) =>
            m.name.toLowerCase().includes(query) ||
            m.id.toLowerCase().includes(query)
        );
        if (models.length === 0 && !providerNameMatches) return;
      }
      filtered[providerId] = {
        ...group,
        models: sortModels(models),
      };
    });

    return filtered;
  }, [groupedModels, searchQuery, addedModelValues]);

  const handleSelect = (model: ModelEntry | ModelSelectProp): void => {
    const value = (model as ModelEntry).value || (model as ModelSelectProp).name || "";
    const isAdded = addedModelValues.includes(value);

    if (isAdded && onDeselect) {
      onDeselect(model);
    } else {
      onSelect(model);
    }

    if (closeOnSelect) {
      onClose();
      setSearchQuery("");
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        onClose();
        setSearchQuery("");
      }}
      title={title}
      size="md"
      className="p-4!"
      footer={null}
    >
      {/* Info bar */}
      <div className="flex items-center gap-2 mb-3 px-2.5 py-2 bg-primary/8 border border-primary/20 rounded-lg text-xs text-text-muted">
        <span className="material-symbols-outlined text-primary shrink-0" style={{ fontSize: "14px" }}>info</span>
        <span>Click to add, click again to remove. Changes are saved automatically.</span>
      </div>

      {/* Search - compact */}
      <div className="mb-3">
        <div className="relative">
          <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted text-[16px]">
            search
          </span>
          <input
            type="text"
            placeholder="Search..."
            value={searchQuery}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 bg-surface border border-border rounded text-xs focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
        </div>
      </div>

      {/* Models grouped by provider - compact */}
      <div className="max-h-[400px] overflow-y-auto space-y-3">
        {/* Combos section - always first */}
        {filteredCombos.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-1.5 sticky top-0 bg-surface py-0.5">
              <span className="material-symbols-outlined text-primary text-[14px]">layers</span>
              <span className="text-xs font-medium text-primary">Combos</span>
              <span className="text-[10px] text-text-muted">({filteredCombos.length})</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {filteredCombos.map((combo: Combo) => {
                const isSelected = selectedModel === combo.name;
                return (
                  <button
                    key={combo.id}
                    onClick={() => handleSelect({ id: combo.name, name: combo.name, value: combo.name })}
                    className={`
                      px-2 py-1 rounded-xl text-xs font-medium transition-all border hover:cursor-pointer flex items-center gap-1
                      ${isSelected
                        ? "bg-primary text-white border-primary"
                        : addedModelValues.includes(combo.name)
                          ? "bg-primary border-primary text-white hover:bg-primary-hover"
                          : "bg-surface border-border text-text-main hover:border-primary/50 hover:bg-primary/5"
                      }
                    `}
                  >
                    {addedModelValues.includes(combo.name) && (
                      <span className="material-symbols-outlined leading-none" style={{ fontSize: "10px" }}>check</span>
                    )}
                    {combo.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Provider models */}
        {Object.entries(filteredGroups).map(([providerId, group]: [string, GroupEntry]) => (
          <div key={providerId}>
            {/* Provider header */}
            <div className="flex items-center gap-1.5 mb-1.5 sticky top-0 bg-surface py-0.5">
              <ProviderIcon
                src={`/providers/${providerId}.png`}
                alt={group.name}
                size={14}
                fallbackText={(group.name || providerId).slice(0, 2).toUpperCase()}
                fallbackColor={group.color}
              />
              <span className="text-xs font-medium text-primary">
                {group.name}
              </span>
              <span className="text-[10px] text-text-muted">
                ({group.models.length})
              </span>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {group.models.map((model: ModelEntry) => {
                const isSelected = selectedModel === model.value;
                const isPlaceholder = model.isPlaceholder;
                return (
                  <button
                    key={model.value}
                    onClick={() => handleSelect(model)}
                    title={isPlaceholder ? "Select to pre-fill, then edit model ID in the input" : undefined}
                    className={`
                      px-2 py-1 rounded-xl text-xs font-medium transition-all border hover:cursor-pointer
                      ${isPlaceholder
                        ? "border-dashed border-border text-text-muted hover:border-primary/50 hover:text-primary bg-surface italic"
                        : isSelected
                          ? "bg-primary text-white border-primary"
                          : addedModelValues.includes(model.value)
                            ? "bg-primary border-primary text-white hover:bg-primary-hover"
                            : "bg-surface border-border text-text-main hover:border-primary/50 hover:bg-primary/5"
                      }
                    `}
                  >
                    <span className="flex items-center gap-1">
                      {addedModelValues.includes(model.value) && !isPlaceholder && (
                        <span className="material-symbols-outlined leading-none" style={{ fontSize: "10px" }}>check</span>
                      )}
                      {isPlaceholder ? (
                        <>
                          <span className="material-symbols-outlined text-[11px]">edit</span>
                          {model.name}
                        </>
                      ) : model.isCustom ? (
                        <>
                          {model.name}
                          <span className="text-[9px] opacity-60 font-normal">custom</span>
                          <CapacityBadges caps={getCaps(model.value) as Record<string, boolean> | null} />
                        </>
                      ) : (
                        <>
                          {model.name}
                          <CapacityBadges caps={getCaps(model.value) as Record<string, boolean> | null} />
                        </>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        {Object.keys(filteredGroups).length === 0 && filteredCombos.length === 0 && (
          <div className="text-center py-4 text-text-muted">
            <span className="material-symbols-outlined text-2xl mb-1 block">
              search_off
            </span>
            <p className="text-xs">No models found</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
