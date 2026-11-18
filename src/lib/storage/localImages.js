// Generated images kept on the router's own disk, for the customers the admin
// picked ("Lưu ảnh trên máy chủ"). Files live under DATA_DIR/generated-images/
// <yyyymmdd>/<uuid>.<ext> and are served publicly by /api/public/images/<name>,
// where <name> = <yyyymmdd>-<uuid>.<ext>: unguessable, and nothing else under
// DATA_DIR can be named by it.
//
// Synchronous DB helpers take `db` first and end in `Sync`. Relative imports only.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { getDataDir } from "../dataDir.js";
import { isBlockedAddress } from "../../shared/utils/ssrfGuard.js";

// DATA_DIR also holds the database: images stop well before the disk is full.
export const LOCAL_IMAGE_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;
const USAGE_CACHE_MS = 60_000;

const DIR = "generated-images";
const NAME = /^(\d{8})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(png|jpg|webp|gif)$/;
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const TYPE = Object.fromEntries(Object.entries(EXT).map(([type, ext]) => [ext, type]));
export const LOCAL_IMAGE_ROUTE = "/api/public/images";

function root() {
  return path.join(getDataDir(), DIR);
}

/** Absolute path of a public name, or null when the name is not one of ours. */
function fileOf(name) {
  const match = NAME.exec(String(name || ""));
  if (!match) return null;
  return { file: path.join(root(), match[1], `${match[2]}.${match[3]}`), type: TYPE[match[3]] };
}

// A host a customer could never open: the server's own bind address.
const UNREACHABLE_HOST = /^(0\.0\.0\.0|localhost|127\.\d+\.\d+\.\d+|\[::1?\])(:\d+)?$/i;
const HOST = /^[a-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-f:.]+\](:\d{1,5})?$/i;

/**
 * The public origin links are built on: `settings.publicBaseUrl` when set, else
 * the host the reverse proxy forwarded (x-forwarded-host / host, with
 * x-forwarded-proto). Never `request.url`: in Next it carries the server's bind
 * address (http://0.0.0.0:20128), a dead link. "" when no usable origin is known.
 */
export function localImageBaseUrl(request, settings) {
  const configured = typeof settings?.publicBaseUrl === "string" ? settings.publicBaseUrl.trim() : "";
  if (configured) return configured.replace(/\/+$/, "");
  const headers = request?.headers;
  const first = (name) => String(headers?.get?.(name) || "").split(",")[0].trim();
  const host = first("x-forwarded-host") || first("host");
  if (!host || !HOST.test(host) || UNREACHABLE_HOST.test(host)) return "";
  // A name the internet cannot resolve: a Docker service ("router:20128") or a
  // private/loopback address forwarded by a proxy that did not set Host.
  const bare = host.replace(/:\d{1,5}$/, "").replace(/^\[|\]$/g, "");
  const isIp = /^[\d.]+$/.test(bare) || bare.includes(":");
  if (isIp ? isBlockedAddress(bare) : !bare.includes(".")) return "";
  const proto = first("x-forwarded-proto").toLowerCase();
  return `${proto === "http" ? "http" : "https"}://${host.toLowerCase()}`;
}

/** Free bytes on the volume holding DATA_DIR, or null when the platform cannot say. */
export function localFreeBytes() {
  try {
    fs.mkdirSync(root(), { recursive: true });
    const stats = fs.statfsSync(root());
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

/** Write one image (atomically); returns its public name. `type` is a sniffed image type. */
export function saveLocalImage(bytes, type, now = new Date(), { freeBytes = localFreeBytes } = {}) {
  const ext = EXT[type];
  if (!ext) throw new Error("unsupported image type");
  const free = freeBytes();
  if (free != null && free - bytes.length < LOCAL_IMAGE_MIN_FREE_BYTES) {
    const error = new Error("disk almost full");
    error.code = "LOW_DISK";
    throw error;
  }
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  const id = crypto.randomUUID();
  const dir = path.join(root(), day);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.${ext}`);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw error;
  }
  return `${day}-${id}.${ext}`;
}

/**
 * `{ stream, size, type }` for a public name, or null. The file is streamed:
 * a popular link must not hold 25 MB buffers or block the event loop.
 */
export async function openLocalImage(name) {
  const target = fileOf(name);
  if (!target) return null;
  try {
    const stat = await fs.promises.stat(target.file);
    if (!stat.isFile()) return null;
    return { stream: Readable.toWeb(fs.createReadStream(target.file)), size: stat.size, type: target.type };
  } catch {
    return null;
  }
}

/** `{ size, type }` for a public name without opening it (HEAD), or null. */
export async function statLocalImage(name) {
  const target = fileOf(name);
  if (!target) return null;
  try {
    const stat = await fs.promises.stat(target.file);
    return stat.isFile() ? { size: stat.size, type: target.type } : null;
  } catch {
    return null;
  }
}

/** Test helper: the bytes of a stored image, or null. */
export async function readLocalImage(name) {
  const target = fileOf(name);
  if (!target) return null;
  try {
    return { bytes: await fs.promises.readFile(target.file), type: target.type };
  } catch {
    return null;
  }
}

let usageCache = null;

/**
 * Files and bytes kept on disk, plus the free space (the admin overview). Scanned
 * without blocking and cached for a minute: the page reloads often.
 */
export async function localImagesUsage({ fresh = false } = {}) {
  if (!fresh && usageCache && Date.now() - usageCache.at < USAGE_CACHE_MS) return usageCache.value;
  let files = 0;
  let bytes = 0;
  let days = [];
  try {
    days = (await fs.promises.readdir(root(), { withFileTypes: true })).filter((d) => d.isDirectory() && /^\d{8}$/.test(d.name));
  } catch {
    days = [];
  }
  for (const day of days) {
    let entries = [];
    try {
      entries = await fs.promises.readdir(path.join(root(), day.name), { withFileTypes: true });
    } catch {
      continue; // removed meanwhile
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.endsWith(".tmp")) continue;
      files += 1;
      try { bytes += (await fs.promises.stat(path.join(root(), day.name, entry.name))).size; } catch { /* removed meanwhile */ }
    }
  }
  const value = { files, bytes, freeBytes: localFreeBytes(), minFreeBytes: LOCAL_IMAGE_MIN_FREE_BYTES };
  usageCache = { at: Date.now(), value };
  return value;
}

// ─── which customers ─────────────────────────────────────────────────────────

export function isLocalImageUserSync(db, userId) {
  if (!userId) return false;
  return Number(db.get(`SELECT imageStorageLocal FROM users WHERE id = ?`, [userId])?.imageStorageLocal) === 1;
}

export function setLocalImageUserSync(db, userId, enabled) {
  const res = db.run(`UPDATE users SET imageStorageLocal = ? WHERE id = ?`, [enabled ? 1 : 0, userId]);
  return (res?.changes ?? 0) > 0;
}

export function localImageUsersSync(db) {
  return db.all(`SELECT id, email, displayName FROM users WHERE imageStorageLocal = 1 ORDER BY email`)
    .map((row) => ({ userId: row.id, email: row.email, name: row.displayName || null }));
}
