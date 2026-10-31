import { NextResponse } from "next/server";
import { getDiscount, updateDiscount, deleteDiscount } from "@/lib/db/repos/modelDiscountsRepo.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const rule = await getDiscount(id);
    if (!rule) return NextResponse.json({ error: "Không tìm thấy giảm giá" }, { status: 404, headers: NO_STORE });
    return NextResponse.json({ rule }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Không tải được giảm giá" }, { status: 500, headers: NO_STORE });
  }
}

// PATCH — partial update. The scope of a rule cannot change.
export async function PATCH(request, { params }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu gửi lên không hợp lệ" }, { status: 400, headers: NO_STORE });
  }
  try {
    const { id } = await params;
    const result = await updateDiscount(id, body && typeof body === "object" ? body : {});
    if (result.notFound) return NextResponse.json({ error: "Không tìm thấy giảm giá" }, { status: 404, headers: NO_STORE });
    if (!result.ok) {
      return NextResponse.json({ error: result.errors[0].message, errors: result.errors }, { status: 400, headers: NO_STORE });
    }
    return NextResponse.json({ rule: result.rule }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Không lưu được giảm giá" }, { status: 500, headers: NO_STORE });
  }
}

export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const removed = await deleteDiscount(id);
    if (!removed) return NextResponse.json({ error: "Không tìm thấy giảm giá" }, { status: 404, headers: NO_STORE });
    return NextResponse.json({ success: true }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Không xóa được giảm giá" }, { status: 500, headers: NO_STORE });
  }
}
