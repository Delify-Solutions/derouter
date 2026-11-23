// Engine-install tests: the data the customer installer is built from.
//
// The skill catalogue ships markdown; the markdown calls tools that live in a Node
// MCP server, one per bundle a customer has skills from. `--engine` is what closes
// that gap, and these pin the things that decide whether it can:
//   * which agents take a registration, and which take a bridge instead
//   * the Node floor, because the engine's store is `node:sqlite`
//   * that a bundle's own tarball/bridge URLs are built correctly
//   * that the rendered script carries real data and no placeholders
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const {
  ENGINE_TARGETS,
  ENGINE_HOME_BASE,
  bundleTarballUrl,
  bundleRawFileUrl,
  engineHomeFor,
  NODE_MIN,
  nodeIsNewEnough,
  engineTargetSummary,
  mcpEngineTargets,
  bridgeEngineTargets,
} = await import("../src/lib/skills/engineTargets.js");

const { buildInstallScript } = await import("../src/lib/skills/installScript.js");

const SAMPLE_BUNDLE = {
  slug: "rea-policy",
  sourceHost: "github.com",
  sourceOwner: "Delify-Solutions",
  sourceRepo: "rea_policy",
  sourceRef: "main",
  installerEntrypoint: "install.mjs",
};

/* ── agent coverage ────────────────────────────────────────────────────── */

test("every target has a mode and a home directory", () => {
  for (const target of ENGINE_TARGETS) {
    assert.ok(target.id, "target without an id");
    assert.ok(target.dir, `${target.id} has no dir`);
    assert.ok(["mcp", "bridge", "none"].includes(target.mode), `${target.id} has mode ${target.mode}`);
  }
});

test("an mcp target carries the config path and key it writes", () => {
  for (const target of mcpEngineTargets()) {
    assert.ok(target.path, `${target.id} is mcp but has no path`);
    assert.ok(target.key, `${target.id} is mcp but has no key`);
  }
});

test("claude, codex and cursor are mcp targets", () => {
  const ids = mcpEngineTargets().map((t) => t.id);
  for (const wanted of ["claude", "codex", "cursor"]) {
    assert.ok(ids.includes(wanted), `${wanted} should be an mcp target`);
  }
});

test("omp is a bridge target, because it has no MCP client", () => {
  assert.deepEqual(bridgeEngineTargets().map((t) => t.id), ["omp"]);
});

test("dsh is skipped: its plugin already owns an engine", () => {
  const summary = engineTargetSummary();
  assert.ok(summary.none.includes("dsh"));
});

test("the summary names every target exactly once", () => {
  const summary = engineTargetSummary();
  const all = [...summary.mcp, ...summary.bridge, ...summary.none];
  assert.equal(all.length, ENGINE_TARGETS.length);
  assert.equal(new Set(all).size, ENGINE_TARGETS.length);
});

/* ── node floor ────────────────────────────────────────────────────────── */

test("the node floor is 22.5, where node:sqlite appeared", () => {
  assert.equal(NODE_MIN.major, 22);
  assert.equal(NODE_MIN.minor, 5);
});

test("node versions below the floor are refused", () => {
  assert.equal(nodeIsNewEnough("20.11.0"), false);
  assert.equal(nodeIsNewEnough("22.4.9"), false);
  assert.equal(nodeIsNewEnough("v22.4.9"), false);
  assert.equal(nodeIsNewEnough(""), false);
  assert.equal(nodeIsNewEnough(null), false);
  assert.equal(nodeIsNewEnough("not-a-version"), false);
});

test("node at or above the floor is accepted", () => {
  assert.equal(nodeIsNewEnough("22.5.0"), true);
  assert.equal(nodeIsNewEnough("v22.22.3"), true);
  assert.equal(nodeIsNewEnough("26.3.0"), true);
  assert.equal(nodeIsNewEnough("23.0.0"), true);
});

/* ── per-bundle URLs ───────────────────────────────────────────────────── */

test("a bundle's tarball URL is a real GitHub codeload URL for its own repo/ref", () => {
  const url = bundleTarballUrl(SAMPLE_BUNDLE);
  assert.match(url, /^https:\/\/codeload\.github\.com\/[\w-]+\/[\w-]+\/tar\.gz\/refs\/heads\/main$/);
  assert.ok(url.includes(SAMPLE_BUNDLE.sourceOwner));
  assert.ok(url.includes(SAMPLE_BUNDLE.sourceRepo));
});

test("a bundle's raw file URL (the omp bridge fallback) is real", () => {
  const url = bundleRawFileUrl(SAMPLE_BUNDLE, "omp/rt-engine.ts");
  assert.match(url, /^https:\/\/raw\.githubusercontent\.com\/[\w-]+\/[\w-]+\/main\/omp\/rt-engine\.ts$/);
});

test("a gitlab or forgejo bundle gets that host's own archive/raw shape", () => {
  const gitlab = { ...SAMPLE_BUNDLE, sourceHost: "gitlab.com", sourceOwner: "acme", sourceRepo: "toolkit" };
  assert.match(bundleTarballUrl(gitlab), /^https:\/\/gitlab\.com\/acme\/toolkit\/-\/archive\/main\//);
  assert.match(bundleRawFileUrl(gitlab, "omp/rt-engine.ts"), /^https:\/\/gitlab\.com\/acme\/toolkit\/-\/raw\/main\//);

  const forgejo = { ...SAMPLE_BUNDLE, sourceHost: "codeberg.org", sourceOwner: "acme", sourceRepo: "toolkit" };
  assert.match(bundleTarballUrl(forgejo), /^https:\/\/codeberg\.org\/acme\/toolkit\/archive\/main\.tar\.gz$/);
  assert.match(bundleRawFileUrl(forgejo, "omp/rt-engine.ts"), /^https:\/\/codeberg\.org\/acme\/toolkit\/raw\/branch\/main\//);
});

test("a bundle unpacks under its own named home, keyed by slug", () => {
  assert.ok(ENGINE_HOME_BASE.length > 0);
  assert.equal(engineHomeFor("rea-policy"), `${ENGINE_HOME_BASE}/rea-policy`);
});

/* ── the rendered script ───────────────────────────────────────────────── */

const script = buildInstallScript("https://ai.delify.vn");
const bundleScript = buildInstallScript("https://ai.delify.vn", [SAMPLE_BUNDLE]);

test("no placeholder survives rendering, with or without a bundle", () => {
  for (const rendered of [script, bundleScript]) {
    const left = rendered.match(/__[A-Z_]+__/g) || [];
    assert.deepEqual(left, []);
  }
});

test("a published bundle's tarball and bridge URLs land in the script", () => {
  assert.ok(bundleScript.includes(bundleTarballUrl(SAMPLE_BUNDLE)));
  assert.ok(bundleScript.includes(bundleRawFileUrl(SAMPLE_BUNDLE, "omp/rt-engine.ts")));
  assert.ok(bundleScript.includes(`BUNDLE_SLUGS="${SAMPLE_BUNDLE.slug}"`));
  // No bundle published: nothing to install, but the script is still well-formed.
  assert.ok(script.includes('BUNDLE_SLUGS=""'));
});

test("the script takes the engine flags", () => {
  assert.ok(script.includes("--engine)"));
  assert.ok(script.includes("--engine-only)"));
  assert.ok(script.includes("--engine-update)"));
});

test("every mcp agent has a path and key case in the script", () => {
  for (const target of mcpEngineTargets()) {
    assert.ok(script.includes(`${target.id}) printf`), `${target.id} has no case in the script`);
  }
});

test("the engine's home base is written into the script, not hard-coded twice", () => {
  assert.ok(script.includes(`ENGINE_HOME_BASE="${ENGINE_HOME_BASE}"`));
});

test("the node floor is written into the script, not hard-coded twice", () => {
  assert.ok(script.includes(`NODE_MIN="${NODE_MIN.major}.${NODE_MIN.minor}"`));
});

test("sh parses it: the script every customer runs must be valid shell", () => {
  // Counting quotes was a proxy, and it broke the moment a legitimate `'` appeared in
  // a TOML key. Ask the shell itself: `sh -n` parses without executing anything.
  for (const rendered of [script, bundleScript]) {
    const file = join(tmpdir(), `rt-install-${process.pid}-${Math.random().toString(36).slice(2)}.sh`);
    writeFileSync(file, rendered);
    try {
      execFileSync("sh", ["-n", file], { stdio: "pipe" });
    } catch (error) {
      assert.fail(`sh -n rejected the generated installer: ${error.stderr}`);
    } finally {
      rmSync(file, { force: true });
    }
    assert.ok(!rendered.includes("@{"), "an unexpanded shell-brace placeholder survived");
  }
});
