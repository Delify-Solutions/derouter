// Custom OpenAI-compatible provider nodes (`openai-compatible-<id>`): the operator
// points a node at any `<baseUrl>/images/generations` endpoint.
//
// Unlike the built-in OpenAI adapter, the body is forwarded as sent: image gateways
// of this kind take model-specific fields (`condition_images`, `num_inference_steps`,
// `seed`, ...) that no fixed whitelist can anticipate. Only `model` is replaced with
// the upstream model name. The built-in adapters keep their whitelists untouched.
export const OPENAI_COMPATIBLE_PREFIX = "openai-compatible-";

export function isOpenAICompatibleImageProvider(providerId) {
  return typeof providerId === "string" && providerId.startsWith(OPENAI_COMPATIBLE_PREFIX);
}

const adapter = {
  buildUrl: (_model, credentials) => {
    const baseUrl = credentials?.providerSpecificData?.baseUrl;
    if (typeof baseUrl !== "string" || !baseUrl.trim()) {
      throw new Error("Provider node has no base URL configured");
    }
    return `${baseUrl.trim().replace(/\/+$/, "")}/images/generations`;
  },
  buildHeaders: (credentials) => {
    const headers = { "Content-Type": "application/json" };
    const key = credentials?.apiKey || credentials?.accessToken;
    if (key) headers.Authorization = `Bearer ${key}`;
    return headers;
  },
  buildBody: (model, body) => ({ ...body, model }),
  // Already the OpenAI shape ({ created, data: [{ url | b64_json }] }).
  normalize: (responseBody) => responseBody,
};

export default adapter;
