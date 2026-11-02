import { NextResponse } from "next/server";
import { consumeVerification, getUserById, updateUser } from "@/lib/localDb";
import { VERIFICATION_PURPOSE } from "@/lib/users/register";
import { recordActivity } from "@/lib/db/repos/activityRepo.js";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request) {
  const token = request.nextUrl.searchParams.get("token");
  if (!token) {
    return NextResponse.json({ error: "Missing token" }, { status: 400, headers: NO_STORE });
  }

  const userId = await consumeVerification(token, VERIFICATION_PURPOSE);
  if (!userId) {
    return NextResponse.json(
      { error: "This link is invalid or has expired. Request a new one." },
      { status: 400, headers: NO_STORE }
    );
  }

  const user = await getUserById(userId);
  if (!user) {
    return NextResponse.json({ error: "Account not found" }, { status: 404, headers: NO_STORE });
  }

  // Only unverified accounts flip; activating a suspended account through an old
  // verification link would let an admin's action be undone.
  if (user.status === "unverified") {
    await updateUser(user.id, { status: "active" });
  }

  await recordActivity(request, { userId: user.id, action: "email_verified" });
  return NextResponse.json({ ok: true, email: user.email }, { headers: NO_STORE });
}
