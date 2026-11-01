import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { getOwnedKeySecret } from "@/lib/account/keySecret";
import { hitLimit } from "@/lib/auth/actionLimiter";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };
// A person shows or copies a key a few times; a script draining keys from a
// stolen session does it thousands of times.
const SECRET_LIMIT = { limit: 60, windowMs: 60_000 };

// Hands one of the signed-in customer's own keys to the browser: to show or copy
// it on /account/keys, or to open the public /usage page, which works from the
// raw key. Only on an explicit press. POST, not GET: a link prefetch or a cached
// response must never carry the secret. The session cookie is SameSite=Lax, so
// another site cannot make this request with it.
//
// Never log the response: it is the secret.
export async function POST(request, { params }) {
  const session = await resolveAccountUser(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const gate = hitLimit(`account-key-secret:${session.userId}`, SECRET_LIMIT);
  if (!gate.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(gate.retryAfterSec) } }
    );
  }

  const { id } = await params;
  const secret = await getOwnedKeySecret(session.userId, id);
  // Someone else's key reads as missing: the id space is not a directory.
  if (!secret) {
    return NextResponse.json({ error: "Key not found" }, { status: 404, headers: NO_STORE });
  }
  return NextResponse.json({ secret }, { headers: NO_STORE });
}
