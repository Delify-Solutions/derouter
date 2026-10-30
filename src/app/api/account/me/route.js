import { NextResponse } from "next/server";
import { resolveAccountUser } from "@/lib/auth/userSession";
import { getKeyGroupById, getUserById, updateUser } from "@/lib/localDb";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
}

/**
 * Wallet totals live in billingRepo (owned by the billing task). Imported lazily
 * so this module keeps working — with a zeroed shape — while that module is absent
 * or a migration is mid-flight.
 */
async function readWallet(userId) {
  try {
    const mod = await import("@/lib/db/repos/billingRepo.js");
    if (typeof mod?.walletSummary === "function") {
      const summary = await mod.walletSummary(userId);
      if (summary && typeof summary === "object") {
        return {
          availableNanoUsd: Number.isFinite(summary.availableNanoUsd) ? summary.availableNanoUsd : 0,
          hasUnlimitedCredit: summary.hasUnlimitedCredit === true,
          overdraftNanoUsd: Number.isFinite(summary.overdraftNanoUsd) ? summary.overdraftNanoUsd : 0,
          totalGrantedNanoUsd: Number.isFinite(summary.totalGrantedNanoUsd) ? summary.totalGrantedNanoUsd : 0,
          plans: Array.isArray(summary.plans) ? summary.plans : [],
        };
      }
    }
  } catch (error) {
    console.error("[account/me] wallet summary unavailable:", error?.message || error);
  }
  return { availableNanoUsd: 0, overdraftNanoUsd: 0, totalGrantedNanoUsd: 0, plans: [] };
}

export async function GET(request) {
  const session = await resolveAccountUser(request);
  if (!session) return unauthorized();

  const user = await getUserById(session.userId);
  if (!user) return unauthorized();

  const [group, wallet] = await Promise.all([
    user.groupId ? getKeyGroupById(user.groupId).catch(() => null) : null,
    readWallet(user.id),
  ]);

  return NextResponse.json(
    {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        status: user.status,
        groupId: user.groupId,
        groupName: group?.name ?? null,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
      },
      wallet,
    },
    { headers: NO_STORE }
  );
}

export async function PATCH(request) {
  const session = await resolveAccountUser(request);
  if (!session) return unauthorized();

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400, headers: NO_STORE });
  }

  // Wholesale patches are not allowed: an account holder changes their display
  // name here, nothing else. Status and group are admin decisions.
  if (!Object.prototype.hasOwnProperty.call(body || {}, "displayName")) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400, headers: NO_STORE });
  }
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  if (displayName.length > 80) {
    return NextResponse.json({ error: "Display name is too long" }, { status: 400, headers: NO_STORE });
  }

  const updated = await updateUser(session.userId, { displayName: displayName || null });
  if (!updated) return unauthorized();

  return NextResponse.json(
    {
      user: {
        id: updated.id,
        email: updated.email,
        displayName: updated.displayName,
        status: updated.status,
        groupId: updated.groupId,
      },
    },
    { headers: NO_STORE }
  );
}
