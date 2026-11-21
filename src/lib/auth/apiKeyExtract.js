// The one way an LLM request's API key is read (spec api-access-enforcement
// "One API key extraction for the guard and the handlers").
//
// The request guard (src/dashboardGuard.js) and every handler use this, so a key
// the guard accepted is always the key the handler enforces, masks, rate-limits
// and charges. When the guard read `?key=` / `x-goog-api-key` but the handlers
// did not, a customer key sent that way passed the guard and was then served as
// keyless (no combo-only rule, no masking, no plan admission, no charge) whenever
// `requireApiKey` was off.
//
// Order: `Authorization: Bearer`, `x-api-key` (Anthropic), `x-goog-api-key`
// (Google), `?key=` (Google). Dependency-free; relative-import safe.

/**
 * @param {Request} request a Web Request or NextRequest
 * @returns {string|null}
 */
export function extractApiKey(request) {
  const headers = request?.headers;
  if (!headers) return null;
  const authHeader = headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  const apiKeyHeader = headers.get("x-api-key");
  if (apiKeyHeader) return apiKeyHeader;
  const googleApiKeyHeader = headers.get("x-goog-api-key");
  if (googleApiKeyHeader) return googleApiKeyHeader;
  const params = request.nextUrl?.searchParams ?? searchParamsOf(request.url);
  return params?.get("key") || null;
}

function searchParamsOf(url) {
  try {
    return new URL(url).searchParams;
  } catch {
    return null;
  }
}
