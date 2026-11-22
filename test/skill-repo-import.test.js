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
