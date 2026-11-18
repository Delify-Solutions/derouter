// A customer's own image storage (S3-compatible) and the re-hosting of generated
// images onto it. A customer key may only use image models once its owner has
// connected a storage; every image is then uploaded there and the response
// carries that storage's link instead of the upstream's (spec image-storage).
//
// Synchronous DB helpers take `db` first and end in `Sync`. Relative imports
// only: tests import this module directly.

import crypto from "node:crypto";
import { decryptSecret, encryptSecret } from "../crypto/secrets.js";
import { assertPublicUrl, assertPublicUrlResolved, fetchPublic } from "../../shared/utils/ssrfGuard.js";
import { safeFetch } from "./safeHttp.js";
import { deleteObject, encodeKey, presignGetUrl, putObject } from "./s3.js";

/** Form presets. They only prefill the form; every one speaks the S3 API. */
export const STORAGE_PROVIDERS = {
  s3: { label: "Amazon S3", region: "us-east-1", forcePathStyle: false },
  r2: { label: "Cloudflare R2", region: "auto", forcePathStyle: true },
  b2: { label: "Backblaze B2", region: "us-west-004", forcePathStyle: true },
  spaces: { label: "DigitalOcean Spaces", region: "sgp1", forcePathStyle: false },
  minio: { label: "MinIO", region: "us-east-1", forcePathStyle: true },
  other: { label: "S3-compatible khác", region: "us-east-1", forcePathStyle: true },
};

export const IMAGE_DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
export const STORAGE_REQUIRED_MESSAGE =
  "Bạn chưa kết nối CDN lưu ảnh. Vào Tài khoản → CDN ảnh (/account/storage) để kết nối S3, Cloudflare R2, Backblaze B2… rồi thử lại.";

const REGION = /^[a-z0-9-]{1,40}$/;
const BUCKET = /^[a-z0-9][a-z0-9._-]{2,62}$/;
const PREFIX_SEGMENT = /^[A-Za-z0-9._-]{1,64}$/;

// ─── validation ──────────────────────────────────────────────────────────────

function httpsUrl(raw, label) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    return { error: `${label} không phải URL hợp lệ` };
  }
  if (url.protocol !== "https:") return { error: `${label} phải bắt đầu bằng https://` };
  if (url.username || url.password) return { error: `${label} không được chứa tài khoản/mật khẩu` };
  if (url.search || url.hash) return { error: `${label} không được có ?query hoặc #` };
  try {
    assertPublicUrl(url.toString());
  } catch {
    return { error: `${label} trỏ vào địa chỉ nội bộ, không được phép` };
  }
  return { value: `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}` };
}

/**
 * Check a storage form. `existing` (the stored row) lets the secret be left blank
 * to keep the saved one. @returns {{ value: object } | { error: string }}
 */
export function validateStorageInput(input = {}, existing = null) {
  const provider = typeof input.provider === "string" && STORAGE_PROVIDERS[input.provider] ? input.provider : null;
  if (!provider) return { error: "Chọn loại lưu trữ" };
  const preset = STORAGE_PROVIDERS[provider];

  const region = String(input.region ?? "").trim().toLowerCase() || preset.region;
  if (!REGION.test(region)) return { error: "Region chỉ gồm chữ thường, số và dấu gạch ngang" };

  let endpoint = String(input.endpoint ?? "").trim();
  if (!endpoint && provider === "s3") endpoint = `https://s3.${region}.amazonaws.com`;
  if (!endpoint) return { error: "Nhập endpoint S3 (https://…)" };
  const checkedEndpoint = httpsUrl(endpoint, "Endpoint");
  if (checkedEndpoint.error) return checkedEndpoint;

  const bucket = String(input.bucket ?? "").trim();
  if (!BUCKET.test(bucket)) return { error: "Tên bucket không hợp lệ (3–63 ký tự: chữ thường, số, . - _)" };

  // Blank keeps the stored key id (the page only ever sees it masked).
  const accessKeyId = String(input.accessKeyId ?? "").trim() || existing?.accessKeyId || "";
  if (!accessKeyId || accessKeyId.length > 256 || /\s/.test(accessKeyId)) return { error: "Nhập Access Key ID" };

  const secretInput = String(input.secretAccessKey ?? "").trim();
  if (secretInput && (secretInput.length > 512 || /\s/.test(secretInput))) return { error: "Secret Access Key không hợp lệ" };
  if (!secretInput && !existing?.secretAccessKey) return { error: "Nhập Secret Access Key" };

  let publicBaseUrl = null;
  if (String(input.publicBaseUrl ?? "").trim()) {
    const checked = httpsUrl(input.publicBaseUrl, "Link công khai");
    if (checked.error) return checked;
    publicBaseUrl = checked.value;
  }

  const prefixRaw = String(input.pathPrefix ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (prefixRaw.length > 100) return { error: "Thư mục tối đa 100 ký tự" };
  const segments = prefixRaw ? prefixRaw.split("/") : [];
  if (segments.some((s) => !PREFIX_SEGMENT.test(s) || s === "." || s === "..")) {
    return { error: "Thư mục chỉ gồm chữ, số, . - _ và dấu /" };
  }

  return {
    value: {
      provider,
      endpoint: checkedEndpoint.value,
      region,
      bucket,
      accessKeyId,
      secretAccessKey: secretInput || null, // null = keep the stored one
      forcePathStyle: typeof input.forcePathStyle === "boolean" ? input.forcePathStyle : preset.forcePathStyle,
      publicBaseUrl,
      pathPrefix: segments.join("/") || null,
      enabled: input.enabled !== false,
    },
  };
}

// ─── storage rows ────────────────────────────────────────────────────────────

export function getStorageRowSync(db, userId) {
  if (!userId) return null;
  return db.get(`SELECT * FROM userStorage WHERE userId = ?`, [userId]) || null;
}

function maskKey(value) {
  const text = String(value || "");
  return text.length <= 8 ? `${text.slice(0, 2)}…` : `${text.slice(0, 4)}…${text.slice(-4)}`;
}

/** What the pages see: everything but the secret, and the key id masked. */
export function toPublicStorage(row) {
  if (!row) return null;
  return {
    provider: row.provider,
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    accessKeyIdMasked: maskKey(row.accessKeyId),
    hasSecret: Boolean(row.secretAccessKey),
    forcePathStyle: Number(row.forcePathStyle) === 1,
    publicBaseUrl: row.publicBaseUrl || null,
    pathPrefix: row.pathPrefix || null,
    enabled: Number(row.enabled) === 1,
    lastTestAt: row.lastTestAt || null,
    lastTestOk: row.lastTestOk == null ? null : Number(row.lastTestOk) === 1,
    lastError: row.lastError || null,
    updatedBy: row.updatedBy || null,
    updatedAt: row.updatedAt,
  };
}

/**
 * Insert or replace the account's storage. A blank secret keeps the stored one
 * (a blank key id was already resolved by validateStorageInput). Changing
 * where or how it writes clears the last test result.
 */
export function saveStorageSync(db, userId, value, { actor = "customer", now = new Date().toISOString() } = {}) {
  const existing = getStorageRowSync(db, userId);
  const secret = value.secretAccessKey ? encryptSecret(value.secretAccessKey) : existing?.secretAccessKey;
  if (!secret) throw new Error("secret required");
  const moved = !existing
    || existing.endpoint !== value.endpoint
    || existing.bucket !== value.bucket
    || existing.region !== value.region
    || existing.accessKeyId !== value.accessKeyId
    || Boolean(value.secretAccessKey)
    || Number(existing.forcePathStyle) !== (value.forcePathStyle ? 1 : 0)
    || (existing.publicBaseUrl || null) !== value.publicBaseUrl;
  db.run(
    `INSERT INTO userStorage(userId, provider, endpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyle,
                             publicBaseUrl, pathPrefix, enabled, lastTestAt, lastTestOk, lastError, updatedBy, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(userId) DO UPDATE SET
       provider = excluded.provider, endpoint = excluded.endpoint, region = excluded.region, bucket = excluded.bucket,
       accessKeyId = excluded.accessKeyId, secretAccessKey = excluded.secretAccessKey,
       forcePathStyle = excluded.forcePathStyle, publicBaseUrl = excluded.publicBaseUrl, pathPrefix = excluded.pathPrefix,
       enabled = excluded.enabled, lastTestAt = excluded.lastTestAt, lastTestOk = excluded.lastTestOk,
       lastError = excluded.lastError, updatedBy = excluded.updatedBy, updatedAt = excluded.updatedAt`,
    [
      userId, value.provider, value.endpoint, value.region, value.bucket, value.accessKeyId, secret,
      value.forcePathStyle ? 1 : 0, value.publicBaseUrl, value.pathPrefix, value.enabled ? 1 : 0,
      moved ? null : existing.lastTestAt, moved ? null : existing.lastTestOk, moved ? null : existing.lastError,
      actor, existing?.createdAt || now, now,
    ]
  );
  return getStorageRowSync(db, userId);
}

export function deleteStorageSync(db, userId) {
  const res = db.run(`DELETE FROM userStorage WHERE userId = ?`, [userId]);
  return (res?.changes ?? 0) > 0;
}

export function recordStorageResultSync(db, userId, { ok, error = null, now = new Date().toISOString() }) {
  db.run(
    `UPDATE userStorage SET lastTestAt = ?, lastTestOk = ?, lastError = ? WHERE userId = ?`,
    [now, ok ? 1 : 0, ok ? null : String(error || "").slice(0, 300), userId]
  );
}

/** The decrypted config the S3 client needs, or null when none is usable. */
export function storageConfigFromRow(row) {
  return usableConfig(row);
}

function usableConfig(row) {
  if (!row || Number(row.enabled) !== 1) return null;
  const secretAccessKey = decryptSecret(row.secretAccessKey);
  if (!secretAccessKey) return null;
  return {
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    accessKeyId: row.accessKeyId,
    secretAccessKey,
    forcePathStyle: Number(row.forcePathStyle) === 1,
    publicBaseUrl: row.publicBaseUrl || null,
    pathPrefix: row.pathPrefix || null,
  };
}

// ─── links, uploads, test ────────────────────────────────────────────────────

/** The link handed to the customer: the public base + key, or a 7-day presigned URL. */
export function objectLink(config, key, { date } = {}) {
  if (config.publicBaseUrl) return `${config.publicBaseUrl}/${encodeKey(key)}`;
  return presignGetUrl(config, key, { date });
}

function objectKey(config, ext, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const name = `images/${day}/${crypto.randomUUID()}.${ext}`;
  return config.pathPrefix ? `${config.pathPrefix}/${name}` : name;
}

/** A Vietnamese reason for a failed S3 call, without anything secret in it. */
export function describeStorageError(result) {
  if (!result || result.ok) return null;
  if (result.reason === "blocked") return "Endpoint trỏ vào địa chỉ nội bộ, không được phép";
  if (result.reason === "timeout") return "Endpoint không phản hồi (quá thời gian)";
  if (result.reason === "network_error") return "Không kết nối được endpoint";
  const code = result.code ? ` (${result.code})` : "";
  if (["InvalidAccessKeyId", "SignatureDoesNotMatch"].includes(result.code)) return `Sai Access Key ID hoặc Secret${code}`;
  if (result.code === "AccessDenied" || result.status === 403) return `Key không có quyền ghi vào bucket${code}`;
  if (result.code === "NoSuchBucket" || result.status === 404) return `Không tìm thấy bucket${code}`;
  if (result.status === 301 || result.code === "PermanentRedirect" || result.code === "AuthorizationHeaderMalformed") {
    return `Sai region hoặc endpoint của bucket${code}`;
  }
  return `Lưu trữ trả lỗi HTTP ${result.status || "?"}${code}`;
}

/**
 * The storage a customer's image request may use: enabled, its secret readable,
 * and its last write test (or last real upload) successful. A storage that failed
 * must be re-tested before images flow again, so a broken bucket costs at most one
 * request. @returns {{ config: object } | { error: string }}
 */
export function usableStorageSync(db, userId) {
  const row = getStorageRowSync(db, userId);
  if (!row || Number(row.enabled) !== 1) return { error: STORAGE_REQUIRED_MESSAGE };
  const config = usableConfig(row);
  if (!config) return { error: "Không đọc được Secret của CDN lưu ảnh. Vào /account/storage nhập lại Secret Access Key rồi lưu." };
  if (Number(row.lastTestOk) !== 1) {
    const why = row.lastError ? `: ${row.lastError}` : "";
    return { error: `CDN lưu ảnh chưa kiểm tra thành công${why}. Vào /account/storage bấm "Kiểm tra lại" rồi thử lại.` };
  }
  return { config };
}

// ─── calls to the customer's endpoint ────────────────────────────────────────

// The endpoint is customer-supplied: https only, no redirect, and the address
// dialed is checked at connect time (safeHttp).
const storageFetch = safeFetch;

/**
 * @returns {Promise<{ ok: boolean, sent: boolean, ... }>} `sent` = the body may have
 * left the router: anything but a failure before the secure connection was up.
 */
async function put(config, key, bytes, type, fetchImpl) {
  let result;
  try {
    result = await putObject(config, key, bytes, type, { fetchImpl });
  } catch (error) {
    result = { ok: false, reason: error?.blocked ? "blocked" : "network_error", notSent: Boolean(error?.notSent || error?.blocked) };
  }
  return { ...result, sent: result.ok || !(result.notSent || result.reason === "blocked") };
}

/**
 * Upload a small file, read it back through the link the customer would get,
 * then delete it. @returns {Promise<{ ok: boolean, error?: string, warning?: string }>}
 */
export async function testStorage(config, { fetchImpl = storageFetch } = {}) {
  const key = (config.pathPrefix ? `${config.pathPrefix}/` : "") + `derouter-test/${crypto.randomUUID()}.txt`;
  const body = Buffer.from(`derouter storage test ${new Date().toISOString()}\n`);
  const written = await put(config, key, body, "text/plain; charset=utf-8", fetchImpl);
  if (!written.ok) return { ok: false, error: describeStorageError(written) };
  let warning = null;
  try {
    const res = await fetchImpl(objectLink(config, key), { method: "GET", signal: AbortSignal.timeout(15_000) });
    await res.arrayBuffer().catch(() => null);
    if (!res.ok) {
      warning = config.publicBaseUrl
        ? `Ghi được nhưng link công khai trả HTTP ${res.status}: kiểm tra bucket đã bật truy cập công khai/custom domain chưa`
        : `Ghi được nhưng link tải về trả HTTP ${res.status}`;
    }
  } catch {
    warning = "Ghi được nhưng không mở được link tải về";
  }
  await deleteObject(config, key, { fetchImpl }).catch(() => {});
  return warning ? { ok: true, warning } : { ok: true };
}

// ─── re-hosting generated images ─────────────────────────────────────────────

/** "image/png" | "image/jpeg" | "image/webp" | "image/gif" from the bytes, or null. */
export function sniffImage(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buffer.toString("ascii", 0, 6) === "GIF87a" || buffer.toString("ascii", 0, 6) === "GIF89a") return "image/gif";
  return null;
}

const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

class TooLarge extends Error {
  constructor() {
    super("too large");
  }
}

function decodeBase64Capped(text) {
  // 4 base64 characters carry 3 bytes: refuse before decoding anything big.
  if (Math.floor((text.length * 3) / 4) > IMAGE_DOWNLOAD_MAX_BYTES + 2) throw new TooLarge();
  const bytes = Buffer.from(text, "base64");
  if (bytes.length > IMAGE_DOWNLOAD_MAX_BYTES) throw new TooLarge();
  return bytes;
}

async function readCapped(res) {
  const declared = Number(res.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > IMAGE_DOWNLOAD_MAX_BYTES) throw new TooLarge();
  const reader = res.body?.getReader?.();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > IMAGE_DOWNLOAD_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw new TooLarge();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** Bytes of one generated image: inline base64, a data: URL, or the upstream's link. */
async function imageBytes(item, downloadImpl) {
  if (typeof item?.b64_json === "string" && item.b64_json) return decodeBase64Capped(item.b64_json);
  const url = typeof item?.url === "string" ? item.url : "";
  const dataUrl = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i.exec(url);
  if (dataUrl) return decodeBase64Capped(dataUrl[1]);
  if (!/^https?:\/\//i.test(url)) throw new Error("no image");
  const res = await downloadImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`download ${res.status}`);
  return readCapped(res);
}

/**
 * Upload raw image bytes.
 * @returns {Promise<{ ok: true, url: string } | { ok: false, error: string, sent: boolean, storageFault: boolean }>}
 *   sent: the bytes may have reached the customer's endpoint (the request is charged).
 *   storageFault: the storage refused or failed, as opposed to a bad image.
 */
export async function uploadImage(config, bytes, { fetchImpl = storageFetch, now = new Date() } = {}) {
  if (bytes.length > IMAGE_DOWNLOAD_MAX_BYTES) return { ok: false, error: "Ảnh vượt quá 25 MB", sent: false, storageFault: false };
  const type = sniffImage(bytes);
  if (!type) return { ok: false, error: "Ảnh trả về không đọc được", sent: false, storageFault: false };
  const key = objectKey(config, EXT[type], now);
  const written = await put(config, key, bytes, type, fetchImpl);
  if (!written.ok) return { ok: false, error: describeStorageError(written), sent: written.sent, storageFault: true };
  return { ok: true, url: objectLink(config, key) };
}

// Only these fields reach the customer: anything else an upstream returns could
// carry its own link.
function cleanItem(item, url) {
  const out = { url };
  if (typeof item?.b64_json === "string" && item.b64_json) out.b64_json = item.b64_json;
  if (typeof item?.revised_prompt === "string") out.revised_prompt = item.revised_prompt;
  return out;
}

/**
 * Re-host every image of an OpenAI-shaped response (`{ data: [{ url | b64_json }] }`)
 * onto the customer's storage. Each image gets the storage link; a `b64_json` the
 * client asked for stays. Only `created`, `data` and `usage` are returned.
 *
 * All or nothing for the response: one failed image fails it, so no upstream link
 * reaches the customer. `charge` says whether the request must still be paid: true
 * once any image byte was handed to the customer's endpoint, which the customer
 * controls (a stored image followed by an error answer is still a delivered image).
 * `storageFault` says the customer's storage failed (it is marked failing), as
 * opposed to an upstream that returned no usable image.
 * @returns {Promise<{ ok: true, body: object } | { ok: false, error: string, charge: boolean, storageFault: boolean }>}
 */
export async function rehostImageBody(body, config, { fetchImpl = storageFetch, downloadImpl = fetchPublic, now = new Date() } = {}) {
  const items = Array.isArray(body?.data) ? body.data : [];
  if (!items.length) return { ok: false, error: "Model không trả về ảnh nào", charge: false, storageFault: false };
  const data = [];
  for (const item of items) {
    let bytes;
    try {
      bytes = await imageBytes(item, downloadImpl);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof TooLarge ? "Ảnh vượt quá 25 MB" : "Không tải được ảnh vừa tạo",
        charge: data.length > 0,
        storageFault: false,
      };
    }
    const uploaded = await uploadImage(config, bytes, { fetchImpl, now });
    if (!uploaded.ok) {
      return { ok: false, error: uploaded.error, charge: data.length > 0 || uploaded.sent, storageFault: uploaded.storageFault };
    }
    data.push(cleanItem(item, uploaded.url));
  }
  const out = { created: Number(body.created) || Math.floor(now.getTime() / 1000), data };
  if (body.usage && typeof body.usage === "object") out.usage = body.usage;
  return { ok: true, body: out };
}

// ─── page actions (shared by the customer and the admin routes) ──────────────

/** The page's view of one account's storage, with the form presets. */
export function storageViewSync(db, userId) {
  const presets = Object.fromEntries(
    Object.entries(STORAGE_PROVIDERS).map(([id, p]) => [id, { label: p.label, region: p.region, forcePathStyle: p.forcePathStyle }])
  );
  return { storage: toPublicStorage(getStorageRowSync(db, userId)), providers: presets };
}

// Each test makes the server call the customer's host: a few a minute at most.
const TEST_WINDOW_MS = 10 * 60 * 1000;
const TESTS_PER_WINDOW = 10;
const testLog = new Map();

function testAllowed(userId, now = Date.now()) {
  const recent = (testLog.get(userId) || []).filter((t) => now - t < TEST_WINDOW_MS);
  if (recent.length >= TESTS_PER_WINDOW) {
    testLog.set(userId, recent);
    return false;
  }
  recent.push(now);
  testLog.set(userId, recent);
  if (testLog.size > 10_000) testLog.delete(testLog.keys().next().value);
  return true;
}

export function resetStorageTestLimitForTests() {
  testLog.clear();
}

const RATE_LIMITED = { status: 429, body: { error: "Kiểm tra quá nhiều lần. Thử lại sau ít phút." } };

/** Run the upload test on the saved storage and record its result. */
export async function retestStorage(db, userId, { testImpl = testStorage, rateLimit = false } = {}) {
  const row = getStorageRowSync(db, userId);
  if (!row) return { status: 404, body: { error: "Chưa có cấu hình CDN" } };
  const config = usableConfig({ ...row, enabled: 1 });
  if (!config) return { status: 409, body: { error: "Không đọc được Secret đã lưu. Nhập lại Secret Access Key rồi lưu." } };
  if (rateLimit && !testAllowed(userId)) return RATE_LIMITED;
  const test = await testImpl(config);
  recordStorageResultSync(db, userId, { ok: test.ok, error: test.error });
  return { status: 200, body: { test, ...storageViewSync(db, userId) } };
}

/**
 * Validate, save, then test what was saved. The endpoint and public link are also
 * resolved here, so a name that points inside is refused before it is stored.
 * @returns {Promise<{ status: number, body: object, saved?: boolean }>}
 */
export async function saveAndTestStorage(db, userId, input, { actor = "customer", testImpl = testStorage, rateLimit = false, resolveImpl = assertPublicUrlResolved } = {}) {
  const checked = validateStorageInput(input, getStorageRowSync(db, userId));
  if (checked.error) return { status: 400, body: { error: checked.error } };
  for (const [url, label] of [[checked.value.endpoint, "Endpoint"], [checked.value.publicBaseUrl, "Link công khai"]]) {
    if (!url) continue;
    try {
      await resolveImpl(url);
    } catch {
      return { status: 400, body: { error: `${label} trỏ vào địa chỉ nội bộ, không được phép` } };
    }
  }
  if (rateLimit && !testAllowed(userId)) return RATE_LIMITED;
  saveStorageSync(db, userId, checked.value, { actor });
  // Counted above already: the test itself is not limited a second time.
  return { ...(await retestStorage(db, userId, { testImpl })), saved: true };
}
