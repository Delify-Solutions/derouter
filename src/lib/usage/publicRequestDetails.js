// Request details as a key holder reads them through the public usage API
// (/api/usage/key/receipts/detail). Pure helpers over stored detail records:
// the route does the key lookup and the database read.
//
// For a customer key with hideUpstreamModels on (`hide`), nothing returned names
// the upstream (spec model-privacy "Usage data never shows the upstream model"):
// no resolved model, no connection id (the provider account that served the
// request: it lets a customer count and fingerprint pooled accounts), and no
// stored detail id (older ids embed the upstream model). Each row is identified
// by an opaque id instead, which the single-detail lookup accepts back.
//
// Relative imports only (tests import this module).
import { maskOptionsFor } from "../models/customerModels.js";
import { maskStoredResponse } from "../models/publicModel.js";
import { sealId, openSealedId } from "../crypto/sealedIds.js";
import { getRequestDetails, getRequestDetailForKey } from "../db/repos/requestDetailsRepo.js";

const DETAIL_ID_PURPOSE = "request-detail";

/**
 * The id a customer key sees for a stored detail: stable, reveals nothing, and
 * resolvable by this server alone (sealed, see crypto/sealedIds.js; every sealed
 * id has the same length). A stored id too long to seal (none the router writes:
 * timestamp + suffix, or an old id with a model name far under the limit) is
 * referenced by the row's timestamp instead, which the row already shows and
 * the lookup accepts; it is never sent as a longer id.
 */
export function publicDetailId(detail) {
  return sealId(DETAIL_ID_PURPOSE, String(detail.id)) ?? (detail.timestamp || null);
}

/** The stored id behind a public detail id, or null when it is not one. */
export function storedDetailId(publicId) {
  return openSealedId(DETAIL_ID_PURPOSE, publicId);
}

// How many recent rows a timestamp (or admin id) lookup searches.
const RECENT_LOOKUP_ROWS = 100;

/**
 * The detail `id` names, read for `apiKey` only (every query is `apiKey = ?`).
 * A customer's opaque id is opened and read by primary key, so a row on any page
 * resolves; anything else (a timestamp, an admin's connection or stored id) is
 * matched among the key's most recent rows in the date range, as before.
 */
export async function lookupDetail({ apiKey, id, hide = false, startDate = null, endDate = null }) {
  if (!apiKey || !id) return null;
  if (hide) {
    const stored = storedDetailId(id);
    if (stored) return getRequestDetailForKey(stored, apiKey);
  }
  const res = await getRequestDetails({ apiKey, pageSize: RECENT_LOOKUP_ROWS, page: 1, startDate, endDate });
  return findDetail(res.details || [], id, hide);
}

export function maskKey(key) {
  if (!key) return null;
  if (key.length <= 10) return "****";
  return `${key.slice(0, 6)}…****${key.slice(-4)}`;
}

// Normalize status to an HTTP-style code for display. requestDetails stores
// "success"/"error" (its own vocabulary) plus provider status strings. Map:
// success/ok/completed → "200"; a numeric 1xx-5xx → as-is; otherwise leave
// the raw value (so real upstream errors like "429", "rate_limited" are shown).
export function normalizeStatus(s) {
  if (s == null || s === "") return "—";
  const lower = String(s).toLowerCase();
  if (lower === "ok" || lower === "success" || lower === "completed") return "200";
  if (lower === "error" || lower === "failed" || lower === "failure") return "500";
  const n = Number(s);
  if (!Number.isNaN(n) && n >= 100 && n < 600) return String(Math.trunc(n));
  if (/^\d{3}$/.test(String(s))) return String(s);
  return String(s);
}

/**
 * The detail `id` names among `details` (already scoped to the key), or null.
 * `id` is what the caller was given: the opaque id for a customer key (`hide`),
 * a connection id or stored id for an admin key; or, for both, a usage-history
 * timestamp (history rows have no id), matched to the nearest detail within
 * 2 minutes so the link from Request History works.
 */
export function findDetail(details, id, hide = false) {
  const all = Array.isArray(details) ? details : [];
  if (!id) return null;
  const stored = hide ? storedDetailId(id) : null;
  let detail = hide
    ? (stored ? all.find((d) => d?.id === stored) || null : null)
    : all.find((d) => d?.connectionId === id || d?.id === id) || null;
  if (detail) return detail;
  const tsId = Date.parse(id);
  if (Number.isNaN(tsId)) return null;
  let bestDelta = Infinity;
  for (const d of all) {
    const t = Date.parse(d?.timestamp || "");
    if (Number.isNaN(t)) continue;
    const delta = Math.abs(t - tsId);
    if (delta < bestDelta) { bestDelta = delta; detail = d; }
  }
  return detail && bestDelta <= 120_000 ? detail : null;
}

// Always mask the apiKey field; strip the raw payloads unless includeRaw.
// Provider is intentionally omitted from the output (not exposed publicly).
export function scrubDetailForList(d, includeRaw, hide = false) {
  const req = d.request || {};
  const messages = Array.isArray(req.messages) ? req.messages : [];
  const tools = Array.isArray(req.tools) ? req.tools : null;
  const systemCount = messages.filter((m) => m?.role === "system").length;
  const reasoningTokens =
    d.tokens?.reasoning_tokens ||
    d.tokens?.completion_tokens_details?.reasoning_tokens ||
    d.tokens?.reasoningTokens ||
    0;
  // Body size: estimate from the request payload (JSON length in bytes).
  let bodyBytes = 0;
  try { bodyBytes = Buffer.byteLength(JSON.stringify(req || {}), "utf8"); } catch { /* keep 0 */ }

  const out = {
    ...(hide
      ? { id: d.id ? publicDetailId(d) : null }
      : { connectionId: d.connectionId || d.id || null }),
    timestamp: d.timestamp,
    // Show the combo the key holder called (requestedModel) when available; fall back
    // to the resolved model for older records that predate the field. The
    // resolved (upstream) model itself is never returned to a customer key
    // (spec model-privacy); an admin key still gets it.
    // A customer row with no recorded combo (written before error rows kept it)
    // shows no model rather than the upstream one.
    model: d.requestedModel || (hide ? null : d.model),
    ...(hide ? {} : { resolvedModel: d.model || null }),
    status: normalizeStatus(d.status),
    apiKey: maskKey(d.apiKey),
    latency: d.latency || { ttft: null, total: 0 },
    inputTokens: d.tokens?.prompt_tokens ?? d.tokens?.input_tokens ?? 0,
    outputTokens: d.tokens?.completion_tokens ?? d.tokens?.output_tokens ?? 0,
    cachedTokens: d.tokens?.cached_tokens ?? d.tokens?.cache_read_input_tokens ?? d.tokens?.prompt_tokens_details?.cached_tokens ?? 0,
    cacheCreationTokens: d.tokens?.cache_creation_input_tokens ?? 0,
    reasoningTokens,
    messageCount: messages.length,
    systemMessageCount: systemCount,
    toolCount: tools ? tools.length : 0,
    bodyBytes,
  };
  if (includeRaw) {
    out.request = d.request ?? null;
    out.response = d.response ?? null;
    // The stored request/response are the engine's: the request already carries
    // the upstream model it was rewritten to, the response the upstream's own
    // fields and errors. Both are masked for a customer key.
    if (hide) {
      const options = maskOptionsFor({
        publicName: d.requestedModel || "—",
        upstream: [d.model, d.provider && d.model ? `${d.provider}/${d.model}` : null].filter(Boolean),
        providers: [d.provider].filter(Boolean),
      });
      if (out.request) out.request = maskStoredResponse(out.request, options);
      if (out.response) out.response = maskStoredResponse(out.response, options);
    }
  }
  return out;
}

// Single-detail mode: same scrub but always carry the per-request summary.
export function scrubDetail(d, includeRaw, hide = false) {
  const base = scrubDetailForList(d, includeRaw, hide);
  if (includeRaw) {
    return base; // already has payloads
  }
  // Without raw: still return the summary; payloads redacted marker for UI.
  return { ...base, request: { redacted: true }, response: { redacted: true } };
}
