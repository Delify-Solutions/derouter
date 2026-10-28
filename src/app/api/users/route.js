import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getApiKeys, getKeyGroups, listUsers } from "@/lib/localDb";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

async function readWallet(userId) {
  try {
    const mod = await import("@/lib/db/repos/billingRepo.js");
    if (typeof mod?.walletSummary === "function") {
      const summary = await mod.walletSummary(userId);
      if (summary && typeof summary === "object") {
        return {
          availableNanoUsd: Number.isFinite(summary.availableNanoUsd) ? summary.availableNanoUsd : 0,
          totalGrantedNanoUsd: Number.isFinite(summary.totalGrantedNanoUsd) ? summary.totalGrantedNanoUsd : 0,
        };
      }
    }
  } catch {
    // Billing repo not present yet — report zeroes rather than failing the list.
  }
  return { availableNanoUsd: 0, totalGrantedNanoUsd: 0 };
}

export async function GET(request) {
  try {
    const db = await getAdapter();
    const [users, keys, groups] = await Promise.all([listUsers(), getApiKeys(), getKeyGroups()]);

    const groupNames = new Map(groups.map((group) => [group.id, group.name]));
    const keyCounts = new Map();
    for (const key of keys) {
      if (!key.userId) continue;
      keyCounts.set(key.userId, (keyCounts.get(key.userId) || 0) + 1);
    }

    // Session count is a cheap COUNT over an indexed column; a per-user await
    // inside the map would issue one query per row.
    const sessionCounts = new Map();
    try {
      const rows = db.all(
        `SELECT userId, COUNT(*) AS n FROM userSessions WHERE revokedAt IS NULL AND expiresAt > ? GROUP BY userId`,
        [new Date().toISOString()]
      );
      for (const row of rows) sessionCounts.set(row.userId, row.n);
    } catch {
      // Sessions table missing on an old DB — the column just reads 0.
    }

    const statusFilter = request.nextUrl.searchParams.get("status");
    const filtered = statusFilter ? users.filter((user) => user.status === statusFilter) : users;

    const enriched = await Promise.all(
      filtered.map(async (user) => {
        const wallet = await readWallet(user.id);
        return {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          groupId: user.groupId,
          groupName: user.groupId ? groupNames.get(user.groupId) ?? null : null,
          status: user.status,
          createdAt: user.createdAt,
          lastLoginAt: user.lastLoginAt,
          keyCount: keyCounts.get(user.id) || 0,
          activeSessions: sessionCounts.get(user.id) || 0,
          availableNanoUsd: wallet.availableNanoUsd,
          totalGrantedNanoUsd: wallet.totalGrantedNanoUsd,
        };
      })
    );

    return NextResponse.json({ users: enriched }, { headers: NO_STORE });
  } catch (error) {
    console.log("[users] list failed:", error?.message || error);
    return NextResponse.json({ error: "Failed to load users" }, { status: 500, headers: NO_STORE });
  }
}
