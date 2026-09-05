// Match a configured CLI base URL against all known endpoints (local/tunnel/tailscale/cloud)
import type { EndpointMatchOptions, EndpointMatchResult } from "./cliTools.types";

const stripTrailingSlash = (s: string): string => (s || "").replace(/\/+$/, "");

export function matchKnownEndpoint(
  currentUrl: string | null | undefined,
  opts: EndpointMatchOptions = {},
): EndpointMatchResult {
  if (!currentUrl) return false;
  const url = stripTrailingSlash(currentUrl);
  const { tunnelPublicUrl, tailscaleUrl, cloudUrl } = opts;
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(url)) return true;
  if (tunnelPublicUrl && url.startsWith(stripTrailingSlash(tunnelPublicUrl))) return true;
  if (tailscaleUrl && url.startsWith(stripTrailingSlash(tailscaleUrl))) return true;
  if (cloudUrl && url.startsWith(stripTrailingSlash(cloudUrl))) return true;
  return false;
}
