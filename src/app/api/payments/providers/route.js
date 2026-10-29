import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { createProvider, listProviders } from "@/lib/db/repos/paymentProvidersRepo.js";
import { getAdminActor } from "@/lib/auth/adminIdentity";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/** The base URL SePay should call, derived from the operator's configured site URL. */
async function webhookBaseUrl() {
  try {
    const db = await getAdapter();
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    const data = row ? JSON.parse(row.data) : {};
    const configured = typeof data?.publicBaseUrl === "string" ? data.publicBaseUrl.trim() : "";
    if (configured) return configured.replace(/\/+$/, "");
  } catch {
    // fall through
  }
  return "";
}

/** GET /api/payments/providers — every provider, secrets reduced to `{ set, last4 }`. */
export async function GET() {
  try {
    const providers = await listProviders();
    return NextResponse.json(
      { providers, webhookUrl: `${await webhookBaseUrl()}/api/payments/sepay/webhook` },
      { headers: NO_STORE }
    );
  } catch {
    return NextResponse.json({ error: "Không tải được nguồn nhận tiền" }, { status: 500, headers: NO_STORE });
  }
}

/**
 * POST /api/payments/providers
 *
 * SePay's webhook key is generated server-side and returned ONCE here: the admin
 * copies it into SePay and can never read it again (spec payment-provider-admin
 * "Secret not echoed").
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400, headers: NO_STORE });
  }

  try {
    const result = await createProvider(body);
    // One audit-shaped log line, no secrets: the operator can see who added an
    // account without the row carrying a credential.
    const actor = await getAdminActor(request);
    console.warn(`[payments] provider created by ${actor}: ${result.provider.kind}/${result.provider.id}`);
    // `createProvider` already returns the public projection PLUS the one-time
    // webhook key, so the POST and GET shapes stay identical apart from that key.
    return NextResponse.json(
      { provider: result.provider, webhookKey: result.webhookKey },
      { status: 201, headers: NO_STORE }
    );
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Không tạo được nguồn nhận tiền" }, { status: 400, headers: NO_STORE });
  }
}
