//! Provider config — ported from src/shared/constants/providers.js and
//! src/lib/providerNormalization.js.
//! Contains provider ID normalization and compatible/embedding classification.

use super::lists;

/// Prefix for OpenAI-compatible provider IDs.
pub const OPENAI_COMPATIBLE_PREFIX: &str = "openai-compatible-";
/// Prefix for Anthropic-compatible provider IDs.
pub const ANTHROPIC_COMPATIBLE_PREFIX: &str = "anthropic-compatible-";
/// Prefix for custom embedding provider IDs.
pub const CUSTOM_EMBEDDING_PREFIX: &str = "custom-embedding-";

/// Check if a provider ID is an OpenAI-compatible provider.
pub fn is_openai_compatible_provider(provider_id: &str) -> bool {
    provider_id.starts_with(OPENAI_COMPATIBLE_PREFIX)
}

/// Check if a provider ID is an Anthropic-compatible provider.
pub fn is_anthropic_compatible_provider(provider_id: &str) -> bool {
    provider_id.starts_with(ANTHROPIC_COMPATIBLE_PREFIX)
}

/// Check if a provider ID is a custom embedding provider.
pub fn is_custom_embedding_provider(provider_id: &str) -> bool {
    provider_id.starts_with(CUSTOM_EMBEDDING_PREFIX)
}

/// Provider alias → ID mapping.
/// Ported from the registry's alias field (uiAlias || alias).
/// For Phase 1, we store the static mapping. Phase 3 will use a dynamic registry.
pub fn alias_to_id(alias: &str) -> Option<&'static str> {
    ALIAS_TO_ID.iter().find(|(a, _)| *a == alias).map(|(_, id)| *id)
}

/// Provider ID → alias mapping.
pub fn id_to_alias(id: &str) -> Option<&'static str> {
    ID_TO_ALIAS.iter().find(|(i, _)| *i == id).map(|(_, alias)| *alias)
}

/// Get the display name for a provider ID.
pub fn get_provider_name(id: &str) -> Option<&'static str> {
    ID_TO_NAME.iter().find(|(i, _)| *i == id).map(|(_, name)| *name)
}

/// Normalize a provider ID: try direct match, then slug, then alias lookup.
/// Ported from src/lib/providerNormalization.js normalizeProviderId.
pub fn normalize_provider_id(provider: &str) -> String {
    let trimmed = provider.trim();

    // Direct match in any provider list
    if lists::is_apikey_provider(trimmed)
        || lists::is_free_tier_provider(trimmed)
        || lists::is_web_cookie_provider(trimmed)
        || lists::is_free_provider(trimmed)
        || lists::is_oauth_provider(trimmed)
    {
        return trimmed.to_string();
    }

    // Compatible/embedding prefix providers pass through
    if is_openai_compatible_provider(trimmed)
        || is_anthropic_compatible_provider(trimmed)
        || is_custom_embedding_provider(trimmed)
    {
        return trimmed.to_string();
    }

    // Try slug: lowercase, replace non-alphanumeric with dashes, trim leading/trailing dashes
    let slug: String = trimmed
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string();

    if lists::is_apikey_provider(&slug)
        || lists::is_free_tier_provider(&slug)
        || lists::is_web_cookie_provider(&slug)
        || lists::is_free_provider(&slug)
        || lists::is_oauth_provider(&slug)
    {
        return slug;
    }

    // Try alias lookup
    if let Some(id) = alias_to_id(trimmed) {
        return id.to_string();
    }

    // Try alias lookup with slug
    if let Some(id) = alias_to_id(&slug) {
        return id.to_string();
    }

    // No match — return trimmed original (compatible/embedding nodes are dynamic)
    trimmed.to_string()
}

/// Static alias→ID mapping table (from registry entries).
/// Format: (alias, id)
static ALIAS_TO_ID: &[(&str, &str)] = &[
    ("alicode-intl", "alicode-intl"),
    ("alicode", "alicode"),
    ("alims-intl", "alims-intl"),
    ("alitp-intl", "alitp-intl"),
    ("anthropic", "anthropic"),
    ("ag", "antigravity"),
    ("af", "api-airforce"),
    ("aai", "assemblyai"),
    ("polly", "aws-polly"),
    ("azure", "azure"),
    ("qianfan", "baidu"),
    ("bzl", "bazaarlink"),
    ("bfl", "black-forest-labs"),
    ("bb", "blackbox"),
    ("bm", "bluesminds"),
    ("brave", "brave-search"),
    ("bpm", "byteplus"),
    ("cartesia", "cartesia"),
    ("cerebras", "cerebras"),
    ("ch", "chutes"),
    ("cc", "claude"),
    ("cl", "cline"),
    ("clinepass", "clinepass"),
    ("cf", "cloudflare-ai"),
    ("cbcn", "codebuddy-cn"),
    ("cbai", "codebuddy-intl"),
    ("cx", "codex"),
    ("cohere", "cohere"),
    ("comfyui", "comfyui"),
    ("cmc", "commandcode"),
    ("coqui", "coqui"),
    ("cu", "cursor"),
    ("dg", "deepgram"),
    ("ds", "deepseek"),
    ("dv", "devin-cli"),
    ("edge-tts", "edge-tts"),
    ("el", "elevenlabs"),
    ("exa", "exa"),
    ("fal", "fal-ai"),
    ("fl", "featherless"),
    ("firecrawl", "firecrawl"),
    ("fireworks", "fireworks"),
    ("fish", "fish-audio"),
    ("gc", "gemini-cli"),
    ("gemini", "gemini"),
    ("gh", "github"),
    ("glm-cn", "glm-cn"),
    ("glm", "glm"),
    ("gpse", "google-pse"),
    ("google-tts", "google-tts"),
    ("gcli", "grok-cli"),
    ("gw", "grok-web"),
    ("groq", "groq"),
    ("hf", "huggingface"),
    ("hyp", "hyperbolic"),
    ("if", "iflow"),
    ("inworld", "inworld"),
    ("jina", "jina-ai"),
    ("jina-reader", "jina-reader"),
    ("kgw", "kilo-gateway"),
    ("kc", "kilocode"),
    ("kimchi", "kimchi"),
    ("kimi", "kimi"),
    ("kr", "kiro"),
    ("linkup", "linkup"),
    ("llm7", "llm7"),
    ("local-device", "local-device"),
    ("mmf", "mimo-free"),
    ("minimax-cn", "minimax-cn"),
    ("minimax", "minimax"),
    ("mistral", "mistral"),
    ("morph", "morph"),
    ("nb", "nanobanana"),
    ("nebius", "nebius"),
    ("nvidia", "nvidia"),
    ("ollama-local", "ollama-local"),
    ("ollama-search", "ollama-search"),
    ("ollama", "ollama"),
    ("openai", "openai"),
    ("ocg", "opencode-go"),
    ("oc", "opencode"),
    ("openrouter", "openrouter"),
    ("pa", "perplexity-agent"),
    ("pw", "perplexity-web"),
    ("pplx", "perplexity"),
    ("playht", "playht"),
    ("ps", "poolside"),
    ("qd", "qoder"),
    ("recraft", "recraft"),
    ("runway", "runwayml"),
    ("samba", "sambanova"),
    ("sdwebui", "sdwebui"),
    ("searchapi", "searchapi"),
    ("searxng", "searxng"),
    ("selfhosted-embedding", "selfhosted-embedding"),
    ("selfhosted-stt", "selfhosted-stt"),
    ("selfhosted-tts", "selfhosted-tts"),
    ("serper", "serper"),
    ("siliconflow", "siliconflow"),
    ("stability", "stability-ai"),
    ("tavily", "tavily"),
    ("hunyuan", "tencent"),
    ("together", "together"),
    ("tokenrouter", "tokenrouter"),
    ("topaz", "topaz"),
    ("tortoise", "tortoise"),
    ("tr", "trae"),
    ("venice", "venice"),
    ("vercel", "vercel-ai-gateway"),
    ("vxp", "vertex-partner"),
    ("vx", "vertex"),
    ("ark", "volcengine-ark"),
    ("voyage", "voyage-ai"),
    ("ws", "windsurf"),
    ("xai", "xai"),
    ("mimo", "xiaomi-mimo"),
    ("xmtp", "xiaomi-tokenplan"),
    ("xquik", "xquik"),
    ("youcom", "youcom"),
    ("zd", "zed"),
];

/// Static ID→alias mapping table.
/// Generated from the same data as ALIAS_TO_ID.
static ID_TO_ALIAS: &[(&str, &str)] = &[
    ("alicode-intl", "alicode-intl"),
    ("alicode", "alicode"),
    ("alims-intl", "alims-intl"),
    ("alitp-intl", "alitp-intl"),
    ("anthropic", "anthropic"),
    ("antigravity", "ag"),
    ("api-airforce", "af"),
    ("assemblyai", "aai"),
    ("aws-polly", "polly"),
    ("azure", "azure"),
    ("baidu", "qianfan"),
    ("bazaarlink", "bzl"),
    ("black-forest-labs", "bfl"),
    ("blackbox", "bb"),
    ("bluesminds", "bm"),
    ("brave-search", "brave"),
    ("byteplus", "bpm"),
    ("cartesia", "cartesia"),
    ("cerebras", "cerebras"),
    ("chutes", "ch"),
    ("claude", "cc"),
    ("cline", "cl"),
    ("clinepass", "clinepass"),
    ("cloudflare-ai", "cf"),
    ("codebuddy-cn", "cbcn"),
    ("codebuddy-intl", "cbai"),
    ("codex", "cx"),
    ("cohere", "cohere"),
    ("comfyui", "comfyui"),
    ("commandcode", "cmc"),
    ("coqui", "coqui"),
    ("cursor", "cu"),
    ("deepgram", "dg"),
    ("deepseek", "ds"),
    ("devin-cli", "dv"),
    ("edge-tts", "edge-tts"),
    ("elevenlabs", "el"),
    ("exa", "exa"),
    ("fal-ai", "fal"),
    ("featherless", "fl"),
    ("firecrawl", "firecrawl"),
    ("fireworks", "fireworks"),
    ("fish-audio", "fish"),
    ("gemini-cli", "gc"),
    ("gemini", "gemini"),
    ("github", "gh"),
    ("glm-cn", "glm-cn"),
    ("glm", "glm"),
    ("google-pse", "gpse"),
    ("google-tts", "google-tts"),
    ("grok-cli", "gcli"),
    ("grok-web", "gw"),
    ("groq", "groq"),
    ("huggingface", "hf"),
    ("hyperbolic", "hyp"),
    ("iflow", "if"),
    ("inworld", "inworld"),
    ("jina-ai", "jina"),
    ("jina-reader", "jina-reader"),
    ("kilo-gateway", "kgw"),
    ("kilocode", "kc"),
    ("kimchi", "kimchi"),
    ("kimi", "kimi"),
    ("kiro", "kr"),
    ("linkup", "linkup"),
    ("llm7", "llm7"),
    ("local-device", "local-device"),
    ("mimo-free", "mmf"),
    ("minimax-cn", "minimax-cn"),
    ("minimax", "minimax"),
    ("mistral", "mistral"),
    ("morph", "morph"),
    ("nanobanana", "nb"),
    ("nebius", "nebius"),
    ("nvidia", "nvidia"),
    ("ollama-local", "ollama-local"),
    ("ollama-search", "ollama-search"),
    ("ollama", "ollama"),
    ("openai", "openai"),
    ("opencode-go", "ocg"),
    ("opencode", "oc"),
    ("openrouter", "openrouter"),
    ("perplexity-agent", "pa"),
    ("perplexity-web", "pw"),
    ("perplexity", "pplx"),
    ("playht", "playht"),
    ("poolside", "ps"),
    ("qoder", "qd"),
    ("recraft", "recraft"),
    ("runwayml", "runway"),
    ("sambanova", "samba"),
    ("sdwebui", "sdwebui"),
    ("searchapi", "searchapi"),
    ("searxng", "searxng"),
    ("selfhosted-embedding", "selfhosted-embedding"),
    ("selfhosted-stt", "selfhosted-stt"),
    ("selfhosted-tts", "selfhosted-tts"),
    ("serper", "serper"),
    ("siliconflow", "siliconflow"),
    ("stability-ai", "stability"),
    ("tavily", "tavily"),
    ("tencent", "hunyuan"),
    ("together", "together"),
    ("tokenrouter", "tokenrouter"),
    ("topaz", "topaz"),
    ("tortoise", "tortoise"),
    ("trae", "tr"),
    ("venice", "venice"),
    ("vercel-ai-gateway", "vercel"),
    ("vertex-partner", "vxp"),
    ("vertex", "vx"),
    ("volcengine-ark", "ark"),
    ("voyage-ai", "voyage"),
    ("windsurf", "ws"),
    ("xai", "xai"),
    ("xiaomi-mimo", "mimo"),
    ("xiaomi-tokenplan", "xmtp"),
    ("xquik", "xquik"),
    ("youcom", "youcom"),
    ("zed", "zd"),
];

/// Static ID→display name mapping.
static ID_TO_NAME: &[(&str, &str)] = &[
    ("alicode-intl", "Alibaba Coding"),
    ("alicode", "Alibaba"),
    ("alims-intl", "Alibaba Studio"),
    ("alitp-intl", "Alibaba Token Plan"),
    ("anthropic", "Anthropic"),
    ("antigravity", "Antigravity"),
    ("api-airforce", "API.airforce"),
    ("assemblyai", "AssemblyAI"),
    ("aws-polly", "AWS Polly"),
    ("azure", "Azure OpenAI"),
    ("baidu", "Baidu Qianfan"),
    ("bazaarlink", "Bazaarlink"),
    ("black-forest-labs", "Black Forest Labs"),
    ("blackbox", "Blackbox AI"),
    ("bluesminds", "BluesMinds"),
    ("brave-search", "Brave Search"),
    ("byteplus", "BytePlus ModelArk"),
    ("cartesia", "Cartesia"),
    ("cerebras", "Cerebras"),
    ("chutes", "Chutes AI"),
    ("claude", "Claude Code"),
    ("cline", "Cline"),
    ("clinepass", "ClinePass"),
    ("cloudflare-ai", "Cloudflare"),
    ("codebuddy-cn", "CodeBuddy CN"),
    ("codebuddy-intl", "CodeBuddy"),
    ("codex", "OpenAI Codex"),
    ("cohere", "Cohere"),
    ("comfyui", "ComfyUI"),
    ("commandcode", "Command Code"),
    ("coqui", "Coqui TTS"),
    ("cursor", "Cursor IDE"),
    ("deepgram", "Deepgram"),
    ("deepseek", "DeepSeek"),
    ("devin-cli", "Devin CLI"),
    ("edge-tts", "Edge TTS"),
    ("elevenlabs", "ElevenLabs"),
    ("exa", "Exa"),
    ("fal-ai", "Fal.ai"),
    ("featherless", "Featherless"),
    ("firecrawl", "Firecrawl"),
    ("fireworks", "Fireworks AI"),
    ("fish-audio", "Fish Audio"),
    ("gemini-cli", "Gemini CLI"),
    ("gemini", "Gemini"),
    ("github", "GitHub Copilot"),
    ("gitlab", "GitLab Duo"),
    ("glm-cn", "GLM (China)"),
    ("glm", "GLM Coding"),
    ("google-pse", "Google PSE"),
    ("google-tts", "Google TTS"),
    ("grok-cli", "Grok CLI (Grok Build)"),
    ("grok-web", "Grok Web (Subscription)"),
    ("groq", "Groq"),
    ("huggingface", "HuggingFace"),
    ("hyperbolic", "Hyperbolic"),
    ("iflow", "iFlow AI"),
    ("inworld", "Inworld TTS"),
    ("jina-ai", "Jina AI"),
    ("jina-reader", "Jina Reader"),
    ("kilo-gateway", "Kilo Gateway"),
    ("kilocode", "Kilo Code"),
    ("kimchi", "Kimchi"),
    ("kimi", "Kimi"),
    ("kiro", "Kiro AI"),
    ("linkup", "Linkup"),
    ("llm7", "LLM7"),
    ("local-device", "Local Device"),
    ("mimo-free", "MiMo Code Free"),
    ("minimax-cn", "Minimax (China)"),
    ("minimax", "Minimax Coding"),
    ("mistral", "Mistral"),
    ("mmf", "MMF"),
    ("morph", "Morph"),
    ("nanobanana", "NanoBanana API"),
    ("nebius", "Nebius AI"),
    ("nvidia", "NVIDIA NIM"),
    ("ollama-local", "Ollama Local"),
    ("ollama-search", "Ollama Search"),
    ("ollama", "Ollama Cloud"),
    ("openai", "OpenAI"),
    ("opencode-go", "OpenCode Go"),
    ("opencode", "OpenCode Free"),
    ("openrouter", "OpenRouter"),
    ("perplexity-agent", "Perplexity Agent"),
    ("perplexity-web", "Perplexity Web (Pro/Max)"),
    ("perplexity", "Perplexity"),
    ("playht", "PlayHT"),
    ("poolside", "Poolside"),
    ("qoder", "Qoder"),
    ("recraft", "Recraft"),
    ("runwayml", "Runway ML"),
    ("sambanova", "SambaNova"),
    ("sdwebui", "SD WebUI"),
    ("searchapi", "SearchAPI"),
    ("searxng", "SearXNG"),
    ("selfhosted-embedding", "Self-hosted Embedding"),
    ("selfhosted-stt", "Self-hosted STT"),
    ("selfhosted-tts", "Self-hosted TTS"),
    ("serper", "Serper"),
    ("siliconflow", "SiliconFlow"),
    ("stability-ai", "Stability AI"),
    ("tavily", "Tavily"),
    ("tencent", "Tencent Hunyuan"),
    ("together", "Together AI"),
    ("tokenrouter", "TokenRouter"),
    ("topaz", "Topaz"),
    ("tortoise", "Tortoise TTS"),
    ("trae", "Trae"),
    ("venice", "Venice AI"),
    ("vercel-ai-gateway", "Vercel AI Gateway"),
    ("vertex-partner", "Vertex Partner"),
    ("vertex", "Vertex AI"),
    ("volcengine-ark", "Volcengine Ark"),
    ("voyage-ai", "Voyage AI"),
    ("windsurf", "Windsurf"),
    ("xai", "xAI (Grok)"),
    ("xiaomi-mimo", "Xiaomi MiMo"),
    ("xiaomi-tokenplan", "Xiaomi MiMo (Token Plan)"),
    ("xquik", "Xquik"),
    ("youcom", "You.com Search"),
    ("zed", "Zed"),
];
