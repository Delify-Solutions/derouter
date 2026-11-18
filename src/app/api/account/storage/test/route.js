import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { getAdapter } from "@/lib/db/driver.js";
import { retestStorage } from "@/lib/storage/userStorage.js";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/** POST /api/account/storage/test — upload, read back and delete a small test file. */
export async function POST(request) {
  const session = await resolveAccountUser(request);
  if (!session) {
    return NextResponse.json({ error: "Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại." }, { status: 401, headers: NO_STORE });
  }
  const result = await retestStorage(await getAdapter(), session.userId, { rateLimit: true });
  return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
}
