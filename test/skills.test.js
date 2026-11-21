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
  assert.match(skills.skillInputError({ ...base, installPath: "x".repeat(301) }), /Đường dẫn/);
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
