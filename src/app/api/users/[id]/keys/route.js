import { NextResponse } from "next/server";
import { getAdapter } from "@/lib/db/driver.js";
import { getUserById } from "@/lib/localDb";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/users/[id]/keys — the customer's keys, with prefix (never the secret),
 * creation date, status and last use (spec admin-user-management, `API key` tab).
 *
 * "Last use" is the latest usage row attributed to the key, which is the only
 * honest answer: the key row itself is not touched on every request.
 */
export async function GET(request, { params }) {
  const { id } = await params;
  const user = await getUserById(id);
  if (!user) {
    return NextResponse.json({ error: "Không tìm thấy người dùng" }, { status: 404, headers: NO_STORE });
  }

  const db = await getAdapter();
  const rows = db.all(
    `SELECT k.id, k.name, k.keyPrefix, k.isActive, k.createdAt, k.expiresAt,
            (SELECT MAX(uh.timestamp) FROM usageHistory uh
              WHERE uh.apiKeyId = k.id OR (uh.apiKey IS NOT NULL AND uh.apiKey = k.key)) AS lastUsedAt
       FROM apiKeys k
      WHERE k.userId = ?
      ORDER BY k.createdAt DESC`,
    [id]
  );

  return NextResponse.json(
    {
      keys: rows.map((row) => ({
        id: row.id,
        name: row.name ?? null,
        keyPrefix: row.keyPrefix ?? null,
        isActive: row.isActive === 1 || row.isActive === true,
        createdAt: row.createdAt ?? null,
        expiresAt: row.expiresAt ?? null,
        lastUsedAt: row.lastUsedAt ?? null,
      })),
    },
    { headers: NO_STORE }
  );
}
