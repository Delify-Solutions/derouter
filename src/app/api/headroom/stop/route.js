import { NextResponse } from "next/server";
import { stopHeadroomProxy } from "@/lib/headroom/process";
import { requirePagePermission } from "@/lib/auth/adminAccess";

export const dynamic = "force-dynamic";

export async function POST(request) {
  const denied = await requirePagePermission(request, "token-saver", "edit");
  if (denied) return denied;
  try {
    const result = stopHeadroomProxy();
    const status = result.stopped ? 200 : 409;
    return NextResponse.json({ ...result }, { status });
  } catch (error) {
    return NextResponse.json({ error: error.message, code: error.code || null }, { status: 500 });
  }
}
