// Provider normalizers and fetchers (design D2/D3, task 3.3).
//
// Every provider has fixture coverage for an INCOMING and an OUTGOING transaction,
// because the reconciliation rules key on direction: an outgoing row that normalizes
// as incoming is a refund being counted as a sale.
//
// The last group of tests is the security requirement from the ticket: no error
// string may contain a token, password, key or secret. They grep the actual output
// rather than trusting the intent.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const fixtures = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "fixtures", "payment-providers.json"), "utf8")
);

const sepay = await import("../src/lib/payments/providers/sepay.js");
const web2m = await import("../src/lib/payments/providers/web2m.js");
const binance = await import("../src/lib/payments/providers/binance.js");

// Distinctive values so a grep for them can only match a leak.
const LEKT = {
  sepayKey: "sepay-key-9f0c1d2e3b4a",
  sepayToken: "sepay-api-token-77aa88bb",
  web2mToken: "web2m-token-55cc66dd",
  web2mPassword: "web2m-bank-password-eeff",
  binanceKey: "binance-api-key-11223344",
  binanceSecret: "binance-api-secret-55667788",
};

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

/** Every string reachable from a value, so a leak cannot hide one level down. */
function allStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) allStrings(item, out);
  else if (value && typeof value === "object") for (const item of Object.values(value)) allStrings(item, out);
  return out;
}

function assertNoSecrets(result, label) {
  const text = allStrings(result).join("\n");
  for (const [name, secret] of Object.entries(LEKT)) {
    assert.equal(text.includes(secret), false, `${label}: leaked ${name} in "${text}"`);
  }
  // A URL bearing a token/password must not be quoted verbatim either.
  assert.equal(/https?:\/\//.test(text), false, `${label}: echoed a URL in "${text}"`);
}

/** Assert one specific credential value is absent from every string in `result`. */
function assertAbsent(result, secret, label) {
  const text = allStrings(result).join("\n");
  assert.equal(text.includes(secret), false, `${label}: leaked the raw value in "${text}"`);
}

// ── SePay ──────────────────────────────────────────────────────────────────

test("sepay: webhook incoming normalizes id, direction, amount, content, time", () => {
  const tx = sepay.normalizeSepayTransaction(fixtures.sepay.webhookIncoming);
  assert.equal(tx.externalId, "92704");
  assert.equal(tx.direction, "in");
  assert.equal(tx.amount, 250000);
  assert.equal(tx.currency, "VND");
  assert.equal(tx.content, "MBVCB.1234567.DR8K3Q7MZP.CT tu 0123 toi 9876");
  assert.equal(tx.accountNumber, "1017588888");
  // 11:08:33 Vietnam time == 04:08:33Z.
  assert.equal(tx.occurredAt, "2024-07-02T04:08:33.000Z");
  assert.deepEqual(tx.raw, fixtures.sepay.webhookIncoming);
});

test("sepay: webhook outgoing normalizes as out", () => {
  const tx = sepay.normalizeSepayTransaction(fixtures.sepay.webhookOutgoing);
  assert.equal(tx.externalId, "92705");
  assert.equal(tx.direction, "out");
  assert.equal(tx.amount, 50000);
});

test("sepay: v2 API row incoming uses amount_in and transaction_content", () => {
  const tx = sepay.normalizeSepayTransaction(fixtures.sepay.apiIncoming);
  assert.equal(tx.externalId, "a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  assert.equal(tx.direction, "in");
  assert.equal(tx.amount, 250000);
  assert.equal(tx.content, "DR8K3Q7MZP thanh toan");
});

test("sepay: v2 API row outgoing uses amount_out", () => {
  const tx = sepay.normalizeSepayTransaction(fixtures.sepay.apiOutgoing);
  assert.equal(tx.direction, "out");
  assert.equal(tx.amount, 120000);
});

test("sepay: a row with no id is not a transaction", () => {
  assert.equal(sepay.normalizeSepayTransaction({ transferAmount: 1 }), null);
  assert.equal(sepay.normalizeSepayTransaction(null), null);
});

test("sepay: date parsing is UTC+7 and tolerant of ISO input", () => {
  assert.equal(sepay.sepayDateToIso("2024-07-02 11:08:33"), "2024-07-02T04:08:33.000Z");
  assert.equal(sepay.sepayDateToIso("2024-07-02T04:08:33Z"), "2024-07-02T04:08:33.000Z");
  assert.equal(sepay.sepayDateToIso("nonsense"), null);
});

test("sepay: verifyWebhookAuth accepts the right key, rejects wrong/missing/different length", () => {
  const key = LEKT.sepayKey;
  assert.equal(sepay.verifyWebhookAuth(`Apikey ${key}`, key), true);
  assert.equal(sepay.verifyWebhookAuth(`apikey ${key}`, key), true, "scheme is case-insensitive");
  assert.equal(sepay.verifyWebhookAuth("Apikey wrong", key), false);
  assert.equal(sepay.verifyWebhookAuth("Apikey ", key), false);
  assert.equal(sepay.verifyWebhookAuth(`Apikey ${key}x`, key), false, "different length must not throw");
  assert.equal(sepay.verifyWebhookAuth(`Bearer ${key}`, key), false, "only the Apikey scheme is accepted");
  assert.equal(sepay.verifyWebhookAuth(null, key), false);
  assert.equal(sepay.verifyWebhookAuth(`Apikey ${key}`, ""), false);
  assert.equal(sepay.verifyWebhookAuth(`Apikey ${key}`, null), false);
});

test("sepay: poll namespaces API ids so a webhook row cannot collide", async () => {
  const fetchImpl = async () =>
    jsonResponse({ status: "success", data: [fixtures.sepay.apiIncoming, fixtures.sepay.apiOutgoing] });
  const result = await sepay.fetchSepayTransactions({
    config: {},
    secrets: { apiToken: LEKT.sepayToken },
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.transactions.map((tx) => tx.externalId),
    [
      "sepay-api:a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "sepay-api:b1b2c3d4-e5f6-7890-abcd-ef1234567891",
    ]
  );
});

test("sepay: no token means no polling, with a message that names no credential", async () => {
  const result = await sepay.fetchSepayTransactions({ config: {}, secrets: {}, fetchImpl: async () => jsonResponse({}) });
  assert.equal(result.ok, false);
  assertNoSecrets(result, "sepay/no-token");
});

test("sepay: an HTTP failure is reported without the URL or token", async () => {
  const fetchImpl = async () => jsonResponse({ message: "Unauthorized" }, 401);
  const result = await sepay.fetchSepayTransactions({
    config: {},
    secrets: { apiToken: LEKT.sepayToken },
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /sepay: HTTP 401/);
  assertNoSecrets(result, "sepay/401");
});

test("sepay: a timeout is reported as waiting, not as a crash", async () => {
  const fetchImpl = async () => {
    const error = new Error("timed out");
    error.name = "TimeoutError";
    throw error;
  };
  const result = await sepay.fetchSepayTransactions({
    config: {},
    secrets: { apiToken: LEKT.sepayToken },
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /hết thời gian chờ/);
  assertNoSecrets(result, "sepay/timeout");
});

// ── web2m ──────────────────────────────────────────────────────────────────

test("web2m: incoming row normalizes id without spaces, direction, amount, memo", () => {
  const tx = web2m.normalizeWeb2mTransaction(fixtures.web2m.incoming);
  assert.equal(tx.externalId, "FT24012345678");
  assert.equal(tx.direction, "in");
  assert.equal(tx.amount, 250000);
  assert.equal(tx.currency, "VND");
  assert.equal(tx.content, "MBVCB.DR8K3Q7MZP.CT tu 0123");
  assert.equal(tx.occurredAt, "2024-07-02T04:08:33.000Z");
});

test("web2m: outgoing row normalizes as out", () => {
  const tx = web2m.normalizeWeb2mTransaction(fixtures.web2m.outgoing);
  assert.equal(tx.externalId, "FT24012345679");
  assert.equal(tx.direction, "out");
  assert.equal(tx.amount, 50000);
});

test("web2m: an unknown direction is treated as outgoing, never as money in", () => {
  const tx = web2m.normalizeWeb2mTransaction({ transactionID: "X1", type: "??", amount: 1000 });
  assert.equal(tx.direction, "out");
});

test("web2m: URL for both styles", () => {
  const tokenStyle = web2m.buildWeb2mUrl({
    config: { apiBase: "https://web2m.example/api/", urlStyle: "token" },
    secrets: { token: "tok123" },
  });
  assert.equal(tokenStyle, "https://web2m.example/api/tok123");

  const passStyle = web2m.buildWeb2mUrl({
    config: { apiBase: "https://web2m.example/api", urlStyle: "password_account_token", accountNumber: "0123456789" },
    secrets: { token: "tok123", password: "p@ss/word" },
  });
  assert.equal(passStyle, "https://web2m.example/api/p%40ss%2Fword/0123456789/tok123");
});

test("web2m: a missing password for the password style fails without echoing anything", () => {
  assert.throws(
    () => web2m.buildWeb2mUrl({
      config: { apiBase: "https://web2m.example/api", urlStyle: "password_account_token", accountNumber: "0123" },
      secrets: { token: LEKT.web2mToken },
    }),
    (error) => {
      assert.equal(error.message.includes(LEKT.web2mToken), false);
      assert.match(error.message, /mật khẩu/);
      return true;
    }
  );
});

test("web2m: the token never appears in a fetch error", async () => {
  const fetchImpl = async () => jsonResponse({}, 502);
  const result = await web2m.fetchWeb2mTransactions({
    config: { apiBase: "https://web2m.example/api", urlStyle: "token" },
    secrets: { token: LEKT.web2mToken },
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /HTTP 502/);
  assertNoSecrets(result, "web2m/502");
});

test("web2m: the password-style URL never appears in a fetch error", async () => {
  const fetchImpl = async () => {
    const error = new Error("ECONNREFUSED");
    throw error;
  };
  const result = await web2m.fetchWeb2mTransactions({
    config: { apiBase: "https://web2m.example/api", urlStyle: "password_account_token", accountNumber: "0123" },
    secrets: { token: LEKT.web2mToken, password: LEKT.web2mPassword },
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assertNoSecrets(result, "web2m/password-transport");
});

test("web2m: a body without `transactions` is an outage, not 'no payments'", async () => {
  const fetchImpl = async () => jsonResponse({ error: "maintenance" });
  const result = await web2m.fetchWeb2mTransactions({
    config: { apiBase: "https://web2m.example/api" },
    secrets: { token: LEKT.web2mToken },
    fetchImpl,
  });
  assert.equal(result.ok, false);
});

test("web2m: an empty list is a valid success", async () => {
  const fetchImpl = async () => jsonResponse({ transactions: [] });
  const result = await web2m.fetchWeb2mTransactions({
    config: { apiBase: "https://web2m.example/api" },
    secrets: { token: LEKT.web2mToken },
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.transactions, []);
});

test("web2m: fetch normalizes both directions from one response", async () => {
  const fetchImpl = async () =>
    jsonResponse({ transactions: [fixtures.web2m.incoming, fixtures.web2m.outgoing] });
  const result = await web2m.fetchWeb2mTransactions({
    config: { apiBase: "https://web2m.example/api" },
    secrets: { token: LEKT.web2mToken },
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.transactions.map((tx) => tx.direction), ["in", "out"]);
});

// ── Binance ────────────────────────────────────────────────────────────────

test("binance: signQuery matches a known HMAC-SHA256 vector", () => {
  const secret = "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j";
  assert.equal(
    binance.signQuery("timestamp=1610090460133&recvWindow=10000", secret),
    "57e712d79f16172673ee3ecf4bb9a107217e9d04ab100bd00167abc0da3b0d8e"
  );
});

test("binance: buildQuery sorts keys so the same params always sign identically", () => {
  assert.equal(
    binance.buildQuery({ timestamp: 1, limit: 100, recvWindow: 10000, startTime: 2 }),
    "limit=100&recvWindow=10000&startTime=2&timestamp=1"
  );
});

test("binance: incoming row normalizes to nano-USDT", () => {
  const tx = binance.normalizeBinanceTransaction(fixtures.binance.incoming);
  assert.equal(tx.externalId, "M_P_71505104267788288");
  assert.equal(tx.direction, "in");
  assert.equal(tx.amount, 10_500_000_000);
  assert.equal(tx.currency, "USDT");
  assert.equal(tx.occurredAt, "2021-01-08T07:21:00.133Z");
});

test("binance: outgoing row normalizes as out with a positive amount", () => {
  const tx = binance.normalizeBinanceTransaction(fixtures.binance.outgoing);
  assert.equal(tx.direction, "out");
  assert.equal(tx.amount, 4_250_000_000);
});

test("binance: a non-USDT row is ignored", () => {
  assert.equal(binance.normalizeBinanceTransaction(fixtures.binance.nonUsdt), null);
});

test("binance: a mixed-asset row is priced from its USDT line", () => {
  const tx = binance.normalizeBinanceTransaction(fixtures.binance.mixedAsset);
  assert.equal(tx.amount, 9_990_000_000, "9.99 USDT from fundsDetail, not 0.0001 BTC");
});

test("binance: fetch drops non-USDT rows and keeps the rest", async () => {
  const fetchImpl = async () =>
    jsonResponse({
      code: "000000",
      message: "success",
      data: [fixtures.binance.incoming, fixtures.binance.nonUsdt, fixtures.binance.outgoing],
    });
  const result = await binance.fetchBinanceTransactions({
    config: {},
    secrets: { apiKey: LEKT.binanceKey, apiSecret: LEKT.binanceSecret },
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.transactions.map((tx) => tx.externalId), [
    "M_P_71505104267788288",
    "M_P_71505104267788289",
  ]);
});

test("binance: the request is signed and carries X-MBX-APIKEY", async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return jsonResponse({ code: "000000", data: [] });
  };
  await binance.fetchBinanceTransactions({
    config: {},
    secrets: { apiKey: LEKT.binanceKey, apiSecret: LEKT.binanceSecret },
    fetchImpl,
    now: () => 1_700_000_000_000,
    lookbackDays: 1,
  });
  assert.equal(seen.init.headers["X-MBX-APIKEY"], LEKT.binanceKey);
  const query = seen.url.split("?")[1];
  const unsigned = query.split("&signature=")[0];
  assert.match(query, /&signature=[a-f0-9]{64}$/);
  assert.equal(query.split("&signature=")[1], binance.signQuery(unsigned, LEKT.binanceSecret));
  assert.match(unsigned, /timestamp=1700000000000/);
  assert.match(unsigned, /recvWindow=10000/);
});

test("binance: a rejected signature is reported by code, without the secret", async () => {
  const fetchImpl = async () =>
    jsonResponse({ code: -1022, msg: "Signature for this request is not valid." }, 400);
  const result = await binance.fetchBinanceTransactions({
    config: {},
    secrets: { apiKey: LEKT.binanceKey, apiSecret: LEKT.binanceSecret },
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /HTTP 400/);
  assert.match(result.error, /-1022/);
  assertNoSecrets(result, "binance/400");
});

test("binance: missing credentials are refused before any request", async () => {
  let called = false;
  const result = await binance.fetchBinanceTransactions({
    config: {},
    secrets: {},
    fetchImpl: async () => { called = true; return jsonResponse({}); },
  });
  assert.equal(result.ok, false);
  assert.equal(called, false);
  assertNoSecrets(result, "binance/no-credentials");
});

test("binance: a 200 with a non-zero code is an error, not an empty history", async () => {
  const fetchImpl = async () => jsonResponse({ code: "100001", message: "internal error" });
  const result = await binance.fetchBinanceTransactions({
    config: {},
    secrets: { apiKey: LEKT.binanceKey, apiSecret: LEKT.binanceSecret },
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /100001/);
});

test("binance: a network failure names no URL", async () => {
  const result = await binance.fetchBinanceTransactions({
    config: {},
    secrets: { apiKey: LEKT.binanceKey, apiSecret: LEKT.binanceSecret },
    fetchImpl: async () => { throw new Error("ECONNRESET"); },
  });
  assert.equal(result.ok, false);
  assertNoSecrets(result, "binance/network");
});

// ── NC-1: redaction by VALUE, not by label ────────────────────────────────
//
// The earlier suite only grepped for a credential after a label it controls, which
// is exactly how a body echoing `key=ABC` slipped through. Each case below is a
// shape a real provider returns, with the secret embedded in a place no label
// pattern can find on its own.

test("NC-1: sanitizeMessage redacts the value even with a bare `key=` label", async () => {
  const { sanitizeMessage } = await import("../src/lib/payments/providers/http.js");
  const key = LEKT.binanceKey;
  const out = sanitizeMessage(`upstream said: key=${key}`, { secrets: [key] });
  assert.equal(out.includes(key), false, `leaked in "${out}"`);
  assert.match(out, /\[redacted\]/);
});

test("NC-1: sanitizeMessage redacts a Bearer value the label pass would split", async () => {
  const { sanitizeMessage } = await import("../src/lib/payments/providers/http.js");
  const key = LEKT.binanceKey;
  const out = sanitizeMessage(`Authorization: Bearer ${key}`, { secrets: [key] });
  assert.equal(out.includes(key), false, `leaked in "${out}"`);
});

test("NC-1: sanitizeMessage redacts a JSON body quoting the key", async () => {
  const { sanitizeMessage } = await import("../src/lib/payments/providers/http.js");
  const key = LEKT.binanceKey;
  const out = sanitizeMessage(JSON.stringify({ msg: `bad key ${key}` }), { secrets: [key] });
  assert.equal(out.includes(key), false, `leaked in "${out}"`);
});

test("NC-1: sanitizeMessage redacts the real Binance shape", async () => {
  const { sanitizeMessage } = await import("../src/lib/payments/providers/http.js");
  const key = LEKT.binanceKey;
  const raw = `HTTP 500 (bad request https://api.binance.com/sapi/v1/pay/transactions?timestamp=1&signature=deadbeefdeadbeef auth=undefined key=${key} ua=node)`;
  const out = sanitizeMessage(raw, { secrets: [key] });
  assert.equal(out.includes(key), false, `leaked in "${out}"`);
  assert.equal(out.includes("signature=deadbeef"), false, "the signature must go too");
  assert.equal(/api\.binance\.com/.test(out), false, "the URL must go too");
});

test("NC-1: the label pass alone is not trusted — an unlabeled secret is caught", async () => {
  const { sanitizeMessage } = await import("../src/lib/payments/providers/http.js");
  const key = LEKT.web2mToken;
  const out = sanitizeMessage(`rejected ${key}`, { secrets: [key] });
  assert.equal(out.includes(key), false, `leaked in "${out}"`);
});

test("NC-1: a URL-encoded secret is redacted too", async () => {
  const { sanitizeMessage } = await import("../src/lib/payments/providers/http.js");
  const secret = "p@ss/w0rd-abc";
  const out = sanitizeMessage(`path=/api/${encodeURIComponent(secret)}/x`, { secrets: [secret] });
  assert.equal(out.includes(encodeURIComponent(secret)), false, `leaked in "${out}"`);
});

test("NC-1: providerMessage applies the value redaction to the provider's own text", async () => {
  const { providerMessage } = await import("../src/lib/payments/providers/http.js");
  const key = LEKT.binanceKey;
  const out = providerMessage({ msg: `Invalid key=${key}` }, ["msg"], [key]);
  assert.equal(out.includes(key), false, `leaked in "${out}"`);
});

test("NC-1: a Binance 500 whose body echoes the key leaks it nowhere", async () => {
  const fetchImpl = async () =>
    jsonResponse({ code: -1000, msg: `bad request auth=undefined key=${LEKT.binanceKey} ua=node` }, 500);
  const result = await binance.fetchBinanceTransactions({
    config: {},
    secrets: { apiKey: LEKT.binanceKey, apiSecret: LEKT.binanceSecret },
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assertAbsent(result, LEKT.binanceKey, "binance/500-echo");
  assertAbsent(result, LEKT.binanceSecret, "binance/500-echo");
});

test("NC-1: a SePay 401 body quoting the token leaks it nowhere", async () => {
  const fetchImpl = async () => jsonResponse({ message: `Unauthorized token: ${LEKT.sepayToken}` }, 401);
  const result = await sepay.fetchSepayTransactions({
    config: {},
    secrets: { apiToken: LEKT.sepayToken },
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assertAbsent(result, LEKT.sepayToken, "sepay/401-echo");
});

test("NC-1: a web2m body echoing the bank password leaks it nowhere", async () => {
  const fetchImpl = async () =>
    jsonResponse({ error: `wrong password ${LEKT.web2mPassword} for token ${LEKT.web2mToken}` }, 403);
  const result = await web2m.fetchWeb2mTransactions({
    config: { apiBase: "https://web2m.example/api", urlStyle: "password_account_token", accountNumber: "0123" },
    secrets: { token: LEKT.web2mToken, password: LEKT.web2mPassword },
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assertAbsent(result, LEKT.web2mPassword, "web2m/403-echo");
  assertAbsent(result, LEKT.web2mToken, "web2m/403-echo");
});
