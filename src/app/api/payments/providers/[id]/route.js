import { NextResponse } from "next/server";
import {
  getProvider,
  updateProvider,
  deleteProvider,
} from "@/lib/db/repos/paymentProvidersRepo.js";
import { clearAcbToken } from "@/lib/payments/poller.js";
import { getAdminActor } from "@/lib/auth/adminIdentity";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request, { params }) {
  const { id } = await params;
  try {
    const provider = await getProvider(id);
    if (!provider) return NextResponse.json({ error: "Không tìm thấy nguồn nhận tiền" }, { status: 404, headers: NO_STORE });
    return NextResponse.json({ provider }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Không tải được nguồn nhận tiền" }, { status: 500, headers: NO_STORE });
  }
}

/**
 * PATCH /api/payments/providers/[id]
 *
 * Secrets are write-only: an empty string keeps the stored value, a non-empty one
 * replaces it. `regenerateWebhookKey: true` issues a new key and returns it once
 * (spec payment-provider-admin "Provider configuration").
 *
 * When the credentials that mint an ACB token change, the cached token is cleared
 * in the same request (design D1/7.3): leaving it would make the next poll present
 * a token ACB minted for other credentials, which reads as a refusal.
 */
export async function PATCH(request, { params }) {
  const { id } = await params;
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400, headers: NO_STORE });
  }

  try {
    const result = await updateProvider(id, body);
    if (!result) return NextResponse.json({ error: "Không tìm thấy nguồn nhận tiền" }, { status: 404, headers: NO_STORE });

    if (result.credentialsChanged && result.provider.kind === "acb") {
      await clearAcbToken(id).catch(() => {});
    }

    const actor = await getAdminActor(request);
    console.warn(`[payments] provider updated by ${actor}: ${result.provider.kind}/${id}`);

    return NextResponse.json(
      { provider: result.provider, webhookKey: result.webhookKey ?? null },
      { headers: NO_STORE }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || "Không lưu được nguồn nhận tiền" },
      { status: 400, headers: NO_STORE }
    );
  }
}

/**
 * DELETE — refused with 409 while any order or transaction references the provider
 * (spec payment-provider-admin). Historical money must stay attributable, so the
 * only way out is to disable it.
 */
export async function DELETE(request, { params }) {
  const { id } = await params;
  try {
    const result = await deleteProvider(id);
    if (result.ok) {
      const actor = await getAdminActor(request);
      console.warn(`[payments] provider deleted by ${actor}: ${id}`);
      return NextResponse.json({ success: true }, { headers: NO_STORE });
    }
    if (result.reason === "not_found") {
      return NextResponse.json({ error: "Không tìm thấy nguồn nhận tiền" }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json(
      {
        error: result.reason === "has_orders"
          ? `Nguồn này đã có ${result.count} đơn hàng — hãy tắt thay vì xoá`
          : `Nguồn này đã có ${result.count} giao dịch — hãy tắt thay vì xoá`,
        code: result.reason,
        count: result.count,
      },
      { status: 409, headers: NO_STORE }
    );
  } catch {
    return NextResponse.json({ error: "Không xoá được nguồn nhận tiền" }, { status: 500, headers: NO_STORE });
  }
}
