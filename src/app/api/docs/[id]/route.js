import { NextResponse } from "next/server";
import { getDocById, updateDoc, deleteDoc } from "@/lib/localDb";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request, { params }) {
  const { id } = await params;
  const doc = await getDocById(id);
  if (!doc) {
    return NextResponse.json({ error: "Không tìm thấy trang" }, { status: 404, headers: NO_STORE });
  }
  return NextResponse.json({ doc }, { headers: NO_STORE });
}

export async function PATCH(request, { params }) {
  const { id } = await params;
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400, headers: NO_STORE });
  }

  try {
    const doc = await updateDoc(id, body);
    if (!doc) {
      return NextResponse.json({ error: "Không tìm thấy trang" }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json({ doc }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || "Không lưu được trang" },
      { status: 400, headers: NO_STORE }
    );
  }
}

export async function DELETE(request, { params }) {
  const { id } = await params;
  const removed = await deleteDoc(id);
  if (!removed) {
    return NextResponse.json({ error: "Không tìm thấy trang" }, { status: 404, headers: NO_STORE });
  }
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
