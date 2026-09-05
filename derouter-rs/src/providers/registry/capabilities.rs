//! Capabilities lookup from the full registry.
//! Ports open-sse/providers/capabilities.js getCapabilitiesForModel with the full
//! fallback chain: provider-specific overrides → canonical exact → pattern → default.

use serde::{Deserialize, Serialize};

/// Capabilities for a model (the Rust-facing struct, same as Phase 2).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Caps {
    pub vision: bool,
    pub search: bool,
    pub reasoning: bool,
    #[serde(default)]
    pub context_window: i64,
    #[serde(default)]
    pub max_output: i64,
}

impl Caps {
    pub fn default_caps() -> Self {
        Caps {
            vision: false,
            search: false,
            reasoning: false,
            context_window: 0,
            max_output: 0,
        }
    }
}

/// Default capabilities (safe floor) — matches Node's DEFAULT_CAPABILITIES but with
/// more conservative contextWindow/maxOutput (0 instead of 200000/64000) so the
/// frontend doesn't show inflated limits for unknown models.
const DEFAULT_CONTEXT_WINDOW: i64 = 200_000;
const DEFAULT_MAX_OUTPUT: i64 = 64_000;

/// Internal pattern caps entry
struct PatternCaps {
    pattern: &'static str,
    vision: bool,
    search: bool,
    reasoning: bool,
    context_window: i64,
    max_output: i64,
}

/// Get capabilities for a model.
/// Follows the Node 4-step fallback chain:
///   1. Provider-specific override
///   2. Canonical exact model id
///   3. Pattern match (first match wins)
///   4. Default floor
pub fn get_capabilities_for_model(provider: &str, model: &str) -> Caps {
    if model.is_empty() {
        return default_caps();
    }

    // Strip vendor prefix: "anthropic/claude-opus-4.7" -> "claude-opus-4.7"
    let base_model = if model.contains('/') {
        model.rsplit('/').next().unwrap_or(model)
    } else {
        model
    };

    // 1. Provider-specific overrides
    if let Some(caps) = provider_override(provider, model) {
        return caps;
    }
    if let Some(caps) = provider_override(provider, base_model) {
        return caps;
    }

    // 2. Canonical exact
    if let Some(caps) = exact_match(base_model) {
        return caps;
    }
    if let Some(caps) = exact_match(model) {
        return caps;
    }

    // 3. Pattern match
    for p in PATTERNS {
        if match_pattern(p.pattern, base_model) || match_pattern(p.pattern, model) {
            return Caps {
                vision: p.vision,
                search: p.search,
                reasoning: p.reasoning,
                context_window: if p.context_window > 0 { p.context_window } else { DEFAULT_CONTEXT_WINDOW },
                max_output: if p.max_output > 0 { p.max_output } else { DEFAULT_MAX_OUTPUT },
            };
        }
    }

    // 4. Floor
    Caps {
        vision: false,
        search: false,
        reasoning: false,
        context_window: DEFAULT_CONTEXT_WINDOW,
        max_output: DEFAULT_MAX_OUTPUT,
    }
}

fn default_caps() -> Caps {
    Caps {
        vision: false,
        search: false,
        reasoning: false,
        context_window: DEFAULT_CONTEXT_WINDOW,
        max_output: DEFAULT_MAX_OUTPUT,
    }
}

/// Provider-specific capability overrides.
fn provider_override(provider: &str, model: &str) -> Option<Caps> {
    let p = provider;
    let m = model;
    match (p, m) {
        // NVIDIA NIM
        ("nvidia", "minimaxai/minimax-m2.7") => Some(Caps { vision: false, search: false, reasoning: true, context_window: 200000, max_output: 131072 }),
        ("nvidia", "minimaxai/minimax-m3") => Some(Caps { vision: true, search: false, reasoning: true, context_window: 512000, max_output: 131072 }),
        ("nvidia", "z-ai/glm-5.2") => Some(Caps { vision: false, search: false, reasoning: true, context_window: 200000, max_output: 128000 }),
        ("nvidia", "deepseek-ai/deepseek-v4-pro") => Some(Caps { vision: false, search: false, reasoning: true, context_window: 1000000, max_output: 65536 }),
        ("nvidia", "deepseek-ai/deepseek-v4-flash") => Some(Caps { vision: false, search: false, reasoning: true, context_window: 1000000, max_output: 65536 }),

        // Codex
        ("codex", "gpt-5.6-sol") | ("codex", "gpt-5.6-sol-review") => Some(Caps { vision: true, search: true, reasoning: true, context_window: 372000, max_output: 128000 }),
        ("codex", "gpt-5.6-terra") | ("codex", "gpt-5.6-terra-review") | ("codex", "gpt-5.6-luna") | ("codex", "gpt-5.6-luna-review") => Some(Caps { vision: true, search: true, reasoning: true, context_window: 272000, max_output: 128000 }),

        // Kiro
        ("kiro", "gpt-5.6-sol") | ("kiro", "gpt-5.6-terra") | ("kiro", "gpt-5.6-luna")
        | ("kiro", "gpt-5.6-sol-thinking") | ("kiro", "gpt-5.6-terra-thinking") | ("kiro", "gpt-5.6-luna-thinking")
        | ("kiro", "gpt-5.6-sol-agentic") | ("kiro", "gpt-5.6-terra-agentic") | ("kiro", "gpt-5.6-luna-agentic")
        | ("kiro", "gpt-5.6-sol-thinking-agentic") | ("kiro", "gpt-5.6-terra-thinking-agentic") | ("kiro", "gpt-5.6-luna-thinking-agentic") => Some(Caps { vision: true, search: true, reasoning: true, context_window: 272000, max_output: 128000 }),

        // CodeBuddy CN
        ("codebuddy-cn", "glm-5.2") => Some(Caps { vision: false, search: false, reasoning: true, context_window: 1000000, max_output: 48000 }),
        ("codebuddy-cn", "glm-5.1") => Some(Caps { vision: false, search: false, reasoning: true, context_window: 200000, max_output: 48000 }),
        ("codebuddy-cn", "glm-5.0") => Some(Caps { vision: false, search: false, reasoning: true, context_window: 200000, max_output: 48000 }),
        ("codebuddy-cn", "glm-5.0-turbo") => Some(Caps { vision: false, search: false, reasoning: true, context_window: 200000, max_output: 48000 }),
        ("codebuddy-cn", "glm-5v-turbo") => Some(Caps { vision: true, search: false, reasoning: true, context_window: 200000, max_output: 38000 }),
        ("codebuddy-cn", "minimax-m3") => Some(Caps { vision: true, search: false, reasoning: true, context_window: 512000, max_output: 48000 }),
        ("codebuddy-cn", "minimax-m2.7") => Some(Caps { vision: true, search: false, reasoning: true, context_window: 200000, max_output: 48000 }),
        ("codebuddy-cn", "kimi-k2.7") => Some(Caps { vision: true, search: false, reasoning: true, context_window: 256000, max_output: 32000 }),
        ("codebuddy-cn", "kimi-k2.6") => Some(Caps { vision: true, search: false, reasoning: true, context_window: 256000, max_output: 32000 }),
        ("codebuddy-cn", "kimi-k2.5") => Some(Caps { vision: true, search: false, reasoning: true, context_window: 164000, max_output: 32000 }),

        // Poolside
        ("poolside", "poolside/laguna-s-2.1") => Some(Caps { vision: false, search: false, reasoning: true, context_window: 1000000, max_output: 32000 }),
        ("poolside", "poolside/laguna-xs-2.1") => Some(Caps { vision: false, search: false, reasoning: true, context_window: 200000, max_output: 32000 }),

        _ => None,
    }
}

/// Canonical exact-id overrides
fn exact_match(model: &str) -> Option<Caps> {
    match model {
        // Claude 4.6+/5 = 1M context + adaptive thinking
        "claude-fable-5-1" | "claude-opus-5" | "claude-opus-5-thinking" | "claude-opus-5-agentic" | "claude-opus-5-thinking-agentic"
        | "claude-opus-4.6" | "claude-opus-4-6" | "claude-opus-4.7" | "claude-opus-4-7" | "claude-opus-4.8"
        | "claude-opus-4-8" | "claude-opus-4.8-thinking" | "claude-opus-4-8-thinking"
        | "claude-sonnet-4.6" | "claude-sonnet-4-6" | "claude-sonnet-5"
        | "claude-sonnet-5-thinking" | "claude-sonnet-5-agentic" | "claude-sonnet-5-thinking-agentic" => {
            Some(Caps { vision: true, search: true, reasoning: true, context_window: 1000000, max_output: 128000 })
        }
        "gpt-image-1" => Some(Caps { vision: false, search: false, reasoning: false, context_window: 0, max_output: 0 }),
        "glm-5.3-flash" => Some(Caps { vision: true, search: false, reasoning: true, context_window: 1000000, max_output: 131072 }),
        "glm-4.6v" => Some(Caps { vision: true, search: false, reasoning: true, context_window: 128000, max_output: 32768 }),
        "glm-4.5v" => Some(Caps { vision: true, search: false, reasoning: true, context_window: 64000, max_output: 16384 }),
        "deepseek-v4-flash-vision-exp" => Some(Caps { vision: true, search: false, reasoning: true, context_window: 1000000, max_output: 384000 }),
        "vision-model" => Some(Caps { vision: true, search: false, reasoning: true, context_window: 1000000, max_output: 0 }),
        "coder-model" => Some(Caps { vision: false, search: false, reasoning: true, context_window: 1000000, max_output: 0 }),
        "kimi-k3" | "k3" => Some(Caps { vision: true, search: false, reasoning: true, context_window: 1048576, max_output: 131072 }),
        "kimi-for-coding" | "kimi-for-coding-highspeed" => Some(Caps { vision: true, search: false, reasoning: true, context_window: 262144, max_output: 65536 }),
        "kimi-k2.7-code" | "kimi-k2.7-code-highspeed" => Some(Caps { vision: true, search: false, reasoning: true, context_window: 262144, max_output: 65536 }),
        "muse-spark-1.2-contributor-free" | "muse-spark-1.3-contributor-free" => Some(Caps { vision: true, search: false, reasoning: true, context_window: 1048576, max_output: 131072 }),
        _ => None,
    }
}

/// Glob pattern matching: `*` = wildcard, case-insensitive, anchored
fn match_pattern(pattern: &str, text: &str) -> bool {
    let pattern_lower = pattern.to_lowercase();
    let text_lower = text.to_lowercase();
    let parts: Vec<&str> = pattern_lower.split('*').collect();
    if parts.is_empty() {
        return text_lower == pattern_lower;
    }
    // If the pattern doesn't contain *, do exact match
    if !pattern.contains('*') {
        return text_lower == pattern_lower;
    }
    let mut pos = 0;
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        if i == 0 && !pattern.starts_with('*') {
            // Anchor at start
            if !text_lower[pos..].starts_with(part) {
                return false;
            }
            pos += part.len();
        } else {
            match text_lower[pos..].find(part) {
                Some(idx) => pos += idx + part.len(),
                None => return false,
            }
        }
    }
    // If pattern ends with *, allow any suffix
    // If pattern doesn't end with *, check end
    if !pattern.ends_with('*') {
        let last = parts.last().unwrap_or(&"");
        if !last.is_empty() && !text_lower.ends_with(last) {
            return false;
        }
    }
    true
}

/// Pattern capabilities table — ordered specific → generic
static PATTERNS: &[PatternCaps] = &[
    // Claude
    PatternCaps { pattern: "*claude*fable*", vision: true, search: true, reasoning: true, context_window: 1000000, max_output: 128000 },
    PatternCaps { pattern: "*claude*opus-5*", vision: true, search: true, reasoning: true, context_window: 1000000, max_output: 128000 },
    PatternCaps { pattern: "*claude*opus-4.6*", vision: true, search: true, reasoning: true, context_window: 200000, max_output: 64000 },
    PatternCaps { pattern: "*claude*opus-4.7*", vision: true, search: true, reasoning: true, context_window: 200000, max_output: 64000 },
    PatternCaps { pattern: "*claude*opus-4.8*", vision: true, search: true, reasoning: true, context_window: 200000, max_output: 64000 },
    PatternCaps { pattern: "*claude*sonnet-4.6*", vision: true, search: true, reasoning: true, context_window: 200000, max_output: 64000 },
    PatternCaps { pattern: "*claude*sonnet-4.7*", vision: true, search: true, reasoning: true, context_window: 200000, max_output: 64000 },
    PatternCaps { pattern: "*claude*haiku*", vision: true, search: false, reasoning: true, context_window: 200000, max_output: 64000 },
    PatternCaps { pattern: "*claude*opus*", vision: true, search: true, reasoning: true, context_window: 200000, max_output: 64000 },
    PatternCaps { pattern: "*claude*sonnet*", vision: true, search: true, reasoning: true, context_window: 200000, max_output: 64000 },
    PatternCaps { pattern: "*claude-3*", vision: true, search: false, reasoning: false, context_window: 200000, max_output: 64000 },
    PatternCaps { pattern: "*claude*", vision: true, search: true, reasoning: true, context_window: 200000, max_output: 64000 },

    // Gemini
    PatternCaps { pattern: "*gemini*image*", vision: true, search: false, reasoning: false, context_window: 1048576, max_output: 65536 },
    PatternCaps { pattern: "*gemini-3.8*", vision: true, search: true, reasoning: true, context_window: 1048576, max_output: 65536 },
    PatternCaps { pattern: "*gemini-3.7*", vision: true, search: true, reasoning: true, context_window: 1048576, max_output: 65536 },
    PatternCaps { pattern: "*gemini-3*pro*", vision: true, search: true, reasoning: true, context_window: 1048576, max_output: 65535 },
    PatternCaps { pattern: "*gemini-3*", vision: true, search: true, reasoning: true, context_window: 1048576, max_output: 65536 },
    PatternCaps { pattern: "*gemini-2.5*", vision: true, search: true, reasoning: true, context_window: 1048576, max_output: 65536 },
    PatternCaps { pattern: "*gemini-2*", vision: true, search: true, reasoning: false, context_window: 1048576, max_output: 65536 },
    PatternCaps { pattern: "*gemini*", vision: true, search: true, reasoning: false, context_window: 1048576, max_output: 0 },
    PatternCaps { pattern: "*gemma*", vision: true, search: false, reasoning: false, context_window: 128000, max_output: 0 },
    PatternCaps { pattern: "*nanobanana*", vision: true, search: false, reasoning: false, context_window: 0, max_output: 0 },

    // OpenAI GPT
    PatternCaps { pattern: "*gpt-5*image*", vision: false, search: false, reasoning: false, context_window: 0, max_output: 0 },
    PatternCaps { pattern: "*gpt-5*codex*", vision: false, search: true, reasoning: true, context_window: 400000, max_output: 128000 },
    PatternCaps { pattern: "*gpt-5*", vision: true, search: true, reasoning: true, context_window: 400000, max_output: 128000 },
    PatternCaps { pattern: "*gpt-4o*", vision: true, search: true, reasoning: false, context_window: 128000, max_output: 16384 },
    PatternCaps { pattern: "*gpt-4.1*", vision: true, search: false, reasoning: false, context_window: 1000000, max_output: 32768 },
    PatternCaps { pattern: "*gpt-4-turbo*", vision: true, search: false, reasoning: false, context_window: 128000, max_output: 4096 },
    PatternCaps { pattern: "*gpt-4*", vision: false, search: false, reasoning: false, context_window: 128000, max_output: 0 },
    PatternCaps { pattern: "*gpt-3.5*", vision: false, search: false, reasoning: false, context_window: 16385, max_output: 4096 },
    PatternCaps { pattern: "*gpt-oss*", vision: false, search: false, reasoning: true, context_window: 128000, max_output: 0 },

    // OpenAI o-series
    PatternCaps { pattern: "*o1-mini*", vision: false, search: false, reasoning: true, context_window: 128000, max_output: 0 },
    PatternCaps { pattern: "*o1*", vision: true, search: false, reasoning: true, context_window: 200000, max_output: 100000 },
    PatternCaps { pattern: "*o3*", vision: true, search: false, reasoning: true, context_window: 200000, max_output: 100000 },
    PatternCaps { pattern: "*o4*", vision: true, search: false, reasoning: true, context_window: 200000, max_output: 100000 },

    // Grok
    PatternCaps { pattern: "*grok*image*", vision: false, search: false, reasoning: false, context_window: 0, max_output: 0 },
    PatternCaps { pattern: "*grok-code*", vision: false, search: false, reasoning: true, context_window: 256000, max_output: 0 },
    PatternCaps { pattern: "*grok-4.6*", vision: true, search: true, reasoning: true, context_window: 500000, max_output: 500000 },
    PatternCaps { pattern: "*grok-4.5*", vision: true, search: true, reasoning: true, context_window: 500000, max_output: 64000 },
    PatternCaps { pattern: "*grok-4*", vision: true, search: true, reasoning: true, context_window: 256000, max_output: 0 },
    PatternCaps { pattern: "*grok-3*", vision: true, search: true, reasoning: true, context_window: 131072, max_output: 0 },
    PatternCaps { pattern: "*grok*", vision: true, search: true, reasoning: true, context_window: 256000, max_output: 0 },

    // Qwen
    PatternCaps { pattern: "*qwen*vl*", vision: true, search: false, reasoning: true, context_window: 262144, max_output: 0 },
    PatternCaps { pattern: "*qwen*omni*", vision: true, search: false, reasoning: true, context_window: 262144, max_output: 65536 },
    PatternCaps { pattern: "*qwen*coder*", vision: false, search: false, reasoning: true, context_window: 1000000, max_output: 0 },
    PatternCaps { pattern: "*qwen*max*", vision: false, search: false, reasoning: true, context_window: 1000000, max_output: 65536 },
    PatternCaps { pattern: "*qwen3.5*", vision: true, search: false, reasoning: true, context_window: 1000000, max_output: 65536 },
    PatternCaps { pattern: "*qwen3.6*", vision: true, search: false, reasoning: true, context_window: 1000000, max_output: 65536 },
    PatternCaps { pattern: "*qwen3.7*", vision: true, search: false, reasoning: true, context_window: 1000000, max_output: 65536 },
    PatternCaps { pattern: "*qwen*plus*", vision: true, search: false, reasoning: true, context_window: 1000000, max_output: 65536 },
    PatternCaps { pattern: "*qwen*235b*", vision: false, search: false, reasoning: true, context_window: 262144, max_output: 0 },
    PatternCaps { pattern: "*qwq*", vision: false, search: false, reasoning: true, context_window: 131072, max_output: 0 },
    PatternCaps { pattern: "*qwen*", vision: false, search: false, reasoning: true, context_window: 262144, max_output: 0 },

    // Kimi
    PatternCaps { pattern: "*kimi*k3*", vision: true, search: false, reasoning: true, context_window: 1048576, max_output: 131072 },
    PatternCaps { pattern: "*kimi*for-coding*", vision: true, search: false, reasoning: true, context_window: 262144, max_output: 65536 },
    PatternCaps { pattern: "*kimi*k2.7*code*", vision: true, search: false, reasoning: true, context_window: 262144, max_output: 65536 },
    PatternCaps { pattern: "*kimi*k2*", vision: true, search: false, reasoning: true, context_window: 262144, max_output: 262144 },
    PatternCaps { pattern: "*kimi*", vision: false, search: false, reasoning: true, context_window: 262144, max_output: 0 },

    // GLM
    PatternCaps { pattern: "*glm-5.3*", vision: false, search: false, reasoning: true, context_window: 200000, max_output: 128000 },
    PatternCaps { pattern: "*glm-5.2*", vision: false, search: false, reasoning: true, context_window: 200000, max_output: 128000 },
    PatternCaps { pattern: "*glm-5*", vision: false, search: false, reasoning: true, context_window: 200000, max_output: 128000 },
    PatternCaps { pattern: "*glm-4.7*", vision: false, search: false, reasoning: true, context_window: 200000, max_output: 128000 },
    PatternCaps { pattern: "*glm-4*", vision: false, search: false, reasoning: true, context_window: 200000, max_output: 0 },
    PatternCaps { pattern: "*glm*", vision: false, search: false, reasoning: true, context_window: 200000, max_output: 0 },

    // DeepSeek
    PatternCaps { pattern: "*deepseek-v4*", vision: false, search: false, reasoning: true, context_window: 1000000, max_output: 384000 },
    PatternCaps { pattern: "*reasoner*", vision: false, search: false, reasoning: true, context_window: 128000, max_output: 0 },
    PatternCaps { pattern: "*deepseek-r*", vision: false, search: false, reasoning: true, context_window: 128000, max_output: 0 },
    PatternCaps { pattern: "*deepseek-chat*", vision: false, search: false, reasoning: false, context_window: 128000, max_output: 0 },
    PatternCaps { pattern: "*deepseek*", vision: false, search: false, reasoning: true, context_window: 128000, max_output: 0 },

    // MiniMax
    PatternCaps { pattern: "*minimax*image*", vision: false, search: false, reasoning: false, context_window: 0, max_output: 0 },
    PatternCaps { pattern: "*minimax-m3*", vision: true, search: false, reasoning: true, context_window: 1048576, max_output: 512000 },
    PatternCaps { pattern: "*minimax-m2.7*", vision: false, search: false, reasoning: true, context_window: 204800, max_output: 131072 },
    PatternCaps { pattern: "*minimax*", vision: false, search: false, reasoning: true, context_window: 200000, max_output: 131072 },

    // Xiaomi MiMo
    PatternCaps { pattern: "*mimo*v2.5*", vision: true, search: false, reasoning: false, context_window: 1048576, max_output: 131072 },
    PatternCaps { pattern: "*mimo*omni*", vision: true, search: false, reasoning: false, context_window: 262144, max_output: 131072 },
    PatternCaps { pattern: "*mimo*", vision: true, search: false, reasoning: false, context_window: 262144, max_output: 131072 },

    // Llama
    PatternCaps { pattern: "*llama-4*", vision: true, search: false, reasoning: false, context_window: 1000000, max_output: 0 },
    PatternCaps { pattern: "*llama*", vision: false, search: false, reasoning: false, context_window: 128000, max_output: 0 },

    // Mistral
    PatternCaps { pattern: "*codestral*", vision: false, search: false, reasoning: false, context_window: 256000, max_output: 0 },
    PatternCaps { pattern: "*mistral-large*", vision: true, search: false, reasoning: false, context_window: 256000, max_output: 0 },
    PatternCaps { pattern: "*mistral*", vision: false, search: false, reasoning: false, context_window: 128000, max_output: 0 },

    // Cohere
    PatternCaps { pattern: "*command-a-vision*", vision: true, search: false, reasoning: false, context_window: 128000, max_output: 0 },
    PatternCaps { pattern: "*command*", vision: false, search: false, reasoning: false, context_window: 128000, max_output: 0 },

    // Perplexity
    PatternCaps { pattern: "*sonar*", vision: false, search: true, reasoning: false, context_window: 128000, max_output: 0 },
    PatternCaps { pattern: "*pplx*", vision: false, search: true, reasoning: false, context_window: 128000, max_output: 0 },
    PatternCaps { pattern: "*perplexity*", vision: false, search: true, reasoning: false, context_window: 128000, max_output: 0 },

    // Poolside Laguna
    PatternCaps { pattern: "*laguna-s-2.1*free*", vision: false, search: false, reasoning: true, context_window: 200000, max_output: 32000 },
    PatternCaps { pattern: "*laguna-s-2.1*", vision: false, search: false, reasoning: true, context_window: 1000000, max_output: 32000 },
    PatternCaps { pattern: "*laguna*", vision: false, search: false, reasoning: true, context_window: 200000, max_output: 32000 },

    // Muse Spark
    PatternCaps { pattern: "*muse*spark*", vision: true, search: false, reasoning: true, context_window: 1048576, max_output: 131072 },

    // Others
    PatternCaps { pattern: "*hunyuan*", vision: false, search: false, reasoning: true, context_window: 262144, max_output: 262144 },
    PatternCaps { pattern: "hy3*", vision: false, search: false, reasoning: true, context_window: 262144, max_output: 262144 },
    PatternCaps { pattern: "*step-*", vision: false, search: false, reasoning: true, context_window: 128000, max_output: 0 },
    PatternCaps { pattern: "*nemotron*", vision: false, search: false, reasoning: true, context_window: 128000, max_output: 0 },
    PatternCaps { pattern: "*ling-*", vision: false, search: false, reasoning: true, context_window: 128000, max_output: 0 },
];
