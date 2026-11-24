// DSH-plugin registry tests against a real throwaway SQLite database.
//
// A DSH plugin is not a skill: it is an npm package the harness loads, so the row
// carries a package spec rather than a markdown body. These pin the two things that
// make that safe to publish — the package spec cannot smuggle shell syntax into the
// install command a customer copies, and the audience/published flags keep an
// internal plugin out of the customer list.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-dsh-plugins-test-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const plugins = await import("../src/lib/db/repos/dshPluginsRepo.js");

let db;

function reset() {
  try { db.run("DELETE FROM dshPlugins"); } catch { /* table not created yet */ }
}

before(async () => {
  db = await getAdapter();
  reset();
});

after(() => {
  try { db.close?.(); } catch { /* best effort */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ── the package spec ──────────────────────────────────────────────────── */

test("a plain npm name is accepted", () => {
  assert.equal(plugins.packageError("dsh-purge-safe"), null);
});

test("a scoped and a versioned name are accepted", () => {
  assert.equal(plugins.packageError("@scope/plugin"), null);
  assert.equal(plugins.packageError("dsh-purge-safe@2.0.1"), null);
});

test("a git or tarball spec is accepted, because not every plugin is on npm", () => {
  assert.equal(plugins.packageError("git+https://github.com/a/b.git"), null);
  assert.equal(plugins.packageError("https://example.com/p.tgz"), null);
  assert.equal(plugins.packageError("file:../local-plugin"), null);
});

test("shell syntax in a package name is refused", () => {
  // The name is interpolated into `dsh plugin add <spec>`, which a customer runs.
  for (const bad of ["pkg; rm -rf /", "pkg && curl evil", "pkg|sh", "pkg`id`", "pkg$(id)", "a b"]) {
    assert.ok(plugins.packageError(bad), `should refuse: ${bad}`);
  }
});

test("an empty package name is refused", () => {
  assert.match(plugins.packageError(""), /không được để trống/);
  assert.match(plugins.packageError("   "), /không được để trống/);
});

test("links must be http(s), never javascript:", () => {
  const problem = plugins.pluginInputError({
    name: "x",
    packageName: "ok",
    repoUrl: "javascript:alert(1)",
  });
  assert.match(problem, /http\(s\)/);

  const docsProblem = plugins.pluginInputError({
    name: "x",
    packageName: "ok",
    docsUrl: "data:text/html,<script>",
  });
  assert.match(docsProblem, /http\(s\)/);
});

/* ── the whole payload ─────────────────────────────────────────────────── */

test("a name is required", () => {
  assert.match(plugins.pluginInputError({ packageName: "ok" }), /Tên plugin/);
});

test("the slug is derived from the name when omitted", async () => {
  reset();
  const created = await plugins.createPlugin({ name: "DSH Purge Safe", packageName: "dsh-purge-safe" });
  assert.equal(created.slug, "dsh-purge-safe");
});

test("a duplicate slug is refused", async () => {
  await assert.rejects(
    () => plugins.createPlugin({ name: "DSH Purge Safe", packageName: "other" }),
    /đã được dùng/,
  );
});

/* ── visibility ────────────────────────────────────────────────────────── */

test("an internal plugin never reaches the customer list", async () => {
  reset();
  await plugins.createPlugin({ name: "Public", slug: "public-one", packageName: "a" });
  await plugins.createPlugin({ name: "Internal", slug: "internal-one", packageName: "b", audience: "internal" });

  const customerView = await plugins.listPublishedPlugins();
  assert.deepEqual(customerView.map((p) => p.slug), ["public-one"]);

  const adminView = await plugins.listPlugins();
  assert.equal(adminView.length, 2);

  assert.equal(await plugins.getPluginBySlug("internal-one", { publishedOnly: true }), null);
});

test("an unpublished plugin is absent from the customer list", async () => {
  reset();
  const created = await plugins.createPlugin({ name: "Draft", slug: "draft-one", packageName: "a", isPublished: false });
  assert.equal((await plugins.listPublishedPlugins()).length, 0);

  await plugins.updatePlugin(created.id, { isPublished: true });
  assert.equal((await plugins.listPublishedPlugins()).length, 1);
});

test("the customer view hides who published it", async () => {
  reset();
  await plugins.createPlugin({ name: "Owned", slug: "owned", packageName: "a" }, { createdBy: "admin:alice" });
  const [visible] = await plugins.listPublishedPlugins();
  assert.equal(visible.createdBy, undefined);
});

/* ── updates ───────────────────────────────────────────────────────────── */

test("a partial patch keeps the fields it does not mention", async () => {
  reset();
  const created = await plugins.createPlugin({
    name: "Patch",
    slug: "patch-test",
    packageName: "pkg",
    version: "1.0.0",
    dshTarget: "0.2.2-rc.3",
    usageGuide: "### Guide\n",
  });

  await plugins.updatePlugin(created.id, { description: "changed" });

  const after = await plugins.getPluginById(created.id);
  assert.equal(after.description, "changed");
  assert.equal(after.packageName, "pkg");
  assert.equal(after.version, "1.0.0");
  assert.equal(after.dshTarget, "0.2.2-rc.3");
  // normalize() trims the guide on write, so the trailing newline is gone by design —
  // stored text has no leading/trailing whitespace, same as every other field.
  assert.equal(after.usageGuide, "### Guide");
});

test("a patch cannot introduce an invalid package name", async () => {
  reset();
  const created = await plugins.createPlugin({ name: "Guard", slug: "guard", packageName: "good" });
  await assert.rejects(
    () => plugins.updatePlugin(created.id, { packageName: "bad; rm -rf /" }),
    /không hợp lệ/,
  );
});

test("renaming onto an existing slug is refused", async () => {
  reset();
  await plugins.createPlugin({ name: "First", slug: "first", packageName: "a" });
  const second = await plugins.createPlugin({ name: "Second", slug: "second", packageName: "b" });
  await assert.rejects(() => plugins.updatePlugin(second.id, { slug: "first" }), /đã được dùng/);
});

test("delete reports whether a row matched", async () => {
  reset();
  const created = await plugins.createPlugin({ name: "Gone", slug: "gone", packageName: "a" });
  assert.equal(await plugins.deletePlugin(created.id), true);
  assert.equal(await plugins.deletePlugin(created.id), false);
});

test("the install counter increments without touching the guide", async () => {
  reset();
  const created = await plugins.createPlugin({ name: "Count", slug: "count", packageName: "a", usageGuide: "x" });
  await plugins.incrementPluginInstall(created.id);
  await plugins.incrementPluginInstall(created.id);

  const after = await plugins.getPluginById(created.id);
  assert.equal(after.installCount, 2);
  assert.equal(after.usageGuide, "x");
});
