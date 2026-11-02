// The client IP to STORE for a request (spec activity-ip-log, design D2).
//
// Unlike the rate-limit bucket key in loginLimiter.getClientIp, which falls back
// to the Host header so every unknown client does not share one bucket, a stored
// IP must be an IP or nothing: it is evidence an admin may ban an account on.
// Relative imports only: tests import this directly.
import { hasTrustedPeerHeaders } from "./trustedPeer.js";

const MAX_IP_LENGTH = 64;

function clean(value) {
  // A proxy that sends "203.0.113.9:51234" still means the IPv4 address.
  const ip = String(value || "").trim().replace(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/, "$1");
  if (!ip || ip.length > MAX_IP_LENGTH || !/^[0-9a-fA-F:.]+$/.test(ip)) return null;
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

/**
 * The address the nearest trusted proxy saw, same rule as custom-server.js:
 * X-Real-IP (nginx sets it to $remote_addr), else the LAST X-Forwarded-For hop.
 * The FIRST hop is whatever the client sent — $proxy_add_x_forwarded_for appends
 * the real peer after it — so reading it let a client pick its own IP.
 */
export function forwardedClientIp(xRealIp, xff) {
  const real = String(xRealIp || "").trim();
  if (real) return real;
  const hops = String(xff || "").split(",").map((hop) => hop.trim()).filter(Boolean);
  return hops.length ? hops[hops.length - 1] : "";
}

/** Trusted client IP of a Request (custom-server stamp, or TRUST_PROXY), else null. */
export function getRequestIp(request) {
  const headers = request?.headers;
  if (!headers?.get) return null;
  if (hasTrustedPeerHeaders(request)) {
    const stamped = clean(headers.get("x-dr-real-ip"));
    if (stamped) return stamped;
  }
  if (process.env.TRUST_PROXY === "true") {
    const forwarded = forwardedClientIp(headers.get("x-real-ip"), headers.get("x-forwarded-for"));
    if (forwarded) return clean(forwarded);
  }
  return null;
}

/** User agent capped for storage. */
export function getRequestUserAgent(request) {
  const ua = request?.headers?.get?.("user-agent");
  return ua ? String(ua).slice(0, 300) : null;
}
