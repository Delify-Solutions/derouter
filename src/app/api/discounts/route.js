import { NextResponse } from "next/server";
import { listDiscounts, createDiscount } from "@/lib/db/repos/modelDiscountsRepo.js";
import { SCOPE_TYPES } from "@/lib/billing/discounts.js";

// Admin-only: /api/discounts is not in PUBLIC_API_PATHS, so dashboardGuard
// requires the admin session for every method.
export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

// GET /api/discounts?scopeType=combo|plan|group&scopeId=...
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const scopeType = searchParams.get("scopeType");
    const scopeId = searchParams.get("scopeId");
    if (scopeType && !SCOPE_TYPES.includes(scopeType)) {
      return NextResponse.json({ error: "Phạm vi không hợp lệ" }, { status: 400, headers: NO_STORE });
    }
    return NextResponse.json(await listDiscounts({ scopeType, scopeId }), { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Không tải được danh sách giảm giá" }, { status: 500, headers: NO_STORE });
  }
}

// POST /api/discounts — create one rule. 400 { error, errors:[{field,message}] } on validation.
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu gửi lên không hợp lệ" }, { status: 400, headers: NO_STORE });
  }
  try {
    const result = await createDiscount(body && typeof body === "object" ? body : {});
    if (!result.ok) {
      return NextResponse.json({ error: result.errors[0].message, errors: result.errors }, { status: 400, headers: NO_STORE });
    }
    return NextResponse.json({ rule: result.rule }, { status: 201, headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Không tạo được giảm giá" }, { status: 500, headers: NO_STORE });
  }
}
