// Repository-import tests: URL parsing and file selection, in plain Node.
//
// These pin the two things that decide which files become skills — and a wrong
// answer here publishes something the admin never chose, or silently imports
// nothing at all:
//   * the shapes of URL an admin actually copies out of a browser
//   * which markdown files in a repository are skills, and which are supporting
//     material beside one
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  parseRepoUrl,
  pickSkillPaths,
  slugFromRepoPath,
  describeSkillFile,
  hasSkillFrontmatter,
  detectEngine,
  findRootReadme,
  rawFileUrl,
  MAX_REPO_FILES,
} = await import("../src/lib/skills/repoImport.js");

/* ── URLs ──────────────────────────────────────────────────────────────── */

test("a plain repository URL", () => {
  const parsed = parseRepoUrl("https://github.com/owner/repo");
  assert.equal(parsed.kind, "github");
  assert.equal(parsed.owner, "owner");
  assert.equal(parsed.repo, "repo");
  assert.equal(parsed.ref, null);
  assert.equal(parsed.path, "");
});

test("a .git suffix is dropped", () => {
  assert.equal(parseRepoUrl("https://github.com/owner/repo.git").repo, "repo");
});

test("an scp-style git remote", () => {
  const parsed = parseRepoUrl("git@github.com:owner/repo.git");
  assert.equal(parsed.kind, "github");
  assert.equal(parsed.owner, "owner");
  assert.equal(parsed.repo, "repo");
});

test("a tree URL carries its branch and folder", () => {
  const parsed = parseRepoUrl("https://github.com/owner/repo/tree/main/skills/redteam");
  assert.equal(parsed.ref, "main");
  assert.equal(parsed.path, "skills/redteam");
});

test("a blob URL is read as its folder, not the file", () => {
  // An admin who copies the URL of one file still means "the skills around it".
  const parsed = parseRepoUrl("https://github.com/owner/repo/blob/main/skills/one/SKILL.md");
  assert.equal(parsed.ref, "main");
  assert.equal(parsed.path, "skills/one/SKILL.md");
});

test("a URL without a scheme still parses", () => {
  const parsed = parseRepoUrl("github.com/owner/repo");
  assert.equal(parsed.owner, "owner");
  assert.equal(parsed.repo, "repo");
});

test("GitLab nested groups keep the full owner path", () => {
  const parsed = parseRepoUrl("https://gitlab.com/group/subgroup/repo/-/tree/main/skills");
  assert.equal(parsed.kind, "gitlab");
  assert.equal(parsed.owner, "group/subgroup");
  assert.equal(parsed.repo, "repo");
  assert.equal(parsed.ref, "main");
  assert.equal(parsed.path, "skills");
});

test("Codeberg is recognised", () => {
  const parsed = parseRepoUrl("https://codeberg.org/owner/repo");
  assert.equal(parsed.kind, "forgejo");
});

test("an unsupported host is refused with a message naming it", () => {
  const parsed = parseRepoUrl("https://bitbucket.org/owner/repo");
  assert.match(parsed.error, /bitbucket\.org/);
});

test("garbage is refused rather than guessed at", () => {
  assert.ok(parseRepoUrl("").error);
  assert.ok(parseRepoUrl("https://github.com/onlyowner").error);
});

/* ── which files are skills ────────────────────────────────────────────── */

const files = (...paths) => paths.map((path) => ({ path, url: `https://x/${path}` }));

test("one directory per skill", () => {
  const { picked } = pickSkillPaths(
    files("skills/alpha/SKILL.md", "skills/beta/SKILL.md"),
  );
  assert.deepEqual(picked.map((f) => f.path), ["skills/alpha/SKILL.md", "skills/beta/SKILL.md"]);
});

test("a SKILL.md beats the name of the folder it sits in", () => {
  assert.equal(slugFromRepoPath("skills/rt-recon-pipeline/SKILL.md"), "rt-recon-pipeline");
  assert.equal(slugFromRepoPath("skills/rt-recon-pipeline.md"), "rt-recon-pipeline");
  assert.equal(slugFromRepoPath("SKILL.md"), "");
});

test("a loose markdown file at the root is a skill", () => {
  const { picked } = pickSkillPaths(files("active-scan.md", "dir-bruteforce.md"));
  assert.equal(picked.length, 2);
});

test("supporting markdown beside a SKILL.md is not a second skill", () => {
  // The common repository layout: the skill's own README and reference docs sit in
  // the same directory. Importing them as skills would publish three copies of one.
  const { picked, ignored } = pickSkillPaths(
    files(
      "skills/alpha/SKILL.md",
      "skills/alpha/README.md",
      "skills/alpha/reference/notes.md",
    ),
  );
  assert.deepEqual(picked.map((f) => f.path), ["skills/alpha/SKILL.md"]);
  assert.equal(ignored, 2);
});

test("a README at the repository root is not a skill", () => {
  // The repository's own documents live at the top level beside the skills; they are
  // never a skill of their own, whatever their content.
  const { picked, ignored } = pickSkillPaths(
    files("README.md", "LICENSE.md", "CHANGELOG.md", "skills/alpha/SKILL.md"),
  );
  assert.deepEqual(picked.map((f) => f.path), ["skills/alpha/SKILL.md"]);
  assert.equal(ignored, 3);
});

test("a README deep inside the tree, away from any skill, is still offered", () => {
  // Only the top level is treated as repository documentation: a markdown file in a
  // subtree that holds no SKILL.md may well be a skill written as one file.
  const { picked } = pickSkillPaths(files("docs/guide.md", "skills/alpha/SKILL.md"));
  assert.deepEqual(picked.map((f) => f.path), ["docs/guide.md", "skills/alpha/SKILL.md"]);
});

test("a scope narrows everything to one subtree", () => {
  const { picked, scoped } = pickSkillPaths(
    files(
      "skills/redteam/alpha/SKILL.md",
      "skills/other/beta/SKILL.md",
      "docs/gamma.md",
    ),
    "skills/redteam",
  );
  assert.deepEqual(picked.map((f) => f.path), ["skills/redteam/alpha/SKILL.md"]);
  assert.equal(scoped, 2);
});

test("a scope with a trailing slash behaves the same", () => {
  const withSlash = pickSkillPaths(files("skills/alpha/SKILL.md", "docs/x.md"), "skills/");
  assert.equal(withSlash.picked.length, 1);
});

test("only markdown is considered at all", () => {
  const { picked } = pickSkillPaths(
    files("skills/alpha/SKILL.md", "skills/alpha/run.sh", "skills/alpha/data.json"),
  );
  assert.deepEqual(picked.map((f) => f.path), ["skills/alpha/SKILL.md"]);
});

test("the cap exists so one URL cannot walk a monorepo", () => {
  assert.equal(MAX_REPO_FILES, 100);
});

/* ── hostile and malformed URLs ────────────────────────────────────────── */

test("a malformed escape is an error, not an exception", () => {
  // decodeURIComponent throws on %zz; the route used to answer 500 for it.
  assert.doesNotThrow(() => parseRepoUrl("https://github.com/a/b%zz"));
  assert.ok(parseRepoUrl("https://github.com/a/b%zz").error);
});

test("an encoded slash cannot smuggle path segments into the API call", () => {
  // owner and repo are pasted into https://api.github.com/repos/<owner>/<repo>.
  assert.ok(parseRepoUrl("https://github.com/a%2F..%2Fb/c").error);
  assert.ok(parseRepoUrl("https://github.com/a/..").error);
  assert.ok(parseRepoUrl("git@github.com:a/..").error);
  assert.ok(parseRepoUrl("https://gitlab.com/g%2Fx/../repo").error);
});

test("ordinary names with dots, dashes and underscores still pass", () => {
  const parsed = parseRepoUrl("https://github.com/My-Org/some_repo.v2");
  assert.equal(parsed.owner, "My-Org");
  assert.equal(parsed.repo, "some_repo.v2");
});

/* ── the row a file becomes ────────────────────────────────────────────── */

test("a SKILL.md row takes its slug from the folder and its text from the front matter", () => {
  const row = describeSkillFile(
    "skills/rt-recon/SKILL.md",
    "---\nname: Recon Pipeline\ndescription: Map the surface\n---\nBody",
  );
  assert.equal(row.slug, "rt-recon");
  assert.equal(row.name, "Recon Pipeline");
  assert.equal(row.summary, "Map the surface");
  assert.equal(row.problem, "");
  assert.ok(row.bytes > 0);
});

test("a read that failed is flagged and carries no body", () => {
  const row = describeSkillFile("skills/a/SKILL.md", null, { failed: true });
  assert.equal(row.problem, "Không tải được file");
  assert.equal(row.body, "");
});

test("a file over the size cap is flagged as such, not as a failed read", () => {
  assert.equal(describeSkillFile("skills/a/SKILL.md", null).problem, "Lớn hơn 512 KB");
});

test("an empty file is flagged", () => {
  assert.match(describeSkillFile("skills/a/SKILL.md", "  \n").problem, /rỗng/);
});

test("a front-matter-less note at the repository root looks like documentation", () => {
  assert.match(describeSkillFile("NOTES.md", "just some notes").problem, /tài liệu/);
  // …but a loose file that declares itself a skill is fine.
  assert.equal(describeSkillFile("recon.md", "---\nname: Recon\n---\nx").problem, "");
});

test("a very long summary is cut to the 200 characters the catalogue stores", () => {
  const row = describeSkillFile("a/SKILL.md", `---\ndescription: ${"x".repeat(400)}\n---\nb`);
  assert.equal(row.summary.length, 200);
});

/* ── skill vs documentation ────────────────────────────────── */


test("frontmatter with a name marks a skill", () => {
  assert.equal(hasSkillFrontmatter("---\nname: rt-x\ndescription: y\n---\n\n# X\n"), true);
});

test("frontmatter with only a description still marks a skill", () => {
  assert.equal(hasSkillFrontmatter("---\ndescription: y\n---\n\n# X\n"), true);
});

test("a plain document is not a skill", () => {
  // The shape of every docs/*.md in a repository: a heading and prose, no block.
  assert.equal(hasSkillFrontmatter("# Architecture\n\nSome prose.\n"), false);
});

test("an unrelated frontmatter block is not a skill header", () => {
  assert.equal(hasSkillFrontmatter("---\ntitle: Notes\ntags: [a]\n---\n\n# Notes\n"), false);
});

test("an empty file is not a skill", () => {
  assert.equal(hasSkillFrontmatter(""), false);
  assert.equal(hasSkillFrontmatter(null), false);
});

/* ── the row a file becomes ─────────────────────────────────── */

test("a loose document deep in the tree is flagged, not silently offered", () => {
  // The bug this pins: testing only the repository root let every docs/*.md through,
  // so importing a real repo put seven architecture notes in the customer catalogue.
  const row = describeSkillFile("docs/architecture.md", "# Architecture\n\nProse.\n");
  assert.equal(row.problem, "Không có frontmatter (name/description) — là tài liệu, không phải skill");
});

test("a loose markdown file with frontmatter is a skill", () => {
  const row = describeSkillFile("active-scan.md", "---\nname: active-scan\ndescription: x\n---\n\n# X\n");
  assert.equal(row.problem, "");
  assert.equal(row.slug, "active-scan");
});

test("a SKILL.md in a directory is trusted without a frontmatter block", () => {
  // Its path already says what it is, and the admin can fill in a name in the preview.
  const row = describeSkillFile("skills/alpha/SKILL.md", "# Alpha\n\nDo the thing.\n");
  assert.equal(row.problem, "");
  assert.equal(row.slug, "alpha");
});

test("an unreadable file is reported as such", () => {
  assert.match(describeSkillFile("x.md", null).problem, /Không tải được|512/);
  assert.match(describeSkillFile("x.md", "", { failed: true }).problem, /Không tải được file/);
});

/* ── engine detection (skill-bundles) ──────────────────────────────────── */

test("a repository with lib/mcp-server.mjs and a root install.mjs is detected as an engine, with its entrypoint", () => {
  const info = detectEngine(["lib/mcp-server.mjs", "install.mjs", "skills/alpha/SKILL.md", "README.md"]);
  assert.deepEqual(info, { detected: true, installerEntrypoint: "install.mjs" });
});

test("an engine repository without install.mjs is still detected, with no entrypoint offered", () => {
  const info = detectEngine(["lib/mcp-server.mjs", "lib/store-core.js", "skills/alpha/SKILL.md"]);
  assert.deepEqual(info, { detected: true, installerEntrypoint: null });
});

test("a plain skill repository (no lib/mcp-server.mjs) is not detected as an engine", () => {
  const info = detectEngine(["skills/alpha/SKILL.md", "install.mjs", "README.md"]);
  assert.deepEqual(info, { detected: false, installerEntrypoint: null });
});

test("a bare mcp-server.mjs elsewhere in the tree does not count — the path must be exact", () => {
  // design.md: the literal `lib/mcp-server.mjs` check is deliberate, not a
  // heuristic — a server file under a different path is not offered as a bundle.
  const info = detectEngine(["src/lib/mcp-server.mjs", "lib/mcp-server.js"]);
  assert.equal(info.detected, false);
});

test("detectEngine and findRootReadme tolerate an empty or missing file list", () => {
  assert.deepEqual(detectEngine(), { detected: false, installerEntrypoint: null });
  assert.deepEqual(detectEngine([]), { detected: false, installerEntrypoint: null });
  assert.equal(findRootReadme(), null);
  assert.equal(findRootReadme([]), null);
});

test("the root README is found regardless of case or .markdown extension, but a nested one is not it", () => {
  assert.equal(findRootReadme(["Readme.md", "lib/mcp-server.mjs"]), "Readme.md");
  assert.equal(findRootReadme(["README.markdown"]), "README.markdown");
  assert.equal(findRootReadme(["docs/README.md"]), null);
  assert.equal(findRootReadme(["readme.txt"]), null);
});

test("rawFileUrl builds the right raw-content URL per host", () => {
  const github = { kind: "github", owner: "o", repo: "r" };
  assert.equal(rawFileUrl(github, "main", "README.md"), "https://raw.githubusercontent.com/o/r/main/README.md");

  const gitlab = { kind: "gitlab", owner: "o", repo: "r" };
  assert.equal(rawFileUrl(gitlab, "main", "README.md"), "https://gitlab.com/o/r/-/raw/main/README.md");

  const forgejo = { kind: "forgejo", host: "codeberg.org", owner: "o", repo: "r" };
  assert.equal(rawFileUrl(forgejo, "main", "README.md"), "https://codeberg.org/o/r/raw/branch/main/README.md");
});
