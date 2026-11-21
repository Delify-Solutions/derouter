// The one-line skill installer, end to end: the real route handlers behind a
// local HTTP server, and the real install script run by sh against a throwaway
// HOME. What matters is what lands on disk and who is refused.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { register } from "node:module";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-skills-install-"));
process.env.DATA_DIR = tmpDir;
register("./helpers/src-alias-hook.mjs", import.meta.url);
register("./helpers/next-server-hook.mjs", import.meta.url);

const { getAdapter } = await import("../src/lib/db/driver.js");
const { createApiKey } = await import("../src/lib/db/repos/apiKeysRepo.js");
const { updateSettings } = await import("../src/lib/db/repos/settingsRepo.js");
const skills = await import("../src/lib/db/repos/skillsRepo.js");
const { buildInstallScript, isSafeOrigin } = await import("../src/lib/skills/installScript.js");
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
  assert.deepEqual(recon, ["recon-pipeline", "SKILL.md", "1.2", "claude,cursor", "Recon Pipeline"]);
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
  // recon-pipeline supports claude + cursor and both are here; codex is here but not supported.
  assert.ok(fs.existsSync(installed(".claude", "skills", "recon-pipeline", "SKILL.md")));
  assert.ok(fs.existsSync(installed(".cursor", "skills", "recon-pipeline", "SKILL.md")));
  assert.ok(!fs.existsSync(installed(".codex", "skills", "recon-pipeline")));
  // data-sweep supports only codex.
  assert.ok(fs.existsSync(installed(".codex", "skills", "data-sweep", "SKILL.md")));
  assert.ok(!fs.existsSync(installed(".claude", "skills", "data-sweep")));
  assert.match(r.out, /recon-pipeline \[claude\]: đã cài/);
  assert.match(r.out, /recon-pipeline \[cursor\]: đã cài/);
  assert.match(r.out, /Xong: 3 bản cài/);
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
  assert.match(r.err, /--target chỉ nhận/);
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
