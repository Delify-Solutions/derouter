// Decide whether a model is a text (llm) or an image model.
//
// Pure and dependency-free: the model test route, the provider page and the combos
// page all need the same answer, and `node --test` loads this file directly.

// Names that are almost always image generators. Only a guess for the default when
// nothing was recorded; an explicit type always wins.
const IMAGE_NAME = /(^|[-_/.\s])(image|images|imagen|dall-?e|flux|sdxl|sd3|stable-diffusion|midjourney|ideogram|recraft|seedream)([-_/.\s\d]|$)/i;

/** Best guess from the model id alone: "image" or "llm". */
export function guessModelKind(modelId) {
  return IMAGE_NAME.test(String(modelId || "")) ? "image" : "llm";
}

const kindOf = (entry) => entry?.kind || entry?.type || "llm";

/**
 * Kind of a routed model string ("<alias>/<model>" or a combo name).
 *
 * Order: the combo's own kind, a model recorded on the node with an explicit type,
 * an image-only node, then the name guess. `data` is `{ customModels, nodes, combos }`.
 *
 * @returns {"image"|"llm"}
 */
export function detectModelKind(model, { customModels = [], nodes = [], combos = [] } = {}) {
  const value = String(model || "");
  if (!value) return "llm";

  const combo = combos.find((entry) => entry?.name === value);
  if (combo) return combo.kind === "image" ? "image" : "llm";

  const slash = value.indexOf("/");
  if (slash <= 0) return guessModelKind(value);
  const head = value.slice(0, slash);
  const rest = value.slice(slash + 1);

  const node = nodes.find((entry) => entry?.id === head || entry?.prefix === head) || null;
  const aliases = new Set([head, node?.id, node?.prefix].filter(Boolean));

  const recorded = customModels.find((entry) => entry?.id === rest && aliases.has(entry.providerAlias));
  if (recorded) return kindOf(recorded) === "image" ? "image" : "llm";

  if (node?.apiType === "images") return "image";
  return guessModelKind(rest);
}
