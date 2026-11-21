// End-to-end check for the "AI doanh nghiệp" product (task 9.1).
//
// Runs against the standalone build with a throwaway DATA_DIR and a stubbed
// OpenAI-compatible upstream (scripts/biz-e2e-upstream.mjs). It drives the REAL
// pages with Playwright, so what it proves is what a browser sees:
//
//   1. /doanh-nghiep renders the five pipeline steps and the animation is running;
//   2. with `prefers-reduced-motion: reduce` nothing in the diagram animates;
//   3. a customer with a business plan creates a bot, uploads a TXT, sees it
//      ready, and gets a real reply from the playground.
//
// The admin/customer setup (provider, combo, prices, plan purchase) goes through a
// tiny seeding script run with the router's own modules against the same DATA_DIR,
// because those are console-only flows already covered by their own tests.
//
// Usage: node scripts/biz-e2e.mjs
// Env:   PORT (default 39128), BASE_URL to reuse a running server.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PLAYWRIGHT_PATH = process.env.PLAYWRIGHT_PATH ||
  "/Users/duogxaolin/.npm/_npx/e41f203b7505f1fb/node_modules/playwright";
const { chromium } = require(PLAYWRIGHT_PATH);

const PORT = Number(process.env.PORT || 39128);
const UPSTREAM_PORT = Number(process.env.BIZ_E2E_UPSTREAM_PORT || 39127);
const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;
const DATA_DIR = process.env.BIZ_E2E_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "derouter-biz-e2e-"));
const UPSTREAM_TOKEN = "test-token";

const CUSTOMER = { email: `biz-e2e-${Date.now()}@test.local`, password: "MatKhau123!@" };
const REPLY = "Sofa da nhập khẩu giá 12 triệu đồng, bảo hành 2 năm.";

let failures = 0;
function step(name) {
  console.log(`\n▶ ${name}`);
}
function ok(message) {
  console.log(`  ✓ ${message}`);
}
function fail(message) {
  failures += 1;
  console.error(`  ✗ ${message}`);
}

function waitForServer(url, timeoutMs = 90_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(url);
        if (res.status < 500) return resolve();
      } catch {
        /* not up yet */
      }
      if (Date.now() - started > timeoutMs) return reject(new Error(`server did not start: ${url}`));
      setTimeout(tick, 500);
    };
    tick();
  });
}

async function main() {
  const children = [];
  const cleanup = () => {
    for (const child of children.reverse()) {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
  };
  process.on("exit", cleanup);

  // ── stubbed upstream ──────────────────────────────────────────────────────
  step("Start the stubbed upstream");
  const upstream = spawn(process.execPath, ["scripts/biz-e2e-upstream.mjs"], {
    env: {
      ...process.env,
      BIZ_E2E_UPSTREAM_PORT: String(UPSTREAM_PORT),
      BIZ_E2E_UPSTREAM_TOKEN: UPSTREAM_TOKEN,
      BIZ_E2E_CHAT_REPLY: REPLY,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(upstream);
  upstream.stdout.on("data", (data) => process.stdout.write(`    ${data}`));
  await waitForServer(`http://127.0.0.1:${UPSTREAM_PORT}/`, 20_000).catch(() => {});
  ok(`upstream on 127.0.0.1:${UPSTREAM_PORT}`);

  // ── router ────────────────────────────────────────────────────────────────
  let server = null;
  if (!process.env.BASE_URL) {
    step("Start the standalone server");
    server = spawn(process.execPath, [".next/standalone/custom-server.js"], {
      env: {
        ...process.env,
        PORT: String(PORT),
        HOSTNAME: "127.0.0.1",
        DATA_DIR,
        INITIAL_PASSWORD: "admin-e2e-password",
        DISABLE_TELEGRAM_REMINDERS: "true",
        DISABLE_PAYMENT_POLLER: "true",
        NEXT_PHASE: "phase-production-server",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(server);
    server.stderr.on("data", (data) => {
      const text = String(data);
      if (/error|Error/.test(text)) process.stderr.write(`    ${text}`);
    });
    await waitForServer(`${BASE_URL}/api/health`);
    ok(`router on ${BASE_URL} (DATA_DIR ${DATA_DIR})`);
  }

  // ── seed through the router's own modules ─────────────────────────────────
  step("Seed provider, combos, plans and settings");
  const seed = spawn(process.execPath, ["scripts/biz-e2e-seed.mjs"], {
    env: {
      ...process.env,
      DATA_DIR,
      BIZ_E2E_UPSTREAM_PORT: String(UPSTREAM_PORT),
      BIZ_E2E_UPSTREAM_TOKEN: UPSTREAM_TOKEN,
      BIZ_E2E_CUSTOMER_EMAIL: CUSTOMER.email,
      BIZ_E2E_CUSTOMER_PASSWORD: CUSTOMER.password,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(seed);
  const seedCode = await new Promise((resolve) => seed.on("exit", resolve));
  assert.equal(seedCode, 0, "seeding failed");
  ok("seeded");

  // ── browser ───────────────────────────────────────────────────────────────
  step("Open /doanh-nghiep");
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  try {
    await page.goto(`${BASE_URL}/doanh-nghiep`, { waitUntil: "networkidle" });

    const heading = await page.locator("h1").first().textContent();
    heading?.includes("AI chatbot cho doanh nghiệp")
      ? ok("hero heading")
      : fail(`hero heading was "${heading}"`);

    const steps = ["Câu hỏi", "Lọc an toàn", "Tài liệu công ty", "Trả lời", "Kiểm duyệt"];
    for (const label of steps) {
      const visible = await page.locator("figcaption", { hasText: label }).count();
      visible ? ok(`step text "${label}"`) : fail(`step text "${label}" missing`);
    }

    const svg = page.locator("svg.biz-pipeline");
    (await svg.getAttribute("aria-hidden")) === "true"
      ? ok("diagram is aria-hidden")
      : fail("diagram is not aria-hidden");

    const animation = await page.evaluate(() => {
      const comet = document.querySelector(".biz-pipeline__comet");
      const chip = document.querySelector(".biz-pipeline__chip--1");
      const ping = document.querySelector(".biz-pipeline__ping");
      const read = (node) => (node ? getComputedStyle(node).animationName : "none");
      return { comet: read(comet), chip: read(chip), ping: read(ping) };
    });
    animation.comet === "biz-comet" && animation.chip === "biz-chip-1" && animation.ping === "biz-ping"
      ? ok("comet, chip highlight and ping are animating")
      : fail(`animation not running: ${JSON.stringify(animation)}`);

    // The comet must actually move: two samples of the computed offset.
    const offsets = await page.evaluate(async () => {
      const comet = document.querySelector(".biz-pipeline__comet");
      const first = getComputedStyle(comet).strokeDashoffset;
      await new Promise((resolve) => setTimeout(resolve, 600));
      const second = getComputedStyle(comet).strokeDashoffset;
      return [first, second];
    });
    offsets[0] !== offsets[1]
      ? ok(`comet moves (${offsets[0]} → ${offsets[1]})`)
      : fail(`comet is static at ${offsets[0]}`);

    const planCard = page.locator("text=Tối đa 2 bot").first();
    (await planCard.count()) > 0
      ? ok("business plan card shows the bot line")
      : fail("business plan card missing its bot line");

    step("Open /doanh-nghiep with prefers-reduced-motion");
    const reduced = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      reducedMotion: "reduce",
    });
    const reducedPage = await reduced.newPage();
    await reducedPage.goto(`${BASE_URL}/doanh-nghiep`, { waitUntil: "networkidle" });
    const reducedAnimation = await reducedPage.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll(".biz-pipeline, .biz-pipeline *"));
      return nodes.map((node) => getComputedStyle(node).animationName).filter((name) => name && name !== "none");
    });
    reducedAnimation.length === 0
      ? ok("no animation under prefers-reduced-motion")
      : fail(`still animating: ${reducedAnimation.join(", ")}`);
    await reduced.close();

    step("Main landing sells only API plans, and links to /doanh-nghiep");
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    const bizCardOnMain = await page.locator("text=Gói AI doanh nghiệp").count();
    bizCardOnMain === 0
      ? ok("no business plan card on the main landing")
      : fail(`the main landing still shows ${bizCardOnMain} business card heading(s)`);
    const navLink = page.locator('nav a[href="/doanh-nghiep"]').first();
    (await navLink.count()) > 0 ? ok("navigation links to /doanh-nghiep") : fail("navigation has no Doanh nghiệp link");

    step("Sign in as the customer");
    await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle" });
    await page.fill('input[type="email"]', CUSTOMER.email);
    await page.fill('input[type="password"]', CUSTOMER.password);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/account/, { timeout: 30_000 });
    ok("signed in");

    step("Account navigation and grouped plans");
    await page.goto(`${BASE_URL}/account/business`, { waitUntil: "networkidle" });
    const navLabels = await page.locator('nav[aria-label="Tài khoản"] a').allTextContents();
    const aiIndex = navLabels.findIndex((label) => label.includes("AI doanh nghiệp"));
    const keyIndex = navLabels.findIndex((label) => label.trim().endsWith("API key"));
    const usageIndex = navLabels.findIndex((label) => label.includes("Lịch sử dùng"));
    aiIndex > keyIndex && aiIndex < usageIndex
      ? ok("“AI doanh nghiệp” sits between “API key” and “Lịch sử dùng”")
      : fail(`account navigation order: ${JSON.stringify(navLabels)}`);

    await page.goto(`${BASE_URL}/account/plans`, { waitUntil: "networkidle" });
    const apiGroup = await page.locator("text=Gói API").count();
    const bizGroup = await page.locator("text=Gói AI doanh nghiệp").count();
    apiGroup > 0 && bizGroup > 0
      ? ok("plans page groups by product line")
      : fail(`plan groups missing (api=${apiGroup}, business=${bizGroup})`);

    step("Create a bot at /account/business");
    await page.goto(`${BASE_URL}/account/business`, { waitUntil: "networkidle" });
    const quotaLine = await page.locator("text=Tài liệu").first().textContent();
    ok(`quota tile: ${quotaLine?.trim().slice(0, 40)}`);

    await page.getByRole("button", { name: "Tạo bot" }).first().click();
    await page.fill("#bot-name", "Bot E2E");
    await page.fill("#bot-company", "Nội thất E2E");
    await page.fill("#bot-domain", "Cửa hàng bán sofa da và bàn ăn cho gia đình.");
    await page.locator('form button[type="submit"]').click();
    await page.waitForSelector("text=Bot E2E", { timeout: 20_000 });
    ok("bot created");

    step("Open the bot and upload a TXT");
    await page.getByRole("link", { name: "Mở bot" }).first().click();
    await page.waitForURL(/\/account\/business\/[^/]+$/, { timeout: 20_000 });
    await page.getByRole("tab", { name: "Tài liệu" }).click();
    await page.fill("#doc-title", "Bảng giá");
    const fileInput = page.locator("#doc-file");
    await fileInput.setInputFiles({
      name: "bang-gia.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(
        "Sofa da nhập khẩu giá 12 triệu đồng, bảo hành 2 năm.\n\nSofa vải giá 8 triệu đồng, bảo hành 1 năm."
      ),
    });
    await page.locator('form button[type="submit"]').click();
    await page.waitForSelector("text=Sẵn sàng", { timeout: 60_000 });
    ok("document reached “Sẵn sàng”");

    step("Ask the playground");
    await page.getByRole("tab", { name: "Chat thử" }).click();
    await page.fill("#playground-input", "Sofa da giá bao nhiêu?");
    await page.getByRole("button", { name: "Gửi câu hỏi" }).click();
    await page.waitForSelector(`text=${REPLY}`, { timeout: 60_000 });
    ok("playground answered through the pipeline");

    step("The bot key is fenced to chat completions");
    // Create a real bot key in the console, then call the non-chat endpoints with
    // it: the fence lives in the shared enforcement layer, so the API must answer
    // 403 endpoint_not_allowed with no model call.
    await page.getByRole("tab", { name: "Key API" }).click();
    await page.fill("#key-name", "Key E2E");
    await page.locator('form button[type="submit"]').click();
    await page.waitForSelector("text=Đây là lần duy nhất key hiện đầy đủ", { timeout: 20_000 });
    const botKey = await page.locator("code").first().textContent();
    const denied = await page.evaluate(async ({ key, base }) => {
      const response = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "e2e-biz", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    }, { key: botKey.trim(), base: BASE_URL });
    denied.status === 403 && denied.body?.error?.code === "endpoint_not_allowed"
      ? ok("bot key on /v1/messages → 403 endpoint_not_allowed")
      : fail(`bot key on /v1/messages returned ${denied.status} ${JSON.stringify(denied.body)}`);

    const listing = await page.evaluate(async ({ key, base }) => {
      const response = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${key}` } });
      const body = await response.json().catch(() => null);
      return { status: response.status, ids: (body?.data ?? []).map((model) => model.id) };
    }, { key: botKey.trim(), base: BASE_URL });
    listing.status === 200 && listing.ids.length === 1 && listing.ids[0] === "e2e-biz"
      ? ok(`bot key lists exactly the business model (${listing.ids.join(", ")})`)
      : fail(`bot key listing was ${JSON.stringify(listing)}`);

    step("Ask a sovereignty question in the playground");
    // The key-fence step above moved the page to another tab.
    await page.getByRole("tab", { name: "Chat thử" }).click();
    await page.fill("#playground-input", "Trường Sa thuộc về ai?");
    await page.getByRole("button", { name: "Gửi câu hỏi" }).click();
    await page.waitForSelector("text=Đã chặn: chủ quyền", { timeout: 20_000 });
    ok("sovereignty reply labelled with its category");
    step("Admin page: AI doanh nghiệp");
    // The admin session is a separate JWT signed with DATA_DIR/jwt-secret, which
    // the seeding script cannot mint (it is the console's own cookie). The page is
    // therefore opened with the router's password flow.
    const admin = await browser.newContext();
    const adminPage = await admin.newPage();
    await adminPage.goto(`${BASE_URL}/admin/ss`, { waitUntil: "networkidle" });
    await adminPage.fill('input[type="password"]', process.env.BIZ_E2E_ADMIN_PASSWORD || "admin-e2e-password");
    await adminPage.click('button[type="submit"]');
    await adminPage.waitForURL(/\/dashboard/, { timeout: 20_000 });
    await adminPage.goto(`${BASE_URL}/dashboard/business`, { waitUntil: "networkidle" });
    // The dashboard shell renders the product name as the first h1; the page's own
    // heading is the h1 inside main.
    const settingsTitle = await adminPage.locator("main h1").first().textContent();
    settingsTitle?.includes("AI doanh nghiệp")
      ? ok("admin settings page renders")
      : fail(`admin page heading was "${settingsTitle}"`);
    const botRow = await adminPage.locator("td", { hasText: "Bot E2E" }).count();
    botRow > 0 ? ok("admin overview lists the customer's bot") : fail("admin overview missing the bot row");
    const sidebarItem = await adminPage.locator('nav a[href="/dashboard/business"]').count();
    sidebarItem > 0 ? ok("sidebar has the AI doanh nghiệp entry") : fail("sidebar entry missing");
    await admin.close();
  } finally {
    await browser.close();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log("\nAll E2E checks passed");
  }
  cleanup();
  if (!process.env.BIZ_E2E_KEEP) {
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
