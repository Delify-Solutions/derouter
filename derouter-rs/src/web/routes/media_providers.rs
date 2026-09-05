//! Media providers TTS voice routes — JSON API.
//! Ported from src/app/api/media-providers/tts/voices/route.js and per-provider routes.
//! GET /api/media-providers/tts/voices?provider=edge-tts|local-device|elevenlabs|gemini[&lang=...][&apiKey=...]
//! GET /api/media-providers/tts/{provider}/voices[?lang=...]
//!
//! Providers:
//!   edge-tts: fetches voice list from Bing consumer endpoint (no auth)
//!   elevenlabs: fetches from elevenlabs API (key from query param or DB connection)
//!   gemini: returns static prebuilt voice list
//!   deepgram: fetches model list from deepgram API (key from DB)
//!   inworld: fetches from inworld API (key from DB)
//!   minimax: fetches from minimax API (key from DB)
//!   local-device: system TTS voices — deferred to Phase 4 (platform-dependent)

use std::collections::BTreeMap;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::auth;
use crate::db::DbPool;
use crate::db::repos::connections::{ConnectionFilter, get_provider_connections};

/// Edge TTS voice list URL (public, no auth).
const EDGE_TTS_VOICES_URL: &str =
    "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4";

/// Static Gemini prebuilt voices (mirrors open-sse/handlers/ttsProviders/gemini.js).
static GEMINI_VOICES: &[(&str, &str, &str)] = &[
    ("Achernar", "en", "Female"),
    ("Achird", "en", "Female"),
    ("Algenib", "en", "Male"),
    ("Alhena", "en", "Female"),
    ("Alnilam", "en", "Female"),
    ("Aoede", "en", "Female"),
    ("Autonoe", "en", "Female"),
    ("Ballad", "en", "Male"),
    ("Bella", "en", "Female"),
    ("Bulbul", "en", "Female"),
    ("Charon", "en", "Male"),
    ("Charm", "en", "Female"),
    ("Despina", "en", "Female"),
]; // truncated static; Phase 4 will fetch full list

/// GET /api/media-providers/tts/voices — aggregated voice listing.
/// Query: ?provider=edge-tts|local-device|elevenlabs|gemini&lang=xx&apiKey=xxx
pub async fn voices(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let provider = params.get("provider").map(|s| s.as_str()).unwrap_or("edge-tts");
    let lang_filter = params.get("lang").map(|s| s.as_str());
    let api_key = params.get("apiKey").map(|s| s.as_str()).unwrap_or("");

    match provider {
        "edge-tts" => edge_tts_voices(lang_filter).await,
        "elevenlabs" => elevenlabs_voices_aggregated(pool, api_key, lang_filter).await,
        "gemini" => gemini_voices(lang_filter),
        "local-device" => {
            // TODO Phase4: local-device TTS voice enumeration requires platform-specific system calls
            // (say/macos or SAPI/Windows). Defer with a graceful empty list.
            tracing::warn!("local-device TTS voices not yet ported (Phase 4)");
            Json(serde_json::json!({
                "voices": [],
                "languages": [],
                "byLang": {},
                "error": "local-device voices not yet ported (Phase 4)"
            })).into_response()
        }
        _ => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": format!("Provider '{}' does not support voice listing", provider)})),
        )
            .into_response(),
    }
}

/// GET /api/media-providers/tts/{provider}/voices — per-provider voice listing.
/// Supports: elevenlabs, deepgram, inworld, minimax (all need DB connection API keys).
pub async fn provider_voices(
    State(pool): State<DbPool>,
    headers: axum::http::HeaderMap,
    Path(provider): Path<String>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if let Err(resp) = auth::require_auth(&headers) {
        return resp;
    }

    let lang_filter = params.get("lang").map(|s| s.as_str());

    match provider.as_str() {
        "elevenlabs" => elevenlabs_voices_from_db(pool, lang_filter).await,
        "deepgram" => deepgram_voices(pool, lang_filter).await,
        "inworld" => inworld_voices(pool, lang_filter).await,
        "minimax" | "minimax-cn" => minimax_voices(pool, &provider, lang_filter, params.get("voice_type").map(|s| s.as_str()).unwrap_or("all")).await,
        _ => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": format!("Unknown TTS provider: {}", provider)})),
        )
            .into_response(),
    }
}

// ===== Edge TTS =====

async fn edge_tts_voices(lang_filter: Option<&str>) -> Response {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Mozilla/5.0")
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": format!("Failed to create HTTP client: {}", e)})),
            )
                .into_response();
        }
    };

    let res = match client.get(EDGE_TTS_VOICES_URL).send().await {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({"error": format!("Edge TTS voices fetch failed: {}", e)})),
            )
                .into_response();
        }
    };

    if !res.status().is_success() {
        let status = res.status().as_u16();
        return (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({"error": format!("Edge TTS voices fetch failed: {}", status)})),
        )
            .into_response();
    }

    let voices_raw: Vec<serde_json::Value> = match res.json().await {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({"error": format!("Failed to parse Edge TTS response: {}", e)})),
            )
                .into_response();
        }
    };

    // Normalize edge-tts voices (same logic as Node route)
    let mut voices: Vec<serde_json::Value> = Vec::new();
    for v in &voices_raw {
        let short_name = v.get("ShortName").and_then(|x| x.as_str()).unwrap_or("");
        let friendly = v.get("FriendlyName").and_then(|x| x.as_str()).unwrap_or(short_name);
        let locale = v.get("Locale").and_then(|x| x.as_str()).unwrap_or("");
        let gender = v.get("Gender").and_then(|x| x.as_str()).unwrap_or("");

        let name = friendly
            .replace("Microsoft ", "")
            .replace(" Online (Natural) - ", " (");

        let parts: Vec<&str> = locale.split('-').collect();
        let lang = parts.first().copied().unwrap_or("").to_string();
        let country = parts.get(1).copied().unwrap_or("").to_string();

        let lang_name = lang_name(&lang);
        let country_name = if country.is_empty() {
            lang_name.clone()
        } else {
            region_name(&country).unwrap_or_else(|| country.clone())
        };

        let voice = serde_json::json!({
            "id": short_name,
            "name": name,
            "locale": locale,
            "lang": lang,
            "country": country,
            "countryName": country_name,
            "langName": lang_name,
            "gender": gender,
        });
        voices.push(voice);
    }

    // Apply lang filter
    if let Some(lf) = lang_filter {
        voices.retain(|v| v.get("lang").and_then(|x| x.as_str()) == Some(lf));
    }

    // Group by language
    let (languages, by_lang) = group_by_lang(&voices);

    Json(serde_json::json!({"voices": voices, "languages": languages, "byLang": by_lang})).into_response()
}

// ===== ElevenLabs (aggregated, key from query or DB) =====

async fn elevenlabs_voices_aggregated(
    pool: DbPool,
    api_key: &str,
    lang_filter: Option<&str>,
) -> Response {
    // If no apiKey in query, try DB
    let key = if api_key.is_empty() {
        match get_api_key_from_db(pool, "elevenlabs").await {
            Some(k) => k,
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"error": "No ElevenLabs API key provided"})),
                )
                    .into_response();
            }
        }
    } else {
        api_key.to_string()
    };

    elevenlabs_fetch_and_normalize(&key, lang_filter).await
}

async fn elevenlabs_voices_from_db(
    pool: DbPool,
    lang_filter: Option<&str>,
) -> Response {
    let key = match get_api_key_from_db(pool, "elevenlabs").await {
        Some(k) => k,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "No ElevenLabs connection found"})),
            )
                .into_response();
        }
    };

    // Per-provider route returns {languages, byLang} grouped shape (like the deepgram/inworld routes)
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_default();

    let res = match client
        .get("https://api.elevenlabs.io/v1/voices")
        .header("xi-api-key", &key)
        .header("Content-Type", "application/json")
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({"error": format!("ElevenLabs voices fetch failed: {}", e)})),
            )
                .into_response();
        }
    };

    if !res.status().is_success() {
        let status = res.status().as_u16();
        return (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({"error": format!("ElevenLabs voices fetch failed: {}", status)})),
        )
            .into_response();
    }

    let data: serde_json::Value = match res.json().await {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({"error": format!("Failed to parse ElevenLabs response: {}", e)})),
            )
                .into_response();
        }
    };

    let voices_arr = data.get("voices").and_then(|v| v.as_array()).cloned().unwrap_or_default();

    // Group by language (like the Node per-provider route)
    let mut by_lang: BTreeMap<String, serde_json::Value> = BTreeMap::new();
    for v in &voices_arr {
        let voice_id = v.get("voice_id").and_then(|x| x.as_str()).unwrap_or("");
        let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("");
        let empty_labels = serde_json::json!({});
        let labels = v.get("labels").unwrap_or(&empty_labels);
        let primary_lang = labels.get("language").and_then(|x| x.as_str()).unwrap_or("en");
        let gender = labels.get("gender").and_then(|x| x.as_str()).unwrap_or("");
        let category = v.get("category").and_then(|x| x.as_str()).unwrap_or("");
        let is_owner = v.get("is_owner").and_then(|x| x.as_bool()).unwrap_or(false);
        let free = category == "premade" || is_owner;

        add_to_lang_group(&mut by_lang, primary_lang, voice_id, name, gender, primary_lang, Some(free));

        // Add to all verified_languages
        if let Some(vls) = v.get("verified_languages").and_then(|x| x.as_array()) {
            for vl in vls {
                if let Some(vl_lang) = vl.get("language").and_then(|x| x.as_str()) {
                    if vl_lang != primary_lang {
                        add_to_lang_group(&mut by_lang, vl_lang, voice_id, name, gender, vl_lang, Some(free));
                    }
                }
            }
        }
    }

    let (languages, by_lang_json) = finalize_lang_groups(&by_lang);

    if let Some(lf) = lang_filter {
        let voices_list = by_lang_json.get(lf)
            .and_then(|g| g.get("voices"))
            .cloned()
            .unwrap_or(serde_json::json!([]));
        return Json(serde_json::json!({"voices": voices_list})).into_response();
    }

    Json(serde_json::json!({"languages": languages, "byLang": by_lang_json})).into_response()
}

async fn elevenlabs_fetch_and_normalize(key: &str, lang_filter: Option<&str>) -> Response {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_default();

    let res = match client
        .get("https://api.elevenlabs.io/v1/voices")
        .header("xi-api-key", key)
        .header("Content-Type", "application/json")
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({"error": format!("ElevenLabs voices fetch failed: {}", e)})),
            )
                .into_response();
        }
    };

    if !res.status().is_success() {
        let status = res.status().as_u16();
        return (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({"error": format!("ElevenLabs voices fetch failed: {}", status)})),
        )
            .into_response();
    }

    let data: serde_json::Value = match res.json().await {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({"error": format!("Failed to parse ElevenLabs response: {}", e)})),
            )
                .into_response();
        }
    };

    let voices_arr = data.get("voices").and_then(|v| v.as_array()).cloned().unwrap_or_default();

    // Normalize to the aggregated shape (like the /voices route does for elevenlabs)
    let mut voices: Vec<serde_json::Value> = Vec::new();
    for v in &voices_arr {
        let voice_id = v.get("voice_id").and_then(|x| x.as_str()).unwrap_or("");
        let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("");
        let empty_labels = serde_json::json!({});
        let labels = v.get("labels").unwrap_or(&empty_labels);
        let locale = labels.get("language").and_then(|x| x.as_str()).unwrap_or("en");
        let lang = locale.split('-').next().unwrap_or("en").to_string();
        let gender = labels.get("gender").and_then(|x| x.as_str()).unwrap_or("");
        let category = v.get("category").and_then(|x| x.as_str()).unwrap_or("");

        voices.push(serde_json::json!({
            "id": voice_id,
            "name": name,
            "locale": locale,
            "lang": lang,
            "country": "",
            "countryName": "",
            "langName": lang_name(&lang),
            "gender": gender,
            "category": category,
        }));
    }

    if let Some(lf) = lang_filter {
        voices.retain(|v| v.get("lang").and_then(|x| x.as_str()) == Some(lf));
    }

    let (languages, by_lang) = group_by_lang(&voices);

    // Mask API key in response (never echo it)
    Json(serde_json::json!({"voices": voices, "languages": languages, "byLang": by_lang, "apiKey": "****"})).into_response()
}

// ===== Gemini (static) =====

fn gemini_voices(lang_filter: Option<&str>) -> Response {
    let mut voices: Vec<serde_json::Value> = Vec::new();
    for (id, lang, gender) in GEMINI_VOICES {
        let lang_s = lang.to_string();
        voices.push(serde_json::json!({
            "voice_id": id,
            "name": id,
            "labels": {"language": lang_s, "gender": gender.to_string()},
            "lang": lang_s,
        }));
    }

    if let Some(lf) = lang_filter {
        voices.retain(|v| v.get("lang").and_then(|x| x.as_str()) == Some(lf));
    }

    let (languages, by_lang) = group_by_lang(&voices);

    Json(serde_json::json!({"voices": voices, "languages": languages, "byLang": by_lang})).into_response()
}

// ===== Deepgram =====

async fn deepgram_voices(pool: DbPool, lang_filter: Option<&str>) -> Response {
    let key = match get_api_key_from_db(pool, "deepgram").await {
        Some(k) => k,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "No Deepgram connection found"})),
            )
                .into_response();
        }
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_default();

    let res = match client
        .get("https://api.deepgram.com/v1/models")
        .header("Authorization", format!("Token {}", key))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({"error": format!("Deepgram API error: {}", e)})),
            )
                .into_response();
        }
    };

    if !res.status().is_success() {
        let status = res.status().as_u16();
        let text = res.text().await.unwrap_or_default();
        return (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({"error": format!("Deepgram API {}: {}", status, text)})),
        )
            .into_response();
    }

    let data: serde_json::Value = match res.json().await {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({"error": format!("Failed to parse Deepgram response: {}", e)})),
            )
                .into_response();
        }
    };

    let tts_models = data.get("tts").and_then(|v| v.as_array()).cloned().unwrap_or_default();

    let mut by_lang: BTreeMap<String, serde_json::Value> = BTreeMap::new();
    for m in &tts_models {
        let canonical = m.get("canonical_name").and_then(|x| x.as_str()).unwrap_or("");
        let name = m.get("name").and_then(|x| x.as_str()).unwrap_or(canonical);
        let voice_id = if canonical.is_empty() { name } else { canonical };
        let langs: Vec<String> = m
            .get("languages")
            .and_then(|x| x.as_array())
            .map(|arr| arr.iter().filter_map(|l| l.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_else(|| {
                vec![canonical.split('-').last().unwrap_or("en").to_string()]
            });

        // Gender from metadata.tags
        let gender = m
            .get("metadata")
            .and_then(|x| x.get("tags"))
            .and_then(|x| x.as_array())
            .and_then(|arr| {
                arr.iter().find_map(|t| {
                    let s = t.as_str().unwrap_or("");
                    if s == "masculine" || s == "feminine" {
                        Some(s.to_string())
                    } else {
                        None
                    }
                })
            })
            .unwrap_or_default();

        for code in &langs {
            add_to_lang_group(&mut by_lang, code, voice_id, name, &gender, code, None);
        }
    }

    let (languages, by_lang_json) = finalize_lang_groups(&by_lang);

    if let Some(lf) = lang_filter {
        let voices_list = by_lang_json
            .get(lf)
            .and_then(|g| g.get("voices"))
            .cloned()
            .unwrap_or(serde_json::json!([]));
        return Json(serde_json::json!({"voices": voices_list})).into_response();
    }

    Json(serde_json::json!({"languages": languages, "byLang": by_lang_json})).into_response()
}

// ===== Inworld =====

async fn inworld_voices(pool: DbPool, lang_filter: Option<&str>) -> Response {
    let key = match get_api_key_from_db(pool, "inworld").await {
        Some(k) => k,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "No Inworld connection found"})),
            )
                .into_response();
        }
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_default();

    let res = match client
        .get("https://api.inworld.ai/tts/v1/voices")
        .header("Authorization", format!("Basic {}", key))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({"error": format!("Inworld API error: {}", e)})),
            )
                .into_response();
        }
    };

    if !res.status().is_success() {
        let status = res.status().as_u16();
        let text = res.text().await.unwrap_or_default();
        return (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({"error": format!("Inworld API {}: {}", status, text)})),
        )
            .into_response();
    }

    let data: serde_json::Value = match res.json().await {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({"error": format!("Failed to parse Inworld response: {}", e)})),
            )
                .into_response();
        }
    };

    let voices_arr = data.get("voices").and_then(|v| v.as_array()).cloned().unwrap_or_default();

    let mut by_lang: BTreeMap<String, serde_json::Value> = BTreeMap::new();
    for v in &voices_arr {
        let voice_id = v.get("voiceId").and_then(|x| x.as_str()).unwrap_or("");
        let display_name = v.get("displayName").and_then(|x| x.as_str()).unwrap_or(voice_id);
        let gender = v.get("gender").and_then(|x| x.as_str()).unwrap_or("");
        let langs: Vec<String> = v
            .get("languages")
            .and_then(|x| x.as_array())
            .map(|arr| arr.iter().filter_map(|l| l.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_else(|| vec!["en".to_string()]);
        for code in &langs {
            add_to_lang_group(&mut by_lang, code, voice_id, display_name, gender, code, None);
        }
    }

    let (languages, by_lang_json) = finalize_lang_groups(&by_lang);

    if let Some(lf) = lang_filter {
        let voices_list = by_lang_json
            .get(lf)
            .and_then(|g| g.get("voices"))
            .cloned()
            .unwrap_or(serde_json::json!([]));
        return Json(serde_json::json!({"voices": voices_list})).into_response();
    }

    Json(serde_json::json!({"languages": languages, "byLang": by_lang_json})).into_response()
}

// ===== MiniMax =====

async fn minimax_voices(
    pool: DbPool,
    provider: &str,
    lang_filter: Option<&str>,
    voice_type: &str,
) -> Response {
    let key = match get_api_key_from_db(pool, provider).await {
        Some(k) => k,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": format!("No {} connection found", provider)})),
            )
                .into_response();
        }
    };

    let endpoint = if provider == "minimax-cn" {
        "https://api.minimaxi.com/v1/get_voice"
    } else {
        "https://api.minimax.io/v1/get_voice"
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_default();

    let res = match client
        .post(endpoint)
        .header("Authorization", format!("Bearer {}", key))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({"voice_type": voice_type}))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({"error": format!("MiniMax API error: {}", e)})),
            )
                .into_response();
        }
    };

    let raw_text = res.text().await.unwrap_or_default();
    let data: serde_json::Value = serde_json::from_str(&raw_text).unwrap_or(serde_json::json!({}));

    let base_resp = data
        .get("base_resp")
        .or_else(|| data.get("baseResp"))
        .cloned()
        .unwrap_or(serde_json::json!({}));
    let status_code = base_resp
        .get("status_code")
        .or_else(|| base_resp.get("statusCode"))
        .and_then(|x| x.as_i64())
        .unwrap_or(0);
    let status_msg = base_resp
        .get("status_msg")
        .or_else(|| base_resp.get("statusMsg"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();

    if status_code != 0 {
        return (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({"error": status_msg})),
        )
            .into_response();
    }

    // Normalize MiniMax voices (same logic as Node)
    let voice_groups = [
        ("system_voice", "System"),
        ("voice_cloning", "Cloned"),
        ("voice_generation", "Generated"),
        ("music_generation", "Music"),
    ];

    let mut by_lang: BTreeMap<String, serde_json::Value> = BTreeMap::new();
    for (group_key, group_label) in &voice_groups {
        let voices = data.get(group_key).and_then(|x| x.as_array()).cloned().unwrap_or_default();
        for item in &voices {
            let voice_id = item
                .get("voice_id")
                .or_else(|| item.get("voiceId"))
                .and_then(|x| x.as_str())
                .unwrap_or("");
            if voice_id.is_empty() {
                continue;
            }
            let voice_name = item
                .get("voice_name")
                .or_else(|| item.get("voiceName"))
                .and_then(|x| x.as_str())
                .unwrap_or(voice_id);
            let lang = if *group_key == "system_voice" {
                infer_minimax_language(voice_id)
            } else {
                "Custom".to_string()
            };
            let name = if *group_key == "system_voice" {
                voice_name.to_string()
            } else {
                format!("{} · {}", voice_name, group_label)
            };
            add_to_lang_group_custom(
                &mut by_lang,
                &lang,
                voice_id,
                &name,
                &lang,
                Some(group_key.to_string()),
            );
        }
    }

    // Sort with Custom last
    let mut languages: Vec<serde_json::Value> = by_lang
        .values()
        .map(|v| {
            serde_json::json!({
                "code": v.get("code").unwrap_or(&serde_json::json!("")),
                "name": v.get("name").unwrap_or(&serde_json::json!("")),
                "voices": v.get("voices").cloned().unwrap_or(serde_json::json!([])),
            })
        })
        .collect();
    languages.sort_by(|a, b| {
        let a_code = a.get("code").and_then(|x| x.as_str()).unwrap_or("");
        let b_code = b.get("code").and_then(|x| x.as_str()).unwrap_or("");
        if a_code == "Custom" {
            std::cmp::Ordering::Greater
        } else if b_code == "Custom" {
            std::cmp::Ordering::Less
        } else {
            let a_name = a.get("name").and_then(|x| x.as_str()).unwrap_or("");
            let b_name = b.get("name").and_then(|x| x.as_str()).unwrap_or("");
            a_name.cmp(b_name)
        }
    });

    // Sort voices within each lang
    let by_lang_json: serde_json::Map<String, serde_json::Value> = {
        let mut m = serde_json::Map::new();
        for (code, v) in &by_lang {
            let mut voices_arr = v
                .get("voices")
                .and_then(|x| x.as_array())
                .cloned()
                .unwrap_or_default();
            voices_arr.sort_by(|a, b| {
                let a_name = a.get("name").and_then(|x| x.as_str()).unwrap_or("");
                let b_name = b.get("name").and_then(|x| x.as_str()).unwrap_or("");
                a_name.cmp(b_name)
            });
            m.insert(
                code.clone(),
                serde_json::json!({
                    "code": code,
                    "name": v.get("name").unwrap_or(&serde_json::json!(code)),
                    "voices": voices_arr,
                }),
            );
        }
        m
    };

    if let Some(lf) = lang_filter {
        let voices_list = by_lang_json
            .get(lf)
            .and_then(|g| g.get("voices"))
            .cloned()
            .unwrap_or(serde_json::json!([]));
        return Json(serde_json::json!({"voices": voices_list})).into_response();
    }

    Json(serde_json::json!({"languages": languages, "byLang": serde_json::Value::Object(by_lang_json)})).into_response()
}

fn infer_minimax_language(voice_id: &str) -> String {
    if !voice_id.contains('_') {
        return "Custom".to_string();
    }
    voice_id
        .split('_')
        .next()
        .unwrap_or("Custom")
        .to_string()
}

// ===== Helpers =====

/// Get API key from the first active provider connection for `provider`.
async fn get_api_key_from_db(pool: DbPool, provider: &str) -> Option<String> {
    let provider = provider.to_string();
    let pool_c = pool.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<crate::db::repos::connections::ProviderConnection>> {
        let conn = pool_c.get().map_err(|e| anyhow::anyhow!("Pool error: {}", e))?;
        get_provider_connections(&conn, &ConnectionFilter {
            provider: Some(provider.clone()),
            is_active: Some(true),
        })
    })
    .await;

    match result {
        Ok(Ok(conns)) => {
            if let Some(conn) = conns.first() {
                conn.data
                    .get("apiKey")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string())
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Group voices by `lang` field and build the byLang + languages arrays.
fn group_by_lang(voices: &[serde_json::Value]) -> (Vec<serde_json::Value>, serde_json::Value) {
    let mut by_lang: BTreeMap<String, (String, Vec<serde_json::Value>)> = BTreeMap::new();
    for v in voices {
        let lang = v.get("lang").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let lang_name = v
            .get("langName")
            .and_then(|x| x.as_str())
            .unwrap_or(&lang)
            .to_string();
        let entry = by_lang
            .entry(lang.clone())
            .or_insert_with(|| (lang_name, Vec::new()));
        entry.1.push(v.clone());
    }

    let by_lang_json: serde_json::Map<String, serde_json::Value> = {
        let mut m = serde_json::Map::new();
        for (code, (name, voices)) in &by_lang {
            m.insert(
                code.clone(),
                serde_json::json!({"code": code, "name": name, "voices": voices}),
            );
        }
        m
    };

    let mut languages: Vec<serde_json::Value> = by_lang
        .iter()
        .map(|(code, (name, voices))| {
            serde_json::json!({"code": code, "name": name, "voices": voices})
        })
        .collect();
    languages.sort_by(|a, b| {
        let a_name = a.get("name").and_then(|x| x.as_str()).unwrap_or("");
        let b_name = b.get("name").and_then(|x| x.as_str()).unwrap_or("");
        a_name.cmp(b_name)
    });

    (languages, serde_json::Value::Object(by_lang_json))
}

/// Add a voice to a language group in the by_lang map (with optional `free_users_allowed` flag).
fn add_to_lang_group(
    by_lang: &mut BTreeMap<String, serde_json::Value>,
    code: &str,
    voice_id: &str,
    name: &str,
    gender: &str,
    lang: &str,
    free: Option<bool>,
) {
    let entry = by_lang
        .entry(code.to_string())
        .or_insert_with(|| serde_json::json!({"code": code, "name": lang_name(code), "voices": []}));

    let voices_arr = entry
        .get_mut("voices")
        .and_then(|x| x.as_array_mut())
        .expect("voices must be array");

    // Avoid duplicates
    if voices_arr
        .iter()
        .any(|v| v.get("id").and_then(|x| x.as_str()) == Some(voice_id))
    {
        return;
    }

    let mut voice = serde_json::json!({
        "id": voice_id,
        "name": name,
        "gender": gender,
        "lang": lang,
    });
    if let Some(f) = free {
        voice["free_users_allowed"] = serde_json::json!(f);
    }
    voices_arr.push(voice);
}

/// Add a voice to a language group with an optional category field (for MiniMax).
fn add_to_lang_group_custom(
    by_lang: &mut BTreeMap<String, serde_json::Value>,
    code: &str,
    voice_id: &str,
    name: &str,
    lang: &str,
    category: Option<String>,
) {
    let entry = by_lang
        .entry(code.to_string())
        .or_insert_with(|| serde_json::json!({"code": code, "name": code, "voices": []}));

    let voices_arr = entry
        .get_mut("voices")
        .and_then(|x| x.as_array_mut())
        .expect("voices must be array");

    if voices_arr
        .iter()
        .any(|v| v.get("id").and_then(|x| x.as_str()) == Some(voice_id))
    {
        return;
    }

    let mut voice = serde_json::json!({
        "id": voice_id,
        "name": name,
        "lang": lang,
    });
    if let Some(cat) = category {
        voice["category"] = serde_json::json!(cat);
    }
    voices_arr.push(voice);
}

/// Finalize BTreeMap into (languages, byLang) JSON.
fn finalize_lang_groups(
    by_lang: &BTreeMap<String, serde_json::Value>,
) -> (Vec<serde_json::Value>, serde_json::Value) {
    let by_lang_json: serde_json::Map<String, serde_json::Value> = {
        let mut m = serde_json::Map::new();
        for (code, v) in by_lang {
            m.insert(code.clone(), v.clone());
        }
        m
    };

    let mut languages: Vec<serde_json::Value> = by_lang
        .values()
        .map(|v| {
            serde_json::json!({
                "code": v.get("code").unwrap_or(&serde_json::json!("")),
                "name": v.get("name").unwrap_or(&serde_json::json!("")),
                "voices": v.get("voices").cloned().unwrap_or(serde_json::json!([])),
            })
        })
        .collect();
    languages.sort_by(|a, b| {
        let a_name = a.get("name").and_then(|x| x.as_str()).unwrap_or("");
        let b_name = b.get("name").and_then(|x| x.as_str()).unwrap_or("");
        a_name.cmp(b_name)
    });

    (languages, serde_json::Value::Object(by_lang_json))
}

/// Approximate language name lookup. In Node this uses Intl.DisplayNames.
/// We use a small static map for common codes; fallback to the code itself.
fn lang_name(code: &str) -> String {
    let map: &[(&str, &str)] = &[
        ("en", "English"), ("es", "Spanish"), ("fr", "French"),
        ("de", "German"), ("it", "Italian"), ("pt", "Portuguese"),
        ("ru", "Russian"), ("ja", "Japanese"), ("ko", "Korean"),
        ("zh", "Chinese"), ("vi", "Vietnamese"), ("th", "Thai"),
        ("hi", "Hindi"), ("ar", "Arabic"), ("tr", "Turkish"),
        ("nl", "Dutch"), ("pl", "Polish"), ("sv", "Swedish"),
        ("id", "Indonesian"), ("ms", "Malay"), ("fil", "Filipino"),
        ("uk", "Ukrainian"), ("ro", "Romanian"), ("cs", "Czech"),
        ("da", "Danish"), ("fi", "Finnish"), ("el", "Greek"),
        ("he", "Hebrew"), ("hu", "Hungarian"), ("no", "Norwegian"),
        ("sk", "Slovak"), ("bg", "Bulgarian"),
    ];
    for (c, name) in map {
        if *c == code {
            return name.to_string();
        }
    }
    code.to_string()
}

/// Approximate region name lookup.
fn region_name(code: &str) -> Option<String> {
    let map: &[(&str, &str)] = &[
        ("US", "United States"), ("GB", "United Kingdom"),
        ("AU", "Australia"), ("CA", "Canada"), ("IN", "India"),
        ("CN", "China"), ("JP", "Japan"), ("KR", "Korea"),
        ("BR", "Brazil"), ("MX", "Mexico"), ("FR", "France"),
        ("DE", "Germany"), ("ES", "Spain"), ("IT", "Italy"),
        ("RU", "Russia"), ("VN", "Vietnam"), ("TH", "Thailand"),
        ("ID", "Indonesia"), ("MY", "Malaysia"), ("PH", "Philippines"),
        ("NL", "Netherlands"), ("PL", "Poland"), ("SE", "Sweden"),
        ("TR", "Turkey"), ("UA", "Ukraine"), ("EG", "Egypt"),
        ("SA", "Saudi Arabia"), ("AE", "United Arab Emirates"),
        ("HK", "Hong Kong"), ("TW", "Taiwan"), ("PT", "Portugal"),
        ("BE", "Belgium"), ("CH", "Switzerland"), ("AT", "Austria"),
        ("IE", "Ireland"), ("NZ", "New Zealand"), ("ZA", "South Africa"),
        ("SG", "Singapore"), ("DK", "Denmark"), ("FI", "Finland"),
        ("NO", "Norway"), ("CZ", "Czech Republic"), ("RO", "Romania"),
        ("HU", "Hungary"), ("EL", "Greece"), ("IL", "Israel"),
        ("BG", "Bulgaria"), ("SK", "Slovakia"),
    ];
    for (c, name) in map {
        if *c == code {
            return Some(name.to_string());
        }
    }
    None
}
