// Skills repo tests against a real throwaway SQLite database.
//
// These pin the rules that separate an operator's published catalogue from a
// draft: an internal skill never reaches a customer, an unpublished one is not
// listed, and the slug — which becomes a directory name on the customer's
// machine — cannot be talked into escaping it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-skills-test-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const skills = await import("../src/lib/db/repos/skillsRepo.js");

let db;

function reset() {
  for (const t of ["skills"]) {
    try { db.run(`DELETE FROM ${t}`); } catch { /* table may not exist yet */ }
  }
}

before(async () => {
  db = await getAdapter();
  reset();
});

after(() => {
  try { db.close?.(); } catch { /* best effort */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const BODY = "---\nname: rt-demo\ndescription: demo\n---\n\n# Demo\n";

test("slugify handles Vietnamese diacritics and punctuation", () => {
  assert.equal(skills.slugifySkill("Kỹ năng Đọc File"), "ky-nang-doc-file");
  assert.equal(skills.slugifySkill("  Red Team / Recon  "), "red-team-recon");
  assert.equal(skills.slugifySkill("a__b"), "a-b");
});

test("a slug that could escape a directory is refused", () => {
  assert.ok(skills.slugError("../etc/passwd"));
  assert.ok(skills.slugError("a/b"));
  assert.ok(skills.slugError("UPPER"));
  assert.ok(skills.slugError(""));
  assert.equal(skills.slugError("rt-recon-pipeline"), null);
});

test("an empty body is refused before it reaches the table", () => {
  const problem = skills.skillInputError({ name: "Demo", body: "   " });
  assert.match(problem, /Nội dung/);
});

test("creating a skill stores it and derives the slug from the name", async () => {
  reset();
  const created = await skills.createSkill({ name: "Recon Pipeline", body: BODY, summary: "s" });
  assert.equal(created.slug, "recon-pipeline");

  const full = await skills.getSkillBySlug("recon-pipeline");
  assert.equal(full.name, "Recon Pipeline");
  assert.equal(full.body, BODY);
  assert.equal(full.isPublished, true);
  assert.equal(full.audience, "customer");
  assert.equal(full.fileName, "SKILL.md");
});

test("a duplicate slug is refused rather than silently overwriting", async () => {
  await assert.rejects(
    () => skills.createSkill({ name: "Recon Pipeline", body: BODY }),
    /đã được dùng/
  );
});

test("an internal skill never reaches the customer catalogue", async () => {
  reset();
  await skills.createSkill({ name: "Public One", body: BODY, category: "Red team" });
  await skills.createSkill({
    name: "Internal One",
    body: BODY,
    category: "Red team",
    audience: "internal",
  });

  const customerView = await skills.listPublishedSkills();
  assert.equal(customerView.length, 1);
  assert.equal(customerView[0].name, "Public One");

  // The admin view still sees both, which is the point of the audience flag.
  const adminView = await skills.listSkills();
  assert.equal(adminView.length, 2);

  // And the published-only lookup used by the download route refuses it.
  assert.equal(await skills.getSkillBySlug("internal-one", { publishedOnly: true }), null);
});

test("an unpublished skill is absent from the customer catalogue", async () => {
  reset();
  const created = await skills.createSkill({
    name: "Draft Skill",
    body: BODY,
    isPublished: false,
  });
  assert.equal((await skills.listPublishedSkills()).length, 0);

  await skills.updateSkill(created.id, { isPublished: true });
  assert.equal((await skills.listPublishedSkills()).length, 1);
});

test("the list omits bodies; the single read includes one", async () => {
  reset();
  await skills.createSkill({ name: "Body Test", body: BODY });

  const listed = (await skills.listSkills())[0];
  assert.equal(listed.body, undefined);

  const full = await skills.getSkillById(listed.id);
  assert.equal(full.body, BODY);
});

test("a partial patch keeps the fields it does not mention", async () => {
  reset();
  const created = await skills.createSkill({
    name: "Patch Test",
    body: BODY,
    summary: "original",
    category: "Red team",
  });

  await skills.updateSkill(created.id, { summary: "changed" });

  const after = await skills.getSkillById(created.id);
  assert.equal(after.summary, "changed");
  assert.equal(after.body, BODY);        // untouched
  assert.equal(after.category, "Red team"); // untouched
});

test("renaming the slug de-duplicates against other rows", async () => {
  reset();
  await skills.createSkill({ name: "First", body: BODY });
  const second = await skills.createSkill({ name: "Second", body: BODY });

  await assert.rejects(
    () => skills.updateSkill(second.id, { slug: "first" }),
    /đã được dùng/
  );
});

test("categories count only what a customer can see", async () => {
  reset();
  await skills.createSkill({ name: "A", body: BODY, category: "Recon" });
  await skills.createSkill({ name: "B", body: BODY, category: "Recon" });
  await skills.createSkill({ name: "C", body: BODY, category: "Exploit" });
  await skills.createSkill({ name: "D", body: BODY, category: "Exploit", audience: "internal" });
  await skills.createSkill({ name: "E", body: BODY, category: "Draft", isPublished: false });

  const categories = await skills.listSkillCategories();
  const byName = Object.fromEntries(categories.map((c) => [c.category, c.count]));
  assert.equal(byName.Recon, 2);
  assert.equal(byName.Exploit, 1); // the internal row is not counted
  assert.equal(byName.Draft, undefined); // nor the unpublished one
});

test("deleting removes the row and reports whether anything matched", async () => {
  reset();
  const created = await skills.createSkill({ name: "Gone", body: BODY });
  assert.equal(await skills.deleteSkill(created.id), true);
  assert.equal(await skills.getSkillById(created.id), null);
  assert.equal(await skills.deleteSkill(created.id), false);
});

test("the download counter increments without rewriting the body", async () => {
  reset();
  const created = await skills.createSkill({ name: "Counter", body: BODY });
  await skills.incrementSkillDownload(created.id);
  await skills.incrementSkillDownload(created.id);

  const full = await skills.getSkillById(created.id);
  assert.equal(full.downloadCount, 2);
  assert.equal(full.body, BODY);
});

test("a slug the admin typed is refused as typed, never rewritten", async () => {
  reset();
  for (const slug of ["../etc/passwd", "a/b", "UPPER", "has space", "trail-"]) {
    assert.ok(skills.skillInputError({ name: "N", slug, body: BODY }), `input ${slug}`);
    await assert.rejects(() => skills.createSkill({ name: "N", slug, body: BODY }), undefined, slug);
  }
  assert.equal((await skills.listSkills()).length, 0);

  // Only a missing slug is derived from the name.
  const derived = await skills.createSkill({ name: "Kỹ năng Đọc", body: BODY });
  assert.equal(derived.slug, "ky-nang-doc");

  // The same rule holds on update.
  await assert.rejects(() => skills.updateSkill(derived.id, { slug: "../x" }), /Slug/);
  await assert.rejects(() => skills.updateSkill(derived.id, { slug: "UPPER" }), /Slug/);
  assert.equal((await skills.getSkillById(derived.id)).slug, "ky-nang-doc");
});

test("a file name must be an ASCII .md name", async () => {
  reset();
  for (const fileName of ["Kỹ-năng.md", "../SKILL.md", "a/b.md", "SKILL.txt", ".md", 'x".md', "a\nb.md"]) {
    assert.match(skills.skillInputError({ name: "N", body: BODY, fileName }) || "", /Tên file/, fileName);
  }
  assert.equal(skills.skillInputError({ name: "N", body: BODY, fileName: "SKILL.md" }), null);
  assert.equal(skills.skillInputError({ name: "N", body: BODY, fileName: "recon-v2.md" }), null);
  assert.equal(skills.skillInputError({ name: "N", body: BODY }), null); // blank → SKILL.md
});

test("every stated limit is refused, not silently cut", () => {
  const base = { name: "N", body: BODY };
  assert.match(skills.skillInputError({ ...base, usageNotes: "x".repeat(4001) }), /Ghi chú/);
  assert.match(skills.skillInputError({ ...base, version: "x".repeat(41) }), /Phiên bản/);
  assert.match(skills.skillInputError({ ...base, category: "x".repeat(81) }), /Nhóm/);
  assert.equal(skills.skillInputError({ ...base, usageNotes: "x".repeat(4000), version: "x".repeat(40) }), null);
});

test("the body limit counts UTF-8 bytes, not characters", () => {
  // 200,000 three-byte characters is 600,000 bytes: over 512 KB although it is
  // under 512 K characters.
  assert.match(skills.skillInputError({ name: "N", body: "ệ".repeat(200000) }), /512 KB/);
  assert.equal(skills.skillInputError({ name: "N", body: "ệ".repeat(100000) }), null);
});

test("runtime, audience and the published flag only accept known values", async () => {
  reset();
  const base = { name: "N", body: BODY };
  assert.match(skills.skillInputError({ ...base, targets: ["claude", "vim"] }), /Runtime/);
  assert.match(skills.skillInputError({ ...base, target: "vim" }), /Runtime/);
  assert.match(skills.skillInputError({ ...base, audience: "everyone" }), /Đối tượng/);
  assert.match(skills.skillInputError({ ...base, isPublished: "maybe" }), /phát hành/);

  // The strings a form or script may send are read as booleans, not as "truthy".
  const off = await skills.createSkill({ name: "Off", body: BODY, isPublished: "false" });
  assert.equal((await skills.getSkillById(off.id)).isPublished, false);
  const on = await skills.createSkill({ name: "On", body: BODY, isPublished: "true" });
  assert.equal((await skills.getSkillById(on.id)).isPublished, true);
  await skills.updateSkill(on.id, { isPublished: 0 });
  assert.equal((await skills.getSkillById(on.id)).isPublished, false);
});

test("a blank slug on update keeps the current slug instead of renaming", async () => {
  reset();
  const created = await skills.createSkill({ name: "Keep Me", body: BODY });
  await skills.updateSkill(created.id, { slug: "", summary: "x" });
  assert.equal((await skills.getSkillById(created.id)).slug, "keep-me");
  await skills.updateSkill(created.id, { slug: "   " });
  assert.equal((await skills.getSkillById(created.id)).slug, "keep-me");
});

test("a long name cannot yield a slug ending in a dash", () => {
  const slug = skills.slugifySkill(`${"a".repeat(63)} b`);
  assert.equal(slug, "a".repeat(63));
  assert.equal(skills.slugError(slug), null);
});

test("a skill can target several runtimes at once", async () => {
  reset();
  const created = await skills.createSkill({ name: "Multi", body: BODY, targets: ["claude", "codex"] });
  const row = await skills.getSkillById(created.id);
  assert.deepEqual(row.targets, ["claude", "codex"]);

  // The list view carries them too, and an update that does not mention them keeps them.
  assert.deepEqual((await skills.listSkills())[0].targets, ["claude", "codex"]);
  await skills.updateSkill(created.id, { summary: "x" });
  assert.deepEqual((await skills.getSkillById(created.id)).targets, ["claude", "codex"]);

  await skills.updateSkill(created.id, { targets: ["cursor"] });
  assert.deepEqual((await skills.getSkillById(created.id)).targets, ["cursor"]);
});

test("no runtime named means every runtime; legacy single target and 'generic' still read", async () => {
  reset();
  const all = ["claude", "codex", "cursor"];
  const none = await skills.createSkill({ name: "None", body: BODY });
  assert.deepEqual((await skills.getSkillById(none.id)).targets, all);

  const legacy = await skills.createSkill({ name: "Legacy", body: BODY, target: "codex" });
  assert.deepEqual((await skills.getSkillById(legacy.id)).targets, ["codex"]);

  const generic = await skills.createSkill({ name: "Generic", body: BODY, target: "generic" });
  assert.deepEqual((await skills.getSkillById(generic.id)).targets, all);

  // A v45 row has no `targets` value: it reads as its single target.
  const row = await skills.createSkill({ name: "Old", body: BODY, target: "cursor" });
  db.run(`UPDATE skills SET targets = NULL WHERE id = ?`, [row.id]);
  assert.deepEqual((await skills.getSkillById(row.id)).targets, ["cursor"]);
  // Duplicates collapse.
  const dup = await skills.createSkill({ name: "Dup", body: BODY, targets: ["claude", "claude", "codex"] });
  assert.deepEqual((await skills.getSkillById(dup.id)).targets, ["claude", "codex"]);
});

test("importing several skills reports each one and never lets one bad row block the rest", async () => {
  reset();
  await skills.createSkill({ name: "Existing", body: BODY, summary: "old", category: "Keep" });
  const results = await skills.importSkills([
    { name: "Fresh One", body: BODY, targets: ["claude", "codex"] },
    { name: "Fresh Two", body: BODY },
    { name: "Existing", body: `${BODY}new\n`, summary: "new" },
    { name: "Bad Body", body: "   " },
    { name: "Bad Slug", slug: "../x", body: BODY },
  ]);
  assert.deepEqual(results.map((r) => r.action), ["created", "created", "skipped", "error", "error"]);
  assert.match(results[3].error, /Nội dung/);
  assert.match(results[4].error, /Slug/);
  assert.equal((await skills.listSkills()).length, 3);
  // "skip" leaves the existing row alone.
  assert.equal((await skills.getSkillBySlug("existing")).summary, "old");

  // "update" overwrites the existing row's body but keeps what the item does not mention.
  const again = await skills.importSkills([{ name: "Existing", body: `${BODY}new\n`, summary: "new" }], { mode: "update" });
  assert.equal(again[0].action, "updated");
  const row = await skills.getSkillBySlug("existing");
  assert.equal(row.summary, "new");
  assert.equal(row.body, `${BODY}new\n`);
  assert.equal(row.category, "Keep");
});

test("the same slug twice in one import is created once", async () => {
  reset();
  const results = await skills.importSkills([
    { name: "Twice", body: BODY },
    { name: "Twice", body: BODY },
  ]);
  assert.deepEqual(results.map((r) => r.action), ["created", "skipped"]);
});

test("an import needs 1 to 100 items", async () => {
  await assert.rejects(() => skills.importSkills([]), /Chưa có/);
  await assert.rejects(
    () => skills.importSkills(Array.from({ length: 101 }, (_, i) => ({ name: `n${i}`, body: BODY }))),
    /tối đa 100/
  );
});

test("a bulk patch changes only the allowed fields on every selected skill", async () => {
  reset();
  const a = await skills.createSkill({ name: "Bulk A", body: BODY, targets: ["claude"], category: "Old" });
  const b = await skills.createSkill({ name: "Bulk B", body: BODY, targets: ["codex"] });
  const untouched = await skills.createSkill({ name: "Bulk C", body: BODY, targets: ["cursor"] });

  const results = await skills.patchSkills([a.id, b.id, "missing"], {
    targets: ["claude", "codex", "cursor"],
    isPublished: false,
    body: "must be ignored",
    slug: "must-be-ignored",
    name: "must be ignored",
  });
  assert.deepEqual(results.map((r) => r.ok), [true, true, false]);

  for (const id of [a.id, b.id]) {
    const row = await skills.getSkillById(id);
    assert.deepEqual(row.targets, ["claude", "codex", "cursor"]);
    assert.equal(row.isPublished, false);
    assert.equal(row.body, BODY);
    assert.match(row.slug, /^bulk-/);
  }
  assert.equal((await skills.getSkillById(a.id)).category, "Old");
  assert.deepEqual((await skills.getSkillById(untouched.id)).targets, ["cursor"]);

  await assert.rejects(() => skills.patchSkills([], { isPublished: true }), /Chưa chọn/);
  await assert.rejects(() => skills.patchSkills([a.id], { body: "x" }), /Không có gì/);
  const bad = await skills.patchSkills([a.id], { targets: ["vim"] });
  assert.equal(bad[0].ok, false);
  assert.match(bad[0].error, /Runtime/);
});

test("re-importing in update mode replaces content only and never changes visibility, agents or category", async () => {
  reset();
  const created = await skills.createSkill({
    name: "Secret Draft",
    body: BODY,
    summary: "old summary",
    category: "Internal tools",
    audience: "internal",
    isPublished: false,
    targets: ["codex"],
  });
  // The shape the import form sends: shared defaults for every row.
  const results = await skills.importSkills([{
    name: "Secret Draft",
    slug: "secret-draft",
    summary: "",
    body: `${BODY}v2\n`,
    fileName: "SKILL.md",
    targets: ["claude", "codex", "cursor"],
    category: "",
    audience: "customer",
    isPublished: true,
  }], { mode: "update" });
  assert.equal(results[0].action, "updated");

  const row = await skills.getSkillById(created.id);
  assert.equal(row.body, `${BODY}v2\n`);
  assert.equal(row.audience, "internal");
  assert.equal(row.isPublished, false);
  assert.deepEqual(row.targets, ["codex"]);
  assert.equal(row.category, "Internal tools");
  assert.equal(row.summary, "old summary"); // an empty summary does not wipe the old one
  assert.equal((await skills.listPublishedSkills()).length, 0);
});

test("a null or empty visibility value is refused, not read as the default", async () => {
  reset();
  const draft = await skills.createSkill({ name: "Draft Keep", body: BODY, isPublished: false, audience: "internal" });
  for (const patch of [{ isPublished: null }, { isPublished: "" }, { audience: null }, { audience: "" }]) {
    await assert.rejects(() => skills.updateSkill(draft.id, patch), /không hợp lệ/);
    const results = await skills.patchSkills([draft.id], patch);
    assert.equal(results[0].ok, false);
  }
  const row = await skills.getSkillById(draft.id);
  assert.equal(row.isPublished, false);
  assert.equal(row.audience, "internal");
});
