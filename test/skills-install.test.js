// The one-line skill installer, end to end: the real route handlers behind a
// local HTTP server, and the real install script run by sh against a throwaway
// HOME. What matters is what lands on disk and who is refused.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { register } from "node:module";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-skills-install-"));
process.env.DATA_DIR = tmpDir;
register("./helpers/src-alias-hook.mjs", import.meta.url);
register("./helpers/next-server-hook.mjs", import.meta.url);

const { getAdapter } = await import("../src/lib/db/driver.js");
const { createApiKey } = await import("../src/lib/db/repos/apiKeysRepo.js");
const { updateSettings } = await import("../src/lib/db/repos/settingsRepo.js");
const skills = await import("../src/lib/db/repos/skillsRepo.js");
const bundlesRepo = await import("../src/lib/db/repos/skillBundlesRepo.js");
const { buildInstallScript, isSafeOrigin } = await import("../src/lib/skills/installScript.js");
const { bundleTarballUrl, bundleRawFileUrl, ENGINE_HOME_BASE } = await import("../src/lib/skills/engineTargets.js");
const installRoute = await import("../src/app/api/public/skills/install.sh/route.js");
const catalogRoute = await import("../src/app/api/public/skills/catalog/route.js");
const fileRoute = await import("../src/app/api/public/skills/file/[slug]/route.js");
const accountList = await import("../src/app/api/account/skills/route.js");
const accountOne = await import("../src/app/api/account/skills/[slug]/route.js");
const accountDownload = await import("../src/app/api/account/skills/[slug]/download/route.js");

const BODY_A = "---\nname: recon-pipeline\ndescription: Quét bề mặt\n---\n\n# Recon — tiếng Việt\n";
const BODY_B = "---\nname: data-sweep\ndescription: demo\n---\n\n# Data\n";

let db;
let server;
let baseUrl;
let customerKey;
let suspendedKey;
let adminKey;
let mockCatalog = null; // when set, the catalogue endpoint answers this instead
const home = path.join(tmpDir, "home");

before(async () => {
  db = await getAdapter();
  const now = new Date().toISOString();
  db.run(`INSERT INTO users(id, email, passwordHash, status, createdAt) VALUES('u1', 'u1@t.io', 'x', 'active', ?)`, [now]);
  db.run(`INSERT INTO users(id, email, passwordHash, status, createdAt) VALUES('u2', 'u2@t.io', 'x', 'suspended', ?)`, [now]);
  customerKey = (await createApiKey("cust", "m", { userId: "u1" })).key;
  suspendedKey = (await createApiKey("susp", "m", { userId: "u2" })).key;
  adminKey = (await createApiKey("ops", "m")).key;

  await skills.createSkill({ name: "Recon Pipeline", body: BODY_A, targets: ["claude", "cursor"], version: "1.2" });
  await skills.createSkill({ name: "Data Sweep", body: BODY_B, targets: ["codex"] });
  await skills.createSkill({ name: "Internal Only", body: BODY_B, audience: "internal" });
  await skills.createSkill({ name: "Draft One", body: BODY_B, isPublished: false });

  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const request = new Request(url, { headers: req.headers });
    let response;
    if (url.pathname === "/api/public/skills/install.sh") {
      response = await installRoute.GET(request);
    } else if (url.pathname === "/api/public/skills/catalog") {
      response = mockCatalog !== null
        ? new Response(mockCatalog, { status: 200 })
        : await catalogRoute.GET(request);
    } else if (url.pathname.startsWith("/api/public/skills/file/")) {
      const slug = decodeURIComponent(url.pathname.slice("/api/public/skills/file/".length));
      response = await fileRoute.GET(request, { params: Promise.resolve({ slug }) });
    } else {
      response = new Response("nope", { status: 404 });
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  try { db.close?.(); } catch { /* best effort */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function get(pathname, key) {
  return fetch(`${baseUrl}${pathname}`, key ? { headers: { Authorization: `Bearer ${key}` } } : {});
}

/**
 * Run the script the way a customer does (piped into sh), with its own HOME.
 * Asynchronous on purpose: the server under test lives in this process, so a
 * blocking spawn would deadlock it.
 */
function runInstaller(args, { key = customerKey, shell = "sh", env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, ["-s", "--", ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: tmpDir,
        DEROUTER_URL: baseUrl,
        DEROUTER_TTY: "/dev/null", // never read the developer's real terminal
        ...(key ? { DEROUTER_KEY: key } : {}),
        ...env,
      },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, out, err }));
    child.stdin.end(buildInstallScript(""));
  });
}

const installed = (...parts) => path.join(home, ...parts);

test("the script is valid POSIX sh", () => {
  const file = path.join(tmpDir, "install.sh");
  fs.writeFileSync(file, buildInstallScript("https://ai.example.com"));
  for (const shell of ["sh", "dash"]) {
    const r = spawnSync(shell, ["-n", file], { encoding: "utf8" });
    if (r.error?.code === "ENOENT") continue; // dash is not on every machine
    assert.equal(r.status, 0, `${shell} -n: ${r.stderr}`);
  }
});

test("only a plain http(s) origin is ever written into the script", () => {
  assert.equal(isSafeOrigin("https://ai.example.com"), true);
  assert.equal(isSafeOrigin("http://127.0.0.1:20128"), true);
  assert.equal(isSafeOrigin("https://x.com'; rm -rf ~; '"), false);
  assert.equal(isSafeOrigin("https://x.com/path"), false);
  assert.equal(isSafeOrigin("javascript:alert(1)"), false);
  const script = buildInstallScript("https://x.com'; rm -rf ~; '");
  assert.ok(!script.includes("rm -rf ~"));
  assert.ok(!script.includes("x.com"));
  assert.ok(script.includes('BASE="${DEROUTER_URL:-}"'));
  assert.ok(buildInstallScript("https://ai.example.com").includes('BASE="${DEROUTER_URL:-https://ai.example.com}"'));
});

test("install.sh is public and takes its origin from the configured public URL", async () => {
  await updateSettings({ publicBaseUrl: "https://ai.example.com" });
  const res = await get("/api/public/skills/install.sh");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /shellscript/);
  const text = await res.text();
  assert.ok(text.startsWith("#!/bin/sh"));
  assert.ok(text.includes("https://ai.example.com"));
  assert.ok(!text.includes(customerKey));
  await updateSettings({ publicBaseUrl: "" });
});

test("the catalogue refuses everything that is not an active customer key", async () => {
  for (const key of [null, "sk-nope", adminKey, suspendedKey]) {
    const res = await get("/api/public/skills/catalog", key);
    assert.equal(res.status, 401, `key ${key ? key.slice(0, 6) : "none"}`);
  }
  // A key in the query string is not read at all.
  const viaQuery = await fetch(`${baseUrl}/api/public/skills/catalog?key=${customerKey}`);
  assert.equal(viaQuery.status, 401);
});

test("the catalogue lists published customer skills as tab-separated lines", async () => {
  const res = await get("/api/public/skills/catalog", customerKey);
  assert.equal(res.status, 200);
  const rows = (await res.text()).trim().split("\n").map((line) => line.split("\t"));
  assert.deepEqual(rows.map((r) => r[0]).sort(), ["data-sweep", "recon-pipeline"]);
  const recon = rows.find((r) => r[0] === "recon-pipeline");
  assert.deepEqual(recon, ["recon-pipeline", "SKILL.md", "1.2", "claude,cursor", "Recon Pipeline", "-"]);
  const sweep = rows.find((r) => r[0] === "data-sweep");
  assert.equal(sweep[2], "-"); // an empty version is "-", never an empty field
});

test("a skill file is the stored markdown, and internal or draft skills are 404", async () => {
  const ok = await get("/api/public/skills/file/recon-pipeline", customerKey);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), BODY_A);
  assert.equal((await get("/api/public/skills/file/internal-only", customerKey)).status, 404);
  assert.equal((await get("/api/public/skills/file/draft-one", customerKey)).status, 404);
  assert.equal((await get("/api/public/skills/file/recon-pipeline")).status, 401);
  assert.equal((await get("/api/public/skills/file/recon-pipeline", adminKey)).status, 401);
});

for (const shell of ["sh", "dash"]) {
  test(`installer (${shell}): --all writes each skill into its runtime's directory`, async (t) => {
    if (spawnSync(shell, ["-c", "exit 0"]).error) return t.skip(`${shell} not installed`);
    fs.rmSync(home, { recursive: true, force: true });
    const r = await runInstaller(["--all"], { shell });
    assert.equal(r.status, 0, r.err + r.out);
    assert.equal(fs.readFileSync(installed(".claude", "skills", "recon-pipeline", "SKILL.md"), "utf8"), BODY_A);
    // A fresh machine has no agent folder, so each skill goes to its first agent:
    // data-sweep is a codex skill, so it lands under .codex without any flag.
    assert.equal(fs.readFileSync(installed(".codex", "skills", "data-sweep", "SKILL.md"), "utf8"), BODY_B);
    assert.ok(!fs.existsSync(installed(".claude", "skills", "internal-only")));
    assert.ok(!fs.existsSync(installed(".claude", "skills", "draft-one")));
    assert.match(r.out, /recon-pipeline \[claude\]: đã cài/);
  });
}

test("installer: a second run is a no-op, a changed skill reports an update", async () => {
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal((await runInstaller(["--all"])).status, 0);
  assert.match((await runInstaller(["--all"])).out, /recon-pipeline \[claude\]: đã là bản mới nhất/);

  const row = (await skills.listSkills()).find((s) => s.slug === "recon-pipeline");
  await skills.updateSkill(row.id, { body: `${BODY_A}\nmore\n` });
  const r = await runInstaller(["--all"]);
  assert.match(r.out, /recon-pipeline \[claude\]: đã cập nhật/);
  assert.equal(
    fs.readFileSync(installed(".claude", "skills", "recon-pipeline", "SKILL.md"), "utf8"),
    `${BODY_A}\nmore\n`
  );
  await skills.updateSkill(row.id, { body: BODY_A });
});

test("installer: a named skill, --target and --dir", async () => {
  fs.rmSync(home, { recursive: true, force: true });
  let r = await runInstaller(["recon-pipeline", "--target", "cursor"]);
  assert.equal(r.status, 0, r.err);
  assert.ok(fs.existsSync(installed(".cursor", "skills", "recon-pipeline", "SKILL.md")));
  assert.ok(!fs.existsSync(installed(".claude")), "--target cursor must not also write to claude");
  assert.ok(!fs.existsSync(installed(".codex")));

  const custom = path.join(tmpDir, "custom");
  r = await runInstaller(["data-sweep", "--dir", custom]);
  assert.equal(r.status, 0, r.err);
  assert.ok(fs.existsSync(path.join(custom, "data-sweep", "SKILL.md")));
});

test("installer: --list and no arguments install nothing", async () => {
  fs.rmSync(home, { recursive: true, force: true });
  for (const args of [["--list"], []]) {
    const r = await runInstaller(args);
    assert.equal(r.status, 0, r.err);
    // --list prints on stdout; the numbered list shown before asking goes to stderr.
    assert.match(r.out + r.err, /recon-pipeline/);
    assert.ok(!(r.out + r.err).includes("internal-only"));
    assert.ok(!fs.existsSync(home));
  }
});

test("installer: refusals leave the disk untouched and say why", async () => {
  fs.rmSync(home, { recursive: true, force: true });
  let r = await runInstaller(["--all"], { key: "sk-wrong" });
  assert.notEqual(r.status, 0);
  assert.match(r.err, /key không hợp lệ/);

  r = await runInstaller(["--all"], { key: suspendedKey });
  assert.notEqual(r.status, 0);

  r = await runInstaller(["no-such-skill"]);
  assert.notEqual(r.status, 0);
  assert.match(r.err, /không có skill/);

  r = await runInstaller(["internal-only"]);
  assert.notEqual(r.status, 0);

  r = await runInstaller(["--all"], { key: "bad key;rm" });
  assert.notEqual(r.status, 0);
  assert.match(r.err, /ký tự không hợp lệ/);
  assert.ok(!fs.existsSync(home));
});

test("installer: a hostile catalogue cannot write outside the skills directory", async () => {
  fs.rmSync(home, { recursive: true, force: true });
  const outside = path.join(tmpDir, "escaped");
  try {
    for (const line of [
      "../escaped\tSKILL.md\t-\tclaude\tx\n",
      "ok\t../../escaped\t-\tclaude\tx\n",
      "ok\t/etc/passwd\t-\tclaude\tx\n",
      ".hidden\tSKILL.md\t-\tclaude\tx\n",
    ]) {
      mockCatalog = line;
      const r = await runInstaller(["--all"]);
      assert.notEqual(r.status, 0, line);
      assert.match(r.err, /không hợp lệ/);
    }
  } finally {
    mockCatalog = null;
  }
  assert.ok(!fs.existsSync(outside));
  assert.ok(!fs.existsSync(home));
});

test("installer downloads are counted", async () => {
  const before = (await skills.getSkillBySlug("data-sweep")).downloadCount;
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal((await runInstaller(["data-sweep"])).status, 0);
  // The counter is bumped after the response; give it a tick.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await skills.getSkillBySlug("data-sweep")).downloadCount, before + 1);
});

test("a key is read the way the request guard reads it, and only from headers", async () => {
  // Lower-case scheme: the guard does not count it as a key either, so accepting
  // it here would be a way around the unknown-key throttle.
  const lower = await fetch(`${baseUrl}/api/public/skills/catalog`, {
    headers: { Authorization: `bearer ${customerKey}` },
  });
  assert.equal(lower.status, 401);
  const viaHeader = await fetch(`${baseUrl}/api/public/skills/catalog`, {
    headers: { "x-api-key": customerKey },
  });
  assert.equal(viaHeader.status, 200);

  // The guard throttles exactly these two paths and leaves the script alone.
  const guard = fs.readFileSync(new URL("../src/dashboardGuard.js", import.meta.url), "utf8");
  assert.ok(guard.includes('"/api/public/skills/catalog"'));
  assert.ok(guard.includes('"/api/public/skills/file"'));
  assert.ok(!guard.includes('"/api/public/skills/install.sh"'));
});

test("an expired or deactivated customer key is refused", async () => {
  const expired = (await createApiKey("old", "m", { userId: "u1" })).key;
  const off = (await createApiKey("off", "m", { userId: "u1" })).key;
  db.run(`UPDATE apiKeys SET expiresAt = ? WHERE key = ?`, [new Date(Date.now() - 60_000).toISOString(), expired]);
  db.run(`UPDATE apiKeys SET isActive = 0 WHERE key = ?`, [off]);
  assert.equal((await get("/api/public/skills/catalog", expired)).status, 401);
  assert.equal((await get("/api/public/skills/catalog", off)).status, 401);
  assert.equal((await get("/api/public/skills/file/recon-pipeline", expired)).status, 401);
});

test("customer views never carry the admin identity", async () => {
  const row = (await skills.listSkills()).find((s) => s.slug === "recon-pipeline");
  db.run(`UPDATE skills SET createdBy = 'admin:owner@example.com' WHERE id = ?`, [row.id]);
  assert.equal((await skills.getSkillById(row.id)).createdBy, "admin:owner@example.com"); // admin keeps it
  for (const customer of await skills.listPublishedSkills()) assert.ok(!("createdBy" in customer));
  const one = await skills.getSkillBySlug("recon-pipeline", { publishedOnly: true });
  assert.ok(!("createdBy" in one));
  db.run(`UPDATE skills SET createdBy = NULL WHERE id = ?`, [row.id]);
});

test("the account routes refuse a request without a customer session", async () => {
  const request = () => new Request("http://x/api/account/skills");
  assert.equal((await accountList.GET(request())).status, 401);
  const params = { params: Promise.resolve({ slug: "recon-pipeline" }) };
  assert.equal((await accountOne.GET(request(), params)).status, 401);
  assert.equal((await accountDownload.GET(request(), params)).status, 401);
});

test("installer: a bad entry anywhere in the catalogue stops everything, even after a good one", async () => {
  fs.rmSync(home, { recursive: true, force: true });
  mockCatalog = "recon-pipeline\tSKILL.md\t-\tclaude\tx\n../escaped\tSKILL.md\t-\tclaude\tx\n";
  try {
    const r = await runInstaller(["--all"]);
    assert.notEqual(r.status, 0);
    assert.match(r.err, /không hợp lệ/);
  } finally {
    mockCatalog = null;
  }
  assert.ok(!fs.existsSync(home), "the good first line must not have been written");
});

test("installer: --bundle expands to every skill the catalogue tags with it, and implies --engine", async () => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(installed(".claude"), { recursive: true });
  fs.mkdirSync(installed(".codex"), { recursive: true });
  mockCatalog =
    "recon-pipeline\tSKILL.md\t-\tclaude\tRecon\tredteam-pack\n" +
    "data-sweep\tSKILL.md\t-\tcodex\tSweep\tredteam-pack\n" +
    "lone\tSKILL.md\t-\tclaude\tLone\t-\n";
  try {
    const r = await runInstaller(["--bundle", "redteam-pack"]);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /Xong: 2 bản cài/);
    assert.ok(fs.existsSync(installed(".claude", "skills", "recon-pipeline", "SKILL.md")));
    assert.ok(fs.existsSync(installed(".codex", "skills", "data-sweep", "SKILL.md")));
    assert.ok(!fs.existsSync(installed(".claude", "skills", "lone")), "a skill outside the bundle is not pulled in");
    // --bundle implies --engine; with no bundle actually published server-side,
    // the engine step is a harmless no-op, never a network fetch.
    assert.match(r.err, /chưa có bundle nào được phát hành/);
  } finally {
    mockCatalog = null;
  }
});

test("installer: --all implies --engine too, same as --bundle", async () => {
  // Without this, "--all" left every bundle's engine uninstalled unless the
  // customer also remembered --engine or --bundle — the skills were useless on
  // their own. --all now means everything, engines included.
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(installed(".claude"), { recursive: true });
  mockCatalog = "recon-pipeline\tSKILL.md\t-\tclaude\tRecon\t-\n";
  try {
    const r = await runInstaller(["--all"]);
    assert.equal(r.status, 0, r.err);
    assert.ok(fs.existsSync(installed(".claude", "skills", "recon-pipeline", "SKILL.md")));
    // No bundle actually published server-side in this test, so the engine step is
    // a harmless no-op rather than a network fetch — but it did run.
    assert.match(r.err, /chưa có bundle nào được phát hành/);
  } finally {
    mockCatalog = null;
  }
});

test("installer: an unknown --bundle name is refused before anything is written", async () => {
  fs.rmSync(home, { recursive: true, force: true });
  mockCatalog = "recon-pipeline\tSKILL.md\t-\tclaude\tRecon\t-\n";
  try {
    const r = await runInstaller(["--bundle", "no-such-bundle"]);
    assert.notEqual(r.status, 0);
    assert.match(r.err, /không có bundle/);
  } finally {
    mockCatalog = null;
  }
  assert.ok(!fs.existsSync(home));
});

test("installer: the key is only sent over https or to this machine", async () => {
  fs.rmSync(home, { recursive: true, force: true });
  for (const url of ["http://skills.example.com", "ftp://x", "http://127.0.0.1.evil.com"]) {
    const r = await runInstaller(["--all"], { env: { DEROUTER_URL: url } });
    assert.notEqual(r.status, 0, url);
    assert.match(r.err, /https/);
  }
  assert.ok(!fs.existsSync(home));
});

test("catalogue lines carry no control characters", async () => {
  const row = await skills.createSkill({ name: "Esc\u001b[31m Name", body: BODY_B, slug: "esc-name" });
  const text = await (await get("/api/public/skills/catalog", customerKey)).text();
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text));
  await skills.deleteSkill(row.id);
});

test("installer: one skill goes into every supported agent that is on the machine", async () => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(installed(".claude"), { recursive: true });
  fs.mkdirSync(installed(".cursor"), { recursive: true });
  fs.mkdirSync(installed(".codex"), { recursive: true });
  const r = await runInstaller(["--all"]);
  assert.equal(r.status, 0, r.err);
  // recon-pipeline supports claude + cursor and both are here; codex is here but not
  // supported. Two folders means one canonical copy that both agents link to.
  const canonical = installed(".agents", "skills", "recon-pipeline");
  assert.equal(fs.readFileSync(path.join(canonical, "SKILL.md"), "utf8"), BODY_A);
  for (const agent of [".claude", ".cursor"]) {
    const dest = installed(agent, "skills", "recon-pipeline");
    assert.ok(fs.lstatSync(dest).isSymbolicLink(), `${agent} links to the shared copy`);
    assert.equal(fs.readFileSync(path.join(dest, "SKILL.md"), "utf8"), BODY_A);
  }
  assert.ok(!fs.existsSync(installed(".codex", "skills", "recon-pipeline")));
  // data-sweep supports only codex: a single folder is written directly, no link.
  assert.equal(fs.readFileSync(installed(".codex", "skills", "data-sweep", "SKILL.md"), "utf8"), BODY_B);
  assert.ok(!fs.lstatSync(installed(".codex", "skills", "data-sweep")).isSymbolicLink());
  assert.ok(!fs.existsSync(installed(".claude", "skills", "data-sweep")));
  assert.match(r.out, /recon-pipeline \[claude,cursor\]: đã liên kết|recon-pipeline \[cursor\]: đã liên kết/);
  assert.match(r.out, /Xong: 4 bản cài/);

  // A second run changes nothing and a changed skill updates the one shared copy.
  const again = await runInstaller(["--all"]);
  assert.equal(again.status, 0, again.err);
  assert.match(again.out, /recon-pipeline \[[a-z,]+\]: đã là bản mới nhất/);
});

test("installer: linking to a shared copy works under dash as well", async () => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(installed(".claude"), { recursive: true });
  fs.mkdirSync(installed(".cursor"), { recursive: true });
  const r = await runInstaller(["recon-pipeline"], { shell: "dash" });
  if (r.status === null || /spawn dash ENOENT/.test(r.err)) return;
  assert.equal(r.status, 0, r.err);
  assert.ok(fs.lstatSync(installed(".claude", "skills", "recon-pipeline")).isSymbolicLink());
  assert.equal(fs.readFileSync(installed(".cursor", "skills", "recon-pipeline", "SKILL.md"), "utf8"), BODY_A);
});

test("installer: --copy writes each agent folder separately instead of linking", async () => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(installed(".claude"), { recursive: true });
  fs.mkdirSync(installed(".cursor"), { recursive: true });
  const r = await runInstaller(["recon-pipeline", "--copy"]);
  assert.equal(r.status, 0, r.err);
  for (const agent of [".claude", ".cursor"]) {
    const dest = installed(agent, "skills", "recon-pipeline");
    assert.ok(!fs.lstatSync(dest).isSymbolicLink());
    assert.equal(fs.readFileSync(path.join(dest, "SKILL.md"), "utf8"), BODY_A);
  }
  assert.ok(!fs.existsSync(installed(".agents")), "no shared copy is made with --copy");
  assert.match(r.out, /recon-pipeline \[claude\]: đã cài/);
  assert.match(r.out, /recon-pipeline \[cursor\]: đã cài/);
});

test("installer: a real folder from an earlier install is updated in place, never swapped for a link", async () => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(installed(".claude", "skills", "recon-pipeline"), { recursive: true });
  fs.writeFileSync(installed(".claude", "skills", "recon-pipeline", "SKILL.md"), "old body");
  fs.writeFileSync(installed(".claude", "skills", "recon-pipeline", "my-notes.txt"), "keep me");
  fs.mkdirSync(installed(".cursor"), { recursive: true });
  const r = await runInstaller(["recon-pipeline"]);
  assert.equal(r.status, 0, r.err);
  const dest = installed(".claude", "skills", "recon-pipeline");
  assert.ok(!fs.lstatSync(dest).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(dest, "SKILL.md"), "utf8"), BODY_A);
  assert.equal(fs.readFileSync(path.join(dest, "my-notes.txt"), "utf8"), "keep me");
  assert.ok(fs.lstatSync(installed(".cursor", "skills", "recon-pipeline")).isSymbolicLink());
});

test("installer: a link the customer made is never re-pointed, its target folder is updated instead", async () => {
  fs.rmSync(home, { recursive: true, force: true });
  const mine = path.join(tmpDir, "my-dotfiles-skill");
  fs.rmSync(mine, { recursive: true, force: true });
  fs.mkdirSync(mine, { recursive: true });
  fs.writeFileSync(path.join(mine, "extra.txt"), "mine");
  fs.mkdirSync(installed(".claude", "skills"), { recursive: true });
  fs.symlinkSync(mine, installed(".claude", "skills", "recon-pipeline"));
  fs.mkdirSync(installed(".cursor"), { recursive: true });
  const r = await runInstaller(["recon-pipeline"]);
  assert.equal(r.status, 0, r.err);
  assert.equal(fs.readlinkSync(installed(".claude", "skills", "recon-pipeline")), mine, "still points at their folder");
  assert.equal(fs.readFileSync(path.join(mine, "SKILL.md"), "utf8"), BODY_A);
  assert.equal(fs.readFileSync(path.join(mine, "extra.txt"), "utf8"), "mine");
  // …while our own link is remade on the next run without complaint.
  const again = await runInstaller(["recon-pipeline"]);
  assert.equal(again.status, 0, again.err);
});

test("installer: XDG_CONFIG_HOME moves OpenCode, Goose and Amp", async () => {
  const created = await skills.createSkill({ name: "Xdg Agents", body: BODY_B, targets: ["opencode", "amp"] });
  try {
    fs.rmSync(home, { recursive: true, force: true });
    const xdg = path.join(tmpDir, "xdg-config");
    fs.rmSync(xdg, { recursive: true, force: true });
    fs.mkdirSync(path.join(xdg, "opencode"), { recursive: true });
    const r = await runInstaller(["xdg-agents"], { env: { XDG_CONFIG_HOME: xdg } });
    assert.equal(r.status, 0, r.err);
    assert.ok(fs.existsSync(path.join(xdg, "opencode", "skills", "xdg-agents", "SKILL.md")));
    assert.ok(!fs.existsSync(installed(".config")), "nothing written under the default config home");

    // Without it, the default is ~/.config.
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(installed(".config", "amp"), { recursive: true });
    const d = await runInstaller(["xdg-agents"]);
    assert.equal(d.status, 0, d.err);
    assert.ok(fs.existsSync(installed(".config", "agents", "skills", "xdg-agents", "SKILL.md")));
  } finally {
    await skills.deleteSkill(created.id);
  }
});

test("installer: omp and dsh get their own folders, and DSH_HOME moves dsh", async () => {
  const created = await skills.createSkill({ name: "Agent Mix", body: BODY_B, targets: ["omp", "dsh"] });
  try {
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(installed(".omp"), { recursive: true });
    fs.mkdirSync(installed(".dsh"), { recursive: true });
    let r = await runInstaller(["agent-mix"]);
    assert.equal(r.status, 0, r.err);
    // omp keeps skills under .omp/agent/skills, not .omp/skills.
    assert.equal(fs.readFileSync(installed(".agents", "skills", "agent-mix", "SKILL.md"), "utf8"), BODY_B);
    assert.ok(fs.lstatSync(installed(".omp", "agent", "skills", "agent-mix")).isSymbolicLink());
    assert.ok(fs.lstatSync(installed(".dsh", "skills", "agent-mix")).isSymbolicLink());

    // DSH_HOME replaces ~/.dsh for both detection and the skills folder.
    fs.rmSync(home, { recursive: true, force: true });
    const elsewhere = path.join(tmpDir, "dsh-home");
    fs.rmSync(elsewhere, { recursive: true, force: true });
    fs.mkdirSync(elsewhere, { recursive: true });
    r = await runInstaller(["agent-mix", "--copy"], { env: { DSH_HOME: elsewhere } });
    assert.equal(r.status, 0, r.err);
    assert.equal(fs.readFileSync(path.join(elsewhere, "skills", "agent-mix", "SKILL.md"), "utf8"), BODY_B);
    assert.ok(!fs.existsSync(installed(".omp")), "omp is not on this machine");
  } finally {
    await skills.deleteSkill(created.id);
  }
});

test("installer: Antigravity, its CLI and ZCode land where each reads skills", async () => {
  const created = await skills.createSkill({ name: "Newer Agents", body: BODY_B, targets: ["antigravity", "agy", "zcode"] });
  try {
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(installed(".gemini", "antigravity-cli"), { recursive: true }); // only the CLI is here
    fs.mkdirSync(installed(".zcode"), { recursive: true });
    const r = await runInstaller(["newer-agents"]);
    assert.equal(r.status, 0, r.err);
    // Antigravity and its CLI share ~/.gemini/config/skills; only the CLI is detected.
    assert.ok(fs.existsSync(installed(".gemini", "config", "skills", "newer-agents", "SKILL.md")));
    assert.ok(fs.existsSync(installed(".zcode", "skills", "newer-agents", "SKILL.md")));
    assert.match(r.out, /newer-agents \[agy\]/);

    // Both Antigravity ids on one machine write the shared folder once.
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(installed(".gemini", "antigravity"), { recursive: true });
    fs.mkdirSync(installed(".gemini", "antigravity-cli"), { recursive: true });
    const both = await runInstaller(["newer-agents", "--target", "antigravity,agy"]);
    assert.equal(both.status, 0, both.err);
    assert.match(both.out, /newer-agents \[antigravity,agy\]: đã cài/);
    assert.match(both.out, /Xong: 1 bản cài/);
  } finally {
    await skills.deleteSkill(created.id);
  }
});

test("installer: agents that read the same folder share one write", async () => {
  const created = await skills.createSkill({ name: "Shared Dir", body: BODY_B, targets: ["cline", "pi", "warp"] });
  try {
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(installed(".cline"), { recursive: true });
    fs.mkdirSync(installed(".pi", "agent"), { recursive: true });
    const r = await runInstaller(["shared-dir"]);
    assert.equal(r.status, 0, r.err);
    assert.equal(fs.readFileSync(installed(".agents", "skills", "shared-dir", "SKILL.md"), "utf8"), BODY_B);
    assert.ok(!fs.lstatSync(installed(".agents", "skills", "shared-dir")).isSymbolicLink());
    assert.match(r.out, /shared-dir \[cline,pi\]: đã cài/);
    assert.match(r.out, /Xong: 1 bản cài/);
  } finally {
    await skills.deleteSkill(created.id);
  }
});

test("installer: an 'all agents' skill follows the machine, and the catalogue says all", async () => {
  const created = await skills.createSkill({ name: "Everywhere", body: BODY_B });
  try {
    const res = await get("/api/public/skills/catalog", customerKey);
    const line = (await res.text()).split("\n").find((l) => l.startsWith("everywhere\t"));
    assert.equal(line.split("\t")[3], "all");

    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(installed(".omp"), { recursive: true });
    const r = await runInstaller(["everywhere"]);
    assert.equal(r.status, 0, r.err);
    assert.ok(fs.existsSync(installed(".omp", "agent", "skills", "everywhere", "SKILL.md")));
    assert.ok(!fs.existsSync(installed(".claude")), "only the agents that are here");

    // No agent at all: it goes to the first one in the table.
    fs.rmSync(home, { recursive: true, force: true });
    const none = await runInstaller(["everywhere"]);
    assert.equal(none.status, 0, none.err);
    assert.match(none.out, /chưa thấy agent nào trên máy, cài cho claude/);
  } finally {
    await skills.deleteSkill(created.id);
  }
});

test("the agent table in the script comes from the registry and is shell-safe", async () => {
  const { SKILL_RUNTIMES } = await import("../src/lib/skills/runtimes.js");
  const { runtimeShell } = await import("../src/lib/skills/installScript.js");
  const shell = runtimeShell();
  assert.deepEqual(shell.ids.split(" "), SKILL_RUNTIMES.map((r) => r.id));
  for (const r of SKILL_RUNTIMES) {
    assert.match(r.id, /^[a-z]+$/);
    for (const p of [r.home, r.skills, r.xdg, r.xdgSkills].filter(Boolean)) {
      assert.match(p, /^[A-Za-z0-9._/-]+$/);
      assert.ok(!p.includes("..") && !p.startsWith("/"), p);
    }
  }
  const script = buildInstallScript("https://ai.example.com");
  assert.ok(script.includes('dsh) printf \'%s\' "${DSH_HOME:-$HOME/.dsh}/skills"'));
  assert.ok(script.includes('omp) printf \'%s\' "$HOME/.omp/agent/skills"'));
});

test("installer: only the agents that are present receive the skill", async () => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(installed(".cursor"), { recursive: true });
  const r = await runInstaller(["recon-pipeline"]);
  assert.equal(r.status, 0, r.err);
  assert.ok(fs.existsSync(installed(".cursor", "skills", "recon-pipeline", "SKILL.md")));
  assert.ok(!fs.existsSync(installed(".claude")), "claude is not on this machine");
});

test("installer: --target takes a comma list or repeats, and skips a skill that does not support it", async () => {
  fs.rmSync(home, { recursive: true, force: true });
  let r = await runInstaller(["recon-pipeline", "--target", "claude,cursor"]);
  assert.equal(r.status, 0, r.err);
  assert.ok(fs.existsSync(installed(".claude", "skills", "recon-pipeline", "SKILL.md")));
  assert.ok(fs.existsSync(installed(".cursor", "skills", "recon-pipeline", "SKILL.md")));

  fs.rmSync(home, { recursive: true, force: true });
  r = await runInstaller(["recon-pipeline", "--target", "claude", "--target", "cursor"]);
  assert.equal(r.status, 0, r.err);
  assert.ok(fs.existsSync(installed(".cursor", "skills", "recon-pipeline", "SKILL.md")));

  fs.rmSync(home, { recursive: true, force: true });
  r = await runInstaller(["recon-pipeline", "--target", "codex"]);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /bỏ qua/);
  assert.ok(!fs.existsSync(installed(".codex")));

  r = await runInstaller(["--all", "--target", "vim"]);
  assert.notEqual(r.status, 0);
  assert.match(r.err, /--target không có agent "vim"/);
});

test("installer: an agent list from the server must name only known agents", async () => {
  fs.rmSync(home, { recursive: true, force: true });
  try {
    for (const agents of ["foo", "ssh", "claude,ssh", ",claude", "claude,", "claude,,codex", "../x", "CLAUDE"]) {
      mockCatalog = `recon-pipeline\tSKILL.md\t-\t${agents}\tx\n`;
      const r = await runInstaller(["--all"]);
      assert.notEqual(r.status, 0, agents);
      assert.match(r.err, /không hợp lệ/, agents);
    }
  } finally {
    mockCatalog = null;
  }
  assert.ok(!fs.existsSync(home), "no agent home or skills directory may be created");
});

test("installer: --target must name an agent, and a server address cannot hide another host", async () => {
  fs.rmSync(home, { recursive: true, force: true });
  let r = await runInstaller(["--all", "--target", ""]);
  assert.notEqual(r.status, 0);
  assert.match(r.err, /ít nhất một/);

  // A space also separates agent names.
  r = await runInstaller(["recon-pipeline", "--target", "claude cursor"]);
  assert.equal(r.status, 0, r.err);
  assert.ok(fs.existsSync(installed(".claude", "skills", "recon-pipeline", "SKILL.md")));
  assert.ok(fs.existsSync(installed(".cursor", "skills", "recon-pipeline", "SKILL.md")));

  fs.rmSync(home, { recursive: true, force: true });
  for (const url of ["http://127.0.0.1:1@evil.example", "https://good.example@evil.example", "http://localhost:80@evil.example"]) {
    r = await runInstaller(["--all"], { env: { DEROUTER_URL: url } });
    assert.notEqual(r.status, 0, url);
    assert.match(r.err, /@/, url);
  }
  assert.ok(!fs.existsSync(home));
});

test("installer: a machine with no supported agent says so and still installs", async () => {
  fs.rmSync(home, { recursive: true, force: true });
  const r = await runInstaller(["data-sweep"]);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /chưa thấy agent nào trên máy, cài cho codex/);
  assert.ok(fs.existsSync(installed(".codex", "skills", "data-sweep", "SKILL.md")));
});

/** Run the installer with no skill named and `answer` typed at the (fake) terminal. */
async function runPicker(answer, extra = {}) {
  const tty = path.join(tmpDir, `tty-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(tty, answer);
  return runInstaller([], { env: { DEROUTER_TTY: tty, ...extra } });
}

test("installer: with no skill named it lists them numbered and installs the ones typed", async () => {
  fs.rmSync(home, { recursive: true, force: true });
  const catalogue = (await (await get("/api/public/skills/catalog", customerKey)).text()).trim().split("\n").map((l) => l.split("\t")[0]);
  const reconNumber = catalogue.indexOf("recon-pipeline") + 1;

  let r = await runPicker(`${reconNumber}\n`);
  assert.equal(r.status, 0, r.err);
  assert.match(r.err, new RegExp(`${reconNumber}\\) recon-pipeline`));
  assert.ok(fs.existsSync(installed(".claude", "skills", "recon-pipeline", "SKILL.md")));
  assert.ok(!fs.existsSync(installed(".codex", "skills", "data-sweep")), "only the chosen skill");

  // Names work too, and so do several at once.
  fs.rmSync(home, { recursive: true, force: true });
  r = await runPicker("data-sweep recon-pipeline\n");
  assert.equal(r.status, 0, r.err);
  assert.ok(fs.existsSync(installed(".codex", "skills", "data-sweep", "SKILL.md")));
  assert.ok(fs.existsSync(installed(".claude", "skills", "recon-pipeline", "SKILL.md")));

  // "a" is everything; commas separate as well as spaces.
  fs.rmSync(home, { recursive: true, force: true });
  r = await runPicker("a\n");
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /Xong: 2 bản cài/);
  fs.rmSync(home, { recursive: true, force: true });
  r = await runPicker(`${reconNumber},data-sweep\n`);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /Xong: 2 bản cài/);
});

test("installer: an empty answer installs nothing, a wrong one stops before writing", async () => {
  fs.rmSync(home, { recursive: true, force: true });
  let r = await runPicker("\n");
  assert.equal(r.status, 0, r.err);
  assert.match(r.err, /Không chọn skill nào/);
  assert.ok(!fs.existsSync(home));

  for (const answer of ["99\n", "0\n", "no-such-skill\n", "1 99\n", "../x\n"]) {
    r = await runPicker(answer);
    assert.notEqual(r.status, 0, answer);
    assert.match(r.err, /không có/, answer);
  }
  assert.ok(!fs.existsSync(home));
});

test("installer: naming skills or --list never asks anything", async () => {
  fs.rmSync(home, { recursive: true, force: true });
  // The fake terminal holds an answer that would install everything; it must be ignored.
  const tty = path.join(tmpDir, "tty-ignored");
  fs.writeFileSync(tty, "a\n");
  let r = await runInstaller(["--list"], { env: { DEROUTER_TTY: tty } });
  assert.equal(r.status, 0, r.err);
  assert.ok(!fs.existsSync(home));
  r = await runInstaller(["data-sweep"], { env: { DEROUTER_TTY: tty } });
  assert.equal(r.status, 0, r.err);
  assert.ok(!fs.existsSync(installed(".claude", "skills", "recon-pipeline")));
});

/* ── --engine: bundle-driven rendering ──────────────────────────────────
 *
 * Running --engine to completion needs a real tarball over HTTPS from the
 * bundle's own source host, which this suite does not fake (no test here ever
 * exercised --engine's execution even before bundles existed). What these pin
 * instead is that the *rendering* — the per-bundle shell this change makes
 * data-driven — is correct: the right URLs, the right case arms, the
 * conditional installer step, and the non-Claude-Code skip note.
 */

const BUNDLE_A = {
  slug: "rea-policy",
  name: "rea policy",
  sourceHost: "github.com",
  sourceOwner: "Delify-Solutions",
  sourceRepo: "rea_policy",
  sourceRef: "main",
  installerEntrypoint: "install.mjs",
};
const BUNDLE_B = {
  slug: "second-bundle",
  name: "second bundle",
  sourceHost: "gitlab.com",
  sourceOwner: "acme",
  sourceRepo: "toolkit",
  sourceRef: "main",
  installerEntrypoint: "", // no installer entrypoint at all
};

test("install.sh embeds every published bundle's engine data, and only those", async () => {
  const created = await bundlesRepo.createBundle(BUNDLE_A);
  const draft = await bundlesRepo.createBundle({ ...BUNDLE_B, isPublished: false });
  try {
    const res = await get("/api/public/skills/install.sh");
    const text = await res.text();
    assert.ok(text.includes(`BUNDLE_SLUGS="${BUNDLE_A.slug}"`), "only the published bundle is listed");
    assert.ok(text.includes(bundleTarballUrl(BUNDLE_A)));
    assert.ok(text.includes(bundleRawFileUrl(BUNDLE_A, "omp/rt-engine.ts")));
    assert.ok(text.includes(`${BUNDLE_A.slug}) printf '%s' "install.mjs"`), "its installer entrypoint case is rendered");
    assert.ok(!text.includes(BUNDLE_B.slug), "an unpublished bundle never reaches the public script");
  } finally {
    await bundlesRepo.deleteBundle(created.id);
    await bundlesRepo.deleteBundle(draft.id);
  }
});

test("the multi-bundle case: two bundles each get their own unpack dir and MCP key", () => {
  const script = buildInstallScript("https://ai.example.com", [BUNDLE_A, BUNDLE_B]);
  assert.ok(script.includes(`BUNDLE_SLUGS="${BUNDLE_A.slug} ${BUNDLE_B.slug}"`));
  assert.ok(script.includes(`e_root="$HOME/$ENGINE_HOME_BASE/$b_slug"`), "each bundle unpacks under its own slug");
  assert.ok(script.includes("holder[leaf][serverName]"), "the MCP key is the bundle's own slug, not a fixed name");
  assert.ok(script.includes(`${BUNDLE_A.slug}) printf '%s' "${bundleTarballUrl(BUNDLE_A)}" ;;`));
  assert.ok(script.includes(`${BUNDLE_B.slug}) printf '%s' "${bundleTarballUrl(BUNDLE_B)}" ;;`));
  assert.ok(ENGINE_HOME_BASE.length > 0);
});

test("the engine step reports a --target agent it has no registration path for", () => {
  // opencode is a real skill runtime (runtimes.js) but not an engine target
  // (engineTargets.js) — before this, asking for it alongside --engine produced
  // no feedback at all, which read as "it worked" when nothing happened.
  const script = buildInstallScript("https://ai.example.com", [BUNDLE_A]);
  assert.ok(script.includes('printf \'engine [%s]: agent này chưa có engine (chỉ cài được skill dạng văn bản)\\n\' "$t_req" >&2'));
  assert.ok(script.includes('case " $ENGINE_TARGETS " in'));
});

test("the omp bridge is taught this bundle's real engine path, not left to guess ~/rt-claude", () => {
  // omp/rt-engine.ts (the upstream bridge we copy verbatim) only looks for
  // REDTEAM_MCP_SERVER or its own get.sh's single ~/rt-claude install — neither
  // exists once a bundle is unpacked per-slug under ~/$ENGINE_HOME_BASE instead.
  // The installer must override enginePath() itself after copying the file.
  const script = buildInstallScript("https://ai.example.com", [BUNDLE_A]);
  assert.ok(script.includes('if cp "$e_src" "$e_bridge"; then'));
  assert.ok(script.includes("enginePath = function enginePath() { return"));
  assert.ok(script.includes('>>"$e_bridge"'), "the override is appended, not a from-scratch rewrite");
  assert.ok(script.includes("js_dq"), "the injected path must be escaped for a JS string literal");
});

test("js_dq escapes a path for a double-quoted JS string literal", () => {
  // Extract the function as rendered and run it for real under sh — a wrong escape
  // here corrupts the bridge file's JS syntax, not just a cosmetic string.
  const script = buildInstallScript("https://ai.example.com");
  const match = script.match(/^js_dq\(\) \{.*\}$/m);
  assert.ok(match, "js_dq must be defined in the rendered script");
  const tricky = String.raw`C:\Users\duogxaolin\pretend "evil" path` + "\\";
  const out = execFileSync("sh", ["-c", `${match[0]}\njs_dq "$1"`, "sh", tricky], { encoding: "utf8" });
  assert.equal(out, String.raw`C:\\Users\\duogxaolin\\pretend \"evil\" path\\`);
  // What matters most: the result parses as a valid JS double-quoted string whose
  // value is exactly the original path.
  // eslint-disable-next-line no-new-func
  assert.equal(new Function(`return "${out}"`)(), tricky);
});

test("the installer-entrypoint step is conditional: present, absent, and a failing run all handled", () => {
  const script = buildInstallScript("https://ai.example.com", [BUNDLE_A, BUNDLE_B]);
  // Present (BUNDLE_A): its path is rendered as a real case arm.
  assert.ok(script.includes(`${BUNDLE_A.slug}) printf '%s' "install.mjs" ;;`));
  // Absent (BUNDLE_B): no entrypoint configured, so its case arm yields "" and
  // run_bundle_installer returns immediately without attempting anything.
  assert.ok(script.includes(`${BUNDLE_B.slug}) printf '%s' "" ;;`));
  assert.ok(script.includes('[ -n "$rb_entry" ] || return 0'));
  // A missing file on disk is skipped silently, never `die`.
  assert.ok(script.includes('[ -f "$rb_file" ] || return 0'));
  // A failing entrypoint (non-zero exit) is a warning, not an abort: the rest of
  // the install (skills, MCP registration) already happened by this point.
  assert.ok(script.includes("thoát lỗi, bỏ qua (skill + MCP vẫn hoạt động)"));
  assert.ok(!/die "[^"]*thoát lỗi/.test(script));
});

test("non-Claude-Code runtimes never run the installer, and the script says why", () => {
  const script = buildInstallScript("https://ai.example.com", [BUNDLE_A]);
  assert.ok(script.includes("khái niệm riêng của Claude Code"));
  // The note only fires for a runtime that is not claude — the loop explicitly
  // excludes it, and running the entrypoint itself is gated on claude being wanted.
  assert.ok(script.includes('if [ "$rb_rt" != "claude" ]'));
  assert.ok(script.includes('*" claude "*) ;;'));
});

test("--dir skips the bundle installer step and says why", () => {
  const script = buildInstallScript("https://ai.example.com", [BUNDLE_A]);
  assert.ok(script.includes("đang dùng --dir, không phải thư mục cài mặc định"));
  assert.ok(script.includes('if [ -n "$DIR" ]'));
});

test("a bundle with no published engine leaves --engine a documented no-op", () => {
  const script = buildInstallScript("https://ai.example.com", []);
  assert.ok(script.includes('BUNDLE_SLUGS=""'));
  assert.ok(script.includes("chưa có bundle nào được phát hành"));
});
