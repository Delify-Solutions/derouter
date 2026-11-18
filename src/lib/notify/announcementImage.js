// The one image an announcement may carry (shown on /account/notifications and
// sent as a Telegram photo). Stored as a file under DATA_DIR, named by the
// announcement id; the type is kept in announcements.imageType.
//
// Only JPEG, PNG and WebP are accepted, detected from the bytes rather than the
// name or the browser-declared type: they are the formats Telegram's sendPhoto
// takes, and none of them can carry script when served back (no SVG).
//
// Relative imports only: tests import this module directly.

import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "../dataDir.js";

export const ANNOUNCEMENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const ANNOUNCEMENT_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

const FORM_OVERHEAD_BYTES = 256 * 1024;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** "image/jpeg" | "image/png" | "image/webp" from the file's first bytes, or null. */
export function detectImageType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) return "image/png";
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/**
 * Check an uploaded image. @returns {{ value: { buffer: Buffer, type: string } } | { error: string }}
 */
export function validateAnnouncementImage(buffer) {
  if (!buffer?.length) return { error: "Ảnh trống" };
  if (buffer.length > ANNOUNCEMENT_IMAGE_MAX_BYTES) return { error: "Ảnh tối đa 5 MB" };
  const type = detectImageType(buffer);
  if (!type) return { error: "Chỉ nhận ảnh JPG, PNG hoặc WebP" };
  return { value: { buffer, type } };
}

/**
 * Read an announcement save request: multipart (fields + an optional `image`
 * file) from the admin page, or plain JSON without an image.
 * @returns {Promise<{ fields: object, image: { buffer: Buffer, type: string } | null } | { error: string }>}
 */
export async function readAnnouncementRequest(request) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    try {
      const fields = await request.json();
      return { fields: fields && typeof fields === "object" ? fields : {}, image: null };
    } catch {
      return { error: "Dữ liệu không hợp lệ" };
    }
  }
  // Refused before the body is read: the form fields add a few KB to the image.
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > ANNOUNCEMENT_IMAGE_MAX_BYTES + FORM_OVERHEAD_BYTES) {
    return { error: "Ảnh tối đa 5 MB" };
  }
  let form;
  try {
    form = await request.formData();
  } catch {
    return { error: "Dữ liệu không hợp lệ" };
  }
  const text = (key) => (typeof form.get(key) === "string" ? form.get(key) : "");
  const flag = (key) => form.get(key) === "true";
  const fields = {
    title: text("title"),
    body: text("body"),
    important: flag("important"),
    sendTelegram: flag("sendTelegram"),
    removeImage: flag("removeImage"),
  };
  const file = form.get("image");
  if (!file || typeof file === "string" || !file.size) return { fields, image: null };
  if (file.size > ANNOUNCEMENT_IMAGE_MAX_BYTES) return { error: "Ảnh tối đa 5 MB" };
  const checked = validateAnnouncementImage(Buffer.from(await file.arrayBuffer()));
  if (checked.error) return { error: checked.error };
  return { fields, image: checked.value };
}

/** Response headers for serving a stored image back. */
export function imageResponseHeaders(type) {
  return {
    "Content-Type": type,
    // The URL carries the announcement's updatedAt, so a replaced image gets a new URL.
    "Cache-Control": "private, max-age=86400",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": "inline",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  };
}

function fileOf(id) {
  if (!ID.test(String(id || ""))) return null;
  return path.join(getDataDir(), "announcement-images", String(id));
}

export function saveAnnouncementImage(id, buffer) {
  const file = fileOf(id);
  if (!file) throw new Error("invalid announcement id");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Written beside and renamed over, so a reader never sees half a file.
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, buffer, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

/** The stored bytes, or null when there is none. */
export function readAnnouncementImage(id) {
  const file = fileOf(id);
  if (!file) return null;
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

export function removeAnnouncementImage(id) {
  const file = fileOf(id);
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
  } catch { /* already gone */ }
}
