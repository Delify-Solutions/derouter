// Turning picked / dropped files into draft skills, and the agent picker's rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickSkillFiles, draftFields, draftProblem, MAX_DRAFT_BYTES } from "../src/lib/skills/importDrafts.js";
import { toggleRuntime, SKILL_RUNTIME_IDS } from "../src/lib/skills/runtimes.js";

const file = (path) => ({ name: path.split("/").pop(), path });

test("a skills folder yields one skill per SKILL.md and ignores everything else", () => {
  const { picked, ignored } = pickSkillFiles([
    file("skills/rt-recon/SKILL.md"),
    file("skills/rt-recon/README.md"),
    file("skills/rt-recon/references/api.md"),
    file("skills/rt-exploit/SKILL.md"),
    file("skills/notes.txt"),
    file("skills/rt-exploit/scripts/run.sh"),
  ]);
  assert.deepEqual(picked.map((e) => e.path), ["skills/rt-recon/SKILL.md", "skills/rt-exploit/SKILL.md"]);
  assert.equal(ignored, 4);
});

test("loose files: every .md is a skill, other extensions are not", () => {
  const { picked, ignored } = pickSkillFiles([file("recon.md"), file("exploit.markdown"), file("notes.txt"), file("image.png")]);
  assert.deepEqual(picked.map((e) => e.name), ["recon.md", "exploit.markdown"]);
  assert.equal(ignored, 2);
  assert.deepEqual(pickSkillFiles([]), { picked: [], ignored: 0 });
});

test("a folder's name is the slug; a loose file uses its frontmatter name, then its file name", () => {
  const text = "---\nname: Recon Pipeline\ndescription: Quét bề mặt\n---\n# x";
  const inFolder = draftFields({ path: "skills/rt-recon/SKILL.md", name: "SKILL.md", text });
  assert.equal(inFolder.slug, "rt-recon");
  assert.equal(inFolder.name, "Recon Pipeline");
  assert.equal(inFolder.summary, "Quét bề mặt");
  assert.equal(inFolder.body, text);

  const loose = draftFields({ path: "any.md", name: "any.md", text });
  assert.equal(loose.slug, "recon-pipeline");

  const bare = draftFields({ path: "My Notes.md", name: "My Notes.md", text: "# no frontmatter" });
  assert.equal(bare.name, "My Notes");
  assert.equal(bare.slug, "my-notes");

  // A loose file that happens to be called SKILL.md has no folder to take a name from.
  const looseSkillFile = draftFields({ path: "SKILL.md", name: "SKILL.md", text });
  assert.equal(looseSkillFile.slug, "recon-pipeline");
});

test("summary is cut to the 200 characters the server accepts", () => {
  const long = `---\nname: x\ndescription: ${"d".repeat(500)}\n---\n`;
  assert.equal(draftFields({ path: "x.md", name: "x.md", text: long }).summary.length, 200);
});

test("empty and oversized drafts are flagged and left out", () => {
  assert.equal(draftProblem(draftFields({ path: "a.md", name: "a.md", text: "  \n" })), "File rỗng");
  const big = draftFields({ path: "b.md", name: "b.md", text: "x".repeat(MAX_DRAFT_BYTES + 1) });
  assert.equal(draftProblem(big), "Lớn hơn 512 KB");
  // Bytes, not characters: 200,000 three-byte characters is 600,000 bytes.
  assert.equal(draftProblem(draftFields({ path: "c.md", name: "c.md", text: "ệ".repeat(200000) })), "Lớn hơn 512 KB");
  assert.equal(draftProblem(draftFields({ path: "d.md", name: "d.md", text: "# fine" })), "");
});

test("the last agent cannot be switched off", () => {
  let r = toggleRuntime(["claude", "codex"], "codex");
  assert.deepEqual(r, { value: ["claude"], changed: true });
  r = toggleRuntime(["claude"], "claude");
  assert.deepEqual(r, { value: ["claude"], changed: false });
  r = toggleRuntime(["claude"], "cursor");
  assert.deepEqual(r.value, ["claude", "cursor"]);
  // The result always follows the runtime list's order.
  assert.deepEqual(toggleRuntime(["cursor"], "claude").value, ["claude", "cursor"]);
  assert.deepEqual(toggleRuntime(SKILL_RUNTIME_IDS, "codex").value, ["claude", "cursor"]);
});
