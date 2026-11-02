import { NextResponse } from "next/server";
import { assignGiftCode, getGiftCodeById } from "@/lib/db/repos/giftRepo.js";
import { getAdminIdentity } from "@/lib/auth/adminIdentity";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };
const MAX_TARGETS = 200;

/** Up to MAX_TARGETS strings from a body field (array or comma/newline-separated text). */
function listOf(value) {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,;]+/) : [];
  return items.map((item) => String(item ?? "").trim()).filter(Boolean);
}

/**
 * POST /api/gift-codes/:id/assign — give this code to accounts without them typing
 * it. Body: `{ userIds?: string[], emails?: string[] | string }`. Answers 200 with
 * one result per account (each may succeed or fail on its own).
 */
export async function POST(request, { params }) {
  const { id } = await params;
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400, headers: NO_STORE });
  }
  const userIds = listOf(body?.userIds);
  const emails = listOf(body?.emails);
  if (userIds.length + emails.length === 0) {
    return NextResponse.json({ error: "Chọn ít nhất một tài khoản" }, { status: 400, headers: NO_STORE });
  }
  if (userIds.length + emails.length > MAX_TARGETS) {
    return NextResponse.json({ error: `Tối đa ${MAX_TARGETS} tài khoản mỗi lần` }, { status: 400, headers: NO_STORE });
  }

  try {
    const actor = `admin:${(await getAdminIdentity(request)) || "admin"}`;
    const result = await assignGiftCode(id, { userIds, emails, actor });
    if (!result.ok) {
      const status = result.reason === "not_found" ? 404 : 400;
      const error = result.reason === "not_found" ? "Không tìm thấy mã quà tặng" : "Chọn ít nhất một tài khoản";
      return NextResponse.json({ error }, { status, headers: NO_STORE });
    }
    return NextResponse.json(
      { results: result.results, code: await getGiftCodeById(id) },
      { headers: NO_STORE }
    );
  } catch (error) {
    console.error("[gift-codes/assign] failed:", error?.message || error);
    return NextResponse.json({ error: "Không gắn được mã" }, { status: 500, headers: NO_STORE });
  }
}
