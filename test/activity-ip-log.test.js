// Client IP resolution, IP on API usage, the activity log and the admin IP
// lookups (spec activity-ip-log).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-ip-log-"));
// DATA_DIR must be set before the DB driver is imported.
process.env.DATA_DIR = tmpDir;

const require = createRequire(import.meta.url);
const { isTrustedProxyPeer, forwardedClientIp } = require("../custom-server.js");
const { getAdapter } = await import("../src/lib/db/driver.js");
const activity = await import("../src/lib/db/repos/activityRepo.js");
const { getRequestIp, getRequestUserAgent } = await import("../src/lib/auth/clientIp.js");
const { saveRequestUsage } = await import("../src/lib/db/repos/usageRepo.js");

let db;
before(async () => { db = await getAdapter(); });
after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(() => {
  for (const table of ["activityLog", "usageHistory", "apiKeys", "users", "creditLedger", "userPlans"]) {
    try { db.run(`DELETE FROM ${table}`); } catch { /* table may not exist */ }
  }
  const now = new Date().toISOString();
  for (const id of ["u1", "u2", "u3"]) {
    db.run(
      `INSERT INTO users(id, email, passwordHash, displayName, groupId, status, overdraftNanoUsd, createdAt, updatedAt)
       VALUES(?, ?, 'x', NULL, NULL, ?, 0, ?, ?)`,
      [id, `${id}@test.local`, id === "u3" ? "suspended" : "active", now, now]
    );
  }
});

function key(id, userId) {
  const now = new Date().toISOString();
  const secret = `sk-test-${id}-0123456789`;
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, updatedAt, userId, keyHash, keyPrefix)
     VALUES(?, ?, ?, NULL, 1, ?, ?, ?, NULL, ?)`,
    [id, secret, id, now, now, userId, secret.slice(0, 8)]
  );
  return secret;
}

function apiRow(keyId, ip, timestamp = new Date().toISOString()) {
  db.run(
    `INSERT INTO usageHistory(timestamp, provider, model, apiKeyId, endpoint, promptTokens, completionTokens, status, clientIp)
     VALUES(?, 'p', 'm', ?, '/v1/chat/completions', 1, 1, 'ok', ?)`,
    [timestamp, keyId, ip]
  );
}

function fakeRequest(headers = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { headers: { get: (name) => map.get(String(name).toLowerCase()) ?? null } };
}

// ── Client IP ────────────────────────────────────────────────────────────────

test("loopback may always assert the client IP; a private-network proxy only when opted in", () => {
  for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(isTrustedProxyPeer(ip, { allowPrivate: false }), true, ip);
  }
  for (const ip of ["172.17.0.1", "::ffff:172.17.0.1", "10.0.0.5", "192.168.1.2", "fd12::1", "fe80::1"]) {
    assert.equal(isTrustedProxyPeer(ip, { allowPrivate: false }), false, ip);
    assert.equal(isTrustedProxyPeer(ip, { allowPrivate: true }), true, ip);
  }
  for (const ip of ["203.0.113.9", "172.32.0.1", "8.8.8.8", "2001:db8::1", "", null]) {
    assert.equal(isTrustedProxyPeer(ip, { allowPrivate: true }), false, String(ip));
  }
});

test("X-Real-IP wins, else the last X-Forwarded-For hop (the one the proxy appended)", () => {
  assert.equal(forwardedClientIp("203.0.113.9", "1.2.3.4"), "203.0.113.9");
  assert.equal(forwardedClientIp("", "1.2.3.4, 203.0.113.9"), "203.0.113.9");
  assert.equal(forwardedClientIp(undefined, "203.0.113.9"), "203.0.113.9");
  assert.equal(forwardedClientIp("", ""), "");
});

test("a stored IP comes only from the custom-server stamp (or TRUST_PROXY), never from Host", () => {
  const previous = process.env.DEROUTER_PEER_TOKEN;
  process.env.DEROUTER_PEER_TOKEN = "peer-secret";
  try {
    assert.equal(getRequestIp(fakeRequest({ "x-dr-real-ip": "203.0.113.9", "x-dr-peer-token": "peer-secret" })), "203.0.113.9");
    assert.equal(getRequestIp(fakeRequest({ "x-dr-real-ip": "::ffff:203.0.113.9", "x-dr-peer-token": "peer-secret" })), "203.0.113.9");
    assert.equal(getRequestIp(fakeRequest({ "x-dr-real-ip": "203.0.113.9", "x-dr-peer-token": "wrong" })), null);
    assert.equal(getRequestIp(fakeRequest({ host: "example.com" })), null);
    assert.equal(getRequestIp(fakeRequest({ "x-dr-real-ip": "<script>", "x-dr-peer-token": "peer-secret" })), null);
    assert.equal(getRequestIp(fakeRequest({ "x-dr-real-ip": "203.0.113.9:51234", "x-dr-peer-token": "peer-secret" })), "203.0.113.9");
  } finally {
    if (previous === undefined) delete process.env.DEROUTER_PEER_TOKEN;
    else process.env.DEROUTER_PEER_TOKEN = previous;
  }
  assert.equal(getRequestUserAgent(fakeRequest({ "user-agent": "x".repeat(500) })).length, 300);
});

// ── Usage ────────────────────────────────────────────────────────────────────

test("an API usage row stores the request's client IP", async () => {
  const secret = key("k1", "u1");
  await saveRequestUsage({
    provider: "test", model: "m", apiKey: secret, endpoint: "/v1/chat/completions",
    tokens: { prompt_tokens: 1, completion_tokens: 1 }, clientIp: "203.0.113.9",
  });
  await saveRequestUsage({
    provider: "test", model: "m2", apiKey: secret, endpoint: "/v1/chat/completions",
    tokens: { prompt_tokens: 2, completion_tokens: 2 },
  });
  const rows = db.all(`SELECT model, clientIp FROM usageHistory ORDER BY id`);
  assert.deepEqual(rows, [{ model: "m", clientIp: "203.0.113.9" }, { model: "m2", clientIp: null }]);
});

// ── Activity log ─────────────────────────────────────────────────────────────

test("recordActivity stores the action and never throws", async () => {
  await activity.recordActivity(fakeRequest({ "user-agent": "curl/8" }), { userId: "u1", action: "login" });
  // A bad call (no action) is swallowed: the action it describes must not fail.
  await activity.recordActivity(fakeRequest(), { userId: "u1" });
  const rows = activity.listUserActivitySync(db, "u1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, "login");
  assert.equal(rows[0].userAgent, "curl/8");
});

test("an account's IPs merge web and API sources and count the other accounts on each", () => {
  activity.insertActivitySync(db, { userId: "u1", action: "login", ip: "203.0.113.9", createdAt: "2026-11-01T10:00:00.000Z" });
  activity.insertActivitySync(db, { userId: "u1", action: "key_create", ip: "203.0.113.9", createdAt: "2026-11-01T11:00:00.000Z" });
  activity.insertActivitySync(db, { userId: "u2", action: "register", ip: "203.0.113.9", createdAt: "2026-11-01T12:00:00.000Z" });
  key("k1", "u1");
  key("k3", "u3");
  apiRow("k1", "198.51.100.4");
  apiRow("k1", "203.0.113.9");
  apiRow("k3", "198.51.100.4");

  const ips = activity.listUserIpsSync(db, "u1");
  const byIp = Object.fromEntries(ips.map((row) => [row.ip, row]));
  assert.equal(byIp["203.0.113.9"].webCount, 2);
  assert.equal(byIp["203.0.113.9"].apiCount, 1);
  assert.equal(byIp["203.0.113.9"].otherAccounts, 1); // u2 registered there
  assert.equal(byIp["198.51.100.4"].webCount, 0);
  assert.equal(byIp["198.51.100.4"].apiCount, 1);
  assert.equal(byIp["198.51.100.4"].otherAccounts, 1); // u3's key called from there
  assert.equal(byIp["203.0.113.9"].firstSeen, "2026-11-01T10:00:00.000Z");
});

test("the IP lookup lists every account seen on it, with status", () => {
  activity.insertActivitySync(db, { userId: "u1", action: "login", ip: "203.0.113.9" });
  activity.insertActivitySync(db, { userId: "u2", action: "register", ip: "203.0.113.9" });
  key("k3", "u3");
  apiRow("k3", "203.0.113.9");
  apiRow("k3", "203.0.113.9");

  const accounts = activity.listAccountsByIpSync(db, "203.0.113.9");
  const byUser = Object.fromEntries(accounts.map((row) => [row.userId, row]));
  assert.deepEqual(Object.keys(byUser).sort(), ["u1", "u2", "u3"]);
  assert.equal(byUser.u3.apiCount, 2);
  assert.equal(byUser.u3.status, "suspended");
  assert.equal(byUser.u1.email, "u1@test.local");
});

test("API usage older than the lookback is left out", () => {
  key("k1", "u1");
  apiRow("k1", "198.51.100.4", new Date(Date.now() - (activity.IP_LOOKBACK_DAYS + 1) * 86400000).toISOString());
  assert.deepEqual(activity.listUserIpsSync(db, "u1"), []);
});

test("the search box treats only IP-shaped text as an IP", () => {
  assert.equal(activity.looksLikeIp("203.0.113.9"), true);
  assert.equal(activity.looksLikeIp("2001:db8::1"), true);
  assert.equal(activity.looksLikeIp("alice@x.com"), false);
  assert.equal(activity.looksLikeIp("1234"), false);
});
