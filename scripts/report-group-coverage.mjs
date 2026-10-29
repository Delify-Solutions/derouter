#!/usr/bin/env node
// Group coverage report — READ-ONLY. Run this against a copy of the production
// data BEFORE deploying a release that enforces groups on customer keys: it lists
// what that release would start rejecting.
//
//   node scripts/report-group-coverage.mjs [--days 30] [--rpm-days 7]
//
// For each active group it prints:
//   1. every model its members called in the last N days that the group's
//      allow-list does not allow, with request counts and the top 5 callers;
//   2. members whose combined requests in any single minute of the last 7 days
//      exceeded the group RPM;
//   3. members whose combined tokens in any single minute of the last 7 days
//      exceeded the group TPM.
//
// Guarantees:
//   * the database file is opened read-only (better-sqlite3 `readonly`, else
//     node:sqlite with the read-only flag) and is never written — no WAL
//     checkpoint, no migration, no `getAdapter()` (which runs migrations);
//   * exit code 0 on success, including when nothing is wrong.
import fs from "node:fs";
import path from "node:path";

// ── Argument parsing ─────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { days: 30, rpmDays: 7 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--days" && next) { out.days = Math.max(1, parseInt(next, 10) || 30); i += 1; }
    else if (arg === "--rpm-days" && next) { out.rpmDays = Math.max(1, parseInt(next, 10) || 7); i += 1; }
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log("Usage: node scripts/report-group-coverage.mjs [--days 30] [--rpm-days 7]");
  process.exit(0);
}

// ── Resolve DATA_DIR exactly as the app does, without importing the driver ───
async function resolveDataFile() {
  const { DATA_FILE } = await import("../src/lib/db/paths.js");
  return DATA_FILE;
}

// ── Read-only driver ────────────────────────────────────────────────────────
// Returns { all(sql, params) } or null. node:sqlite requires Node >= 22.5; the
// better-sqlite3 path is tried first because that is what the app runs on.
async function openReadOnly(file) {
  try {
    const mod = await import("better-sqlite3");
    const Database = mod.default ?? mod;
    const db = new Database(file, { readonly: true, fileMustExist: true });
    return {
      driver: "better-sqlite3",
      all: (sql, params = []) => db.prepare(sql).all(...params),
      close: () => db.close(),
    };
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND" && error?.code !== "MODULE_NOT_FOUND") {
      // A real open failure (missing file, corrupt DB) must not silently fall
      // through to a second driver that would report the same thing worse.
      throw error;
    }
  }

  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    return {
      driver: "node:sqlite",
      all: (sql, params = []) => db.prepare(sql).all(...params),
      close: () => db.close(),
    };
  } catch (error) {
    throw new Error(`No read-only SQLite driver available: ${error?.message || error}`);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function parseJson(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw !== "string") return raw;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function pct(num, den) {
  if (!den) return "0%";
  return `${Math.round((num / den) * 100)}%`;
}

async function main() {
  const file = await resolveDataFile();
  if (!fs.existsSync(file)) {
    console.error(`No database at ${file} — set DATA_DIR to the copy you want to inspect.`);
    process.exit(1);
  }

  const { matchesAllowed } = await import("../src/lib/auth/modelMatching.js");
  const db = await openReadOnly(file);

  try {
    const sinceDays = new Date(Date.now() - args.days * 24 * 60 * 60 * 1000).toISOString();
    const sinceRate = new Date(Date.now() - args.rpmDays * 24 * 60 * 60 * 1000).toISOString();

    const groups = db.all(`SELECT * FROM keyGroups ORDER BY createdAt ASC, rowid ASC`);
    const users = db.all(
      `SELECT id, email, groupId, status FROM users`
    );
    const userById = new Map(users.map((u) => [u.id, u]));
    const membersByGroup = new Map();
    for (const user of users) {
      const key = user.groupId ?? "";
      if (!membersByGroup.has(key)) membersByGroup.set(key, []);
      membersByGroup.get(key).push(user);
    }

    // One scan of the window's usage rows, joined to the owning key → user. The
    // model a member "called" is meta.requestedModel when present (an alias or
    // combo name), falling back to the resolved pool model.
    const rows = db.all(
      `SELECT uh.timestamp AS timestamp,
              uh.model AS model,
              COALESCE(json_extract(uh.meta, '$.requestedModel'), uh.model) AS calledModel,
              COALESCE(uh.promptTokens, 0) + COALESCE(uh.completionTokens, 0) AS tokens,
              ak.userId AS userId
         FROM usageHistory uh
         JOIN apiKeys ak ON ak.userId IS NOT NULL AND (ak.id = uh.apiKeyId OR ak.key = uh.apiKey)
        WHERE uh.timestamp >= ?`,
      [sinceDays]
    );

    console.log(`Group coverage report — ${args.days} day(s) of usage, ${args.rpmDays} day(s) for RPM/TPM`);
    console.log(`Database: ${file} (read-only, driver ${db.driver})`);
    console.log(`Rows scanned: ${rows.length}\n`);

    let problems = 0;

    for (const group of groups) {
      const members = membersByGroup.get(group.id) ?? [];
      const memberIds = new Set(members.map((m) => m.id));
      const allowed = parseJson(group.allowedModels, null);
      const groupRows = rows.filter((r) => r.userId && memberIds.has(r.userId));

      console.log(`## ${group.name}${group.isActive === 1 || group.isActive === true ? "" : " (inactive)"}`);
      console.log(`   members: ${members.length} · requests in window: ${groupRows.length}`);

      // 1. Models outside the allow-list.
      if (!Array.isArray(allowed) || allowed.length === 0) {
        console.log("   allow-list: (unrestricted) — no uncovered model possible");
      } else {
        const uncovered = new Map();
        for (const row of groupRows) {
          const model = row.calledModel || row.model;
          if (!model) continue;
          if (matchesAllowed(model, allowed)) continue;
          if (!uncovered.has(model)) uncovered.set(model, { count: 0, users: new Map() });
          const entry = uncovered.get(model);
          entry.count += 1;
          entry.users.set(row.userId, (entry.users.get(row.userId) || 0) + 1);
        }
        if (uncovered.size === 0) {
          console.log("   uncovered models: none");
        } else {
          problems += uncovered.size;
          console.log(`   uncovered models: ${uncovered.size}`);
          const sorted = [...uncovered.entries()].sort((a, b) => b[1].count - a[1].count);
          for (const [model, entry] of sorted) {
            const top = [...entry.users.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 5)
              .map(([userId, count]) => `${userById.get(userId)?.email || userId} (${count})`)
              .join(", ");
            console.log(`     - ${model}: ${entry.count} request(s) · top: ${top}`);
          }
        }
      }

      // 2-3. Per-minute combined RPM/TPM. A member's own keys share the allowance,
      // so the bucket is per user, per minute.
      const rpmLimit = Number.isFinite(Number(group.rpm)) && Number(group.rpm) > 0 ? Number(group.rpm) : null;
      const tpmLimit = Number.isFinite(Number(group.tpm)) && Number(group.tpm) > 0 ? Number(group.tpm) : null;

      if (rpmLimit || tpmLimit) {
        const buckets = new Map();
        for (const row of groupRows) {
          if (!row.timestamp || row.timestamp < sinceRate) continue;
          const minute = String(row.timestamp).slice(0, 16);
          const key = `${row.userId}|${minute}`;
          const acc = buckets.get(key) || { userId: row.userId, minute, requests: 0, tokens: 0 };
          acc.requests += 1;
          acc.tokens += Number(row.tokens) || 0;
          buckets.set(key, acc);
        }

        if (rpmLimit) {
          const over = [...buckets.values()].filter((b) => b.requests > rpmLimit)
            .sort((a, b) => b.requests - a.requests);
          if (over.length === 0) {
            console.log(`   over RPM ${rpmLimit}: none`);
          } else {
            problems += over.length;
            console.log(`   over RPM ${rpmLimit}: ${over.length} user-minute(s)`);
            for (const bucket of over.slice(0, 20)) {
              console.log(`     - ${userById.get(bucket.userId)?.email || bucket.userId} @ ${bucket.minute}: ${bucket.requests} request(s)`);
            }
          }
        }

        if (tpmLimit) {
          const over = [...buckets.values()].filter((b) => b.tokens > tpmLimit)
            .sort((a, b) => b.tokens - a.tokens);
          if (over.length === 0) {
            console.log(`   over TPM ${tpmLimit}: none`);
          } else {
            problems += over.length;
            console.log(`   over TPM ${tpmLimit}: ${over.length} user-minute(s)`);
            for (const bucket of over.slice(0, 20)) {
              console.log(`     - ${userById.get(bucket.userId)?.email || bucket.userId} @ ${bucket.minute}: ${bucket.tokens} token(s)`);
            }
          }
        }
      } else {
        console.log("   RPM/TPM: (unlimited) — no over-limit possible");
      }

      console.log("");
    }

    // Users with no group at all would silently lose every model once groups are
    // enforced; the start-up repair assigns them the default group, so list them
    // so the operator can confirm that is intended.
    const ungrouped = users.filter((u) => !u.groupId || !groups.some((g) => g.id === u.groupId));
    if (ungrouped.length > 0) {
      console.log(`## Users without a valid group (${ungrouped.length}) — the next start assigns the default group`);
      for (const user of ungrouped.slice(0, 50)) {
        console.log(`   - ${user.email} (${user.status})`);
      }
      console.log("");
    }

    console.log(problems === 0
      ? "Result: no group configuration gaps found."
      : `Result: ${problems} gap(s) listed above — adjust group allow-lists / RPM / TPM before deploying.`);

    // Informational coverage summary.
    const activeGroups = groups.filter((g) => g.isActive === 1 || g.isActive === true);
    if (groups.length > 0) {
      console.log("");
      console.log("Coverage:");
      for (const group of activeGroups) {
        const members = membersByGroup.get(group.id) ?? [];
        const total = rows.filter((r) => r.userId && members.some((m) => m.id === r.userId)).length;
        console.log(`   ${group.name}: ${pct(total, rows.length)} of the window's requests`);
      }
    }
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`report-group-coverage failed: ${error?.message || error}`);
    process.exit(1);
  }
);
