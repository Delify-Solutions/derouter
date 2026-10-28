import crypto from "node:crypto";

// Shared, timing-safe string comparison. Both operands must be strings; anything
// else (null/undefined/number) is a non-match. Length is compared first because
// crypto.timingSafeEqual throws on buffers of different length — and early-exit on
// length leaks nothing beyond the (public) length of the expected secret.
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export const INTERNAL_HEADER = "x-dr-internal";

// Requests signed further apart than this are rejected. Keeps a captured header
// from being replayable for the lifetime of the process.
const MAX_SKEW_SECONDS = 60;

function peerToken() {
  const token = process.env.DEROUTER_PEER_TOKEN;
  return typeof token === "string" && token.length > 0 ? token : null;
}

// signInternalRequest accepts either a `Request` (has .method and .url/.nextUrl) or
// a plain descriptor `{ method, url }`, so call sites that only hold a URL string
// can sign without constructing a Request.
function describe(input) {
  if (!input) return null;
  const method = String(input.method || "GET").toUpperCase();
  const rawUrl = input.url ?? input.nextUrl?.href ?? null;
  if (!rawUrl) return null;
  let pathname;
  try {
    pathname = new URL(rawUrl).pathname;
  } catch {
    return null;
  }
  return { method, pathname };
}

function computeSignature(key, method, pathname, exp) {
  return crypto
    .createHmac("sha256", key)
    .update(`${method}\n${pathname}\n${exp}`)
    .digest("hex");
}

/**
 * Builds the internal-request proof header.
 * @param {Request|{method?: string, url?: string}} input
 * @returns {{ "x-dr-internal": string }}
 */
export function signInternalRequest(input) {
  const token = peerToken();
  const desc = describe(input);
  if (!token || !desc) return {};

  const exp = Math.floor(Date.now() / 1000);
  const signature = computeSignature(token, desc.method, desc.pathname, exp);
  return { [INTERNAL_HEADER]: `${signature}.${exp}` };
}

/**
 * Verifies the internal-request proof header. False when the shared secret is
 * unset, the header is missing/malformed, the timestamp is stale, or the MAC
 * does not match.
 * @param {Request} request
 * @returns {boolean}
 */
export function isInternalRequest(request) {
  const token = peerToken();
  if (!token || !request?.headers?.get) return false;

  const header = request.headers.get(INTERNAL_HEADER);
  if (typeof header !== "string" || !header) return false;

  const separator = header.lastIndexOf(".");
  if (separator <= 0) return false;

  const signature = header.slice(0, separator);
  const expRaw = header.slice(separator + 1);
  if (!/^\d+$/.test(expRaw)) return false;

  const exp = Number(expRaw);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - exp) > MAX_SKEW_SECONDS) return false;

  const desc = describe(request);
  if (!desc) return false;

  // The exp comes from the header itself so producer and consumer can never sign
  // different timestamps for the same request.
  const expected = computeSignature(token, desc.method, desc.pathname, exp);
  return safeEqual(expected, signature);
}
