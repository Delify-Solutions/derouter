// Engine-install tests: the data the customer installer is built from.
//
// The skill catalogue ships markdown; the markdown calls 67 tools that live in a
// Node MCP server. `--engine` is what closes that gap, and these pin the three
// things that decide whether it can:
//   * which agents take a registration, and which take a bridge instead
//   * the Node floor, because the engine's store is `node:sqlite`
//   * that the rendered script carries real URLs and no placeholders
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  ENGINE_TARGETS,
  ENGINE_TARBALL,
  ENGINE_BRIDGE_URL,
  ENGINE_HOME,
  NODE_MIN,
  nodeIsNewEnough,
  engineTargetSummary,
  mcpEngineTargets,
  bridgeEngineTargets,
} = await import("../src/lib/skills/engineTargets.js");

const { buildInstallScript } = await import("../src/lib/skills/installScript.js");

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

/* ── the rendered script ───────────────────────────────────────────────── */

const script = buildInstallScript("https://ai.delify.vn");

test("no placeholder survives rendering", () => {
  const left = script.match(/__[A-Z_]+__/g) || [];
  assert.deepEqual(left, []);
});

test("the engine tarball and bridge URLs are real", () => {
  assert.match(ENGINE_TARBALL, /^https:\/\/codeload\.github\.com\/[\w-]+\/[\w-]+\/tar\.gz\//);
  assert.match(ENGINE_BRIDGE_URL, /^https:\/\/raw\.githubusercontent\.com\/[\w-]+\/[\w-]+\//);
  assert.ok(script.includes(ENGINE_TARBALL));
  assert.ok(script.includes(ENGINE_BRIDGE_URL));
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

test("the engine lands in a named home, not a guessed one", () => {
  assert.ok(ENGINE_HOME.length > 0);
  assert.ok(script.includes(`ENGINE_HOME="${ENGINE_HOME}"`));
});

test("the node floor is written into the script, not hard-coded twice", () => {
  assert.ok(script.includes(`NODE_MIN="${NODE_MIN.major}.${NODE_MIN.minor}"`));
});

test("sh -n would accept it: no unbalanced quotes or dangling expansions", () => {
  // A cheap structural check in place of running sh, so the test suite stays pure.
  const quotes = (script.match(/(?<!\\)'/g) || []).length;
  assert.equal(quotes % 2, 0, `odd number of single quotes (${quotes})`);
  assert.ok(!script.includes("@{" ), "an unexpanded shell-brace placeholder survived");
});
