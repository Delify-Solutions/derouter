//! Web-cookie category providers (2 entries).
//! Ported from open-sse/providers/registry/grok-web.js, perplexity-web.js

use super::*;

pub static ENTRIES: &[ProviderRegistryEntry] = &[
    ProviderRegistryEntry {
        id: "grok-web",
        priority: 150,
        alias: "grok-web",
        ui_alias: Some("gw"),
        display: ProviderDisplay {
            name: "Grok Web (Subscription)",
            icon: Some("auto_awesome"),
            color: Some("#1DA1F2"),
            text_icon: Some("GW"),
            website: Some("https://grok.com"),
            notice: None,
        },
        category: ProviderCategory::WebCookie,
        transport: ProviderTransport {
            base_url: Some("https://grok.com/rest/app-chat/conversations/new"),
            format: Some("grok-web"),
            auth: None,
            force_stream: None,
            ..DEFAULT_TRANSPORT
        },
        models: &[
            ProviderModel { id: "grok-3", name: "Grok 3", kind: None },
            ProviderModel { id: "grok-3-mini", name: "Grok 3 Mini (Thinking)", kind: None },
            ProviderModel { id: "grok-3-thinking", name: "Grok 3 Thinking", kind: None },
            ProviderModel { id: "grok-4", name: "Grok 4", kind: None },
            ProviderModel { id: "grok-4-mini", name: "Grok 4 Mini (Thinking)", kind: None },
            ProviderModel { id: "grok-4-thinking", name: "Grok 4 Thinking", kind: None },
            ProviderModel { id: "grok-4-heavy", name: "Grok 4 Heavy (SuperGrok)", kind: None },
            ProviderModel { id: "grok-4.1-mini", name: "Grok 4.1 Mini (Thinking)", kind: None },
            ProviderModel { id: "grok-4.1-fast", name: "Grok 4.1 Fast", kind: None },
            ProviderModel { id: "grok-4.1-expert", name: "Grok 4.1 Expert", kind: None },
            ProviderModel { id: "grok-4.1-thinking", name: "Grok 4.1 Thinking", kind: None },
            ProviderModel { id: "grok-4.2", name: "Grok 4.2 (4.20 Beta)", kind: None },
        ],
        service_kinds: &[],
        hidden: false,
    },
    ProviderRegistryEntry {
        id: "perplexity-web",
        priority: 220,
        alias: "perplexity-web",
        ui_alias: Some("pw"),
        display: ProviderDisplay {
            name: "Perplexity Web (Pro/Max)",
            icon: Some("search"),
            color: Some("#20808D"),
            text_icon: Some("PW"),
            website: Some("https://www.perplexity.ai"),
            notice: None,
        },
        category: ProviderCategory::WebCookie,
        transport: ProviderTransport {
            base_url: Some("https://www.perplexity.ai/rest/sse/perplexity_ask"),
            format: Some("perplexity-web"),
            auth: None,
            force_stream: None,
            ..DEFAULT_TRANSPORT
        },
        models: &[
            ProviderModel { id: "pplx-auto", name: "Perplexity Auto (Free)", kind: None },
            ProviderModel { id: "pplx-sonar", name: "Perplexity Sonar", kind: None },
            ProviderModel { id: "pplx-gpt", name: "GPT-5.4 (via Perplexity)", kind: None },
            ProviderModel { id: "pplx-gemini", name: "Gemini 3.1 Pro (via Perplexity)", kind: None },
            ProviderModel { id: "pplx-sonnet", name: "Claude Sonnet 4.6 (via Perplexity)", kind: None },
            ProviderModel { id: "pplx-opus", name: "Claude Opus 4.6 (via Perplexity)", kind: None },
            ProviderModel { id: "pplx-nemotron", name: "Nemotron 3 Super (via Perplexity)", kind: None },
        ],
        service_kinds: &[],
        hidden: false,
    },
];
