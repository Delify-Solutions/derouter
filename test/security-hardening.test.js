// Hardening from the security review: scoped login lockout, long random API key
// ids, the API-key guessing limiter and the forwarded client IP rule.
// Relative imports only: plain `node --test` cannot resolve the `@/` alias.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DEROUTER_PEER_TOKEN = "test-peer-token";

const limiter = await import("../src/lib/auth/loginLimiter.js");
const { generateApiKeyWithMachine, parseApiKey, KEY_ID_LENGTH } = await import("../src/shared/utils/apiKey.js");
const { keyLookupLimited, recordKeyLookupMiss, isNonPublicAddress, KEY_LOOKUP_LIMIT } = await import("../src/lib/auth/keyLookupLimiter.js");
const { forwardedClientIp, getRequestIp } = await import("../src/lib/auth/clientIp.js");

// A request as custom-server.js hands it on: the stamped client IP plus the
// per-process proof that the stamp is ours.
function stampedRequest(ip, extra = {}) {
  const headers = new Headers({ "x-dr-real-ip": ip, "x-dr-peer-token": "test-peer-token", ...extra });
  return { headers };
}

// ── Login lockout ───────────────────────────────────────────────────────────

test("a customer sign-in cannot clear the admin login failures of the same client", () => {
  const admin = limiter.adminIpBucket("198.51.100.1");
  for (let i = 0; i < 4; i += 1) limiter.recordFail(admin.key, { maxFails: admin.maxFails });
  // The attacker signs in to their own customer account from the same IP.
  limiter.recordSuccess(limiter.userAccountBucket("me@attacker.test").key);
  limiter.recordSuccess(limiter.userIpBucket("198.51.100.1").key);

  limiter.recordFail(admin.key, { maxFails: admin.maxFails });
  assert.equal(limiter.checkLock(admin.key).locked, true, "the 5th admin failure still locks");
});

test("signing in to one account does not clear failures piled on the client IP", () => {
  const ip = "198.51.100.2";
  const victim = [limiter.userIpBucket(ip), limiter.userAccountBucket("victim@test")];
  for (let i = 0; i < 4; i += 1) limiter.recordFails(victim);
  limiter.recordSuccess(limiter.userAccountBucket("me@attacker.test").key);

  limiter.recordFails(victim);
  assert.equal(limiter.checkLocks(victim).locked, true);
});

test("one account is locked after 10 failures spread over many clients", () => {
  const account = limiter.userAccountBucket("Spread@Test");
  for (let i = 0; i < 9; i += 1) limiter.recordFails([limiter.userIpBucket(`203.0.113.${i}`), account]);
  assert.equal(limiter.checkLock(account.key).locked, false);
  limiter.recordFails([limiter.userIpBucket("203.0.113.200"), account]);
  assert.equal(limiter.checkLock(account.key).locked, true);
  assert.equal(limiter.userAccountBucket(" spread@test ").key, account.key, "email is normalised");
});

// ── API key ids ─────────────────────────────────────────────────────────────

test("new API keys carry a long random id and still parse", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const { key, keyId } = generateApiKeyWithMachine("abcdef0123456789");
    assert.equal(keyId.length, KEY_ID_LENGTH);
    assert.match(keyId, /^[a-z0-9]+$/);
    assert.deepEqual(parseApiKey(key), { machineId: "abcdef0123456789", keyId, isNewFormat: true });
    seen.add(keyId);
  }
  assert.equal(seen.size, 200);
  assert.ok(KEY_ID_LENGTH >= 20);
});

// ── Key guessing limiter ───────────────────────────────────────────────────

test("a public client is throttled after too many unknown keys", () => {
  const req = stampedRequest("203.0.113.50");
  const t0 = Date.now();
  for (let i = 0; i < KEY_LOOKUP_LIMIT.limit - 1; i += 1) recordKeyLookupMiss(req, t0);
  assert.equal(keyLookupLimited(req, t0).limited, false);
  recordKeyLookupMiss(req, t0);
  const limited = keyLookupLimited(req, t0);
  assert.equal(limited.limited, true);
  assert.ok(limited.retryAfterSec > 0);
  assert.equal(keyLookupLimited(stampedRequest("203.0.113.51"), t0).limited, false, "another client is unaffected");
  assert.equal(keyLookupLimited(req, t0 + KEY_LOOKUP_LIMIT.windowMs + 1).limited, false, "the window expires");
});

test("a proxy-looking or untrusted address is never throttled", () => {
  for (const ip of ["172.17.0.1", "10.0.0.5", "192.168.1.2", "127.0.0.1", "::1", "100.100.1.1", "fd00::1"]) {
    assert.equal(isNonPublicAddress(ip), true, ip);
    const req = stampedRequest(ip);
    for (let i = 0; i < KEY_LOOKUP_LIMIT.limit + 5; i += 1) recordKeyLookupMiss(req);
    assert.equal(keyLookupLimited(req).limited, false, ip);
  }
  assert.equal(isNonPublicAddress("203.0.113.9"), false);
  // No custom-server proof: the header is the client's own claim.
  const forged = { headers: new Headers({ "x-dr-real-ip": "203.0.113.60" }) };
  for (let i = 0; i < KEY_LOOKUP_LIMIT.limit + 5; i += 1) recordKeyLookupMiss(forged);
  assert.equal(keyLookupLimited(forged).limited, false);
});

// ── Forwarded client IP ────────────────────────────────────────────────────

test("the forwarded client IP is X-Real-IP, else the last X-Forwarded-For hop", () => {
  assert.equal(forwardedClientIp("198.51.100.7", "1.1.1.1, 198.51.100.7"), "198.51.100.7");
  assert.equal(forwardedClientIp("", "6.6.6.6, 198.51.100.8"), "198.51.100.8", "the client-sent first hop is ignored");
  assert.equal(forwardedClientIp(null, null), "");
});

test("TRUST_PROXY reads the proxy-appended hop, not the client's own", () => {
  const prev = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = "true";
  try {
    const req = { headers: new Headers({ "x-forwarded-for": "6.6.6.6, 198.51.100.9" }) };
    assert.equal(getRequestIp(req), "198.51.100.9");
    assert.equal(limiter.getClientIp(req), "198.51.100.9");
  } finally {
    if (prev === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = prev;
  }
});

test("custom-server.js and clientIp.js pick the same forwarded client IP", async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const server = require("../custom-server.js");
  const cases = [
    ["198.51.100.7", "1.1.1.1, 198.51.100.7"],
    ["", "6.6.6.6, 198.51.100.8"],
    ["", "198.51.100.9"],
    [null, null],
    ["  203.0.113.4 ", ""],
  ];
  for (const [real, xff] of cases) {
    assert.equal(server.forwardedClientIp(real, xff), forwardedClientIp(real, xff), `${real} | ${xff}`);
  }
});

// ── Encoded paths never reach the guard's prefix rules (change hardening-wave1) ──

test("the guard refuses paths that encode letters, digits, dots or slashes", async () => {
  const { isObfuscatedPath } = await import("../src/lib/auth/obfuscatedPath.js");
  for (const p of ["/%61pi/settings", "/%41pi/keys", "/api%2fsettings", "/api%2Fsettings", "/api/%73ettings", "/api/tunnel/%65nable", "/%64ashboard", "/x/%2e%2e/api/settings", "/api%5Csettings", "/api\\settings", "/%7Ex"]) {
    assert.equal(isObfuscatedPath(p), true, p);
  }
  for (const p of ["/api/settings", "/api/combos/my%20combo", "/docs/%E1%BA%BF", "/api/x/%25", "/v1beta/models/gemini-2.5-pro:generateContent", "/api/x/%3A", "/"]) {
    assert.equal(isObfuscatedPath(p), false, p);
  }
});
