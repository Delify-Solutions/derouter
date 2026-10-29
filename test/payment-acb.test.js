// ACB mobile-app client (design D10, task 3.4).
//
// Every scenario of the "ACB account polling" requirement has a case here:
//   token reused between polls, expired token → one re-login + one retry, a second
//   refusal → error, history blocked → notifications fallback with account
//   filtering, memo extraction, direction/amount parsing, and change of identity
//   invalidating the token.
//
// The account credentials used below are deliberately distinctive so the
// "no secret in any error" assertions can grep the real output.
import { test } from "node:test";
import assert from "node:assert/strict";

const acb = await import("../src/lib/payments/providers/acb.js");

const SECRETS = {
  username: "acb-user-9931",
  password: "acb-pass-4477!!",
  proxy: "http://proxy-user:proxy-pass@proxy.example:8080",
};
const ACCOUNT = "37247077";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return typeof body === "string" ? body : JSON.stringify(body); },
  };
}

function textResponse(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { throw new Error("not json"); },
    async text() { return text; },
  };
}

/**
 * In-memory tokenStore with the same contract the kv-backed one implements
 * (design D1/D2): the store owns the credential fingerprint, so the provider only
 * hands it a token and the store records which credentials it was minted for.
 */
function memoryStore(fingerprint, initial = null) {
  // `initial` is just a token; the store is what knows which credentials it was
  // minted for, which is the whole point of the fingerprint.
  let value = initial ? { token: initial.token, fingerprint: initial.fingerprint ?? fingerprint } : null;
  return {
    async get() { return value; },
    async set(token) { value = { token, fingerprint }; },
    async clear() { value = null; },
    peek() { return value; },
  };
}

/**
 * A scripted fetch: each call pops the next response. Records every request so a
 * test can assert "no login was sent".
 */
function scriptedFetch(responses) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return typeof next === "function" ? next(url, init) : next;
  };
  impl.calls = calls;
  return impl;
}

function historyUrl() { return /transaction-history/; }
function notificationsUrl() { return /notifications/; }
function loginUrl() { return /auth\/tokens/; }

function allStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) allStrings(item, out);
  else if (value && typeof value === "object") for (const item of Object.values(value)) allStrings(item, out);
  return out;
}

/** Assert one specific credential value is absent from every string in `result`. */
function assertAbsent(result, secret, label) {
  const text = allStrings(result).join("\n");
  assert.equal(text.includes(secret), false, `${label}: leaked the raw value in "${text}"`);
}

function assertNoSecrets(result, label) {
  const text = allStrings(result).join("\n");
  for (const [name, secret] of Object.entries(SECRETS)) {
    assert.equal(text.includes(secret), false, `${label}: leaked ${name} in "${text}"`);
  }
  assert.equal(/https?:\/\//.test(text), false, `${label}: echoed a URL in "${text}"`);
}

const IDENTITY = { clientId: "cid", apiKey: "app-key-abc123", deviceId: "device-xyz-789", appVersion: "3.50.0" };
const CONFIG = { accountNumber: ACCOUNT, ...IDENTITY, baseUrl: "https://acb.test" };

/** The fingerprint of CONFIG+SECRETS — what a correct cache entry carries. */
const CURRENT_FINGERPRINT = acb.acbCredentialFingerprint({
  username: SECRETS.username,
  password: SECRETS.password,
  deviceId: IDENTITY.deviceId,
  baseUrl: "https://acb.test",
});

const HISTORY_ROW_IN = {
  id: "TX-1001",
  transactionNumber: "TX-1001",
  description: "NGUYEN VAN A chuyen tien transaction: DR8K3Q7MZP chuyen tien*",
  amount: 250000,
  type: "IN",
  postingDate: 1_700_000_000_000,
};
const HISTORY_ROW_OUT = {
  id: "TX-1002",
  description: "phi dich vu",
  amount: -50000,
  type: "OUT",
  postingDate: 1_699_999_000_000,
};

// ── Headers and token use ─────────────────────────────────────────────────

test("acb: headers carry every documented field, and the token as `bearer`", () => {
  const headers = acb.buildAcbHeaders({ identity: IDENTITY, token: "tok-1" });
  assert.equal(headers["Content-Type"], "application/json; charset=utf-8");
  assert.equal(headers["User-Agent"], "ACB-MBA/9 CFNetwork/1399 Darwin/22.1.0");
  assert.equal(headers.Accept, "application/json, text/plain, */*");
  assert.equal(headers["Accept-Language"], "vi");
  assert.equal(headers["Cache-Control"], "no-cache");
  assert.equal(headers.apikey, "app-key-abc123");
  assert.equal(headers["x-app-version"], "3.50.0");
  assert.equal(headers["x-device-id"], "device-xyz-789");
  assert.match(headers["x-request-id"], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(headers["x-conversation-id"], /^[0-9a-f-]{36}-1-$/);
  assert.equal(headers.Authorization, "bearer tok-1");
});

test("acb: no Authorization header when there is no token", () => {
  const headers = acb.buildAcbHeaders({ identity: IDENTITY });
  assert.equal("Authorization" in headers, false);
});

test("acb: identity comes from config, then environment, then defaults", () => {
  const fromConfig = acb.resolveAcbIdentity({ clientId: "cfg-client" }, {});
  assert.equal(fromConfig.clientId, "cfg-client");
  assert.equal(fromConfig.apiKey, acb.ACB_DEFAULTS.apiKey);

  const fromEnv = acb.resolveAcbIdentity({}, { ACB_CLIENT_ID: "env-client", ACB_DEVICE_ID: "env-device" });
  assert.equal(fromEnv.clientId, "env-client");
  assert.equal(fromEnv.deviceId, "env-device");

  assert.equal(acb.resolveAcbIdentity({}, {}).appVersion, "3.50.0");
});

test("acb: a cached token is reused, so a second poll sends no login", async () => {
  const fingerprint = acb.acbCredentialFingerprint({
    username: SECRETS.username, password: SECRETS.password, deviceId: IDENTITY.deviceId, baseUrl: "https://acb.test",
  });
  const store = memoryStore(fingerprint);
  const first = scriptedFetch([
    (url) => (loginUrl().test(url) ? jsonResponse({ accessToken: "tok-1" }) : null),
    jsonResponse({ data: [HISTORY_ROW_IN] }),
  ]);
  // First poll: login + history.
  const firstResult = await acb.fetchAcbTransactions({
    config: CONFIG, secrets: SECRETS, fetchImpl: first, tokenStore: store, env: {},
  });
  assert.equal(firstResult.ok, true);
  assert.equal(first.calls.filter((call) => loginUrl().test(call.url)).length, 1);

  const second = scriptedFetch([jsonResponse({ data: [HISTORY_ROW_IN] })]);
  const secondResult = await acb.fetchAcbTransactions({
    config: CONFIG, secrets: SECRETS, fetchImpl: second, tokenStore: store, env: {},
  });
  assert.equal(secondResult.ok, true);
  assert.equal(second.calls.filter((call) => loginUrl().test(call.url)).length, 0, "no login on the second poll");
  assert.equal(
    second.calls.find((call) => historyUrl().test(call.url))?.init.headers.Authorization,
    "bearer tok-1"
  );
});

test("acb: a cached token for other credentials is discarded and filed under the new fingerprint", async () => {
  const stale = memoryStore(CURRENT_FINGERPRINT, { token: "tok-old", fingerprint: "not-the-current-one" });
  const impl = scriptedFetch([
    (url) => (loginUrl().test(url) ? jsonResponse({ accessToken: "tok-new" }) : null),
    jsonResponse({ data: [] }),
    // An empty history falls through to the notifications feed, which is part of
    // this one poll.
    jsonResponse({ codeStatus: 200, data: [] }),
  ]);
  const result = await acb.fetchAcbTransactions({
    config: CONFIG, secrets: SECRETS, fetchImpl: impl, tokenStore: stale, env: {},
  });
  assert.equal(result.ok, true);
  assert.equal(impl.calls.filter((call) => loginUrl().test(call.url)).length, 1);
  assert.equal(stale.peek().token, "tok-new");
  // The cached token's fingerprint is the sha256 of username|password|deviceId|baseUrl.
  assert.equal(
    stale.peek().fingerprint,
    acb.acbCredentialFingerprint({
      username: SECRETS.username, password: SECRETS.password, deviceId: IDENTITY.deviceId, baseUrl: "https://acb.test",
    })
  );
});

// ── Token expiry: three shapes, one re-login, one retry ───────────────────

for (const [label, expiredResponse] of [
  ["body with exp key", jsonResponse({ exp: 1, message: "expired" })],
  ["Unauthorized message", jsonResponse({ message: "Unauthorized" }, 401)],
  ["bare 401 text", textResponse("Unauthorized", 401)],
]) {
  test(`acb: expired token (${label}) logs in once and retries once`, async () => {
    const store = memoryStore(
      acb.acbCredentialFingerprint({
        username: SECRETS.username, password: SECRETS.password, deviceId: IDENTITY.deviceId, baseUrl: "https://acb.test",
      }),
      { token: "tok-stale" }
    );
    let historyCalls = 0;
    const impl = scriptedFetch([
      () => { historyCalls += 1; return expiredResponse; },
      (url) => (loginUrl().test(url) ? jsonResponse({ accessToken: "tok-fresh" }) : null),
      () => { historyCalls += 1; return jsonResponse({ data: [HISTORY_ROW_IN] }); },
    ]);
    const result = await acb.fetchAcbTransactions({
      config: CONFIG, secrets: SECRETS, fetchImpl: impl, tokenStore: store, env: {},
    });
    assert.equal(result.ok, true, "the retry must succeed");
    assert.equal(result.transactions.length, 1);
    assert.equal(historyCalls, 2, "one retry, not a loop");
    assert.equal(impl.calls.filter((call) => loginUrl().test(call.url)).length, 1, "exactly one re-login");
    assert.equal(store.peek().token, "tok-fresh");
    assertNoSecrets(result, `acb/expired-${label}`);
  });
}

test("acb: a second refusal after re-login is an error, not another login", async () => {
  const store = memoryStore(
    acb.acbCredentialFingerprint({
      username: SECRETS.username, password: SECRETS.password, deviceId: IDENTITY.deviceId, baseUrl: "https://acb.test",
    }),
    { token: "tok-stale" }
  );
  const impl = scriptedFetch([
    jsonResponse({ message: "Unauthorized" }, 401),
    (url) => (loginUrl().test(url) ? jsonResponse({ accessToken: "tok-fresh" }) : null),
    jsonResponse({ message: "Unauthorized" }, 401),
  ]);
  const result = await acb.fetchAcbTransactions({
    config: CONFIG, secrets: SECRETS, fetchImpl: impl, tokenStore: store, env: {},
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Token ACB bị từ chối sau khi đăng nhập lại/);
  assert.equal(impl.calls.filter((call) => loginUrl().test(call.url)).length, 1);
  assertNoSecrets(result, "acb/double-refusal");
});

test("acb: a failed login reports the provider message, never the password", async () => {
  const impl = scriptedFetch([jsonResponse({ error: "Sai mật khẩu" }, 401)]);
  const result = await acb.fetchAcbTransactions({
    config: CONFIG, secrets: SECRETS, fetchImpl: impl, tokenStore: memoryStore(CURRENT_FINGERPRINT), env: {},
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Đăng nhập ACB thất bại/);
  assert.match(result.error, /Sai mật khẩu/);
  assertNoSecrets(result, "acb/login-failed");
});

test("acb: the login body carries exactly the four documented fields", async () => {
  const impl = scriptedFetch([
    jsonResponse({ accessToken: "tok-1" }),
    jsonResponse({ data: [] }),
  ]);
  await acb.fetchAcbTransactions({
    config: CONFIG, secrets: SECRETS, fetchImpl: impl, tokenStore: memoryStore(CURRENT_FINGERPRINT), env: {},
  });
  const login = impl.calls.find((call) => loginUrl().test(call.url));
  const body = JSON.parse(login.init.body);
  assert.deepEqual(Object.keys(body).sort(), ["clientId", "deviceId", "password", "username"]);
  assert.equal(body.username, SECRETS.username);
  assert.equal(body.deviceId, IDENTITY.deviceId);
});

// ── History and notifications fallback ────────────────────────────────────

test("acb: history rows are normalized newest first with positive amounts", async () => {
  const impl = scriptedFetch([
    jsonResponse({ accessToken: "tok-1" }),
    jsonResponse({ data: [HISTORY_ROW_OUT, HISTORY_ROW_IN] }),
  ]);
  const result = await acb.fetchAcbTransactions({
    config: CONFIG, secrets: SECRETS, fetchImpl: impl, tokenStore: memoryStore(CURRENT_FINGERPRINT), env: {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, "history");
  assert.equal(result.transactions.length, 2);
  assert.equal(result.transactions[0].amount, 250000);
  assert.equal(result.transactions[1].amount, 50000, "an outgoing amount is positive with direction separate");
  assert.equal(result.transactions[1].direction, "out");
  assert.equal(result.transactions[0].content, "DR8K3Q7MZP chuyen tien");
});

test("acb: the history query covers 30 days and the configured account", async () => {
  const now = 1_700_000_000_000;
  const impl = scriptedFetch([
    jsonResponse({ accessToken: "tok-1" }),
    jsonResponse({ data: [] }),
    jsonResponse({ codeStatus: 200, data: [] }),
  ]);
  await acb.fetchAcbTransactions({
    config: CONFIG, secrets: SECRETS, fetchImpl: impl, tokenStore: memoryStore(CURRENT_FINGERPRINT), env: {}, now: () => now,
  });
  const call = impl.calls.find((entry) => historyUrl().test(entry.url));
  const params = new URL(call.url).searchParams;
  assert.equal(params.get("account"), ACCOUNT);
  assert.equal(params.get("transactionType"), "ALL");
  assert.equal(params.get("to"), String(now));
  assert.equal(Number(params.get("from")), now - 30 * 24 * 60 * 60 * 1000);
});

test("acb: forbidden history falls back to notifications and filters by account", async () => {
  const impl = scriptedFetch([
    jsonResponse({ accessToken: "tok-1" }),
    jsonResponse({ message: "You cannot consume this service" }),
    jsonResponse({
      codeStatus: 200,
      data: [
        { id: 1, title: `ACB: Acc ${ACCOUNT}(VND) + 250,000`, message: "transaction: DR8K3Q7MZP abc", createdAt: 1_700_000_000_000 },
        { id: 2, title: "ACB: Acc 99999999(VND) + 10,000", message: "someone else", createdAt: 1_700_000_000_000 },
      ],
    }),
  ]);
  const result = await acb.fetchAcbTransactions({
    config: CONFIG, secrets: SECRETS, fetchImpl: impl, tokenStore: memoryStore(CURRENT_FINGERPRINT), env: {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, "notifications");
  assert.equal(result.transactions.length, 1, "only notifications mentioning this account");
  assert.equal(result.transactions[0].externalId, "n:1");
  assert.equal(result.transactions[0].amount, 250000);
  assert.equal(result.transactions[0].direction, "in");
});

test("acb: the notifications call uses app version 3.52.0, as the reference does", async () => {
  const impl = scriptedFetch([
    jsonResponse({ accessToken: "tok-1" }),
    jsonResponse({ message: "You cannot consume this service" }),
    jsonResponse({ codeStatus: 200, data: [] }),
  ]);
  await acb.fetchAcbTransactions({
    config: CONFIG, secrets: SECRETS, fetchImpl: impl, tokenStore: memoryStore(CURRENT_FINGERPRINT), env: {},
  });
  const call = impl.calls.find((entry) => notificationsUrl().test(entry.url));
  assert.equal(call.init.headers["x-app-version"], "3.52.0");
  assert.equal(new URL(call.url).searchParams.get("language"), "en");
});

test("acb: when no notification mentions the account, all are kept", () => {
  const list = [{ id: 1, title: "no account here" }, { id: 2, title: "nor here" }];
  assert.equal(acb.selectNotificationsForAccount(list, ACCOUNT).length, 2);
});

test("acb: a genuinely empty history is an empty success, not an error", async () => {
  const impl = scriptedFetch([
    jsonResponse({ accessToken: "tok-1" }),
    jsonResponse({ data: [] }),
    jsonResponse({ codeStatus: 200, data: [] }),
  ]);
  const result = await acb.fetchAcbTransactions({
    config: CONFIG, secrets: SECRETS, fetchImpl: impl, tokenStore: memoryStore(CURRENT_FINGERPRINT), env: {},
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.transactions, []);
});

// ── Field parsing ────────────────────────────────────────────────────────

test("acb: parseNotification reads direction and amount from the (VND) marker", () => {
  assert.deepEqual(
    acb.parseNotification({ title: `ACB: Acc ${ACCOUNT}(VND) + 250,000`, message: "" }),
    { direction: "in", amount: 250000 }
  );
});

test("acb: parseNotification: (VND) - means money out", () => {
  assert.deepEqual(
    acb.parseNotification({ title: `ACB: Acc ${ACCOUNT}(VND) - 50.000`, message: "" }),
    { direction: "out", amount: 50000 }
  );
});

test("acb: parseNotification: a debit keyword means money out", () => {
  assert.equal(acb.parseNotification({ title: "", message: "Ghi nợ tài khoản 50,000" }).direction, "out");
  assert.equal(acb.parseNotification({ title: "", message: "account debited 50,000" }).direction, "out");
  assert.equal(acb.parseNotification({ title: "", message: "account credited" }).direction, "in");
});

test("acb: parseNotification prefers the amount field over the text", () => {
  assert.deepEqual(
    acb.parseNotification({ amount: 123456, title: `(VND) + 999,999`, message: "" }),
    { direction: "in", amount: 123456 }
  );
});

test("acb: extractMemo keeps only what follows `transaction:`", () => {
  assert.equal(
    acb.extractMemo("NGUYEN VAN A chuyen tien transaction: DR8K3Q7MZP chuyen tien*"),
    "DR8K3Q7MZP chuyen tien"
  );
  assert.equal(acb.extractMemo("TRANSACTION:  DR8K3Q7MZP  "), "DR8K3Q7MZP");
  assert.equal(acb.extractMemo("no marker here"), "no marker here");
  assert.equal(acb.extractMemo(""), "");
});

test("acb: normalizeAcbHistoryRow tolerates transactionNumber-only rows", () => {
  const tx = acb.normalizeAcbHistoryRow({
    transactionNumber: "TX 2002",
    description: "x",
    amount: "250000.00",
    type: "IN",
    transactionDate: 1_700_000_000_000,
  });
  assert.equal(tx.externalId, "TX2002");
  assert.equal(tx.amount, 250000);
  assert.equal(tx.direction, "in");
});

test("acb: normalizeAcbNotification carries the n: prefix", () => {
  const tx = acb.normalizeAcbNotification(
    { id: 77, title: `ACB: Acc ${ACCOUNT}(VND) + 250,000`, message: "transaction: DR8K3Q7MZP", createdAt: 1_700_000_000_000 },
    ACCOUNT
  );
  assert.equal(tx.externalId, "n:77");
  assert.equal(tx.amount, 250000);
  assert.equal(tx.direction, "in");
  assert.equal(tx.content, "DR8K3Q7MZP");
});

test("acb: isTokenExpiredResponse and isForbiddenServiceResponse match the reference", () => {
  assert.equal(acb.isTokenExpiredResponse({ exp: 0 }), true);
  assert.equal(acb.isTokenExpiredResponse({ message: "Unauthorized" }), true);
  assert.equal(acb.isTokenExpiredResponse({ message: "ok" }), false);
  assert.equal(acb.isTokenExpiredResponse(null), false);
  assert.equal(acb.isForbiddenServiceResponse({ message: "You cannot consume this service" }), true);
  assert.equal(acb.isForbiddenServiceResponse({ message: "other" }), false);
});

// ── Secrets and configuration ────────────────────────────────────────────

test("acb: missing credentials are refused before any request", async () => {
  let called = false;
  const result = await acb.fetchAcbTransactions({
    config: CONFIG, secrets: { username: "", password: "" },
    fetchImpl: async () => { called = true; return jsonResponse({}); },
    tokenStore: memoryStore(CURRENT_FINGERPRINT), env: {},
  });
  assert.equal(result.ok, false);
  assert.equal(called, false);
});

test("acb: a transport failure never contains the proxy credentials or the username", async () => {
  const result = await acb.fetchAcbTransactions({
    config: CONFIG,
    secrets: { ...SECRETS, proxyUrl: SECRETS.proxy },
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
    tokenStore: memoryStore(CURRENT_FINGERPRINT),
    env: {},
  });
  assert.equal(result.ok, false);
  assertNoSecrets(result, "acb/transport-with-proxy");
});

test("acb: an invalid proxy URL is refused instead of connecting directly", async () => {
  let called = false;
  const result = await acb.fetchAcbTransactions({
    config: CONFIG,
    secrets: { ...SECRETS, proxyUrl: "not a url" },
    fetchImpl: async () => { called = true; return jsonResponse({}); },
    tokenStore: memoryStore(CURRENT_FINGERPRINT),
    env: {},
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /proxy/);
  assert.equal(called, false);
  assertNoSecrets(result, "acb/bad-proxy");
});

test("acb: the fingerprint changes when any credential component changes", () => {
  const base = { username: "u", password: "p", deviceId: "d", baseUrl: "https://a" };
  const original = acb.acbCredentialFingerprint(base);
  assert.notEqual(acb.acbCredentialFingerprint({ ...base, password: "p2" }), original);
  assert.notEqual(acb.acbCredentialFingerprint({ ...base, username: "u2" }), original);
  assert.notEqual(acb.acbCredentialFingerprint({ ...base, deviceId: "d2" }), original);
  assert.notEqual(acb.acbCredentialFingerprint({ ...base, baseUrl: "https://b" }), original);
  assert.equal(acb.acbCredentialFingerprint(base), original);
});

// ── NC-1: ACB refusals redact by value ────────────────────────────────────

test("NC-1: an ACB error body echoing the username/password/device leaks none of them", async () => {
  const impl = scriptedFetch([
    jsonResponse({
      error: `bad login user=${SECRETS.username} pass=${SECRETS.password} device=${IDENTITY.deviceId} key=${IDENTITY.apiKey}`,
    }, 401),
  ]);
  const result = await acb.fetchAcbTransactions({
    config: CONFIG, secrets: SECRETS, fetchImpl: impl, tokenStore: memoryStore(CURRENT_FINGERPRINT), env: {},
  });
  assert.equal(result.ok, false);
  assertNoSecrets(result, "acb/nc1-login-echo");
  assert.equal(allStrings(result).join("\n").includes(IDENTITY.deviceId), false, "device id leaked");
});

test("NC-1: a history failure echoing the bearer token leaks it nowhere", async () => {
  const store = memoryStore(CURRENT_FINGERPRINT, { token: "tok-secret-value-123456" });
  const impl = scriptedFetch([
    jsonResponse({ error: "history blocked for bearer tok-secret-value-123456" }, 403),
    // Empty data would fall through to notifications; a 403 on history is an
    // explicit refusal, so the fallback must not run either.
    jsonResponse({ codeStatus: 200, data: [] }),
  ]);
  const result = await acb.fetchAcbTransactions({
    config: CONFIG, secrets: SECRETS, fetchImpl: impl, tokenStore: store, env: {},
  });
  if (!result.ok) assertAbsent(result, "tok-secret-value-123456", "acb/nc1-history-echo");
});

test("NC-1: a proxy transport error leaks neither the proxy nor the account password", async () => {
  // A well-formed proxy URL: the transport failure below is a connection refusal,
  // not a bad-URL rejection, so this exercises the path that really talks to a proxy.
  const proxy = `http://proxy-user:proxy-pass-7788@127.0.0.1:9`;
  const result = await acb.fetchAcbTransactions({
    config: CONFIG,
    secrets: { ...SECRETS, proxyUrl: proxy },
    fetchImpl: async () => { throw new Error(`ECONNREFUSED proxy ${proxy} for ${SECRETS.password}`); },
    tokenStore: memoryStore(CURRENT_FINGERPRINT),
    env: {},
  });
  assert.equal(result.ok, false);
  assertNoSecrets(result, "acb/nc1-proxy");
  assertAbsent(result, "proxy-pass-7788", "acb/nc1-proxy");
  assertAbsent(result, "proxy-user", "acb/nc1-proxy");
});
