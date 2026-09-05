//! Provider lists — ported from src/shared/constants/providers.js.
//! Snapshot of the registry categories (Phase 1).
//! Phase 3 will port the full dynamic registry.

/// Providers in the "apikey" category — accept an API key for auth.
pub const APIKEY_PROVIDERS: &[&str] = &[
    "alicode-intl",
    "alicode",
    "alims-intl",
    "alitp-intl",
    "anthropic",
    "assemblyai",
    "aws-polly",
    "azure",
    "black-forest-labs",
    "blackbox",
    "brave-search",
    "cartesia",
    "cerebras",
    "chutes",
    "cohere",
    "comfyui",
    "commandcode",
    "deepgram",
    "deepseek",
    "elevenlabs",
    "exa",
    "fal-ai",
    "featherless",
    "firecrawl",
    "fireworks",
    "fish-audio",
    "glm-cn",
    "glm",
    "google-pse",
    "google-tts",
    "groq",
    "huggingface",
    "hyperbolic",
    "inworld",
    "jina-ai",
    "jina-reader",
    "linkup",
    "llm7",
    "minimax-cn",
    "minimax",
    "mistral",
    "mmf",
    "nanobanana",
    "nebius",
    "ollama-local",
    "ollama-search",
    "openai",
    "opencode-go",
    "perplexity-agent",
    "perplexity",
    "playht",
    "recraft",
    "runwayml",
    "sdwebui",
    "searchapi",
    "selfhosted-embedding",
    "selfhosted-stt",
    "selfhosted-tts",
    "serper",
    "siliconflow",
    "stability-ai",
    "tavily",
    "together",
    "tokenrouter",
    "topaz",
    "venice",
    "vercel-ai-gateway",
    "vertex-partner",
    "volcengine-ark",
    "voyage-ai",
    "xiaomi-mimo",
    "xiaomi-tokenplan",
    "xquik",
    "youcom",
];

/// Providers in the "freeTier" category — free tier with optional API key.
pub const FREE_TIER_PROVIDERS: &[&str] = &[
    "api-airforce",
    "bazaarlink",
    "byteplus",
    "cloudflare-ai",
    "coqui",
    "edge-tts",
    "gemini",
    "google-tts",
    "kilo-gateway",
    "kimchi",
    "local-device",
    "nvidia",
    "ollama",
    "openrouter",
    "poolside",
    "searxng",
    "tortoise",
    "vertex",
];

/// Providers in the "webCookie" category — use browser session cookie.
pub const WEB_COOKIE_PROVIDERS: &[&str] = &[
    "grok-web",
    "perplexity-web",
];

/// Providers in the "free" category — no auth required.
pub const FREE_PROVIDERS: &[&str] = &[
    "devin-cli",
    "gemini-cli",
    "kiro",
    "mimo-free",
    "opencode",
];

/// Providers in the "oauth" category — use OAuth flow.
pub const OAUTH_PROVIDERS: &[&str] = &[
    "antigravity",
    "claude",
    "cline",
    "clinepass",
    "codebuddy-cn",
    "codebuddy-intl",
    "codex",
    "cursor",
    "github",
    "gitlab",
    "grok-cli",
    "iflow",
    "kilocode",
    "kimi",
    "perplexity-agent",
    "qoder",
    "trae",
    "windsurf",
    "xai",
    "zed",
];

/// Provider IDs that have authModes including "apikey" (dual-auth providers).
/// These are OAuth-category providers that also accept API keys.
pub const DUAL_AUTH_APIKEY_PROVIDERS: &[&str] = &[
    "baidu",
    "bazaarlink",
    "bluesminds",
    "clinepass",
    "cloudflare-ai",
    "codebuddy-cn",
    "codebuddy-intl",
    "gemini",
    "kilo-gateway",
    "kimchi",
    "kimi",
    "morph",
    "nvidia",
    "ollama",
    "ollama-search",
    "openrouter",
    "poolside",
    "qoder",
    "sambanova",
    "tencent",
    "windsurf",
];

/// Check if a provider id is in the APIKEY_PROVIDERS list.
pub fn is_apikey_provider(id: &str) -> bool {
    APIKEY_PROVIDERS.contains(&id)
}

/// Check if a provider id is in the FREE_TIER_PROVIDERS list.
pub fn is_free_tier_provider(id: &str) -> bool {
    FREE_TIER_PROVIDERS.contains(&id)
}

/// Check if a provider id is in the WEB_COOKIE_PROVIDERS list.
pub fn is_web_cookie_provider(id: &str) -> bool {
    WEB_COOKIE_PROVIDERS.contains(&id)
}

/// Check if a provider id is in the FREE_PROVIDERS list.
pub fn is_free_provider(id: &str) -> bool {
    FREE_PROVIDERS.contains(&id)
}

/// Check if a provider id is in the OAUTH_PROVIDERS list.
pub fn is_oauth_provider(id: &str) -> bool {
    OAUTH_PROVIDERS.contains(&id)
}

/// Check if a provider supports apikey mode (either in APIKEY_PROVIDERS
/// or in the dual-auth list).
pub fn has_apikey_auth_mode(id: &str) -> bool {
    is_apikey_provider(id) || DUAL_AUTH_APIKEY_PROVIDERS.contains(&id)
}
