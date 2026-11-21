// The Gemini-format model list served at GET /v1beta/models. Pure (the route
// loads the data); relative-import safe.
//
// A customer key gets the combos it may call, exactly what /v1/models lists for
// it; the built-in provider catalog (`models/{provider}/{id}`) names upstream
// providers and models and is for admin keys and local use only (spec
// model-privacy "Customer catalogs list only what the customer can call").

const DEFAULT_INPUT_LIMIT = 128000;
const DEFAULT_OUTPUT_LIMIT = 8192;

/** The built-in catalog: every provider model, plus bare Gemini ids. */
export function geminiCatalogModels(providerModels) {
  const models = [];
  const seen = new Set();
  const add = ({ name, displayName, description, methods = ["generateContent"] }) => {
    if (seen.has(name)) return;
    seen.add(name);
    models.push({
      name,
      displayName,
      description,
      supportedGenerationMethods: methods,
      inputTokenLimit: DEFAULT_INPUT_LIMIT,
      outputTokenLimit: DEFAULT_OUTPUT_LIMIT,
    });
  };
  for (const [provider, list] of Object.entries(providerModels || {})) {
    for (const model of list || []) {
      add({
        name: `models/${provider}/${model.id}`,
        displayName: model.name || model.id,
        description: `${provider} model: ${model.name || model.id}`,
      });
      if (provider === "gemini") {
        add({
          name: `models/${model.id}`,
          displayName: model.name || model.id,
          description: `Gemini model: ${model.name || model.id}`,
          methods: ["generateContent", "streamGenerateContent"],
        });
      }
    }
  }
  return models;
}

/** Combos as /v1/models lists them (`{ id, context_length?, max_completion_tokens? }`). */
export function geminiComboModels(entries) {
  return (entries || [])
    .filter((entry) => typeof entry?.id === "string" && entry.id)
    .map((entry) => ({
      name: `models/${entry.id}`,
      displayName: entry.id,
      description: entry.id,
      supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
      inputTokenLimit: Number.isFinite(entry.context_length) ? entry.context_length : DEFAULT_INPUT_LIMIT,
      outputTokenLimit: Number.isFinite(entry.max_completion_tokens) ? entry.max_completion_tokens : DEFAULT_OUTPUT_LIMIT,
    }));
}
