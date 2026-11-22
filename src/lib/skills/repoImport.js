// Reading a skill library straight from a git host.
//
// An admin pastes a repository URL and the catalogue fills itself: every SKILL.md
// the repository ships is fetched, parsed and offered for import. The point is to
// make "publish a skill" a link instead of forty pasted files.
//
// Hosts: GitHub (a repo, a tree, or a blob URL), GitLab, and Codeberg/Forgejo — all
// expose a public HTTP API for anonymous reads when the repository is public.
// Private repositories are out of scope on purpose: holding a token that can read
// arbitrary repos is a much larger permission than publishing skills, and the admin
// can always paste a file.
//
// Dependency-free and pure where it can be: parsing and file selection are tested
// in plain Node, network reads live behind fetchTree/fetchFile.

import { readSkillFrontmatter, slugFromName } from "./frontmatter.js";

/** The hosts we know how to read, keyed by the hostname a URL may carry. */
const HOSTS = {
  "github.com": "github",
  "www.github.com": "github",
  "gitlab.com": "gitlab",
  "www.gitlab.com": "gitlab",
  "codeberg.org": "forgejo",
};

/** A repository path as it goes into a URL: each segment escaped, separators kept. */
const encodePath = (path) => String(path).split("/").map(encodeURIComponent).join("/");

/** A hard cap on what one import may pull: a wrong URL must not walk a monorepo. */
export const MAX_REPO_FILES = 100;
const MAX_FILE_BYTES = 512 * 1024;
const TREE_TIMEOUT_MS = 15000;
const FILE_TIMEOUT_MS = 10000;

/** A name that is safe to put into a host API path: no separators, no dot segments. */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const isSafeSegment = (value) => SAFE_SEGMENT.test(value) && value !== "." && value !== "..";

/** decodeURIComponent that reports a bad escape (`%zz`) instead of throwing. */
function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** Owner/repo parts become part of an API path, so each one must be a plain name. */
function checkedRepo(parts) {
  return parts.every(isSafeSegment) ? null : { error: "Link repo có ký tự không hợp lệ" };
}

/**
 * Parse a repository URL into the parts every host call needs.
 *
 * Accepts what an admin actually copies out of a browser:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/main/skills
 *   https://github.com/owner/repo/blob/main/skills/rt-x/SKILL.md
 *   git@github.com:owner/repo.git
 *   https://gitlab.com/group/sub/repo/-/tree/main/skills
 *
 * @returns {{host:string, kind:string, owner:string, repo:string, ref:string|null,
 *            path:string, url:string}|{error:string}}
 */
export function parseRepoUrl(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return { error: "Chưa nhập link repo" };

  // scp-style git remote: git@host:owner/repo.git
  const scp = raw.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (scp) {
    const [, host, rest] = scp;
    const kind = HOSTS[host.toLowerCase()];
    if (!kind) return { error: `Chưa hỗ trợ host "${host}" (dùng GitHub, GitLab hoặc Codeberg)` };
    const parts = rest.split("/").filter(Boolean);
    if (parts.length < 2) return { error: "Link repo thiếu owner/tên repo" };
    const bad = checkedRepo(parts.slice(0, 2));
    if (bad) return bad;
    return { host: host.toLowerCase(), kind, owner: parts[0], repo: parts[1], ref: null, path: "", url: raw };
  }

  let url;
  try {
    url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  } catch {
    return { error: "Link không hợp lệ" };
  }
  const host = url.hostname.toLowerCase();
  const kind = HOSTS[host];
  if (!kind) return { error: `Chưa hỗ trợ host "${host}" (dùng GitHub, GitLab hoặc Codeberg)` };

  const segments = url.pathname.split("/").filter(Boolean).map(decodeSegment);
  if (segments.some((segment) => segment === null)) return { error: "Link không hợp lệ" };
  if (segments.length < 2) return { error: "Link repo thiếu owner/tên repo" };

  // GitLab nests groups: everything before /-/ is owner path, and the split marker
  // is the only reliable boundary. GitHub and Forgejo use the second segment.
  if (kind === "gitlab") {
    const dash = segments.indexOf("-");
    const repoPath = dash === -1 ? segments : segments.slice(0, dash);
    if (repoPath.length < 2) return { error: "Link repo thiếu owner/tên repo" };
    const owner = repoPath.slice(0, -1).join("/");
    const repo = repoPath[repoPath.length - 1].replace(/\.git$/, "");
    const bad = checkedRepo([...repoPath.slice(0, -1), repo]);
    if (bad) return bad;
    const after = dash === -1 ? [] : segments.slice(dash + 1);
    const ref = after[0] === "tree" || after[0] === "blob" ? after[1] ?? null : null;
    const path = after[0] === "tree" || after[0] === "blob" ? after.slice(2).join("/") : "";
    return { host, kind, owner, repo, ref, path, url: raw };
  }

  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/, "");
  const bad = checkedRepo([owner, repo]);
  if (bad) return bad;
  const marker = segments[2];
  if (marker === "tree" || marker === "blob") {
    const ref = segments[3] ?? null;
    return { host, kind, owner, repo, ref, path: segments.slice(4).join("/"), url: raw };
  }
  return { host, kind, owner, repo, ref: null, path: "", url: raw };
}

/* ── host calls ────────────────────────────────────────────────────────── */

async function getJson(url, timeout) {
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      // GitHub rejects anonymous API calls without a UA.
      "user-agent": "derouter-skill-import",
    },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function getText(url, timeout) {
  const res = await fetch(url, {
    headers: { accept: "text/plain", "user-agent": "derouter-skill-import" },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.text();
}

/**
 * Every markdown file in the repository, as `{ path, url }`, plus the ref the read
 * resolved to. `url` is where to fetch that file's text later, so a second step
 * never has to know which host it came from.
 *
 * `incomplete` is true when the host cut the listing short (a very large repository),
 * so the caller can say the list may be missing skills instead of hiding it.
 *
 * `allPaths` is every blob path in the (possibly scoped-by-pagination) listing,
 * markdown or not — the raw material `detectEngine`/`findRootReadme` read to
 * notice a repository ships an engine, without a second tree walk.
 *
 * @returns {Promise<{ref:string, files:{path:string,url:string}[], incomplete:boolean, allPaths:string[]}>}
 */
export async function fetchTree(parsed) {
  if (parsed.kind === "github") {
    const ref = parsed.ref || (await githubDefaultBranch(parsed));
    const tree = await getJson(
      `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      TREE_TIMEOUT_MS,
    );
    const blobs = (tree.tree || []).filter((node) => node.type === "blob");
    const files = blobs
      .filter((node) => /\.(md|markdown)$/i.test(node.path))
      .map((node) => ({ path: node.path, url: rawFileUrl(parsed, ref, node.path) }));
    return { ref, files, incomplete: tree.truncated === true, allPaths: blobs.map((node) => node.path) };
  }

  if (parsed.kind === "gitlab") {
    const projectPath = `${parsed.owner}/${parsed.repo}`;
    const project = encodeURIComponent(projectPath);
    const ref = parsed.ref || (await gitlabDefaultBranch(project));
    const perPage = 100;
    const files = [];
    const allPaths = [];
    let incomplete = false;
    for (let page = 1; page <= 4; page += 1) {
      const batch = await getJson(
        `https://gitlab.com/api/v4/projects/${project}/repository/tree?recursive=true&per_page=${perPage}&page=${page}&ref=${encodeURIComponent(ref)}`,
        TREE_TIMEOUT_MS,
      );
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const node of batch) {
        if (node.type !== "blob") continue;
        allPaths.push(node.path);
        if (!/\.(md|markdown)$/i.test(node.path)) continue;
        files.push({ path: node.path, url: rawFileUrl(parsed, ref, node.path) });
      }
      if (batch.length < perPage) break;
      if (page === 4) incomplete = true;
    }
    return { ref, files, incomplete, allPaths };
  }

  // Forgejo / Codeberg
  const ref = parsed.ref || (await forgejoDefaultBranch(parsed));
  const tree = await getJson(
    `https://${parsed.host}/api/v1/repos/${parsed.owner}/${parsed.repo}/git/trees/${encodeURIComponent(ref)}?recursive=true&per_page=200`,
    TREE_TIMEOUT_MS,
  );
  const blobs = (tree.tree || []).filter((node) => node.type === "blob");
  const files = blobs
    .filter((node) => /\.(md|markdown)$/i.test(node.path))
    .map((node) => ({ path: node.path, url: rawFileUrl(parsed, ref, node.path) }));
  return { ref, files, incomplete: tree.truncated === true, allPaths: blobs.map((node) => node.path) };
}

/** The raw-content URL for one file at `ref`, on whichever host `parsed` names. */
export function rawFileUrl(parsed, ref, path) {
  if (parsed.kind === "github") {
    return `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${encodePath(ref)}/${encodePath(path)}`;
  }
  if (parsed.kind === "gitlab") {
    return `https://gitlab.com/${parsed.owner}/${parsed.repo}/-/raw/${encodePath(ref)}/${encodePath(path)}`;
  }
  return `https://${parsed.host}/${parsed.owner}/${parsed.repo}/raw/branch/${encodePath(ref)}/${encodePath(path)}`;
}

/**
 * Whether the repository's file listing shows it ships an engine: a skill's
 * markdown calls tools that live in a Node MCP server, and `lib/mcp-server.mjs` is
 * that server's fixed, literal location (design.md: a heuristic here would both
 * false-positive and false-negative, and the admin always sees this preview before
 * committing to anything).
 *
 * @param {string[]} allPaths every blob path fetchTree found
 * @returns {{ detected: boolean, installerEntrypoint: string|null }}
 */
export function detectEngine(allPaths = []) {
  const set = new Set(allPaths);
  const detected = set.has("lib/mcp-server.mjs");
  return { detected, installerEntrypoint: detected && set.has("install.mjs") ? "install.mjs" : null };
}

/** The root `README.md`'s exact path as the repository spells it, or null. */
export function findRootReadme(allPaths = []) {
  return allPaths.find((path) => /^readme\.(md|markdown)$/i.test(path)) || null;
}

async function githubDefaultBranch(parsed) {
  const info = await getJson(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`, TREE_TIMEOUT_MS);
  if (!info.default_branch) throw new Error("Không đọc được nhánh mặc định");
  return info.default_branch;
}

async function gitlabDefaultBranch(project) {
  const info = await getJson(`https://gitlab.com/api/v4/projects/${project}`, TREE_TIMEOUT_MS);
  if (!info.default_branch) throw new Error("Không đọc được nhánh mặc định");
  return info.default_branch;
}

async function forgejoDefaultBranch(parsed) {
  const info = await getJson(`https://${parsed.host}/api/v1/repos/${parsed.owner}/${parsed.repo}`, TREE_TIMEOUT_MS);
  if (!info.default_branch) throw new Error("Không đọc được nhánh mặc định");
  return info.default_branch;
}

/** The text of one file, or null when it is over the size cap. */
export async function fetchFile(url) {
  const text = await getText(url, FILE_TIMEOUT_MS);
  if (new TextEncoder().encode(text).length > MAX_FILE_BYTES) return null;
  return text;
}

/* ── which files are skills ────────────────────────────────────────────── */

/**
 * Narrow a repository listing to the files a skill library actually consists of.
 *
 * Two shapes ship in practice and both must work:
 *   · `skills/<slug>/SKILL.md` — one directory per skill (Claude Code's layout)
 *   · `<slug>/SKILL.md` at the root, or a flat `<slug>.md` file
 * Only `SKILL.md` counts inside a directory; a README or a `references/*.md` beside
 * it is supporting material, not another skill. A loose `.md` at any depth is a
 * skill file.
 *
 * `scope` (from a /tree/ URL) narrows everything to that subtree, so pasting a
 * link to one folder imports that folder only.
 *
 * @returns {{ picked: {path:string,url:string}[], ignored: number, scoped: number }}
 */
export function pickSkillPaths(files, scope = "") {
  const base = String(scope ?? "").replace(/^\/+|\/+$/g, "");
  const inScope = base
    ? files.filter((f) => f.path === base || f.path.startsWith(`${base}/`))
    : files;
  const scoped = base ? files.length - inScope.length : 0;

  const skillDirs = new Set();
  for (const file of inScope) {
    const segments = file.path.split("/").filter(Boolean);
    if (/^skill\.md$/i.test(segments[segments.length - 1] || "")) {
      skillDirs.add(segments.slice(0, -1).join("/"));
    }
  }

  const picked = [];
  let ignored = 0;
  for (const file of inScope) {
    const segments = file.path.split("/").filter(Boolean);
    const name = segments[segments.length - 1] || "";
    const isSkillFile = /^skill\.md$/i.test(name);

    if (isSkillFile) {
      picked.push(file);
      continue;
    }
    // A repository's own documents at the top level are not skills.
    const atRoot = segments.length === (base ? base.split("/").filter(Boolean).length + 1 : 1);
    if (REPO_DOCS.test(name) && atRoot) {
      ignored += 1;
      continue;
    }
    // Supporting material: anything below a directory that holds a SKILL.md.
    // Without this a skill's own README and reference/ docs each become skills.
    let belongsToSkill = false;
    for (let depth = segments.length - 1; depth >= 0; depth -= 1) {
      if (skillDirs.has(segments.slice(0, depth).join("/"))) {
        belongsToSkill = true;
        break;
      }
    }
    if (belongsToSkill) {
      ignored += 1;
      continue;
    }
    picked.push(file);
  }
  return { picked, ignored, scoped };
}

/** Documentation that sits at a repository root and is never a skill of its own. */
const REPO_DOCS = /^(readme|contributing|changelog|changes|history|license|licence|notice|authors|contributors|security|code_of_conduct|support|third[-_ ]?party[-_ ]?notices?|codeowners)\.(md|markdown)$/i;

/**
 * The slug a repository path asks for: the directory name for a SKILL.md, the file
 * stem for a loose file. This is what the customer's agent will see as the folder
 * name, so it wins over the frontmatter `name`.
 */
export function slugFromRepoPath(path) {
  const parts = String(path ?? "").split("/").filter(Boolean);
  const name = parts[parts.length - 1] || "";
  if (/^skill\.md$/i.test(name)) return parts.length >= 2 ? parts[parts.length - 2] : "";
  return name.replace(/\.(md|markdown)$/i, "");
}


/**
 * Turn one fetched file into the row the import modal shows.
 *
 * Everything the admin sees — slug, name, summary, why a row cannot be imported —
 * is decided here so it is testable without a network. `text` is null when the file
 * was over the size cap and `failed` marks a read that errored.
 *
 * @returns {{path:string,name:string,slug:string,summary:string,body:string,bytes:number,problem:string}}
 */
export function describeSkillFile(path, text, { failed = false } = {}) {
  const dirSlug = slugFromRepoPath(path);
  if (failed || text === null) {
    return {
      path,
      name: dirSlug || path,
      slug: slugFromName(dirSlug || path),
      summary: "",
      body: "",
      bytes: 0,
      problem: failed ? "Không tải được file" : "Lớn hơn 512 KB",
    };
  }
  const fm = readSkillFrontmatter(text);
  const bytes = new TextEncoder().encode(text).length;
  // The folder name is what the customer's agent sees, so it wins over the
  // frontmatter name; only a loose file falls back to that.
  const slugSource = dirSlug || fm.name || path;
  const problems = [];
  if (!text.trim()) problems.push("File rỗng");
  // A directory's SKILL.md is a skill because of where it sits. A loose markdown
  // file has to earn it: without frontmatter naming or describing the skill, no
  // runtime can decide when to load it, so the file is documentation. Testing the
  // path depth alone would only catch the repository root and let `docs/design.md`
  // through; `dirSlug` cannot help here because it is the file stem for a loose
  // file. Still listed — nothing is hidden from the admin — but flagged, so the
  // modal opens with the row unticked.
  const isDirectorySkill = /^skill\.md$/i.test(path.split("/").pop() || "");
  if (!isDirectorySkill && !hasSkillFrontmatter(text)) {
    problems.push("Không có frontmatter (name/description) — là tài liệu, không phải skill");
  }
  return {
    path,
    name: fm.name || slugSource,
    slug: slugFromName(slugSource),
    summary: (fm.description || "").slice(0, 200),
    body: text,
    bytes,
    problem: problems.join(" · "),
  };
}

/**
 * True when a markdown file carries the YAML frontmatter a skill needs.
 *
 * This is the signal that separates a skill from documentation: every agent runtime
 * (Claude Code, Codex, Cursor) reads `name` and `description` from that block to
 * decide when to load the file, so a file without it cannot function as a skill. A
 * loose `.md` anywhere in a repository that has no frontmatter is documentation, not
 * a skill — which is what keeps `docs/architecture.md` out of the catalogue.
 *
 * A `SKILL.md` inside a skill directory is accepted regardless: its path already
 * says what it is, and the admin can fill in a name in the preview.
 */
export function hasSkillFrontmatter(text) {
  const match = String(text ?? "").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return false;
  return /^(name|description)\s*:/im.test(match[1]);
}
