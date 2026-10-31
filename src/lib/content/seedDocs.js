// Start-up seeder for the default docs pages shipped in content/docs/*.md.
//
// Contract:
//   - A page is inserted only when no row with its slug exists yet.
//   - An existing row is NEVER updated or deleted, so whatever an admin edited in
//     /dashboard/content wins over the shipped text. (Consequence: a page an admin
//     deleted is inserted again on the next start; unpublish it instead.)
//   - A missing directory or a malformed file is skipped, never thrown: seeding
//     must not be able to stop the server from starting.
//
// SYNCHRONOUS + DRIVER-FREE, like billing/bootstrap.js which calls it: the adapter
// is passed in and nothing here may import ../db/driver.js.
import fs from "node:fs";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { validateSlug } from "./docsSlug.js";

const FRONT_MATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Default location. DOCS_CONTENT_DIR lets a deployment point elsewhere. */
export function defaultDocsDir() {
  const override = process.env.DOCS_CONTENT_DIR;
  return override ? path.resolve(override) : path.join(process.cwd(), "content", "docs");
}

/**
 * Parse one Markdown file into a docs page, or explain why it is unusable.
 * Front matter is flat `key: value` lines (values may be wrapped in quotes).
 *
 * @returns {{ doc: object } | { error: string }}
 */
export function parseDocFile(text) {
  const match = FRONT_MATTER_RE.exec(String(text ?? ""));
  if (!match) return { error: "missing front matter" };

  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) return { error: `bad front matter line: ${line.slice(0, 40)}` };
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }

  const slugError = validateSlug(meta.slug);
  if (slugError) return { error: `slug: ${slugError}` };
  if (!meta.title) return { error: "missing title" };

  const body = text.slice(match[0].length).trim();
  if (!body) return { error: "empty body" };

  const sortOrder = meta.sortOrder === undefined || meta.sortOrder === "" ? 0 : Number(meta.sortOrder);
  if (!Number.isFinite(sortOrder)) return { error: "sortOrder is not a number" };

  return {
    doc: {
      slug: meta.slug.trim(),
      title: meta.title,
      section: meta.section || "",
      excerpt: meta.excerpt || "",
      summary: meta.summary || "",
      sortOrder,
      body,
    },
  };
}

/**
 * Insert every shipped docs page whose slug is not in the table yet.
 *
 * @param {object} db adapter
 * @param {{ dir?: string }} [options]
 * @returns {{ inserted: string[], skipped: Array<{ file: string, reason: string }> }}
 */
export function seedDocsSync(db, { dir = defaultDocsDir() } = {}) {
  const result = { inserted: [], skipped: [] };
  if (!db) return result;

  let files;
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
  } catch {
    // No content directory (a build that did not ship it): nothing to seed.
    return result;
  }

  const pages = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(dir, file), "utf8");
    } catch (error) {
      result.skipped.push({ file, reason: `unreadable: ${error?.code || "error"}` });
      continue;
    }
    const parsed = parseDocFile(text);
    if (parsed.error) result.skipped.push({ file, reason: parsed.error });
    else pages.push({ file, doc: parsed.doc });
  }
  if (pages.length === 0) return result;

  const now = new Date().toISOString();
  db.transaction(() => {
    const seen = new Set(db.all(`SELECT slug FROM docsPages`).map((row) => row.slug));
    for (const { file, doc } of pages) {
      if (seen.has(doc.slug)) continue;
      seen.add(doc.slug);
      db.run(
        `INSERT INTO docsPages(id, slug, title, summary, excerpt, section, body, isPublished, sortOrder, createdAt, updatedAt)
         VALUES(?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        [uuidv4(), doc.slug, doc.title, doc.summary, doc.excerpt, doc.section, doc.body, doc.sortOrder, now, now]
      );
      result.inserted.push(doc.slug);
    }
  });
  return result;
}
