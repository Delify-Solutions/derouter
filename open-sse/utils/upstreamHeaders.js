// Upstream 9router forwards `retry-after`, `x-should-retry` and `anthropic-ratelimit-*` from the
// provider response to the client. derouter resells pooled provider accounts, so those headers
// would expose the pool's quota and cooldown state to customers (spec model-privacy). Nothing
// from the provider response reaches a customer here; the function stays so the upstream call
// sites keep merging cleanly.
export function upstreamResponseHeaders() {
  return {};
}
