import { NextResponse } from "next/server";
import { getRequestDetails } from "@/lib/usageDb";

/**
 * GET /api/usage/request-details
 * Query parameters: page, pageSize (1-100), provider, model, connectionId, status, startDate, endDate
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    
    const pageRaw = parseInt(searchParams.get("page"));
    const page = Number.isNaN(pageRaw) ? 1 : pageRaw;
    const pageSizeRaw = parseInt(searchParams.get("pageSize"));
    const pageSize = Number.isNaN(pageSizeRaw) ? 20 : pageSizeRaw;
    const provider = searchParams.get("provider");
    const model = searchParams.get("model");
    const connectionId = searchParams.get("connectionId");
    const apiKey = searchParams.get("apiKey");
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
      pageSize
    };

    if (provider) filter.provider = provider;
    if (model) filter.model = model;
    if (connectionId) filter.connectionId = connectionId;
    if (apiKey) filter.apiKey = apiKey;
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

    return NextResponse.json({ ...result, details: redactedDetails });
  } catch (error) {
    console.error("[API] Failed to get request details:", error);
    return NextResponse.json(
      { error: "Failed to fetch request details" },
      { status: 500 }
    );
  }
}
