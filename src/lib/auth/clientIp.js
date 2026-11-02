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

/** Trusted client IP of a Request (custom-server stamp, or TRUST_PROXY), else null. */
export function getRequestIp(request) {
  const headers = request?.headers;
  if (!headers?.get) return null;
  if (hasTrustedPeerHeaders(request)) {
    const stamped = clean(headers.get("x-dr-real-ip"));
    if (stamped) return stamped;
  }
  if (process.env.TRUST_PROXY === "true") {
    const xff = headers.get("x-forwarded-for");
    if (xff) return clean(xff.split(",")[0]);
  }
  return null;
}

/** User agent capped for storage. */
export function getRequestUserAgent(request) {
  const ua = request?.headers?.get?.("user-agent");
  return ua ? String(ua).slice(0, 300) : null;
}
