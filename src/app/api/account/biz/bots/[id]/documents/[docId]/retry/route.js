import { NextResponse } from "next/server";
import { retryDocumentSync } from "@/lib/db/repos/bizDocumentsRepo.js";
import { failure, NO_STORE, withBot } from "@/lib/biz/apiAuth.js";
import { kickIngest } from "@/lib/biz/ingestWorker.js";
import { invalidateBotCache } from "@/lib/biz/retrieval.js";

export const dynamic = "force-dynamic";

/**
 * POST — re-embed a `failed` or `stale` document from its stored chunks and set it
 * back to `processing`; 409 for any other status (spec "Retry and stale documents").
 */
export async function POST(request, { params }) {
  const { id, docId } = await params;
  const scope = await withBot(request, { botId: id });
  if (scope.response) return scope.response;

  const doc = scope.db.get(`SELECT id FROM bizDocuments WHERE id = ? AND botId = ?`, [docId, id]);
  if (!doc) return NextResponse.json({ error: "Không tìm thấy tài liệu" }, { status: 404, headers: NO_STORE });

  const result = retryDocumentSync(scope.db, docId, { currentModel: scope.business.embeddingModel });
  if (!result.ok) return failure(result.error, result.status);

  invalidateBotCache(id);
  kickIngest();
  return NextResponse.json({ document: result.document }, { status: 202, headers: NO_STORE });
}
