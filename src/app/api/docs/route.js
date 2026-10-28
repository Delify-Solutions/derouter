import { NextResponse } from "next/server";
import { listAllDocs, createDoc } from "@/lib/localDb";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/** Admin list: drafts included, bodies omitted (the list only shows metadata). */
export async function GET() {
  try {
    const docs = await listAllDocs();
    return NextResponse.json(
      { docs: docs.map(({ body, ...rest }) => rest) },
      { headers: NO_STORE }
    );
  } catch {
    return NextResponse.json({ error: "Không tải được danh sách trang" }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400, headers: NO_STORE });
  }

  try {
    const doc = await createDoc(body);
    return NextResponse.json({ doc }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || "Không tạo được trang" },
      { status: 400, headers: NO_STORE }
    );
  }
}
