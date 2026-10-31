// Start-up seeding of the default docs pages (content/docs/*.md).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-docs-seed-test-"));
process.env.DATA_DIR = tmpDir;
// Seed from a fixture directory in every test, never from the repo's content/.
process.env.DOCS_CONTENT_DIR = path.join(tmpDir, "does-not-exist");

const { getAdapter } = await import("../src/lib/db/driver.js");
const { seedDocsSync, parseDocFile } = await import("../src/lib/content/seedDocs.js");
const { validateSlug } = await import("../src/lib/content/docsSlug.js");

let db;
before(async () => { db = await getAdapter(); });
after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function page({ slug = "alpha", title = "Alpha", section = "Bắt đầu", sortOrder = 10, body = "Nội dung." } = {}) {
  return `---\nslug: ${slug}\ntitle: ${title}\nsection: ${section}\nexcerpt: "Tóm tắt: ngắn"\nsummary: Giới thiệu\nsortOrder: ${sortOrder}\n---\n\n${body}\n`;
}

function fixtureDir(files) {
  const dir = fs.mkdtempSync(path.join(tmpDir, "fx-"));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

const rows = () => db.all(`SELECT * FROM docsPages ORDER BY slug`);

test("inserts a missing page, published, with every front matter field", () => {
  db.run(`DELETE FROM docsPages`);
  const dir = fixtureDir({ "alpha.md": page() });
  const result = seedDocsSync(db, { dir });
  assert.deepEqual(result.inserted, ["alpha"]);
  const [row] = rows();
  assert.equal(row.slug, "alpha");
  assert.equal(row.title, "Alpha");
  assert.equal(row.section, "Bắt đầu");
  assert.equal(row.excerpt, "Tóm tắt: ngắn");
  assert.equal(row.summary, "Giới thiệu");
  assert.equal(row.sortOrder, 10);
  assert.equal(row.isPublished, 1);
  assert.equal(row.body, "Nội dung.");
});

test("a second run changes nothing", () => {
  const dir = fixtureDir({ "alpha.md": page() });
  const before = rows();
  const result = seedDocsSync(db, { dir });
  assert.deepEqual(result.inserted, []);
  assert.deepEqual(rows(), before);
});

test("an edited, unpublished or retitled row is never touched, new slugs still arrive", () => {
  db.run(`UPDATE docsPages SET title = 'Admin title', body = 'Admin body', isPublished = 0 WHERE slug = 'alpha'`);
  const dir = fixtureDir({
    "alpha.md": page({ title: "Shipped title", body: "Shipped body" }),
    "beta.md": page({ slug: "beta", title: "Beta", sortOrder: 20 }),
  });
  const result = seedDocsSync(db, { dir });
  assert.deepEqual(result.inserted, ["beta"]);
  const alpha = db.get(`SELECT * FROM docsPages WHERE slug = 'alpha'`);
  assert.equal(alpha.title, "Admin title");
  assert.equal(alpha.body, "Admin body");
  assert.equal(alpha.isPublished, 0);
});

test("pages with bad front matter are skipped and do not stop the others", () => {
  db.run(`DELETE FROM docsPages`);
  const dir = fixtureDir({
    "a-good.md": page({ slug: "good" }),
    "no-front-matter.md": "# just text\n",
    "no-title.md": "---\nslug: no-title\n---\nbody\n",
    "bad-slug.md": page({ slug: "Bad_Slug" }),
    "reserved.md": page({ slug: "admin" }),
    "empty-body.md": "---\nslug: empty\ntitle: Empty\n---\n\n",
    "bad-order.md": page({ slug: "bad-order", sortOrder: "abc" }),
    "bad-line.md": "---\nslug: x\nthis line has no colon\n---\nbody\n",
    "notes.txt": "ignored, not markdown",
  });
  const result = seedDocsSync(db, { dir });
  assert.deepEqual(result.inserted, ["good"]);
  assert.equal(result.skipped.length, 7);
  assert.deepEqual(rows().map((r) => r.slug), ["good"]);
});

test("a missing content directory is not an error", () => {
  const result = seedDocsSync(db, { dir: path.join(tmpDir, "nope") });
  assert.deepEqual(result, { inserted: [], skipped: [] });
});

test("the same slug twice in one directory inserts one row", () => {
  db.run(`DELETE FROM docsPages`);
  const dir = fixtureDir({ "one.md": page({ slug: "dup", title: "One" }), "two.md": page({ slug: "dup", title: "Two" }) });
  assert.deepEqual(seedDocsSync(db, { dir }).inserted, ["dup"]);
  assert.equal(rows().length, 1);
});

test("parseDocFile accepts CRLF files and quoted values", () => {
  const text = page({ title: '"Quoted: title"' }).replace(/\n/g, "\r\n");
  const { doc, error } = parseDocFile(text);
  assert.equal(error, undefined);
  assert.equal(doc.title, "Quoted: title");
  assert.equal(doc.body, "Nội dung.");
});

// The shipped pages must all load: a malformed file would otherwise disappear
// from production with only a warning in the boot log.
const SHIPPED = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "content", "docs");
const EXPECTED_SLUGS = [
  "quickstart", "claude-code", "claude-desktop", "codex", "omp", "opencode",
  "cc-switch", "sdk", "models", "plans", "troubleshooting",
];

test("every shipped docs page parses, has a valid slug and seeds", () => {
  db.run(`DELETE FROM docsPages`);
  const result = seedDocsSync(db, { dir: SHIPPED });
  assert.deepEqual(result.skipped, []);
  assert.deepEqual([...result.inserted].sort(), [...EXPECTED_SLUGS].sort());
  for (const slug of result.inserted) assert.equal(validateSlug(slug), null, slug);
});

test("shipped pages: unique sort orders, sections contiguous, no dead-link or raw-html hazards", () => {
  const pages = rows().sort((a, b) => a.sortOrder - b.sortOrder);
  assert.equal(new Set(pages.map((p) => p.sortOrder)).size, pages.length);
  // A section may not reappear after another section started: the docs index
  // groups by first appearance.
  const seen = [];
  for (const p of pages) if (seen.at(-1) !== p.section) seen.push(p.section);
  assert.equal(new Set(seen).size, seen.length, `sections interleave: ${seen.join(" > ")}`);
  for (const p of pages) {
    assert.ok(p.excerpt && p.summary, `${p.slug} needs excerpt and summary`);
    // Screenshots follow /docs-img/<slug>/<file>.png and live in the page's own folder.
    for (const m of p.body.matchAll(/!\[[^\]]*\]\((\/docs-img\/[^)]+)\)/g)) {
      assert.match(m[1], new RegExp(`^/docs-img/${p.slug}/[a-z0-9-]+\\.png$`), `${p.slug}: ${m[1]}`);
    }
    // Internal links must point at a shipped page.
    for (const m of p.body.matchAll(/\]\(\/docs\/([a-z0-9-]+)\)/g)) {
      assert.ok(EXPECTED_SLUGS.includes(m[1]), `${p.slug} links to unknown page ${m[1]}`);
    }
  }
});

test("every shipped page renders without losing a link or image to the sanitiser", async () => {
  const { renderMarkdown } = await import("../src/shared/utils/markdown.js");
  for (const p of rows()) {
    const html = renderMarkdown(p.body);
    assert.doesNotMatch(html, /(href|src)="#"/, `${p.slug} lost a URL`);
    assert.doesNotMatch(html, /<script/i);
    // Every tab block opened in the source produced a tablist (or single block).
    const opened = (p.body.match(/^:::tabs\s*$/gm) || []).length;
    const rendered = (html.match(/class="docs-tabs"/g) || []).length + (html.match(/docs-tab-single/g) || []).length;
    assert.equal(rendered, opened, `${p.slug}: tab blocks`);
  }
});
