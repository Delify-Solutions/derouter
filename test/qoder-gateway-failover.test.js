// Qoder intl gateways for device tokens (api3, api2): a gateway that cannot be connected to
// on a direct connection is skipped for the next one, and is tried last for a while afterwards.
import { test } from "node:test";
import assert from "node:assert/strict";

const gw = await import("../open-sse/shared/qoder/constants.js");
const { seedQoderCatalogForTests, clearQoderCatalog } = await import("../open-sse/services/qoderModels.js");
const { QoderExecutor } = await import("../open-sse/executors/qoder.js");

// undici's shape: TypeError("fetch failed") with the connect error as its cause.
const connectError = (code = "UND_ERR_CONNECT_TIMEOUT") =>
  Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("Connect Timeout Error"), { code }) });
const API3 = "https://api3.qoder.sh";
const API2 = "https://api2.qoder.sh";
const dt = { provider: "qoder", accessToken: "dt-1" };

test.beforeEach(() => gw.resetQoderGatewaysForTests());

test("gateway order per token kind and region", () => {
  assert.deepEqual(gw.qoderInferenceBases(dt), [API3, API2]);
  assert.deepEqual(gw.qoderInferenceBases({ accessToken: "jt-1" }), [API2]);
  assert.deepEqual(gw.qoderInferenceBases(dt, "cn"), ["https://gateway.qoder.com.cn"]);
  assert.equal(gw.qoderInferenceBase(dt), API3);
});

test("an unreachable gateway is tried last until its window ends", () => {
  const now = 1_000_000;
  gw.markQoderGatewayFailed(API3, now);
  assert.deepEqual(gw.qoderInferenceBases(dt, "intl", now + 1000), [API2, API3]);
  assert.equal(gw.qoderInferenceBases(dt, "intl", now + gw.QODER_GATEWAY_FAILED_MS + 1)[0], API3);
  gw.markQoderGatewayFailed("https://evil.example", now);
  assert.equal(gw.qoderInferenceBases(dt, "intl", now + 1000).length, 2);
});

test("only connect-phase error codes count, never message text", () => {
  assert.equal(gw.isQoderConnectError(connectError()), true);
  assert.equal(gw.isQoderConnectError(Object.assign(new AggregateError([]), { code: "ECONNREFUSED" })), true);
  assert.equal(gw.isQoderConnectError(connectError("ENOTFOUND")), true);
  assert.equal(gw.isQoderConnectError(new Error("fetch connect timeout")), false, "the executor's post-connect timer");
  assert.equal(gw.isQoderConnectError(new Error("[ProxyFetch] Proxy required but failed (strictProxy=true): fetch failed")), false);
  assert.equal(gw.isQoderConnectError(new Error("UND_ERR_CONNECT_TIMEOUT in some text")), false);
  assert.equal(gw.isQoderConnectError(null), false);
});

test("withQoderGateway: next gateway on a connect error; every failed gateway is marked", async () => {
  const tried = [];
  const { result, base } = await gw.withQoderGateway({ credentials: dt }, async (b) => {
    tried.push(b);
    if (b === API3) throw connectError();
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(base, API2);
  assert.deepEqual(tried, [API3, API2]);
  assert.deepEqual(gw.qoderInferenceBases(dt), [API2, API3]);

  gw.resetQoderGatewaysForTests();
  await assert.rejects(gw.withQoderGateway({ credentials: dt }, async () => { throw connectError(); }));
  const now = Date.now();
  // both marked; the one that failed first is the one tried first again
  assert.equal(gw.qoderInferenceBases(dt, "intl", now).length, 2);
});

test("withQoderGateway: no failover through a relay or proxy, for a job token, or for other errors", async () => {
  const run = async (opts, err = connectError()) => {
    const tried = [];
    await assert.rejects(gw.withQoderGateway({ credentials: dt, ...opts }, async (b) => { tried.push(b); throw err; }));
    return tried;
  };
  assert.deepEqual(await run({ proxyOptions: { vercelRelayUrl: "https://relay.example" } }), [API3]);
  assert.deepEqual(await run({ proxyOptions: { connectionProxyEnabled: true, connectionProxyUrl: "http://p:1" } }), [API3]);
  assert.deepEqual(gw.qoderInferenceBases(dt), [API3, API2], "a dead relay/proxy does not mark gateways");
  assert.deepEqual(await run({}, new Error("fetch connect timeout")), [API3]);
  const jtTried = [];
  await assert.rejects(gw.withQoderGateway({ credentials: { accessToken: "jt-1" } }, async (b) => { jtTried.push(b); throw connectError(); }));
  assert.deepEqual(jtTried, [API2]);
  const ctrl = new AbortController();
  ctrl.abort();
  assert.deepEqual(await run({ signal: ctrl.signal }), [API3], "a caller abort is not failed over");
});

function chatExecutor(hosts, behave) {
  const executor = new QoderExecutor();
  executor.fetchImpl = async (url) => {
    const host = new URL(url).host;
    hosts.push(host);
    return behave(host);
  };
  return executor;
}
const chat = (executor, credentials) => executor.execute({
  model: "qoder/auto",
  body: { messages: [{ role: "user", content: "hi" }] },
  stream: true,
  credentials,
  log: null,
});

test("chat: api3 unreachable → the request goes to api2, and the next one starts there", async () => {
  clearQoderCatalog();
  const credentials = { provider: "qoder", accessToken: "dt-tok", providerSpecificData: { userId: "u-1" } };
  seedQoderCatalogForTests(credentials, { chat: [{ key: "auto", display_name: "Auto" }] });
  const hosts = [];
  const executor = chatExecutor(hosts, (host) => {
    if (host === "api3.qoder.sh") throw connectError();
    return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
  });
  const first = await chat(executor, credentials);
  assert.deepEqual(hosts, ["api3.qoder.sh", "api2.qoder.sh"]);
  assert.equal(new URL(first.url).host, "api2.qoder.sh");
  hosts.length = 0;
  await chat(executor, credentials);
  assert.equal(hosts[0], "api2.qoder.sh", "the failed gateway is skipped next time");
  clearQoderCatalog();
});

test("chat: a post-connect failure is not resent to another gateway", async () => {
  clearQoderCatalog();
  const credentials = { provider: "qoder", accessToken: "dt-tok", providerSpecificData: { userId: "u-2" } };
  seedQoderCatalogForTests(credentials, { chat: [{ key: "auto", display_name: "Auto" }] });
  const hosts = [];
  const executor = chatExecutor(hosts, () => { throw new Error("fetch connect timeout"); });
  await assert.rejects(() => chat(executor, credentials));
  assert.deepEqual(hosts, ["api3.qoder.sh"]);
  clearQoderCatalog();
});
