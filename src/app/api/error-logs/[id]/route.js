import { NextResponse } from "next/server";
import { getErrorLog, deleteErrorLog } from "../../../../lib/db/repos/errorLogsRepo.js";

export const dynamic = "force-dynamic";

export async function GET(_request, { params }) {
  const { id } = await params;
  const row = await getErrorLog(id);
  if (!row) return NextResponse.json({ error: "Error log entry not found" }, { status: 404 });
  return NextResponse.json(row);
}

export async function DELETE(_request, { params }) {
  const { id } = await params;
  const removed = await deleteErrorLog(id);
  if (!removed) return NextResponse.json({ error: "Error log entry not found" }, { status: 404 });
  return NextResponse.json({ removed: 1 });
}
