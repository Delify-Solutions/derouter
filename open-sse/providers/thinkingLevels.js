// Resolve valid thinking levels per model — drives UI level picker (suffix "model(level)").
// Reuses capabilities.js (thinkingFormat/canDisable) so this file only maps format→levels (DRY).
import { getCapabilitiesForModel } from "./capabilities.js";
import { matchPattern } from "./pricing.js";
import { resolveKiroEffortPath } from "../config/kiroConstants.js";
import { getProviderModels } from "../config/providerModels.js";

// Shared level sets (deduped) — verified against provider docs + wire in thinkingUnified.applyFormat.
const L = {
  base: ["none", "low", "medium", "high"],                          // qwen, step, hunyuan, gemini-budget
  onOff: ["none", "thinking"],                                      // zai (binary), minimax (adaptive)
  openai: ["none", "minimal", "low", "medium", "high", "xhigh"],    // GPT-5.x / o-series (no "max")
  levelMax: ["none", "low", "medium", "high", "max"],               // kimi
  budgetX: ["none", "low", "medium", "high", "xhigh", "max"],       // claude-budget, claude-adaptive
  gemini: ["minimal", "low", "medium", "high"],                     // gemini-3 thinkingLevel (no disable)
  hiMax: ["none", "high", "max"],                                   // deepseek (low/med→high, xhigh→max)
};

// thinkingFormat → valid selectable levels (source of truth for UI options).
const FORMAT_LEVELS = {
  openai: L.openai,
  "claude-adaptive": L.budgetX,
  "claude-budget": L.budgetX,
  "gemini-level": L.gemini,
  "gemini-budget": L.base,
  zai: L.onOff,
  qwen: L.base,
  kimi: L.levelMax,
  deepseek: L.hiMax,
  commandcode: ["none", "low", "medium", "high", "xhigh", "max"],
  minimax: L.onOff,
  hunyuan: L.base,
  step: L.base,
  nous: L.base,
};

const CODEX_GPT_5_6_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

// Opus/Sonnet 4.6 lack xhigh (Anthropic + Kiro docs) — keep the 4-level+max set.
const CLAUDE_NO_XHIGH = ["none", "low", "medium", "high", "max"];

// Model-name pattern overrides (glob, first match wins) — more precise than format default.
const PATTERN_THINKING = [
  // Gemini 4 (Argon) rejects "minimal" with 400 — LOW is the floor; cannot disable thinking.
  { pattern: "*gemini-4*", levels: ["low", "medium", "high"] },
  { pattern: "*claude*4.6*", levels: CLAUDE_NO_XHIGH },
  { pattern: "*claude*4-6*", levels: CLAUDE_NO_XHIGH },
  { provider: "codex", pattern: "*gpt-6*", levels: CODEX_GPT_5_6_LEVELS },
  { provider: "codex", pattern: "*gpt-5.6-sol*", levels: [...CODEX_GPT_5_6_LEVELS, "ultra"] },
  { provider: "codex", pattern: "*gpt-5.6-terra*", levels: [...CODEX_GPT_5_6_LEVELS, "ultra"] },
  { provider: "codex", pattern: "*gpt-5.6-luna*", levels: CODEX_GPT_5_6_LEVELS },
  { pattern: "*codex*", levels: ["low", "medium", "high", "xhigh"] }, // codex cannot disable thinking
  // OpenCode Free (oc) MiMo rides the same OpenRouter-backed route as the rest of
  // that lane and takes the full OpenAI effort enum verbatim (probed live: all
  // seven values 200, anything else 400 "Invalid option"), so it owns the entry
  // ahead of the unqualified *mimo*v2.6* one below — that one describes Xiaomi's
  // own API, and its [none..xhigh] set would make max unreachable here (the
  // deepseek wire branch clamps max→high when the declared set lacks it).
  { provider: "opencode", pattern: "*mimo*v2.6*", levels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] },
  { pattern: "*mimo*v2.6*", levels: ["none", "low", "medium", "high", "xhigh"] },
  // mimo-v2.5-pro on opencode-go rejects reasoning_effort "max" (probed live); v2.5 accepts it.
  { pattern: "*mimo*v2.5-pro*", levels: ["none", "low", "medium", "high", "xhigh"] },
  // DeepSeek v4.* (Alibaba MaaS, probed live): effort low|medium|high|xhigh|max
  // all 200 via output_config.effort; "none" is a 400 on the anthropic route
  // (disable thinking instead). none kept for the picker = disable.
  // ⚠️ The codebuddy-cn exact ids below MUST stay above this unqualified glob —
  // PATTERN_THINKING is first-match-wins, so a later provider-qualified entry
  // would never fire for dotted ids like deepseek-v4.1-flash.
  { provider: "codebuddy-cn", pattern: "deepseek-v4-pro",     levels: ["low", "high", "xhigh"] },
  { provider: "codebuddy-cn", pattern: "deepseek-v4.1-flash", levels: ["low", "high", "max"] },
  // OpenCode Zen free tier (oc / ocz) — the free id of the same v4.1-flash model
  // publishes low|high|max as well, and unlike DeepSeek's own API the upstream
  // forwards the level verbatim (no low→high collapse). The generic
  // *deepseek-v4.* glob below would advertise medium/xhigh, which the model does
  // not serve, so this entry MUST stay above it.
  { pattern: "*deepseek-v4.1-flash-free*", levels: ["low", "high", "max"] },
  { pattern: "*deepseek-v4.*", levels: ["none", "low", "medium", "high", "xhigh", "max"] },
  // codebuddy-cn per-model effort sets — the server's product-config payload
  // publishes `reasoning.supportedEfforts` per model. NOTE: the chat endpoint
  // accepts any level you send (probed none/minimal/low/medium/high/xhigh/max
  // → all 200), but values outside a model's supportedEfforts are silently
  // clamped, so the declared set stays authoritative for the picker. Models
  // that publish no supportedEfforts (glm-5.1 / kimi-k3-1 / minimax-m3)
  // fall through to the openai format default.
  { provider: "codebuddy-cn", pattern: "glm-5.3",      levels: ["low", "high", "max"] },
  { provider: "codebuddy-cn", pattern: "glm-5.3-flash", levels: ["low", "high", "max"] },
  { provider: "codebuddy-cn", pattern: "glm-5.2",      levels: ["high", "xhigh"] },
  { provider: "codebuddy-cn", pattern: "kimi-k2.8-preview",  levels: ["low", "medium", "high"] },
  { provider: "codebuddy-cn", pattern: "hy3",          levels: ["low", "high"] },
  { provider: "codebuddy-cn", pattern: "hy4-preview",  levels: ["high"] },
  // codebuddy-intl rides the same gateway catalog, so its deepseek levels match.
  { provider: "codebuddy-intl", pattern: "deepseek-v4*", levels: ["low", "high", "xhigh"] },
  // MiniMax Code (mcode) — adaptive effort via output_config.effort. M3.1
  // always thinks (no none); M3 is switchable with none/high only, per the
  // magpie static catalog. M2.7 pair falls through to the claude-adaptive
  // set minus none (canDisable: false).
  { provider: "minimax-code", pattern: "MiniMax-M3.1*", levels: ["low", "medium", "high", "xhigh", "max"] },
  { provider: "minimax-code", pattern: "MiniMax-M3", levels: ["none", "high"] },
  { provider: "minimax-code-global", pattern: "MiniMax-M3.1*", levels: ["low", "medium", "high", "xhigh", "max"] },
  { provider: "minimax-code-global", pattern: "MiniMax-M3", levels: ["none", "high"] },
];

// OpenAI documents reasoning.effort "max" for GPT-5.6 and GPT-6 (#5186). The codex rows
// above already carry it; an OpenAI Compatible node serving the same ids gets the same
// set, otherwise the "openai" format list (no max) clamps max to xhigh on the wire.
const OPENAI_MAX_EFFORT_MODEL = /(?:^|\/)gpt-(?:5\.6|6)(?:[.-]|$)/i;
const isOpenAICompatibleNode = (provider) => String(provider || "").startsWith("openai-compatible-");

// Returns valid thinking levels for a model, or null when the model has no reasoning.
// Command Code publishes the efforts each model accepts in its catalog (command-code CLI
// 1.91.0, `reasoningEfforts`; "off" there is "none" here). The /alpha/generate endpoint takes
// exactly those values, and "off" is how the official CLI switches thinking off. A model not
// listed falls back to the generic commandcode set.
export const COMMAND_CODE_EFFORTS = {
  "MiniMaxAI/MiniMax-M3": ["low", "medium", "high"],
  "MiniMaxAI/MiniMax-M3-Free": ["low", "medium", "high"],
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
  "claude-haiku-5-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-7": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-8": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-5-5": ["low", "medium", "high", "xhigh", "max"],
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
  "meta/muse-ember": ["low", "medium", "high", "xhigh", "max"],
  "meta/muse-spark-1.1": ["low", "medium", "high", "xhigh"],
  "meta/muse-spark-1.3": ["low", "medium", "high", "xhigh", "max"],
  "meta/muse-spark-1.3-contributor": ["low", "medium", "high", "xhigh"],
  "meta/muse-spark-open": ["low", "medium", "high"],
  "meta/muse-wonder-1.0": ["low", "medium", "high", "xhigh"],
  "minimax/minimax-m3-free": ["low", "medium", "high"],
  "minimax/minimax-m3.1-flash": ["low", "medium", "high", "xhigh", "max"],
  "mistral/mistral-large-4": ["low", "medium", "high"],
  "moonshotai/Kimi-K3": ["low", "high", "max"],
  "moonshotai/Kimi-K3.1-Pro": ["low", "high", "max"],
  "nvidia/nemotron-3.5-super-vl": ["low", "medium", "high"],
  "reflection/beam:free": ["low", "medium", "high", "xhigh", "max"],
  "sakana/fugu-ultra": ["high", "xhigh"],
  "stealth/crouton-alpha": ["low", "medium", "high", "xhigh", "max"],
  "stepfun/Step-5-Preview": ["low", "medium", "high"],
  "tencent/hy4": ["low", "medium", "high"],
  "tencent/hy4-flash": ["none", "high"],
  "tencent/hy4-preview": ["low", "medium", "high"],
  "xai/grok-4.5": ["low", "medium", "high"],
  "xai/grok-4.6": ["low", "medium", "high", "xhigh"],
  "xai/grok-4.7": ["low", "medium", "high", "xhigh"],
  "z-ai/glm-5.3-flash": ["low", "high", "max"],
  "z-ai/glm-5.3-flashx": ["low", "high", "max"],
  "zai-org/GLM-5.2": ["high", "max"],
  "zai-org/GLM-5.3": ["low", "high", "max"],
};

export function getThinkingLevels(provider, model) {
  if (provider === "kiro" && resolveKiroEffortPath(model) === null) return null;
  const caps = getCapabilitiesForModel(provider, model);
  if (!caps.reasoning) return null;
  const baseId = String(model || "").replace(/\([^()]+\)\s*$/, "");
  const modelLevels = provider === "codex"
    ? getProviderModels("cx").find((entry) => entry.id === baseId)?.thinkingLevels
    : (provider === "commandcode" || provider === "cmc")
      ? COMMAND_CODE_EFFORTS[baseId] ?? null
      : null;
  const hit = PATTERN_THINKING.find((entry) =>
    (!entry.provider || entry.provider === provider) && matchPattern(entry.pattern, model)
  );
  let levels = modelLevels || hit?.levels
    || (isOpenAICompatibleNode(provider) && OPENAI_MAX_EFFORT_MODEL.test(baseId) ? CODEX_GPT_5_6_LEVELS : null)
    || FORMAT_LEVELS[caps.thinkingFormat] || L.base;
  if (caps.thinkingCanDisable === false) levels = levels.filter((l) => l !== "none");
  return levels;
}
