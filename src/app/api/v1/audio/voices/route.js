import { AI_PROVIDERS } from "@/shared/constants/providers";
import { extractApiKey, isValidApiKey, refuseUnmeteredEndpoint } from "@/sse/services/auth.js";
import { getRequestIp } from "@/lib/auth/clientIp.js";
import { getApiKeyByKey } from "@/lib/localDb";
import { platformErrorResponse, PLATFORM_MESSAGES } from "@/lib/auth/platformError.js";
import { GET as elevenlabsVoices } from "@/app/api/media-providers/tts/elevenlabs/voices/route.js";
import { GET as deepgramVoices } from "@/app/api/media-providers/tts/deepgram/voices/route.js";
import { GET as inworldVoices } from "@/app/api/media-providers/tts/inworld/voices/route.js";
import { GET as genericVoices } from "@/app/api/media-providers/tts/voices/route.js";

// Provider → internal voices handler, called in-process. This used to be an HTTP
// fetch to the request's own origin: the host came from the caller's Host header
// (so the server fetched wherever the caller pointed it), and the internal API sits
// behind the admin session, so the call carried no credential and answered 401.
// The handlers only read their query string; the host below is never contacted.
const INTERNAL_BASE = "http://internal.invalid";
const PROVIDER_API = {
  elevenlabs: { handler: elevenlabsVoices, path: "/api/media-providers/tts/elevenlabs/voices" },
  deepgram: { handler: deepgramVoices, path: "/api/media-providers/tts/deepgram/voices" },
  inworld: { handler: inworldVoices, path: "/api/media-providers/tts/inworld/voices" },
  "edge-tts": { handler: genericVoices, path: "/api/media-providers/tts/voices", provider: "edge-tts" },
  "local-device": { handler: genericVoices, path: "/api/media-providers/tts/voices", provider: "local-device" },
};

function internalRequest({ path, provider }, lang) {
  const url = new URL(path, INTERNAL_BASE);
  if (provider) url.searchParams.set("provider", provider);
  if (lang) url.searchParams.set("lang", lang);
  return new Request(url);
}

/**
 * Only a valid admin key (one without an owning account) may list voices. The
 * handlers called below used to sit behind the admin session; called in-process
 * they no longer do, so this route is their gate: the operator's voices (cloned
 * ones included) are never shown to an anonymous caller, whatever
 * `requireApiKey` says, nor to a customer key (TTS is closed to customers, spec
 * model-privacy). Null when the call may proceed.
 */
async function refuseUnlessAdminKey(request, provider) {
  const apiKey = extractApiKey(request);
  const invalid = () => platformErrorResponse({ status: 401, code: "invalid_api_key", message: PLATFORM_MESSAGES.invalid_api_key });
  if (!apiKey || !(await isValidApiKey(apiKey))) return invalid();
  const key = await getApiKeyByKey(apiKey);
  if (!key) return invalid();
  if (key.expiresAt && Date.parse(key.expiresAt) <= Date.now()) {
    return platformErrorResponse({ status: 403, code: "key_expired", message: PLATFORM_MESSAGES.key_expired });
  }
  if (key.userId) {
    return refuseUnmeteredEndpoint(apiKey, { model: provider ? `${provider}/voices` : null, clientIp: getRequestIp(request) });
  }
  return null;
}

export async function OPTIONS() {
  return new Response(null, {
    headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" },
  });
}

// GET /v1/audio/voices?provider={p}[&lang=xx]
// Returns OpenAI-style list with each voice's full model id ready for /v1/audio/speech
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider");
    const lang = searchParams.get("lang");

    const refused = await refuseUnlessAdminKey(request, provider);
    if (refused) return refused;

    if (!provider || !Object.hasOwn(PROVIDER_API, provider)) {
      return Response.json(
        { error: { message: `provider must be one of: ${Object.keys(PROVIDER_API).join(", ")}`, type: "invalid_request_error" } },
        { status: 400, headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }

    const entry = PROVIDER_API[provider];
    const res = await entry.handler(internalRequest(entry, lang));
    const data = await res.json();
    if (!res.ok || data.error) {
      return Response.json(
        { error: { message: data.error || `Upstream ${res.status}`, type: "server_error" } },
        { status: res.ok ? 502 : res.status, headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }

    // Internal API shape: { voices } when lang filter, else { byLang, languages }
    const rawVoices = lang
      ? (data.voices || [])
      : Object.values(data.byLang || {}).flatMap((l) => l.voices || []);

    // Use provider alias for /v1/audio/speech model param (matches skill convention e.g. el/, dg/, edge-tts/)
    const alias = AI_PROVIDERS[provider]?.alias || provider;
    const data_out = rawVoices.map((v) => ({
      id: v.id,
      name: v.name,
      lang: v.lang || "",
      gender: v.gender || "",
      model: `${alias}/${v.id}`,
    }));

    return Response.json({ object: "list", data: data_out }, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  } catch (err) {
    return Response.json(
      { error: { message: err.message || "Failed", type: "server_error" } },
      { status: 502, headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }
}
