import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getApiKeys, getKeyGroups, listUsers } from "@/lib/localDb";
import { createUser, normalizeEmail } from "@/lib/db/repos/userRepo.js";
import bcrypt from "bcryptjs";

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
  } catch {
    return NextResponse.json({ error: "Failed to load users" }, { status: 500, headers: NO_STORE });
  }
}

/**
 * POST /api/users — admin creates an account.
 *
 * The public signup flow exists, but an operator needs to add a customer without
 * that customer receiving mail (no SMTP relay configured, or an account arranged
 * out of band). Creating one here skips verification and marks the account
 * active: the admin vouches for the address, and leaving it "unverified" would
 * lock the customer out until mail is set up.
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ" }, { status: 400, headers: NO_STORE });
  }

  const email = normalizeEmail(body?.email);
  if (!email) {
    return NextResponse.json({ error: "Email không hợp lệ" }, { status: 400, headers: NO_STORE });
  }

  const password = typeof body?.password === "string" ? body.password : "";
  // Same floor as the public signup form; a weaker password set by an admin would
  // quietly become the weakest account in the system.
  if (password.length < 8) {
    return NextResponse.json({ error: "Mật khẩu phải có ít nhất 8 ký tự" }, { status: 400, headers: NO_STORE });
  }

  const existing = (await listUsers()).find((u) => u.email === email);
  if (existing) {
    return NextResponse.json({ error: "Email này đã có tài khoản" }, { status: 409, headers: NO_STORE });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await createUser({
      email,
      passwordHash,
      displayName: typeof body?.displayName === "string" ? body.displayName.trim() || null : null,
      groupId: typeof body?.groupId === "string" && body.groupId.trim() ? body.groupId.trim() : undefined,
      // Verified by the admin's word, not by mail.
      status: "active",
    });
    return NextResponse.json({ user }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || "Không tạo được tài khoản" },
      { status: 400, headers: NO_STORE }
    );
  }
}
