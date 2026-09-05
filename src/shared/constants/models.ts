// Import directly from file to avoid pulling in server-side dependencies via index.js
export {
  PROVIDER_MODELS,
  getProviderModels,
  getDefaultModel,
  isValidModel as isValidModelCore,
  findModelName,
  getModelTargetFormat,
  getModelStrip,
  PROVIDER_ID_TO_ALIAS,
  getModelsByProviderId,
  getModelUpstreamId,
  getModelQuotaFamily,
} from "open-sse/config/providerModels.js";

import { AI_PROVIDERS, isOpenAICompatibleProvider } from "./providers";
import { PROVIDER_MODELS as MODELS_RAW } from "open-sse/config/providerModels.js";

interface ModelEntry {
  id: string;
  name: string;
  kind?: string;
  type?: string;
  [key: string]: unknown;
}

const MODELS = MODELS_RAW as Record<string, ModelEntry[]>;

// Providers that accept any model (passthrough)
const PASSTHROUGH_PROVIDERS = new Set<string>(
  Object.entries(AI_PROVIDERS)
    .filter(([, p]) => p.passthroughModels)
    .map(([key]) => key)
);

// Wrap isValidModel with passthrough providers
export function isValidModel(aliasOrId: string, modelId: string): boolean {
  if (isOpenAICompatibleProvider(aliasOrId)) return true;
  if (PASSTHROUGH_PROVIDERS.has(aliasOrId)) return true;
  const models = MODELS[aliasOrId] as ModelEntry[] | undefined;
  if (!models) return false;
  return models.some(m => m.id === modelId);
}

// Legacy AI_MODELS for backward compatibility
interface AiModelEntry {
  provider: string;
  model: string;
  name: string;
}

export const AI_MODELS: AiModelEntry[] = Object.entries(MODELS).flatMap(([alias, models]) =>
  models.map(m => ({ provider: alias, model: m.id, name: m.name }))
);

interface ModelLike {
  id?: string;
  name?: string | null;
  kind?: string | null;
  type?: string | null;
}

export const getModelKind = (m: ModelLike | null | undefined, fallback: string | null = null): string | null =>
  m?.kind ?? m?.type ?? fallback;

interface CapacityMeta {
  icon: string;
  label: string;
  desc: string;
  color: string;
}

// Capacity metadata for UI badges — icon + label + color per capability.
export const CAPACITY_META: Record<string, CapacityMeta> = {
  vision: { icon: "visibility", label: "Vision", desc: "Supports image input", color: "text-blue-500" },
  // search: temporarily hidden (feature not wired yet)
  reasoning: { icon: "neurology", label: "Reasoning", desc: "Supports reasoning / thinking", color: "text-amber-500" },
};
