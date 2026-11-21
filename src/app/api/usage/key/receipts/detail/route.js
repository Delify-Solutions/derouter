import { NextResponse } from "next/server";
import { getApiKeyForAuth, getRequestDetails } from "@/lib/db/index.js";
import { getSettings } from "@/lib/localDb";
import { hideUpstreamModelsEnabled } from "@/lib/models/customerModels.js";
import { lookupDetail, scrubDetail, scrubDetailForList } from "@/lib/usage/publicRequestDetails.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/usage/key/receipts/detail?key=<apikey>&id=<detail id or timestamp>
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
 * A customer key gets an opaque `id` per row and no `connectionId` (see
 * src/lib/usage/publicRequestDetails.js); an admin key keeps `connectionId`.
 *
 * `id` (optional): if supplied, returns the single matching detail (still
 * scoped to the key). Useful when the history list links to a deep view.
 *
 * `includeRaw=1` (optional): return the stored client request / response bodies
 * verbatim (they're already truncated to observabilityMaxJsonSize in storage).
 * Without it, those payload fields are replaced with `{redacted:true}` —
 * sensitive conversation content isn't shown by default, but the owner CAN opt
 * in to audit their own usage.
 *
 * The UPSTREAM payloads (providerRequest / providerResponse) are never returned
 * here: they are the router's translated request, carrying the provider
 * account's project id, the real upstream model and any injected system prompt.
 * Only the admin request-details view shows them.
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

    // A customer key never sees the upstream model (spec model-privacy).
    let hide = false;
    try {
      hide = Boolean(auth.key.userId) && hideUpstreamModelsEnabled(await getSettings());
    } catch {
      hide = Boolean(auth.key.userId);
    }

    const page = Number.isNaN(pageRaw) ? 1 : Math.max(1, pageRaw);
    const pageSize = Number.isNaN(pageSizeRaw) ? 50 : Math.min(100, Math.max(1, pageSizeRaw));

    if (id) {
      // Single-detail mode, always scoped by `apiKey = ?`: a customer's opaque
      // id is opened and read by primary key; a timestamp (or an admin id) is
      // matched among the key's recent rows (see lookupDetail).
      const detail = await lookupDetail({ apiKey: key, id, hide, startDate, endDate });
      if (!detail) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      return NextResponse.json({ detail: scrubDetail(detail, includeRaw, hide) });
    }

    // List mode: recent details for this key, summary fields + (optionally) raw.
    const res = await getRequestDetails({ apiKey: key, page, pageSize, startDate, endDate });
    const details = (res.details || []).map((d) => scrubDetailForList(d, includeRaw, hide));
    return NextResponse.json({
      details,
      pagination: res.pagination,
    });
  } catch {
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }
}
