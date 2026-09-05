"use client";

import { useState, useEffect, useCallback } from "react";
import type { ModelCaps } from "@/shared/types";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";

// Module cache: one /api/models fetch shared by every useModelCaps instance.
interface CapsCache {
  byFull: Record<string, ModelCaps>;
  byId: Record<string, ModelCaps>;
}

let cache: CapsCache | null = null;
let inflight: Promise<CapsCache> | null = null;

function buildMaps(models: Array<{ caps?: ModelCaps; fullModel?: string; routedModel?: string; model?: string }> | undefined): CapsCache {
  const byFull: Record<string, ModelCaps> = {};
  const byId: Record<string, ModelCaps> = {};
  for (const m of models || []) {
    if (!m.caps) continue;
    if (m.fullModel) byFull[m.fullModel] = m.caps;
    if (m.routedModel) byFull[m.routedModel] = m.caps;
    if (m.model) byId[m.model] = m.caps;
  }
  return { byFull, byId };
}

function loadModelCaps(): Promise<CapsCache> {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = fetch("/api/models")
    .then(async (res) => {
      if (!res.ok) throw new Error(`models ${res.status}`);
      const data = await res.json() as { models?: Array<{ caps?: ModelCaps; fullModel?: string; routedModel?: string; model?: string }> };
      cache = buildMaps(data.models);
      return cache;
    })
    .catch(() => {
      // Keep null so a later mount can retry
      return { byFull: {}, byId: {} };
    })
    .finally(() => { inflight = null; });
  return inflight;
}

// Resolve caps from a "provider/model" string or a bare model id.
function resolveCaps(
  byFull: Record<string, ModelCaps>,
  byId: Record<string, ModelCaps>,
  key: string | null | undefined,
): ModelCaps | null {
  if (!key) return null;
  if (byFull[key]) return byFull[key];
  const bare = key.includes("/") ? key.slice(key.indexOf("/") + 1) : key;
  if (byId[bare]) return byId[bare];
  const provider = key.includes("/") ? key.slice(0, key.indexOf("/")) : null;
  const c = getCapabilitiesForModel(provider, bare);
  return {
    vision: c.vision,
    search: c.search,
    reasoning: c.reasoning,
    contextWindow: c.contextWindow,
    maxOutput: c.maxOutput,
  };
}

export interface UseModelCapsReturn {
  getCaps: (key: string | null | undefined) => ModelCaps | null;
}

export function useModelCaps(): UseModelCapsReturn {
  const [byFull, setByFull] = useState<Record<string, ModelCaps>>(() => cache?.byFull || {});
  const [byId, setById] = useState<Record<string, ModelCaps>>(() => cache?.byId || {});

  useEffect(() => {
    let alive = true;
    const sync = (maps: CapsCache) => {
      if (alive) { setByFull(maps.byFull); setById(maps.byId); }
    };
    if (cache) {
      sync(cache);
    } else {
      loadModelCaps().then(sync);
    }
    // Custom models change at runtime — drop the shared cache and refetch
    const invalidate = () => {
      cache = null;
      loadModelCaps().then(sync);
    };
    window.addEventListener("customModelChanged", invalidate);
    return () => {
      alive = false;
      window.removeEventListener("customModelChanged", invalidate);
    };
  }, []);

  const getCaps = useCallback(
    (key: string | null | undefined) => resolveCaps(byFull, byId, key),
    [byFull, byId],
  );

  return { getCaps };
}
