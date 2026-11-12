import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getAdminActor } from "@/lib/auth/adminIdentity";
import { validateReason } from "@/lib/billing/adminActions.js";
import { adminUnlinkTelegramSync, getTelegramLinkSync } from "@/lib/db/repos/telegramLinkRepo.js";
import { messages, notifyCustomer } from "@/lib/notify/customerTelegram.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

const ERRORS = {
  not_found: { status: 404, error: "Không tìm thấy người dùng" },
  not_linked: { status: 409, error: "Tài khoản này chưa liên kết Telegram" },
  changed: { status: 409, error: "Liên kết Telegram vừa thay đổi. Tải lại rồi thử lại." },
};

/**
 * DELETE /api/users/[id]/telegram — `{ reason }`: the admin removes the
 * account's Telegram link (change telegram-admin). The Telegram user is told
 * first, while the link still exists; the removal is audited.
 */
export async function DELETE(request, { params }) {
  const { id } = await params;
  const actor = await getAdminActor(request);

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400, headers: NO_STORE });
  }
  if (!validateReason(body?.reason)) {
    return NextResponse.json({ error: "Lý do phải có từ 3 đến 500 ký tự" }, { status: 400, headers: NO_STORE });
  }

  const db = await getAdapter();
  const current = getTelegramLinkSync(db, id);
  if (current.linked) {
    // Best effort and bounded by the notifier's own timeout: a Telegram outage
    // must not stop the admin from removing a link.
    await notifyCustomer(id, "security", messages.telegramUnlinkedByAdmin(), { force: true }).catch(() => {});
  }
  try {
    const result = db.transaction(() => adminUnlinkTelegramSync(db, id, {
      actor,
      reason: body.reason.trim(),
      expectTelegramUserId: current.telegramUserId,
    }));
    if (result.error) {
      const mapped = ERRORS[result.error];
      return NextResponse.json({ error: mapped.error }, { status: mapped.status, headers: NO_STORE });
    }
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Không gỡ được liên kết Telegram" }, { status: 500, headers: NO_STORE });
  }
}
