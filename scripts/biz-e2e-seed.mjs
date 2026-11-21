// Seeds the throwaway database the business E2E runs against.
//
// Runs OUTSIDE Next (plain node) against the same DATA_DIR as the standalone
// server, using the router's own repos — the same functions the console calls. It
// sets up exactly what a browser cannot: an OpenAI-compatible provider pointing at
// the stub, the two combos, their prices, the business settings, and a customer
// holding a live business plan plus an API-line purchase.
//
// Idempotent enough for a fresh temp dir; it is not meant to run twice.
import crypto from "node:crypto";
import bcrypt from "bcryptjs";

const PORT = Number(process.env.BIZ_E2E_UPSTREAM_PORT || 39127);
const TOKEN = process.env.BIZ_E2E_UPSTREAM_TOKEN || "test-token";
const EMAIL = process.env.BIZ_E2E_CUSTOMER_EMAIL;
const PASSWORD = process.env.BIZ_E2E_CUSTOMER_PASSWORD || "MatKhau123!@";

const { getAdapter } = await import("../src/lib/db/driver.js");
const { createProviderNode } = await import("../src/lib/db/repos/nodesRepo.js");
const { createProviderConnection } = await import("../src/lib/db/repos/connectionsRepo.js");
const { createCombo } = await import("../src/lib/db/repos/combosRepo.js");
const { updatePricing } = await import("../src/lib/db/repos/pricingRepo.js");
const { updateComboPricing } = await import("../src/lib/db/repos/comboPricingRepo.js");
const { createPlan } = await import("../src/lib/db/repos/billingRepo.js");
const { grantUserPlan } = await import("../src/lib/billing/grants.js");
const { createUser } = await import("../src/lib/db/repos/userRepo.js");
const { saveBusinessSettings } = await import("../src/lib/biz/settings.js");
const { NANO } = await import("../src/shared/utils/money.js");

const USD = (value) => Math.round(value * NANO);

const db = await getAdapter();

// ── Provider node + connection ─────────────────────────────────────────────
const chatNode = await createProviderNode({
  id: "openai-compatible-chat-e2e",
  type: "openai-compatible",
  prefix: "e2e",
  apiType: "chat",
  baseUrl: `http://127.0.0.1:${PORT}`,
  name: "E2E Stub",
});
await createProviderConnection({
  provider: chatNode.id,
  authType: "apikey",
  name: "E2E Stub",
  apiKey: TOKEN,
  priority: 1,
  providerSpecificData: { prefix: "e2e", apiType: "chat", baseUrl: `http://127.0.0.1:${PORT}`, nodeName: "E2E Stub" },
  isActive: true,
  testStatus: "active",
});

const embedNode = await createProviderNode({
  id: "custom-embedding-e2e",
  type: "custom-embedding",
  prefix: "e2e-embed",
  baseUrl: `http://127.0.0.1:${PORT}`,
  name: "E2E Embedding",
});
await createProviderConnection({
  provider: embedNode.id,
  authType: "apikey",
  name: "E2E Embedding",
  apiKey: TOKEN,
  priority: 1,
  providerSpecificData: { prefix: "e2e-embed", baseUrl: `http://127.0.0.1:${PORT}`, nodeName: "E2E Embedding" },
  isActive: true,
  testStatus: "active",
});

// ── Combos and prices ──────────────────────────────────────────────────────
await createCombo({ name: "e2e-biz", kind: "llm", models: ["e2e/stub-chat"] });
await createCombo({ name: "e2e-guard", kind: "llm", models: ["e2e/stub-chat"] });

// A combo price covers every member; per-pool pricing keeps the single-model
// refusal (`refuseUnpricedModel`) quiet for the member too.
await updateComboPricing({
  "e2e-biz": { input: 1, output: 2 },
  "e2e-guard": { input: 1, output: 2 },
});
await updatePricing({
  [chatNode.id]: { "stub-chat": { input: 1, output: 2 } },
  [embedNode.id]: { "stub-embed": { input: 0.01, output: 0 } },
});
await updatePricing({ [embedNode.id]: { "stub-embed": { input: 0.01, output: 0 } } });

// ── Business settings ──────────────────────────────────────────────────────
const saved = await saveBusinessSettings({
  businessModels: [{ id: "e2e-biz", label: "E2E Biz" }],
  guardModel: "e2e-guard",
  embeddingModel: "e2e-embed/stub-embed",
  relevanceThreshold: 0.05,
});
if (!saved.ok) throw new Error(`business settings: ${saved.error}`);

// ── Plans ──────────────────────────────────────────────────────────────────
const bizPlan = await createPlan({
  code: "biz-e2e",
  name: "Biz E2E",
  description: "Gói doanh nghiệp cho bài kiểm tra.",
  priceNanoUsd: USD(30),
  priceVnd: 750000,
  creditNanoUsd: USD(100),
  durationDays: 30,
  isActive: true,
  isPurchasable: true,
  productLine: "business",
  maxBots: 2,
  maxKbBytes: 20 * 1024 * 1024,
  limits: [],
  sortOrder: 1,
});
const apiPlan = await createPlan({
  code: "api-e2e",
  name: "API E2E",
  priceNanoUsd: USD(10),
  priceVnd: 250000,
  creditNanoUsd: USD(50),
  durationDays: 30,
  isActive: true,
  isPurchasable: true,
  productLine: "api",
  limits: [],
  sortOrder: 2,
});

// ── Customer ───────────────────────────────────────────────────────────────
const user = await createUser({
  email: EMAIL,
  passwordHash: await bcrypt.hash(PASSWORD, 10),
  displayName: "E2E Customer",
  status: "active",
});
const userId = user.id ?? user.user?.id;
if (!userId) throw new Error("could not create the customer");

db.transaction(() => {
  grantUserPlan(db, {
    userId,
    planId: bizPlan.id,
    source: "purchase",
    creditNanoUsd: USD(100),
    durationDays: 30,
    limits: [],
  });
  grantUserPlan(db, {
    userId,
    planId: apiPlan.id,
    source: "purchase",
    creditNanoUsd: USD(50),
    durationDays: 30,
    limits: [],
  });
});

console.log(JSON.stringify({
  node: chatNode.id,
  embed: embedNode.id,
  bizPlan: bizPlan.code,
  apiPlan: apiPlan.code,
  user: EMAIL,
  seed: crypto.randomBytes(4).toString("hex"),
}));
