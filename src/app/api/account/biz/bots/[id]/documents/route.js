import { NextResponse } from "next/server";
import { listDocumentsSync, createDocumentSync } from "@/lib/db/repos/bizDocumentsRepo.js";
import { badRequest, failure, NO_STORE, withBot } from "@/lib/biz/apiAuth.js";
import { extractFileText, MAX_UPLOAD_BYTES, UNREADABLE_SCAN, nonWhitespaceLength } from "@/lib/biz/extract.js";
import { chunkText, qaChunks, utf8Bytes } from "@/lib/biz/chunking.js";
import { kickIngest } from "@/lib/biz/ingestWorker.js";
import { recordActivity } from "@/lib/db/repos/activityRepo.js";

export const dynamic = "force-dynamic";

/** GET — the bot's documents with `stale` computed against the current model. */
export async function GET(request, { params }) {
  const { id } = await params;
  const scope = await withBot(request, { botId: id });
  if (scope.response) return scope.response;
  const documents = listDocumentsSync(scope.db, id, scope.business.embeddingModel);
  return NextResponse.json({ documents }, { headers: NO_STORE });
}

/**
 * POST — add one document in one of three forms (spec business-bots "Knowledge
 * base ingestion"):
 *   multipart, field `file`      PDF/DOCX/TXT/MD up to 10 MB
 *   JSON `{type:"text", title, text}`
 *   JSON `{type:"qa", title, pairs:[{question,answer}]}`
 *
 * Text extraction runs here, in the request. The row and its chunks are written in
 * one transaction (202, status `processing`); the worker embeds them afterwards.
 */
export async function POST(request, { params }) {
  const { id } = await params;
  const scope = await withBot(request, { botId: id });
  if (scope.response) return scope.response;
  const { session, db, bot } = scope;

  const contentType = request.headers.get("content-type") || "";
  let title = "";
  let sourceType = "text";
  let mime = null;
  let text = "";
  let chunks = [];
  let status = "processing";
  let error = null;

  if (contentType.includes("multipart/form-data")) {
    let form;
    try {
      form = await request.formData();
    } catch {
      return badRequest("Không đọc được tệp tải lên");
    }
    const file = form.get("file");
    if (!file || typeof file === "string") return badRequest("Cần chọn tệp để tải lên");
    if (Number(file.size) > MAX_UPLOAD_BYTES) return failure("Tệp vượt quá 10 MB", 413);

    const extracted = await extractFileText({
      bytes: new Uint8Array(await file.arrayBuffer()),
      filename: file.name || "",
      mime: file.type || "",
    });
    if (!extracted.ok) return failure(extracted.error, extracted.status);

    sourceType = "file";
    mime = file.type || null;
    title = String(form.get("title") || file.name || "Tài liệu").trim().slice(0, 200);
    text = extracted.text;

    if (nonWhitespaceLength(text) < 20) {
      // A scanned PDF still becomes a VISIBLE row, so the customer learns why it
      // answers nothing instead of watching an upload vanish.
      chunks = chunkText(text);
      status = "failed";
      error = UNREADABLE_SCAN;
    } else {
      chunks = chunkText(text);
    }
  } else {
    let body;
    try {
      body = await request.json();
    } catch {
      return badRequest("Invalid request body");
    }
    const type = body?.type === "qa" ? "qa" : "text";
    title = typeof body?.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : "Tài liệu";

    if (type === "qa") {
      sourceType = "qa";
      const built = qaChunks(body?.pairs);
      if (built.error) return badRequest(built.error);
      chunks = built.chunks;
      text = chunks.join("\n\n");
    } else {
      sourceType = "text";
      const bodyText = typeof body?.text === "string" ? body.text.trim() : "";
      if (!bodyText) return badRequest("Cần nhập nội dung văn bản");
      text = bodyText;
      if (utf8Bytes(text) > MAX_UPLOAD_BYTES) return failure("Tệp vượt quá 10 MB", 413);
      chunks = chunkText(text);
    }
    if (chunks.length === 0) return badRequest("Nội dung quá ngắn để tạo tài liệu");
  }

  const result = db.transaction(() =>
    createDocumentSync(
      db,
      { botId: id, userId: session.userId, title, sourceType, mime, text, chunks, status, error },
      { currentModel: scope.business.embeddingModel }
    )
  );
  if (!result.ok) return failure(result.error, result.status);

  if (result.document.status === "processing") kickIngest();
  await recordActivity(request, {
    userId: session.userId,
    action: "biz_document_create",
    details: { botId: bot.id, docId: result.document.id, title: result.document.title, chunks: result.document.chunkCount },
  });
  return NextResponse.json({ document: result.document }, { status: 202, headers: NO_STORE });
}
