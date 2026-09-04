import { NextResponse } from "next/server";
import { getApiKeyForAuth, getRequestDetails } from "@/lib/db/index.js";

export const dynamic = "force-dynamic";

function maskKey(key) {
  if (!key) return null;
  if (key.length <= 10) return "****";
  return `${key.slice(0, 6)}…****${key.slice(-4)}`;
}

// Normalize status to an HTTP-style code for display. requestDetails stores
// "success"/"error" (its own vocabulary) plus provider status strings. Map:
// success/ok/completed → "200"; a numeric 1xx-5xx → as-is; otherwise leave
// the raw value (so real upstream errors like "429", "rate_limited" are shown).
function normalizeStatus(s) {
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
 * GET /api/usage/key/receipts/detail?key=<apikey>&id=<connectionId>
 *        &page=1&pageSize=50&startDate=&endDate=&includeRaw=1
 *
 * Public — a key holder views their OWN request details (latency, message counts,
 * tools, reasoning tokens, body size, and optionally raw request/response).
 * Gated by the key itself: 404 on unknown key (existence not leaked).
 *
 * All results are filtered by `apiKey = ?` server-side — a caller can NEVER
 * see another key's details. The `apiKey` field inside each detail record is
 * masked before return. Provider identity is intentionally NOT exposed here
 * (no resolved names, no raw UUIDs) per the public-usage-page requirement.
 *
 * `id` (optional): if supplied, returns the single matching detail (still
 * scoped to the key). Useful when the history list links to a deep view.
 *
 * `includeRaw=1` (optional): return the stored providerRequest / providerResponse
 * / request bodies verbatim (they're already truncated to
 * observabilityMaxJsonSize in storage). Without it, those payload fields are
 * replaced with `{redacted:true}` — sensitive conversation content isn't shown
 * by default, but the owner CAN opt in to audit their own usage.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const key = searchParams.get("key");
    const id = searchParams.get("id");
    const pageRaw = parseInt(searchParams.get("page"), 10);
    const pageSizeRaw = parseInt(searchParams.get("pageSize"), 10);
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    const includeRaw = searchParams.get("includeRaw") === "1" || searchParams.get("includeRaw") === "true";

    if (!key) {
      return NextResponse.json({ error: "Not Found" }, { status: 404 });
    }

    const auth = await getApiKeyForAuth(key);
    if (!auth || !auth.key) {
      return NextResponse.json({ error: "Not Found" }, { status: 404 });
    }

    const page = Number.isNaN(pageRaw) ? 1 : Math.max(1, pageRaw);
    const pageSize = Number.isNaN(pageSizeRaw) ? 50 : Math.min(100, Math.max(1, pageSizeRaw));

    if (id) {
      // Single-detail mode: fetch a page of recent details for this key and
      // return the one whose id matches. (requestDetails PK is the id; a
      // dedicated getById-with-key gate is not exported, so we scope by key
      // then filter — safe because the WHERE apiKey=? is enforced server-side.)
      // `id` may be a connectionId, a record id, or a usage-history timestamp
      // (the history table has no id); for the timestamp case, match by the
      // nearest detail within 2 minutes so the link from Request History works.
      const res = await getRequestDetails({ apiKey: key, pageSize: 100, page: 1, startDate, endDate });
      const all = res.details || [];
      let detail = all.find((d) => d.connectionId === id || d.id === id) || null;
      if (!detail) {
        const tsId = Date.parse(id);
        if (!Number.isNaN(tsId)) {
          let best = null;
          let bestDelta = Infinity;
          for (const d of all) {
            const t = Date.parse(d.timestamp || "");
            if (Number.isNaN(t)) continue;
            const delta = Math.abs(t - tsId);
            if (delta < bestDelta) { bestDelta = delta; best = d; }
          }
          if (best && bestDelta <= 120_000) detail = best; // within 2 min
        }
      }
      if (!detail) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      return NextResponse.json({ detail: scrubDetail(detail, includeRaw) });
    }

    // List mode: recent details for this key, summary fields + (optionally) raw.
    const res = await getRequestDetails({ apiKey: key, page, pageSize, startDate, endDate });
    const details = (res.details || []).map((d) => scrubDetailForList(d, includeRaw));
    return NextResponse.json({
      details,
      pagination: res.pagination,
    });
  } catch (err) {
    console.log("Error fetching key detail:", err);
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }
}

// Always mask the apiKey field; strip the raw payloads unless includeRaw.
// Provider is intentionally omitted from the output (not exposed publicly).
function scrubDetailForList(d, includeRaw) {
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
  try { bodyBytes = Buffer.byteLength(JSON.stringify(req || {}), "utf8"); } catch {}

  const out = {
    connectionId: d.connectionId || d.id || null,
    timestamp: d.timestamp,
    model: d.model,
    status: normalizeStatus(d.status),
    apiKey: maskKey(d.apiKey),
    latency: d.latency || { ttft: 0, total: 0 },
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
    out.providerRequest = d.providerRequest ?? null;
    out.providerResponse = d.providerResponse ?? null;
    out.response = d.response ?? null;
  }
  return out;
}

// Single-detail mode: same scrub but always carry the per-request summary.
function scrubDetail(d, includeRaw) {
  const base = scrubDetailForList(d, includeRaw);
  if (includeRaw) {
    return base; // already has payloads
  }
  // Without raw: still return the summary; payloads redacted marker for UI.
  return { ...base, request: { redacted: true }, providerRequest: { redacted: true }, providerResponse: { redacted: true }, response: { redacted: true } };
}
