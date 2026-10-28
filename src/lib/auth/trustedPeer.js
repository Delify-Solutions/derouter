import { safeEqual } from "./internalHeaders.js";

// x-dr-real-ip is only trustworthy when custom-server.js stamped it from the TCP socket.
// It proves that by echoing the per-process secret it generated at boot, which a client
// cannot guess. Without the proof the header is just attacker-supplied input.
export function hasTrustedPeerHeaders(request) {
  const token = process.env.DEROUTER_PEER_TOKEN;
  if (!token) return false;
  return safeEqual(token, request.headers.get("x-dr-peer-token"));
}
