// Thinking efforts each Command Code model accepts.
//
// Command Code publishes them in its model catalog (`reasoningEfforts`), the same public
// endpoint its own CLI polls (no auth, `refreshAfterSeconds`: 900). "off" there is "none" here.
// A model whose catalog entry has no effort list (null) takes no reasoning_effort at all: the
// official CLI never sends one to it, so it is recorded here as an empty list.
//
// The live catalog is read in the background (one request at a time, at most every
// refreshAfterSeconds) and never blocks a request: until it has been read, and whenever it
// cannot be, the snapshot below (command-code CLI 1.91.0, identical to the live catalog on
// 2026-11-18) answers. Lookups are synchronous, because the thinking code that uses them is.
//
// Relative imports only (plain `node --test`).
import { COMMANDCODE_MODELS_URL } from "./commandcodeModels.js";

const DEFAULT_REFRESH_MS = 15 * 60 * 1000;
// A server-sent refresh interval is kept within sane bounds: a tiny value would refetch on
// nearly every request.
const MIN_REFRESH_MS = 60 * 1000;
const MAX_REFRESH_MS = 24 * 60 * 60 * 1000;
const FAILED_RETRY_MS = 60 * 1000;
const KNOWN_LEVELS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const FETCH_TIMEOUT_MS = 8000;

export const COMMAND_CODE_EFFORTS = {
  "MiniMaxAI/MiniMax-M2.5": [],
  "MiniMaxAI/MiniMax-M2.7": [],
  "MiniMaxAI/MiniMax-M3": ["low", "medium", "high"],
  "MiniMaxAI/MiniMax-M3-Free": ["low", "medium", "high"],
  "Qwen/Qwen3.6-Max-Preview": [],
  "Qwen/Qwen3.6-Plus": [],
  "Qwen/Qwen3.7-Flash": [],
  "Qwen/Qwen3.7-Max": [],
  "Qwen/Qwen3.7-Plus": [],
  "Qwen/Qwen3.8-27B": ["low", "medium", "xhigh"],
  "Qwen/Qwen3.8-Flash": ["low", "medium", "xhigh"],
  "Qwen/Qwen3.8-Max": ["low", "medium", "xhigh"],
  "Qwen/Qwen3.8-Max-0902": ["low", "medium", "xhigh"],
  "Qwen/Qwen3.8-Max-Prime": ["low", "medium", "xhigh"],
  "Qwen/Qwen3.8-Omni-Flash": ["low", "medium", "xhigh"],
  "Qwen/Qwen4-Max": ["none", "low", "high", "xhigh"],
  "claude-fable-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-fable-5-1": ["low", "medium", "high", "xhigh", "max"],
  "claude-fable-5-2": ["low", "medium", "high", "xhigh", "max"],
  "claude-haiku-4-5": [],
  "claude-haiku-4-5-20251001": [],
  "claude-haiku-5-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-5-20251101": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-6": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-7": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-8": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-5-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-4-20250514": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-4-5-20250929": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-4-6": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-5-5": ["low", "medium", "high", "xhigh", "max"],
  "deepseek/deepseek-v4-flash": ["none", "high", "max"],
  "deepseek/deepseek-v4-flash-fast": ["low", "high", "max"],
  "deepseek/deepseek-v4-flash-vision-exp": ["none", "high", "max"],
  "deepseek/deepseek-v4-pro": ["none", "high", "max"],
  "deepseek/deepseek-v4.1-flash": ["none", "low", "high", "max"],
  "deepseek/deepseek-v4.1-flash-fast": ["none", "low", "high", "max"],
  "deepseek/deepseek-v4.1-flash-ultrafast": ["none", "low", "high", "max"],
  "google/gemini-3.1-flash-lite": ["low", "medium", "high"],
  "google/gemini-3.5-flash": ["low", "medium", "high"],
  "google/gemini-3.5-flash-lite": ["low", "medium", "high"],
  "google/gemini-3.6-flash": ["low", "medium", "high"],
  "google/gemini-3.7-flash": ["low", "medium", "high"],
  "google/gemini-3.8-flash": ["low", "medium", "high"],
  "google/gemini-4-argon": ["low", "medium", "high"],
  "google/gemini-4-carbon": ["low", "medium", "high"],
  "gpt-5.3-codex": ["low", "medium", "high", "xhigh"],
  "gpt-5.4": ["low", "medium", "high", "xhigh"],
  "gpt-5.4-mini": ["low", "medium", "high"],
  "gpt-5.5": ["low", "medium", "high", "xhigh"],
  "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max"],
  "gpt-6-astra": ["low", "medium", "high", "xhigh", "max"],
  "gpt-6-luna": ["low", "medium", "high", "xhigh", "max"],
  "gpt-6-sol": ["low", "medium", "high", "xhigh", "max"],
  "gpt-6.1-sol": ["low", "medium", "high", "xhigh", "max"],
  "gpt-6.1-terra": ["low", "medium", "high", "xhigh", "max"],
  "gpt-6.2-astra": ["low", "medium", "high", "xhigh", "max"],
  "gpt-6.2-sol": ["low", "medium", "high", "xhigh", "max"],
  "inclusionai/ling-3.1-flash": ["low", "medium", "high"],
  "inclusionai/ling-3.1-flash-1019": ["low", "medium", "high"],
  "inclusionai/ling-3.1-flash-1019:free": ["low", "medium", "high"],
  "inclusionai/ling-3.1-flash:free": [],
  "meituan/LongCat-2.0": [],
  "meituan/LongCat-2.0:free": [],
  "meta/muse-ember": ["low", "medium", "high", "xhigh", "max"],
  "meta/muse-spark-1.1": ["low", "medium", "high", "xhigh"],
  "meta/muse-spark-1.2": ["low", "medium", "high", "xhigh"],
  "meta/muse-spark-1.2-contributor": ["low", "medium", "high", "xhigh"],
  "meta/muse-spark-1.3": ["low", "medium", "high", "xhigh", "max"],
  "meta/muse-spark-1.3-contributor": ["low", "medium", "high", "xhigh"],
  "meta/muse-spark-open": ["low", "medium", "high"],
  "meta/muse-wonder-1.0": ["low", "medium", "high", "xhigh"],
  "minimax/minimax-m2.7-free": [],
  "minimax/minimax-m3-free": ["low", "medium", "high"],
  "minimax/minimax-m3.1-flash": ["low", "medium", "high", "xhigh", "max"],
  "minimax/minimax-m3.1-flash-preview": ["low", "medium", "high", "xhigh", "max"],
  "minimax/minimax-m3.1-flash-preview:free": ["low", "medium", "high", "xhigh", "max"],
  "minimax/minimax-m3.1-flash:free": ["low", "medium", "high", "xhigh", "max"],
  "mistral/mistral-large-4": ["low", "medium", "high"],
  "moonshotai/Kimi-K2.5": [],
  "moonshotai/Kimi-K2.6": [],
  "moonshotai/Kimi-K2.7-Code": [],
  "moonshotai/Kimi-K2.7-Code-Highspeed": [],
  "moonshotai/Kimi-K3": ["low", "high", "max"],
  "moonshotai/Kimi-K3.1-Pro": ["low", "high", "max"],
  "nvidia/nemotron-3-ultra-550b-a55b": [],
  "nvidia/nemotron-3.5-super-vl": ["low", "medium", "high"],
  "ornith/ornith-1.5-122b": [],
  "ornith/ornith-1.5-122b:free": [],
  "poolside/laguna-s-2.1-free": [],
  "recursive/flint-v1.0:free": [],
  "reflection/beam:free": ["low", "medium", "high", "xhigh", "max"],
  "sakana/fugu-ultra": ["high", "xhigh"],
  "stealth/crouton-alpha": ["low", "medium", "high", "xhigh", "max"],
  "stealth/glyph-cluster:free": ["low", "medium", "high", "xhigh"],
  "stealth/pixel-canary": [],
  "stealth/space-bunny-alpha": [],
  "stepfun/Step-3.5-Flash": [],
  "stepfun/Step-3.7-Flash": [],
  "stepfun/Step-5-Preview": ["low", "medium", "high"],
  "tencent/HY3": [],
  "tencent/Hy3": [],
  "tencent/hy3-paid": [],
  "tencent/hy4": ["low", "medium", "high"],
  "tencent/hy4-flash": ["none", "high"],
  "tencent/hy4-preview": ["low", "medium", "high"],
  "thinkingmachines/inkling": [],
  "thinkingmachines/inkling-2-small:free": ["low", "medium", "high", "max"],
  "thinkingmachines/inkling-small": [],
  "xai/grok-4.5": ["low", "medium", "high"],
  "xai/grok-4.6": ["low", "medium", "high", "xhigh"],
  "xai/grok-4.7": ["low", "medium", "high", "xhigh"],
  "xiaomi/mimo-v2.5": [],
  "xiaomi/mimo-v2.5-pro": [],
  "xiaomi/mimo-v2.6-flash": [],
  "xiaomi/mimo-v2.6-pro": [],
  "xiaomi/mimo-v2.6-pro-ultraspeed": [],
  "z-ai/glm-5.3-flash": ["low", "high", "max"],
  "z-ai/glm-5.3-flashx": ["low", "high", "max"],
  "zai-org/GLM-5": [],
  "zai-org/GLM-5.1": [],
  "zai-org/GLM-5.2": ["high", "max"],
  "zai-org/GLM-5.2-Fast": [],
  "zai-org/GLM-5.3": ["low", "high", "max"],
};

function state() {
  if (!globalThis.__commandCodeEfforts) {
    globalThis.__commandCodeEfforts = { live: null, lower: null, fetchedAt: 0, refreshMs: DEFAULT_REFRESH_MS, retryAt: 0, inflight: null };
  }
  return globalThis.__commandCodeEfforts;
}

/** Catalog JSON -> { id or alias: levels } (empty list = the model takes no effort). */
export function parseCommandCodeEfforts(data) {
  const rows = Array.isArray(data?.data) ? data.data : [];
  // No prototype: a catalog id such as "__proto__" or "constructor" is just a key.
  const map = Object.create(null);
  for (const row of rows) {
    if (!row?.id || typeof row.id !== "string") continue;
    // Only levels the router understands; an unknown string would be sent as is.
    const levels = Array.isArray(row.reasoningEfforts)
      ? row.reasoningEfforts.map((e) => (e === "off" ? "none" : String(e))).filter((l) => KNOWN_LEVELS.has(l))
      : [];
    map[row.id] = levels;
    for (const alias of Array.isArray(row.aliases) ? row.aliases : []) {
      if (typeof alias === "string" && alias && !Object.hasOwn(map, alias)) map[alias] = levels;
    }
  }
  return map;
}

function lowerIndex(map) {
  const out = Object.create(null);
  for (const [k, v] of Object.entries(map)) out[k.toLowerCase()] = v;
  return out;
}
let staticLower = null;

/**
 * The efforts `model` accepts: a list (possibly empty = no effort setting), or undefined when
 * neither the live catalog nor the snapshot knows the model. The exact id wins, then a
 * case-insensitive match.
 */
export function getCommandCodeEfforts(model) {
  if (!model) return undefined;
  const id = String(model);
  const s = state();
  if (s.live) {
    if (Object.hasOwn(s.live, id)) return s.live[id];
    const hit = s.lower[id.toLowerCase()];
    if (hit) return hit;
  }
  if (Object.hasOwn(COMMAND_CODE_EFFORTS, id)) return COMMAND_CODE_EFFORTS[id];
  staticLower ??= lowerIndex(COMMAND_CODE_EFFORTS);
  return staticLower[id.toLowerCase()];
}

/** Install a parsed catalog (also used by tests). */
export function setCommandCodeCatalog(data, { now = Date.now() } = {}) {
  const map = parseCommandCodeEfforts(data);
  if (Object.keys(map).length === 0) return false;
  const s = state();
  s.live = map;
  s.lower = lowerIndex(map);
  s.fetchedAt = now;
  const seconds = Number(data?.refreshAfterSeconds);
  s.refreshMs = Number.isFinite(seconds) && seconds > 0
    ? Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, seconds * 1000))
    : DEFAULT_REFRESH_MS;
  return true;
}

export function resetCommandCodeCatalogForTests() {
  globalThis.__commandCodeEfforts = undefined;
}

/**
 * Read the live catalog if it is due. Never throws and never makes a caller wait for the
 * network unless the caller awaits it; a failure keeps what is known and retries a minute later.
 */
export function refreshCommandCodeEffortsIfStale({ fetchImpl = fetch, now = Date.now() } = {}) {
  const s = state();
  if (s.inflight) return s.inflight;
  if (s.live && now - s.fetchedAt < s.refreshMs) return Promise.resolve(false);
  if (now < s.retryAt) return Promise.resolve(false);
  s.inflight = (async () => {
    // Yield first: a fetch that throws synchronously would otherwise run the finally below
    // before `s.inflight` is assigned and leave a settled promise there for good.
    await null;
    try {
      const response = await fetchImpl(COMMANDCODE_MODELS_URL, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response?.ok) throw new Error(`HTTP ${response?.status}`);
      if (!setCommandCodeCatalog(await response.json(), { now })) throw new Error("empty catalog");
      return true;
    } catch {
      s.retryAt = now + FAILED_RETRY_MS;
      return false;
    } finally {
      s.inflight = null;
    }
  })();
  return s.inflight;
}
