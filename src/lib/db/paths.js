import path from "node:path";
import fs from "node:fs";
// Relative, not the `@/` alias: the persistence layer must stay importable by
// plain Node (tests, CLI tooling) where the app's path alias does not exist.
import { DATA_DIR } from "../dataDir.js";

export const DB_DIR = path.join(DATA_DIR, "db");
export const DATA_FILE = path.join(DB_DIR, "data.sqlite");
export const BACKUPS_DIR = path.join(DB_DIR, "backups");
export const LEGACY_FILES = {
  main: path.join(DATA_DIR, "db.json"),
  usage: path.join(DATA_DIR, "usage.json"),
  disabled: path.join(DATA_DIR, "disabledModels.json"),
  details: path.join(DATA_DIR, "request-details.json"),
};

// SQLite keeps recent writes in these sidecars (WAL mode), so they hold the same
// provider tokens and API keys as data.sqlite and need the same mode.
const SIDECAR_SUFFIXES = ["-wal", "-shm"];

/**
 * Tightens permissions on the SQLite file and its WAL/SHM sidecars. The DB holds
 * provider OAuth tokens, API keys and SSO client secrets, so it must not be
 * readable by other local users.
 *
 * SQLite creates the files itself once it opens the database, so a call before the
 * first write is a no-op (@returns false).
 * @returns {boolean} true when data.sqlite exists and its mode was applied
 */
export function hardenDbFile() {
  try {
    if (!fs.existsSync(DATA_FILE)) return false;
    fs.chmodSync(DATA_FILE, 0o600);
  } catch (err) {
    // Windows and some network filesystems cannot represent POSIX modes; a failure
    // here must not stop the database from opening.
    console.warn(`[DB] Could not restrict permissions on ${DATA_FILE}: ${err.message}`);
    return false;
  }
  for (const suffix of SIDECAR_SUFFIXES) {
    try {
      const sidecar = `${DATA_FILE}${suffix}`;
      if (fs.existsSync(sidecar)) fs.chmodSync(sidecar, 0o600);
    } catch {
      // Sidecars are recreated by SQLite at will; a missed chmod is not fatal.
    }
  }
  return true;
}

let pendingHarden = null;

// On a fresh install data.sqlite does not exist when ensureDirs() runs — SQLite
// creates it moments later with the process umask (typically 0644). Poll briefly so
// the very first write is also protected, then stop: this never runs indefinitely
// and never keeps the event loop alive (unref).
function hardenWhenCreated() {
  if (pendingHarden || process.platform === "win32") return;
  const startedAt = Date.now();
  pendingHarden = setInterval(() => {
    if (hardenDbFile() || Date.now() - startedAt > 15_000) {
      clearInterval(pendingHarden);
      pendingHarden = null;
    }
  }, 200);
  pendingHarden.unref?.();
}

export function ensureDirs() {
  // 0700 on creation: the tree holds OAuth tokens, API keys and the jwt-secret.
  // Only directories we create are re-moded — an operator-supplied DATA_DIR keeps
  // whatever permissions its owner chose.
  for (const dir of [DATA_DIR, DB_DIR, BACKUPS_DIR]) {
    if (fs.existsSync(dir)) continue;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // Mounts that cannot express POSIX modes (or a parent-owned path) are fine.
    }
  }
  if (!hardenDbFile()) hardenWhenCreated();
}
