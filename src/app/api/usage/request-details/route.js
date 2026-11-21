import { NextResponse } from "next/server";
import { getRequestDetails, clearAllRequestDetails } from "@/lib/usageDb";
import { describeKeysByRaw } from "@/lib/db/repos/apiKeysRepo.js";

/** keyInfo from the owner snapshot stored on a request-details row (key deleted since). */
function snapshotKeyInfo(owner) {
  if (!owner || typeof owner !== "object" || (!owner.userId && !owner.apiKeyId)) return null;
  return {
    keyId: owner.apiKeyId ?? null,
    name: owner.keyName ?? null,
    kind: owner.userId ? "user" : "admin",
    userId: owner.userId ?? null,
    email: owner.email ?? null,
    displayName: owner.displayName ?? null,
    deleted: true,
  };
}

const SORTS = new Set(["time", "tokens", "latency"]);
const ORDERS = new Set(["desc", "asc"]);

/**
 * GET /api/usage/request-details
 * Query parameters: page, pageSize (1-100), provider, model, connectionId, status, startDate, endDate,
 * modelView (requested | upstream; anything else = requested), q (free-text search),
 * sort (time | tokens | latency), order (desc | asc). An invalid sort or order is HTTP 400.
 * The response also carries `models` (the distinct models of the view, for the filter) and
 * each row's `requestedModel` and `upstreamModel`.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);

    const modelView = searchParams.get("modelView") === "upstream" ? "upstream" : "requested";
    const sort = searchParams.get("sort") ?? "time";
    const order = searchParams.get("order") ?? "desc";
    if (!SORTS.has(sort)) {
      return NextResponse.json({ error: "sort must be time, tokens or latency" }, { status: 400 });
    }
    if (!ORDERS.has(order)) {
      return NextResponse.json({ error: "order must be desc or asc" }, { status: 400 });
    }
    const q = searchParams.get("q");

    const pageRaw = parseInt(searchParams.get("page"));
    const page = Number.isNaN(pageRaw) ? 1 : pageRaw;
    const pageSizeRaw = parseInt(searchParams.get("pageSize"));
    const pageSize = Number.isNaN(pageSizeRaw) ? 20 : pageSizeRaw;
    const provider = searchParams.get("provider");
    const model = searchParams.get("model");
    const connectionId = searchParams.get("connectionId");
    const apiKey = searchParams.get("apiKey");
    // Every key of one customer.
    const userId = searchParams.get("userId");
    const status = searchParams.get("status");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    // includeRaw=1: return stored request/response payloads verbatim (admin-only —
    // this route is behind the dashboard guard). Default (absent): redact payloads
    // to {redacted:true} so conversation content isn't exposed wholesale.
    const includeRaw = searchParams.get("includeRaw") === "1" || searchParams.get("includeRaw") === "true";

    if (page < 1) {
      return NextResponse.json(
        { error: "Page must be >= 1" },
        { status: 400 }
      );
    }

    if (pageSize < 1 || pageSize > 100) {
      return NextResponse.json(
        { error: "PageSize must be between 1 and 100" },
        { status: 400 }
      );
    }

    const filter = {
      page,
      pageSize,
      modelView,
      sort,
      order,
      includeModels: true,
    };
    if (q && q.trim()) filter.q = q.trim().slice(0, 200);

    if (provider) filter.provider = provider;
    if (model) filter.model = model;
    if (connectionId) filter.connectionId = connectionId;
    if (apiKey) filter.apiKey = apiKey;
    if (userId) filter.userId = userId;
    if (status) filter.status = status;
    if (startDate) filter.startDate = startDate;
    if (endDate) filter.endDate = endDate;

    const result = await getRequestDetails(filter);

    // Redact conversation payloads unless includeRaw is set: the stored details
    // include full request bodies (user prompts, tool calls) and provider responses.
    // Returning them wholesale lets any dashboard-authenticated user (or, if
    // requireLogin is disabled, anyone) read every user's conversation history.
    // Keep the metadata (model, tokens, latency, status) but drop message content.
    const redactedDetails = (result.details || []).map((d) => {
      if (includeRaw) return d;
      const redacted = { ...d };
      for (const key of ["request", "providerRequest", "providerResponse", "response"]) {
        if (redacted[key] !== undefined) {
          redacted[key] = { redacted: true };
        }
      }
      return redacted;
    });

    // Name the key and its owner on every row, so the admin sees WHO made the
    // request, not just a masked key.
    const owners = await describeKeysByRaw(redactedDetails.map((d) => d.apiKey));
    // A key deleted since the request no longer resolves live; the owner
    // snapshotted on the row at request time still names the customer.
    const details = redactedDetails.map((d) => ({
      ...d,
      // Both model names, whichever view is shown: the Details panel lists them side by side.
      requestedModel: d.requestedModel || null,
      upstreamModel: d.model ?? null,
      keyInfo: d.apiKey ? owners[d.apiKey] ?? snapshotKeyInfo(d.owner) ?? { kind: "unknown" } : null,
    }));

    return NextResponse.json({ ...result, details, modelView, sort, order });
  } catch (error) {
    console.error("[API] Failed to get request details:", error);
    return NextResponse.json(
      { error: "Failed to fetch request details" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/usage/request-details
 * Admin "Clear all request logs" button. Wipes every row in the request-details
 * (request log) table. This route is served behind the dashboard auth guard via
 * Next.js middleware (same as the GET above). usageHistory (usage accounting) is
 * intentionally NOT cleared — this is the request log, not the billing ledger.
 */
export async function DELETE() {
  try {
    const deleted = await clearAllRequestDetails();
    return NextResponse.json({ ok: true, deleted });
  } catch (error) {
    console.error("[API] Failed to clear request details:", error);
    return NextResponse.json(
      { error: "Failed to clear request details" },
      { status: 500 }
    );
  }
}
