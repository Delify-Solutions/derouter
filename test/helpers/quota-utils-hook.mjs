// Node module-resolution hook for tests importing ProviderLimits/utils.js
// directly: its only bare "open-sse/..." import (resolvable only through
// Next's path alias, see CLAUDE.md) is stubbed so the module loads in plain
// Node. Scoped to this one specifier — never affects any other test's hook.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "open-sse/config/providerModels.js") {
    return { url: new URL("./stub-providerModels.mjs", import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
