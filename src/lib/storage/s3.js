// Minimal S3-compatible client: AWS Signature V4 for PUT/DELETE and presigned GET.
// One protocol covers AWS S3, Cloudflare R2, Backblaze B2, Wasabi, DigitalOcean
// Spaces, MinIO, iDrive e2 and anything else that speaks the S3 API.
//
// Never logs credentials, signed URLs or the Authorization header.
// Relative imports only: tests import this module directly.

import crypto from "node:crypto";

const sha256Hex = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding as SigV4 wants it (encodeURIComponent leaves !'()* alone). */
export function uriEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Object key → path, each segment encoded once, slashes kept. */
export function encodeKey(key) {
  return String(key).split("/").map(uriEncode).join("/");
}

function amzDate(date) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function signingKey(secretAccessKey, dateStamp, region, service = "s3") {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

function canonicalQuery(params) {
  return Object.keys(params)
    .sort()
    .map((key) => `${uriEncode(key)}=${uriEncode(String(params[key]))}`)
    .join("&");
}

/**
 * Where an object lives: `{ url, host, path }`. Path-style puts the bucket in the
 * path (MinIO, most S3-compatible services, R2); virtual-hosted puts it in the
 * host name (AWS default).
 */
export function objectLocation({ endpoint, bucket, forcePathStyle = true }, key) {
  const base = new URL(endpoint);
  const encodedKey = encodeKey(key);
  const basePath = base.pathname.replace(/\/+$/, "");
  if (forcePathStyle) {
    const path = `${basePath}/${uriEncode(bucket)}/${encodedKey}`;
    return { url: `${base.protocol}//${base.host}${path}`, host: base.host, path };
  }
  const host = `${bucket}.${base.host}`;
  const path = `${basePath}/${encodedKey}`;
  return { url: `${base.protocol}//${host}${path}`, host, path };
}

/**
 * Sign a request with an Authorization header.
 * @param {{ method: string, host: string, path: string, query?: object, headers?: object,
 *           payloadHash: string, region: string, accessKeyId: string, secretAccessKey: string,
 *           date?: Date }} input
 * @returns {object} the headers to send (host excluded: fetch sets it)
 */
export function signHeaders({ method, host, path, query = {}, headers = {}, payloadHash, region, accessKeyId, secretAccessKey, date = new Date() }) {
  const { amzDate: stamp, dateStamp } = amzDate(date);
  const all = { ...lowerKeys(headers), host, "x-amz-content-sha256": payloadHash, "x-amz-date": stamp };
  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((name) => `${name}:${String(all[name]).trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [method, path, canonicalQuery(query), canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = crypto.createHmac("sha256", signingKey(secretAccessKey, dateStamp, region)).update(stringToSign).digest("hex");
  const out = { ...all };
  delete out.host;
  out.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}

function lowerKeys(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) out[key.toLowerCase()] = value;
  return out;
}

/** A presigned GET URL (query-string auth), valid `expiresSec` seconds (max 7 days). */
export function presignGetUrl(config, key, { expiresSec = 604800, date = new Date() } = {}) {
  const { url, host, path } = objectLocation(config, key);
  const { amzDate: stamp, dateStamp } = amzDate(date);
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const query = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${config.accessKeyId}/${scope}`,
    "X-Amz-Date": stamp,
    "X-Amz-Expires": String(Math.min(604800, Math.max(1, Math.floor(expiresSec)))),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalRequest = ["GET", path, canonicalQuery(query), `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = crypto.createHmac("sha256", signingKey(config.secretAccessKey, dateStamp, config.region)).update(stringToSign).digest("hex");
  return `${url}?${canonicalQuery(query)}&X-Amz-Signature=${signature}`;
}

function failReason(error) {
  if (error?.blocked) return "blocked";
  return error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : "network_error";
}

/** What a caller needs from a failed S3 call: status and the S3 error code, never the body. */
async function failure(res) {
  const text = await res.text().catch(() => "");
  const code = /<Code>([^<]{1,80})<\/Code>/.exec(text)?.[1] || null;
  return { ok: false, status: res.status, code };
}

/**
 * PUT one object. `fetchImpl` must refuse internal targets (safeFetch) when the
 * endpoint is user-supplied.
 * @returns {Promise<{ ok: true } | { ok: false, status?: number, code?: string, reason?: string }>}
 */
export async function putObject(config, key, body, contentType, { fetchImpl = fetch, timeoutMs = 60_000, date } = {}) {
  const { url, host, path } = objectLocation(config, key);
  const headers = signHeaders({
    method: "PUT",
    host,
    path,
    // content-length is left to the transport (safeFetch sets it from the body).
    headers: { "content-type": contentType },
    payloadHash: sha256Hex(body),
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    date,
  });
  try {
    const res = await fetchImpl(url, { method: "PUT", headers, body, signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? { ok: true } : await failure(res);
  } catch (error) {
    return { ok: false, reason: failReason(error), notSent: Boolean(error?.notSent) };
  }
}

export async function deleteObject(config, key, { fetchImpl = fetch, timeoutMs = 15_000, date } = {}) {
  const { url, host, path } = objectLocation(config, key);
  const headers = signHeaders({
    method: "DELETE",
    host,
    path,
    payloadHash: sha256Hex(""),
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    date,
  });
  try {
    const res = await fetchImpl(url, { method: "DELETE", headers, signal: AbortSignal.timeout(timeoutMs) });
    return res.ok || res.status === 404 ? { ok: true } : await failure(res);
  } catch (error) {
    return { ok: false, reason: failReason(error), notSent: Boolean(error?.notSent) };
  }
}
