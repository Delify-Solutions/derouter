// Deploy (deploy.com) on /dashboard/quota: the prepaid USD balance lives behind the
// portal session cookie, not the Secret Key, and a zero balance is why inference 405s.
// A loopback portal (DEPLOY_LOCAL_TEST_ORIGIN) stands in for ajax-portal.deploy.com:
// proxyAwareFetch has its own transport, so replacing globalThis.fetch would not intercept it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

let handler = () => ({ body: {}, status: 404 });
let seen = [];
const server = http.createServer((req, res) => {
  seen.push({ url: req.url, cookie: req.headers.cookie || "" });
  const { body, status } = handler(req.url);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.DEPLOY_LOCAL_TEST_ORIGIN = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const deployUsage = await import("../open-sse/services/usage/deploy.js");
const { getDeployUsage, deployCookieHeader, deployOrganizationId, deployQuotaFromBalance } = deployUsage;
const { getUsageForProvider } = await import("../open-sse/services/usage.js");
const deployRegistry = (await import("../open-sse/providers/registry/deploy.js")).default;
const { getCapabilitiesForModel } = await import("../open-sse/providers/capabilities.js");
const { getPricingForModel } = await import("../open-sse/providers/pricing.js");

const PROFILE = { status_code: 200, message: "success", data: { personal_organization: { organization_id: 1441188914 } } };
const BALANCE = (balance) => ({
  status_code: 200,
  message: "success",
  data: { payment_model: "credits", billing_info: { balance, recurring: null } },
});

// Route a loopback portal by path; every unlisted path is a 404.
function portal(routes) {
  handler = (url) => routes[url] || { body: {}, status: 404 };
}

test("registry: Deploy is an apikey LLM provider the quota page can read", () => {
  assert.equal(deployRegistry.id, "deploy");
  assert.equal(deployRegistry.category, "apikey");
  assert.equal(deployRegistry.features?.usage, true);
  assert.equal(deployRegistry.features?.usageApikey, true, "the usage route only serves apikey connections on this list");
  assert.equal(deployRegistry.transport.baseUrl, "https://api.deploy.com/api/v1/chat/completions");
  // Both documented models are seeded, with the upstream ids the API actually accepts.
  const ids = deployRegistry.models.map((m) => m.id);
  assert.deepEqual(ids, ["deepseek-ai/deepseek-v4.1-flash-1017", "zai-org/glm-5.3-flash"]);
});

test("registry: Deploy's list prices beat the canonical rates for the same models", () => {
  // The upstream's own numbers (docs.deploy.com/models-and-pricing), not the canonical ones.
  const deepseek = getPricingForModel("deploy", "deepseek-ai/deepseek-v4.1-flash-1017");
  assert.equal(deepseek.input, 0.10);
  assert.equal(deepseek.output, 0.35);
  assert.equal(deepseek.cached, 0.003);
  const glm = getPricingForModel("deploy", "zai-org/glm-5.3-flash");
  assert.equal(glm.input, 0.05);
  assert.equal(glm.output, 0.17);
  // A bare id (what a client may send after the provider prefix) prices the same.
  assert.equal(getPricingForModel("deploy", "glm-5.3-flash").input, 0.05);
  // Another provider is untouched by the override.
  assert.notEqual(getPricingForModel("openrouter", "zai-org/glm-5.3-flash")?.input, 0.05);
});

test("capabilities: both Deploy models keep their 1M context and reasoning lane", () => {
  const deepseek = getCapabilitiesForModel("deploy", "deepseek-ai/deepseek-v4.1-flash-1017");
  assert.equal(deepseek.contextWindow, 1000000);
  assert.equal(deepseek.vision, true);
  assert.equal(deepseek.reasoning, true);
  const glm = getCapabilitiesForModel("deploy", "zai-org/glm-5.3-flash");
  assert.equal(glm.contextWindow, 1000000);
  assert.equal(glm.videoInput, true);
});

test("cookie input: bare value, name=value, DevTools blob and JSON array all normalise; junk is no cookie", () => {
  assert.equal(deployCookieHeader(""), "");
  assert.equal(deployCookieHeader("   "), "");
  assert.equal(deployCookieHeader(null), "");
  assert.equal(deployCookieHeader("abc123"), "hive-portal-production=abc123", "a bare value gets the portal cookie name");
  assert.equal(deployCookieHeader("hive-portal-production=abc"), "hive-portal-production=abc");
  assert.equal(deployCookieHeader("csrf=MTc; hive-portal-production=abc"), "csrf=MTc; hive-portal-production=abc");
  assert.equal(deployCookieHeader('[{"name":"hive-portal-production","value":"v"}]'), "hive-portal-production=v");
  assert.equal(deployCookieHeader("{not json"), "", "malformed cookie JSON must not throw");
  // Percent-encoded session values are passed through untouched — re-encoding breaks the cookie.
  const encoded = "hive-portal-production=VHII%2Babc%2Fdef%3D%3D";
  assert.equal(deployCookieHeader(encoded), encoded);
});

test("organization id: read from the profile, never invented", () => {
  assert.equal(deployOrganizationId({ data: { personal_organization: { organization_id: 1441188914 } } }), "1441188914");
  assert.equal(deployOrganizationId({ data: { default_organization: { organization_id: 7 } } }), "7", "falls back to the default org");
  assert.equal(deployOrganizationId(PROFILE), "1441188914", "the real answer shape");
  assert.equal(deployOrganizationId({ data: {} }), null);
  assert.equal(deployOrganizationId({ data: { personal_organization: { organization_id: "abc" } } }), null);
  assert.equal(deployOrganizationId(null), null);
});

test("balance row: a prepaid purse, not a rate window", () => {
  const paid = deployQuotaFromBalance(BALANCE("32.5113524840"));
  assert.equal(paid.plan, "Deploy");
  assert.equal(paid.paymentModel, "credits");
  assert.equal(paid.quota.name, "Balance (USD)");
  assert.equal(paid.quota.total, 32.511352484);
  assert.equal(paid.quota.used, 0);
  assert.equal(paid.quota.remainingPercentage, 100);
  assert.equal(paid.quota.isCreditBalance, true);
  assert.equal(paid.quota.currency, "USD");
  assert.equal(paid.quota.resetAt, null, "a prepaid balance never resets");
  const empty = deployQuotaFromBalance(BALANCE("0.0000000000"));
  assert.equal(empty.quota.remainingPercentage, 0, "an empty purse reads 0%, not 100%");
  assert.equal(deployQuotaFromBalance({ data: {} }), null);
  assert.equal(deployQuotaFromBalance({ data: { billing_info: { balance: "not a number" } } }), null);
});

test("no cookie: a message that says where the balance comes from, and no network call", async () => {
  seen = [];
  portal({});
  const out = await getDeployUsage("sk-live-key", {}, null);
  assert.equal(out.quotas, undefined);
  assert.match(out.message, /cookie/i);
  assert.match(out.message, /portal/, "the message names the portal, not the API key");
  assert.deepEqual(seen, [], "a key alone cannot reach the balance endpoint");
});

test("cookie: profile resolves the org, then the balance is read from it", async () => {
  seen = [];
  portal({
    "/api/profile": { body: PROFILE, status: 200 },
    "/api/organization/1441188914/balance": { body: BALANCE("32.5113524840"), status: 200 },
  });
  const out = await getDeployUsage("sk-live-key", { cookie: "hive-portal-production=abc" }, null);
  assert.deepEqual(seen.map((s) => s.url), ["/api/profile", "/api/organization/1441188914/balance"]);
  assert.equal(seen[0].cookie, "hive-portal-production=abc", "the cookie header is sent as pasted");
  assert.equal(out.plan, "Deploy");
  assert.equal(out.quotas["Balance (USD)"].total, 32.511352484);
});

test("cookie + pinned organization id: the profile call is skipped", async () => {
  seen = [];
  portal({ "/api/organization/1441188914/balance": { body: BALANCE("12.5"), status: 200 } });
  const out = await getDeployUsage("sk", { cookie: "hive-portal-production=abc", organizationId: "1441188914" }, null);
  assert.deepEqual(seen.map((s) => s.url), ["/api/organization/1441188914/balance"]);
  assert.equal(out.quotas["Balance (USD)"].balance, 12.5);
});

test("an expired cookie and a paused organization each read as their own state", async () => {
  portal({ "/api/profile": { body: { message: "401 Authentication Failed: Cookie and authorization header is missing." }, status: 401 } });
  const expired = await getDeployUsage("sk", { cookie: "hive-portal-production=old" }, null);
  assert.equal(expired.quotas, undefined);
  assert.match(expired.message, /hết hạn/i);

  portal({ "/api/organization/1441188914/balance": { body: BALANCE("0"), status: 200 } });
  const empty = await getDeployUsage("sk", { cookie: "hive-portal-production=abc", organizationId: "1441188914" }, null);
  assert.match(empty.plan, /hết số dư/, "a zero balance is stated in the plan label");
  assert.equal(empty.quotas["Balance (USD)"].balance, 0);
});

test("a portal error is a message, never a fabricated balance", async () => {
  portal({ "/api/profile": { body: {}, status: 500 } });
  const down = await getDeployUsage("sk", { cookie: "hive-portal-production=abc" }, null);
  assert.equal(down.quotas, undefined);
  assert.match(down.message, /500/);
});

test("the usage dispatcher reaches Deploy with the connection's cookie", async () => {
  seen = [];
  portal({ "/api/organization/1441188914/balance": { body: BALANCE("7.25"), status: 200 } });
  const out = await getUsageForProvider({
    provider: "deploy",
    authType: "apikey",
    apiKey: "sk-live-key",
    providerSpecificData: { cookie: "hive-portal-production=abc", organizationId: "1441188914" },
  }, null, {});
  assert.equal(out.quotas["Balance (USD)"].balance, 7.25);
  assert.equal(seen[0].cookie, "hive-portal-production=abc");
});
