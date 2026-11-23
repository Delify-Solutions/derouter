// Skill bundle repo tests against a real throwaway SQLite database.
//
// A bundle is a skillsRepo.js sibling: it has the same kind of lifecycle (slug
// uniqueness, publish/audience) plus one thing a skill never had — an installer
// entrypoint path that gets interpolated into a shell script and resolved inside
// an unpacked repository, so a path that could escape it must be refused. These
// pin that, plus the one operation unique to a bundle: deleting it detaches its
// skills rather than taking them down with it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-skill-bundles-test-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const bundles = await import("../src/lib/db/repos/skillBundlesRepo.js");
const skills = await import("../src/lib/db/repos/skillsRepo.js");

let db;

function reset() {
  for (const t of ["skillBundles", "skills"]) {
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

const BASE = {
  name: "rea policy",
  sourceHost: "github.com",
  sourceOwner: "Delify-Solutions",
  sourceRepo: "rea_policy",
  sourceRef: "main",
};
const SKILL_BODY = "---\nname: rt-demo\ndescription: demo\n---\n\n# Demo\n";

test("creating a bundle stores it, derives the slug, and defaults the entrypoint", async () => {
  reset();
  const created = await bundles.createBundle({ ...BASE });
  assert.equal(created.slug, "rea-policy");

  const full = await bundles.getBundleById(created.id);
  assert.equal(full.name, "rea policy");
  assert.equal(full.installerEntrypoint, "install.mjs"); // default, nothing typed
  assert.equal(full.isPublished, true);
  assert.equal(full.audience, "customer");
  assert.equal(full.sourceHost, "github.com");
  assert.equal(full.sourceOwner, "Delify-Solutions");
  assert.equal(full.sourceRepo, "rea_policy");
  assert.equal(full.sourceRef, "main");
});

test("a minimal bundle is stored with an empty description and usage guide", async () => {
  reset();
  const created = await bundles.createBundle({ ...BASE });
  const full = await bundles.getBundleById(created.id);
  assert.equal(full.description, "");
  assert.equal(full.usageGuide, "");
});

test("version is free text (no git tag to derive one from), capped like a skill's own", async () => {
  reset();
  const created = await bundles.createBundle({ ...BASE, version: "v1.0.0" });
  assert.equal((await bundles.getBundleById(created.id)).version, "v1.0.0");

  const bare = await bundles.createBundle({ ...BASE, slug: "bare", version: "" });
  assert.equal((await bundles.getBundleById(bare.id)).version, "");

  assert.match(bundles.bundleInputError({ ...BASE, version: "v".repeat(41) }), /Phiên bản tối đa 40/);
  assert.equal(bundles.bundleInputError({ ...BASE, version: "v1.0.0" }), null);
});

test("importedSha only accepts a hex commit SHA; anything else is dropped, not stored garbage", async () => {
  reset();
  const sha = "a".repeat(40);
  const created = await bundles.createBundle({ ...BASE, importedSha: sha });
  assert.equal((await bundles.getBundleById(created.id)).importedSha, sha);

  const short = await bundles.createBundle({ ...BASE, slug: "short-sha", importedSha: "abc1234" });
  assert.equal((await bundles.getBundleById(short.id)).importedSha, "abc1234");

  for (const bad of ["not-hex-at-all", "zzzzzzz", "", "abc123"]) { // "abc123" is under the 7-char floor
    const row = await bundles.createBundle({ ...BASE, slug: `bad-${bad || "empty"}`, importedSha: bad });
    assert.equal((await bundles.getBundleById(row.id)).importedSha, null, bad);
  }
});

test("a partial update preserves version and importedSha when neither is mentioned", async () => {
  reset();
  const sha = "b".repeat(40);
  const created = await bundles.createBundle({ ...BASE, version: "v1.0.0", importedSha: sha });
  await bundles.updateBundle(created.id, { description: "changed" });
  const after1 = await bundles.getBundleById(created.id);
  assert.equal(after1.version, "v1.0.0");
  assert.equal(after1.importedSha, sha);

  const newSha = "c".repeat(40);
  await bundles.updateBundle(created.id, { version: "v1.1.0", importedSha: newSha });
  const after2 = await bundles.getBundleById(created.id);
  assert.equal(after2.version, "v1.1.0");
  assert.equal(after2.importedSha, newSha);
});

test("a duplicate slug is refused rather than silently overwriting", async () => {
  reset();
  await bundles.createBundle({ ...BASE });
  await assert.rejects(
    () => bundles.createBundle({ ...BASE, name: "rea policy again", slug: "rea-policy" }),
    /đã được dùng/
  );
});

test("a slug that could escape a directory is refused, same shape as a skill's", () => {
  assert.ok(bundles.bundleSlugError("../etc/passwd"));
  assert.ok(bundles.bundleSlugError("a/b"));
  assert.ok(bundles.bundleSlugError("UPPER"));
  assert.ok(bundles.bundleSlugError(""));
  assert.equal(bundles.bundleSlugError("rea-policy"), null);
});

test("an installer entrypoint path that could escape the unpacked tree is refused", () => {
  for (const bad of ["../../etc/passwd", "/etc/passwd", "lib/../../x", "a//b"]) {
    assert.ok(bundles.installerEntrypointError(bad), bad);
    assert.ok(bundles.bundleInputError({ ...BASE, installerEntrypoint: bad }), bad);
  }
  // An empty value is not "invalid": it means "use the conventional default",
  // same as a skill's blank fileName defaulting to SKILL.md.
  assert.ok(bundles.installerEntrypointError(""));
  assert.equal(bundles.bundleInputError({ ...BASE, installerEntrypoint: "" }), null);

  assert.equal(bundles.installerEntrypointError("install.mjs"), null);
  assert.equal(bundles.installerEntrypointError("bin/install.mjs"), null);
  assert.equal(bundles.bundleInputError({ ...BASE, installerEntrypoint: "install.mjs" }), null);
});

test("saving a bundle with a path-traversal installer entrypoint is refused", async () => {
  reset();
  await assert.rejects(
    () => bundles.createBundle({ ...BASE, installerEntrypoint: "../../etc/passwd" }),
    /installer/
  );
  assert.equal((await bundles.listBundles()).length, 0);
});

test("required source fields are validated before anything is written", () => {
  assert.match(bundles.bundleInputError({ name: "x" }), /owner\/tên repo|Host repo|nhánh\/ref/i);
  assert.match(bundles.bundleInputError({ ...BASE, sourceHost: "bitbucket.org" }), /Host repo/);
  assert.match(bundles.bundleInputError({ ...BASE, sourceRef: "" }), /nhánh\/ref/);
  assert.match(bundles.bundleInputError({ ...BASE, sourceOwner: "a b" }), /Owner/);
  assert.equal(bundles.bundleInputError({ ...BASE }), null);
});

test("a GitLab nested-group owner (group/subgroup) is accepted, a traversal attempt is not", async () => {
  reset();
  const nested = { ...BASE, sourceHost: "gitlab.com", sourceOwner: "group/subgroup", sourceRepo: "toolkit", sourceRef: "main" };
  assert.equal(bundles.bundleInputError(nested), null);
  const created = await bundles.createBundle(nested);
  assert.equal((await bundles.getBundleById(created.id)).sourceOwner, "group/subgroup");

  for (const bad of ["../escape", "group/..", "group/sub group"]) {
    assert.match(bundles.bundleInputError({ ...BASE, sourceHost: "gitlab.com", sourceOwner: bad }), /Owner/, bad);
  }
  assert.match(bundles.bundleInputError({ ...BASE, sourceOwner: "" }), /Thiếu owner/);
});

test("audience and the published flag only accept known values", () => {
  assert.match(bundles.bundleInputError({ ...BASE, audience: "everyone" }), /Đối tượng/);
  assert.match(bundles.bundleInputError({ ...BASE, isPublished: "maybe" }), /phát hành/);
});

test("listBundles narrows by audience and published state; listPublishedBundles hides admin identity", async () => {
  reset();
  const pub = await bundles.createBundle({ ...BASE, name: "Public Bundle" }, { createdBy: "admin:owner@example.com" });
  await bundles.createBundle({ ...BASE, name: "Internal Bundle", slug: "internal-bundle", audience: "internal" });
  await bundles.createBundle({ ...BASE, name: "Draft Bundle", slug: "draft-bundle", isPublished: false });

  assert.equal((await bundles.listBundles()).length, 3);
  assert.equal((await bundles.listBundles({ audience: "internal" })).length, 1);
  assert.equal((await bundles.listBundles({ isPublished: false })).length, 1);

  const published = await bundles.listPublishedBundles();
  assert.deepEqual(published.map((b) => b.name), ["Public Bundle"]);
  assert.ok(!("createdBy" in published[0]));

  const full = await bundles.getBundleById(pub.id);
  assert.equal(full.createdBy, "admin:owner@example.com");
});

test("getBundleBySlug with publishedOnly refuses an internal or draft bundle", async () => {
  reset();
  await bundles.createBundle({ ...BASE, audience: "internal" });
  assert.equal(await bundles.getBundleBySlug("rea-policy", { publishedOnly: true }), null);
  assert.ok(await bundles.getBundleBySlug("rea-policy"));
});

test("a partial update keeps the fields it does not mention", async () => {
  reset();
  const created = await bundles.createBundle({ ...BASE, description: "original" });
  await bundles.updateBundle(created.id, { description: "changed" });
  const after1 = await bundles.getBundleById(created.id);
  assert.equal(after1.description, "changed");
  assert.equal(after1.sourceRepo, "rea_policy"); // untouched
});

test("renaming the slug de-duplicates against other rows", async () => {
  reset();
  await bundles.createBundle({ ...BASE });
  const second = await bundles.createBundle({ ...BASE, name: "Second", slug: "second-bundle" });
  await assert.rejects(
    () => bundles.updateBundle(second.id, { slug: "rea-policy" }),
    /đã được dùng/
  );
});

test("a null or empty visibility value on update is refused, not read as the default", async () => {
  reset();
  const draft = await bundles.createBundle({ ...BASE, isPublished: false, audience: "internal" });
  for (const patch of [{ isPublished: null }, { isPublished: "" }, { audience: null }, { audience: "" }]) {
    await assert.rejects(() => bundles.updateBundle(draft.id, patch), /không hợp lệ/);
  }
  const row = await bundles.getBundleById(draft.id);
  assert.equal(row.isPublished, false);
  assert.equal(row.audience, "internal");
});

test("deleting a bundle detaches its skills instead of taking them down with it", async () => {
  reset();
  const bundle = await bundles.createBundle({ ...BASE });
  const a = await skills.createSkill({ name: "Skill A", body: SKILL_BODY, bundleId: bundle.id });
  const b = await skills.createSkill({ name: "Skill B", body: SKILL_BODY, bundleId: bundle.id });
  const c = await skills.createSkill({ name: "Skill C", body: SKILL_BODY, bundleId: bundle.id });
  const unrelated = await skills.createSkill({ name: "Unrelated", body: SKILL_BODY });

  assert.equal(await bundles.deleteBundle(bundle.id), true);
  assert.equal(await bundles.getBundleById(bundle.id), null);

  for (const id of [a.id, b.id, c.id]) {
    const row = await skills.getSkillById(id);
    assert.ok(row, "the skill still exists");
    assert.equal(row.bundleId, null, "its bundle link is cleared");
  }
  // A skill that never had a bundle is unaffected by someone else's deletion.
  assert.equal((await skills.getSkillById(unrelated.id)).bundleId, null);

  // Deleting again (or a bundle that never existed) reports false, not an error.
  assert.equal(await bundles.deleteBundle(bundle.id), false);
  assert.equal(await bundles.deleteBundle("no-such-id"), false);
});

test("a skill without a bundle behaves exactly as before this capability existed", async () => {
  reset();
  const created = await skills.createSkill({ name: "Standalone", body: SKILL_BODY });
  const row = await skills.getSkillById(created.id);
  assert.equal(row.bundleId, null);

  // An update that never mentions bundleId leaves it alone.
  await skills.updateSkill(created.id, { summary: "x" });
  assert.equal((await skills.getSkillById(created.id)).bundleId, null);
});

test("a skill can be linked to a bundle at creation and later detached explicitly", async () => {
  reset();
  const bundle = await bundles.createBundle({ ...BASE });
  const created = await skills.createSkill({ name: "Linked", body: SKILL_BODY, bundleId: bundle.id });
  assert.equal((await skills.getSkillById(created.id)).bundleId, bundle.id);

  await skills.updateSkill(created.id, { bundleId: null });
  assert.equal((await skills.getSkillById(created.id)).bundleId, null);
});
