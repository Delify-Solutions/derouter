// HTTPS to a customer-supplied host, with the internal-address check done on the
// address actually dialed. A check before the request and a second DNS lookup by
// fetch() would let a host that answers a public address first and 127.0.0.1 next
// (DNS rebinding) reach an internal service. Here the lookup that opens the socket
// is the one that is checked.
//
// No redirects are followed and only https is spoken. The promise settles exactly
// once on every way a request can end (response, error, upgrade, close, timer), so
// a hostile server cannot park a request forever. Relative imports only.

import dns from "node:dns";
import https from "node:https";
import { assertPublicUrl, isBlockedAddress } from "../../shared/utils/ssrfGuard.js";

const MAX_RESPONSE_BYTES = 1024 * 1024; // S3 answers are small XML documents
const HARD_TIMEOUT_MS = 120_000;
const NO_BODY = new Set([204, 205, 304]);

function blocked(message = "Blocked URL: internal host") {
  const error = new Error(message);
  error.blocked = true;
  error.notSent = true;
  return error;
}

/** A `lookup` for http(s).request that refuses internal addresses. */
export function guardedLookup(hostname, options, callback) {
  const opts = typeof options === "object" && options ? options : {};
  dns.lookup(hostname, { ...opts, all: true }, (error, addresses) => {
    if (error) return callback(error);
    const list = Array.isArray(addresses) ? addresses : [];
    if (!list.length) return callback(new Error("no address"));
    if (list.some((a) => isBlockedAddress(a.address))) return callback(blocked());
    if (opts.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

/**
 * fetch()-like: `{ method, headers, body (Buffer), signal }` → a Response.
 * A rejection carries `blocked: true` for an internal or non-https target, and
 * `notSent: true` when it ended before the secure connection was up, so nothing
 * of the body can have reached the server.
 */
export function safeFetch(url, init = {}) {
  return guardedRequest(url, init);
}

/**
 * The request behind safeFetch. The options exist for tests only (a plain-http
 * server on loopback); production always uses the defaults.
 */
export function guardedRequest(url, init = {}, { transport = https, lookup = guardedLookup, protocol = "https:", checkLiteral = true, hardTimeoutMs = HARD_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }
    if (parsed.protocol !== protocol) {
      reject(blocked("Blocked URL: https only"));
      return;
    }
    try {
      // Literal addresses never reach the lookup hook.
      if (checkLiteral) assertPublicUrl(url);
    } catch {
      reject(blocked());
      return;
    }

    let settled = false;
    let connected = false;
    let req = null;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const fail = (error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      if (!connected) err.notSent = true;
      finish(reject, err);
      try { req?.destroy(); } catch { /* already gone */ }
    };

    const headers = { ...(init.headers || {}) };
    const body = init.body == null ? null : Buffer.from(init.body);
    // S3 refuses chunked uploads without a declared length; this header is not signed.
    if (body) headers["content-length"] = String(body.length);

    try {
      req = transport.request(parsed, { method: init.method || "GET", headers, lookup, signal: init.signal }, (res) => {
        const status = res.statusCode || 0;
        if (status < 200 || status > 599) {
          res.destroy();
          fail(new Error(`unexpected status ${status}`));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            fail(new Error("response too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          try {
            const out = new Headers();
            for (const [name, value] of Object.entries(res.headers)) {
              if (Array.isArray(value)) value.forEach((v) => out.append(name, v));
              else if (value != null) out.set(name, String(value));
            }
            finish(resolve, new Response(NO_BODY.has(status) ? null : Buffer.concat(chunks), { status, headers: out }));
          } catch (error) {
            fail(error);
          }
        });
        res.on("error", fail);
        res.on("close", () => fail(new Error("response closed")));
      });
    } catch (error) {
      fail(error);
      return;
    }
    req.on("socket", (socket) => {
      // A reused keep-alive socket is already up; a new one is up once TLS is.
      if (!socket.connecting && !socket.pending) connected = true;
      else socket.once(protocol === "https:" ? "secureConnect" : "connect", () => { connected = true; });
    });
    // A 101 never emits "response": Node hands the socket over here instead.
    req.on("upgrade", (res, socket) => {
      try { socket.destroy(); } catch { /* ignore */ }
      fail(new Error("unexpected upgrade"));
    });
    req.on("error", fail);
    req.on("close", () => fail(new Error("connection closed")));
    // Independent of `signal`: a destroyed request no longer reacts to an abort.
    timer = setTimeout(() => {
      const error = new Error("timeout");
      error.name = "TimeoutError";
      fail(error);
    }, hardTimeoutMs);
    timer.unref?.();
    req.end(body || undefined);
  });
}
