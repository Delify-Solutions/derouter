// The engine half of the customer installer: which agents can run the tools at all,
// and how each one is told about them.
//
// The skill catalogue ships markdown. The markdown calls `redteam_asset_add` and 66
// other tools that live in a Node MCP server, so a customer who wants the engine
// needs three things the skills alone do not carry:
//
//   1. the engine source (`lib/`, ~400 KB),
//   2. an interpreter that has `node:sqlite` (real Node >= 22.5),
//   3. a per-agent registration, because every agent spells "here is an MCP server"
//      differently — and one of them (omp) has no MCP client at all.
//
// This module owns (3): the shapes, as data, so the shell script stays a shell
// script. Dependency-free; rendered into the installer.

/**
 * Agents that can reach the engine, and what telling them costs.
 *
 * `mode`:
 *   · `mcp`      the agent reads a JSON/YAML config listing MCP servers
 *   · `bridge`   no MCP client; needs a small extension that speaks JSON-RPC itself
 *   · `none`     no way in from the outside (the engine would have to be its plugin)
 *
 * `path` is where that registration lives, relative to `$HOME`, and `dir` marks the
 * agent as installed on this machine.
 */
export const ENGINE_TARGETS = [
  { id: "claude", mode: "mcp", dir: ".claude", path: ".claude.json", key: "mcpServers" },
  { id: "codex", mode: "mcp", dir: ".codex", path: ".codex/config.toml", key: "mcp_servers" },
  { id: "cursor", mode: "mcp", dir: ".cursor", path: ".cursor/mcp.json", key: "mcpServers" },
  { id: "windsurf", mode: "mcp", dir: ".codeium", path: ".codeium/windsurf/mcp_config.json", key: "mcpServers" },
  { id: "amp", mode: "mcp", dir: ".config/amp", path: ".config/amp/settings.json", key: "amp.mcpServers" },
  { id: "cline", mode: "mcp", dir: ".cline", path: ".cline/mcp_settings.json", key: "mcpServers" },
  { id: "omp", mode: "bridge", dir: ".omp", path: ".omp/agent/extensions/rt-engine.ts", key: null },
  { id: "dsh", mode: "none", dir: ".dsh", path: null, key: null },
];

const IDS = new Set(ENGINE_TARGETS.map((target) => target.id));

/** Is this engine target a real one? */
export function isEngineTarget(id) {
  return IDS.has(String(id ?? ""));
}

/** Targets that read a config file we can write. */
export function mcpEngineTargets() {
  return ENGINE_TARGETS.filter((target) => target.mode === "mcp");
}

/** Targets that need a bridge file put in place. */
export function bridgeEngineTargets() {
  return ENGINE_TARGETS.filter((target) => target.mode === "bridge");
}

/**
 * A one-line summary for the page and the installer's closing message: who gets
 * which kind of registration, and who cannot take one.
 */
export function engineTargetSummary() {
  const mcp = mcpEngineTargets().map((target) => target.id);
  const bridge = bridgeEngineTargets().map((target) => target.id);
  const none = ENGINE_TARGETS.filter((target) => target.mode === "none").map((target) => target.id);
  return { mcp, bridge, none };
}

/**
 * Where the engine comes from. A release tarball of the public repository: no
 * per-customer hosting, no build step, and the customer can read every byte they
 * are about to run.
 *
 * Pinned to a tag rather than `main` so a fetch is reproducible; bump it when the
 * engine is republished.
 */
export const ENGINE_REPO = "Delify-Solutions/rea_policy";
export const ENGINE_TAG = "main";
export const ENGINE_TARBALL = `https://codeload.github.com/${ENGINE_REPO}/tar.gz/refs/heads/${ENGINE_TAG}`;

/**
 * The omp bridge as a single file. The tarball normally carries it; a codeload cache
 * built before the bridge existed does not, and one missing file should not leave an
 * omp customer with skills whose tools cannot run.
 */
export const ENGINE_BRIDGE_URL = `https://raw.githubusercontent.com/${ENGINE_REPO}/${ENGINE_TAG}/omp/rt-engine.ts`;

/** Where the engine is unpacked under `$HOME`. */
export const ENGINE_HOME = "rt-claude";

/**
 * The minimum Node the engine runs on: `node:sqlite` appeared in 22.5 and the
 * engine's store is built on it.
 */
export const NODE_MIN = { major: 22, minor: 5 };

export function nodeIsNewEnough(version) {
  const [major, minor] = String(version ?? "").replace(/^v/, "").split(".").map(Number);
  if (!Number.isFinite(major)) return false;
  if (major > NODE_MIN.major) return true;
  if (major < NODE_MIN.major) return false;
  return Number.isFinite(minor) && minor >= NODE_MIN.minor;
}
