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
 *
 * `format` says how that file is written: `json` (the default, for every agent but
 * one) or `toml`. It is not decoration — a TOML file handed to a JSON writer loses
 * its contents, because parsing it fails and the writer starts from `{}`.
 */
export const ENGINE_TARGETS = [
  { id: "claude", mode: "mcp", dir: ".claude", path: ".claude.json", key: "mcpServers" },
  // Codex is the one agent whose config is TOML, not JSON. `format` exists so the
  // installer never hands it to a JSON writer: doing that once replaced the whole
  // file with a JSON object and broke `codex` on startup.
  { id: "codex", mode: "mcp", dir: ".codex", path: ".codex/config.toml", key: "mcp_servers", format: "toml" },
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
 * Where an engine is unpacked under `$HOME`: one subdirectory per bundle, keyed by
 * its slug, so a customer who has skills from two different bundles gets two
 * independent engines instead of one overwriting the other.
 *
 * `~/rt-claude` (the former fixed, single-bundle location) never shipped to
 * production, so there is no migration to carry forward (design.md).
 */
export const ENGINE_HOME_BASE = ".engines";

/** Where a bundle is unpacked under `$HOME`, given its slug. */
export function engineHomeFor(slug) {
  return `${ENGINE_HOME_BASE}/${slug}`;
}

/**
 * Where a bundle's engine comes from: a release tarball of its own source
 * repository, at its own ref. No per-customer hosting, no build step, and the
 * customer can read every byte they are about to run.
 *
 * @param {{sourceHost:string, sourceOwner:string, sourceRepo:string, sourceRef:string}} bundle
 */
export function bundleTarballUrl(bundle) {
  const { sourceHost, sourceOwner, sourceRepo, sourceRef } = bundle;
  const ref = sourceRef || "main";
  if (sourceHost === "gitlab.com") {
    return `https://gitlab.com/${sourceOwner}/${sourceRepo}/-/archive/${encodeURIComponent(ref)}/${sourceRepo}-${ref}.tar.gz`;
  }
  if (sourceHost && sourceHost !== "github.com" && sourceHost !== "www.github.com") {
    // Forgejo / Codeberg.
    return `https://${sourceHost}/${sourceOwner}/${sourceRepo}/archive/${encodeURIComponent(ref)}.tar.gz`;
  }
  return `https://codeload.github.com/${sourceOwner}/${sourceRepo}/tar.gz/refs/heads/${ref}`;
}

/**
 * A single raw file from a bundle's own source repository — the omp bridge
 * fallback (`omp/rt-engine.ts`) when the tarball itself does not carry it, same
 * reasoning as before: a cache built before the bridge existed should not leave an
 * omp customer with skills whose tools cannot run.
 */
export function bundleRawFileUrl(bundle, path) {
  const { sourceHost, sourceOwner, sourceRepo, sourceRef } = bundle;
  const ref = sourceRef || "main";
  if (sourceHost === "gitlab.com") {
    return `https://gitlab.com/${sourceOwner}/${sourceRepo}/-/raw/${encodeURIComponent(ref)}/${path}`;
  }
  if (sourceHost && sourceHost !== "github.com" && sourceHost !== "www.github.com") {
    return `https://${sourceHost}/${sourceOwner}/${sourceRepo}/raw/branch/${encodeURIComponent(ref)}/${path}`;
  }
  return `https://raw.githubusercontent.com/${sourceOwner}/${sourceRepo}/${ref}/${path}`;
}

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
