const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { pathToFileURL } = require("url");

const origCreate = http.createServer.bind(http);

// Per-process secret proving x-dr-real-ip was stamped below rather than sent by the client.
// A bare `next start` / `next dev` never loads this file, so it cannot produce a matching
// header even though the env var is inherited by child processes. Named like x-dr-cli-token
// so the request-detail header sanitizer redacts it too.
const PEER_TOKEN = crypto.randomBytes(24).toString("hex");
process.env.DEROUTER_PEER_TOKEN = PEER_TOKEN;

let backgroundRefreshStarted = false;

function startBackgroundTokenRefreshFromCustomServer() {
  if (backgroundRefreshStarted) return;
  backgroundRefreshStarted = true;
  // Prefer source path (repo / standalone that still has src). Fail-open if missing
  // — initializeApp also starts the same scheduler when the Next app boots.
  const modPath = path.join(__dirname, "src", "sse", "services", "backgroundTokenRefresh.js");
  import(pathToFileURL(modPath).href)
    .then((m) => {
      try {
        m.startBackgroundTokenRefresh();
      } catch (e) {
        console.error("[BackgroundTokenRefresh] start failed:", e && e.message ? e.message : e);
      }
      const stop = () => {
        try {
          m.stopBackgroundTokenRefresh();
        } catch {
          /* ignore */
        }
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    })
    .catch((e) => {
      // Expected in published CLI standalone (src/ not on disk). App bootstrap covers it.
      if (process.env.DEBUG_BACKGROUND_TOKEN_REFRESH) {
        console.error("[BackgroundTokenRefresh] import failed:", e && e.message ? e.message : e);
      }
    });
}

// Opt-in (spec activity-ip-log, design D1): with TRUST_PRIVATE_PROXY=true a peer on
// a private network may also assert the client address. That is what nginx on a
// Docker host looks like (it reaches the container from the bridge gateway, e.g.
// 172.17.0.1). Only enable it when that proxy OVERWRITES X-Real-IP /
// X-Forwarded-For — otherwise a client's own header would pass through it — and
// the published port is not reachable from outside except through the proxy.
const TRUST_PRIVATE_PROXY = process.env.TRUST_PRIVATE_PROXY === "true";

// A peer that may assert the client address through forwarding headers: a reverse
// proxy on this host, or (opt-in) on a private network.
function isTrustedProxyPeer(address, { allowPrivate = TRUST_PRIVATE_PROXY } = {}) {
  let ip = String(address || "").toLowerCase();
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (ip === "::1" || ip.startsWith("127.")) return true;
  if (!allowPrivate) return false;
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  // fc00::/7 unique-local and fe80::/10 link-local.
  return /^f[cd][0-9a-f]{2}:/.test(ip) || /^fe[89ab][0-9a-f]:/.test(ip);
}

// The address the nearest trusted proxy saw: X-Real-IP (nginx sets it to
// $remote_addr), else the LAST X-Forwarded-For hop — $proxy_add_x_forwarded_for
// appends the real peer after whatever the client itself sent.
function forwardedClientIp(xRealIp, xff) {
  const real = String(xRealIp || "").trim();
  if (real) return real;
  const hops = String(xff || "").split(",").map((hop) => hop.trim()).filter(Boolean);
  return hops.length ? hops[hops.length - 1] : "";
}

// Wrap Next standalone HTTP server: derive client IP from the TCP socket
// (unspoofable) and strip client-supplied forwarding headers so downstream
// rate-limiting keys on the real peer address instead of attacker-controlled XFF.
http.createServer = (...args) => {
  const handler = args.find((a) => typeof a === "function");
  const rest = args.filter((a) => typeof a !== "function");
  if (!handler) return origCreate(...args);
  const wrapped = (req, res) => {
    const socketIp = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";
    const xff = req.headers["x-forwarded-for"];
    const xRealIp = req.headers["x-real-ip"];
    const viaProxy = !!(xff || xRealIp);
    // Trust forwarding headers only when the TCP peer is a local or private-network
    // reverse proxy. Public sockets remain keyed by the unspoofable peer address.
    const proxyIp = forwardedClientIp(xRealIp, xff);
    const ip = isTrustedProxyPeer(socketIp) && proxyIp ? proxyIp : socketIp;
    delete req.headers["x-dr-real-ip"];
    delete req.headers["x-forwarded-for"];
    delete req.headers["x-dr-via-proxy"];
    delete req.headers["x-dr-peer-token"];
    req.headers["x-dr-real-ip"] = ip;
    req.headers["x-dr-peer-token"] = PEER_TOKEN;
    if (viaProxy) req.headers["x-dr-via-proxy"] = "1";
    return handler(req, res);
  };
  const server = origCreate(...rest, wrapped);
  server.once("listening", () => {
    startBackgroundTokenRefreshFromCustomServer();
  });
  const origEmit = server.emit;
  // JBR 25 sends h2c upgrades that the HTTP/1.1 server would otherwise close.
  server.emit = function (event, ...eventArgs) {
    const [req, socket, head] = eventArgs;
    if (event !== "upgrade" || String(req.headers.upgrade || "").toLowerCase() !== "h2c") {
      return origEmit.call(this, event, ...eventArgs);
    }

    const contentLength = Number(req.headers["content-length"] || 0);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      socket.destroy();
      return true;
    }
    const chunks = [head];
    let received = head.length;
    const serve = () => {
      // Replay the upgraded request through the existing HTTP/1.1 handler.
      const replay = new http.IncomingMessage(socket);
      Object.assign(replay, { method: req.method, url: req.url, headers: req.headers, complete: true });
      if (received) replay.push(Buffer.concat(chunks, received).subarray(0, contentLength));
      replay.push(null);
      const res = new http.ServerResponse(replay);
      res.shouldKeepAlive = false;
      res.assignSocket(socket);
      res.once("finish", () => socket.end());
      Promise.resolve().then(() => wrapped(replay, res)).catch((error) => {
        console.error("Failed to downgrade h2c request", error);
        socket.destroy();
      });
    };
    if (received >= contentLength) serve();
    else {
      socket.on("data", function readBody(chunk) {
        chunks.push(chunk);
        received += chunk.length;
        if (received < contentLength) return;
        socket.off("data", readBody);
        serve();
      });
      socket.resume();
    }
    delete req.headers.upgrade;
    delete req.headers["http2-settings"];
    req.headers.connection = "close";
    return true;
  };
  return server;
};

// Exposed for tests; the server itself only uses them inside the wrapper above.
module.exports = { isTrustedProxyPeer, forwardedClientIp };

if (require.main === module) {
  const standalone = path.join(__dirname, "server.js");
  if (fs.existsSync(standalone)) {
    require(standalone);
  } else {
    // Repo checkout has no standalone build next to us. `next start` builds its HTTP
    // server in-process, so the wrapper above still sanitizes every request.
    const nextBin = require.resolve("next/dist/bin/next");
    process.argv = [process.argv[0], nextBin, "start", ...process.argv.slice(2)];
    require(nextBin);
  }
}
