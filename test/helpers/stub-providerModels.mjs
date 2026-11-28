// Minimal stand-in for open-sse/config/providerModels.js, loaded only via
// quota-utils-hook.mjs for tests of ProviderLimits/utils.js in plain Node.
// groupConnectionsByProvider never needs real model ordering data, so an
// empty list for every provider is sufficient.
export function getModelsByProviderId() {
  return [];
}
