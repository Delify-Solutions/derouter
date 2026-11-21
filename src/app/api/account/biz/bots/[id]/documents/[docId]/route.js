import { NextResponse } from "next/server";
import { deleteDocumentSync } from "@/lib/db/repos/bizDocumentsRepo.js";
import { NO_STORE, withBot } from "@/lib/biz/apiAuth.js";
import { invalidateBotCache } from "@/lib/biz/retrieval.js";
import { recordActivity } from "@/lib/db/repos/activityRepo.js";

export const dynamic = "force-dynamic";

/** DELETE — remove the document and its chunks (spec business-bots "Retry and stale documents"). */
export async function DELETE(request, { params }) {
  const { id, docId } = await params;
  const scope = await withBot(request, { botId: id });
  if (scope.response) return scope.response;

  // The document must belong to THIS bot.
  const doc = scope.db.get(`SELECT id, title FROM bizDocuments WHERE id = ? AND botId = ?`, [docId, id]);
  if (!doc) return NextResponse.json({ error: "Không tìm thấy tài liệu" }, { status: 404, headers: NO_STORE });

  if (!deleteDocumentSync(scope.db, docId)) {
    return NextResponse.json({ error: "Không tìm thấy tài liệu" }, { status: 404, headers: NO_STORE });
  }
  invalidateBotCache(id);
  await recordActivity(request, {
    userId: scope.session.userId,
    action: "biz_document_delete",
    details: { botId: id, docId, title: doc.title ?? null },
  });
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
