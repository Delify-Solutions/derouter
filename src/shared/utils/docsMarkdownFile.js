// Docs pages as standalone .md files: parse an uploaded file into page fields
// and serialise a page back to a file, so export → import round-trips.
//
// File shape (front matter optional):
//
//   ---
//   title: "Bắt đầu"
//   slug: "bat-dau"
//   section: "Hướng dẫn"
//   excerpt: ""
//   summary: ""
//   sortOrder: 10
//   published: true
//   ---
//
//   ...markdown body...
//
// Front matter is deliberately NOT YAML: one `key: value` per line, the value
// optionally wrapped in double quotes (JSON-style escapes) or single quotes
// ('' for a literal quote). That is enough for the seven page fields and keeps
// the parser dependency-free and small enough to run in the browser.
//
// Pure module with relative imports only: the admin editor imports it client-side
// and the tests import it under plain Node.
import { validateSlug, RESERVED_SLUGS } from "../../lib/content/docsSlug.js";

/** Largest file the admin editor accepts (bytes). */
export const MAX_DOC_FILE_BYTES = 1024 * 1024;

/** Front matter keys, in export order. `published` maps to `isPublished`. */
export const FRONT_MATTER_KEYS = ["title", "slug", "section", "excerpt", "summary", "sortOrder", "published"];

// Lower-cased spellings accepted on import → canonical page field.
const KEY_ALIASES = {
  title: "title",
  slug: "slug",
  section: "section",
  excerpt: "excerpt",
  summary: "summary",
  sortorder: "sortOrder",
  sort_order: "sortOrder",
  published: "isPublished",
  ispublished: "isPublished",
};

const MAX_SLUG_LENGTH = 64;

/**
 * Turn a filename (or any text) into a docs slug: lower case, ASCII, hyphens.
 * Vietnamese diacritics are stripped ("Hướng dẫn" → "huong-dan"; đ → d).
 * Returns "" when nothing usable is left. A reserved slug gets a "-doc" suffix
 * so the result always passes validateSlug when it is non-empty.
 */
export function slugifyDocName(name) {
  let base = String(name ?? "").trim();
  base = base.replace(/\.(md|markdown|txt)$/i, "");
  let slug = base
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length > MAX_SLUG_LENGTH) slug = slug.slice(0, MAX_SLUG_LENGTH).replace(/-+$/, "");
  if (!slug) return "";
  if (RESERVED_SLUGS.has(slug)) slug = `${slug}-doc`;
  return validateSlug(slug) ? "" : slug;
}

function unquote(raw) {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      // Not valid JSON escapes: keep the text between the quotes as written.
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/**
 * Split optional front matter from the body. The block must start on the first
 * line with `---`, end with the next `---` line, and hold nothing but `key: value`
 * lines (blank lines and `#` comments allowed, at least one entry). Anything else
 * — no closing line, or prose between two horizontal rules — is body, so a
 * document that merely begins with a horizontal rule is never swallowed.
 *
 * @returns {{ hasFrontMatter: boolean, entries: Array<[string, string]>, body: string }}
 */
export function splitFrontMatter(text) {
  const normalized = String(text ?? "").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trimEnd() !== "---") {
    return { hasFrontMatter: false, entries: [], body: normalized };
  }
  const end = lines.findIndex((line, i) => i > 0 && line.trimEnd() === "---");
  if (end === -1) return { hasFrontMatter: false, entries: [], body: normalized };

  const entries = [];
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    // A line that is not `key: value` means this was never front matter.
    if (!/^\s*[A-Za-z][\w-]*\s*:/.test(line)) return { hasFrontMatter: false, entries: [], body: normalized };
    const colon = line.indexOf(":");
    entries.push([line.slice(0, colon).trim(), unquote(line.slice(colon + 1))]);
  }
  if (entries.length === 0) return { hasFrontMatter: false, entries: [], body: normalized };
  return { hasFrontMatter: true, entries, body: lines.slice(end + 1).join("\n") };
}

// First `# Heading` outside a fenced code block, so a shell comment such as
// "# install" inside ``` is never mistaken for the page title.
function takeFirstH1(body) {
  const lines = body.split("\n");
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const h1 = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (h1) {
      const rest = [...lines.slice(0, i), ...lines.slice(i + 1)];
      // Drop the blank line the heading left behind at its position.
      if (rest[i] !== undefined && !rest[i].trim() && (i === 0 || !rest[i - 1]?.trim())) rest.splice(i, 1);
      return { title: h1[1].trim(), body: rest.join("\n") };
    }
  }
  return { title: "", body };
}

function trimBody(body) {
  return body.replace(/^\s*\n/, "").replace(/\s+$/, "");
}

/**
 * Parse an uploaded .md file into page fields.
 *
 * `fields` holds only what the file supplied (or what was derived from it), so a
 * caller can fill empty fields of an existing draft without overwriting the rest.
 *
 * @param {string} text file contents
 * @param {{ filename?: string, extractTitle?: boolean }} [options]
 *   extractTitle (default true): without a front matter title, take the first
 *   `# ` heading as the title and remove it from the body.
 * @returns {{ fields: object, body: string, hasFrontMatter: boolean, warnings: string[] }}
 */
export function parseDocMarkdownFile(text, { filename = "", extractTitle = true } = {}) {
  const { hasFrontMatter, entries, body: rawBody } = splitFrontMatter(text);
  const fields = {};
  const warnings = [];
  let invalidSlug = null;

  for (const [key, value] of entries) {
    const field = KEY_ALIASES[key.toLowerCase()];
    if (!field) continue;
    if (field === "sortOrder") {
      // Safe integers only: a 400-digit value would become Infinity and be stored as 0.
      if (/^-?\d+$/.test(String(value).trim()) && Number.isSafeInteger(Number(value))) fields.sortOrder = Number(value);
      else warnings.push(`sortOrder "${value}" không phải số nguyên — bỏ qua.`);
    } else if (field === "isPublished") {
      const v = String(value).trim().toLowerCase();
      if (v === "true") fields.isPublished = true;
      else if (v === "false") fields.isPublished = false;
      else warnings.push(`published "${value}" không phải true/false — bỏ qua.`);
    } else if (field === "slug") {
      const slug = String(value).trim();
      if (slug && !validateSlug(slug)) fields.slug = slug;
      else if (slug) invalidSlug = slug;
    } else {
      fields[field] = String(value);
    }
  }

  let body = rawBody;
  if (!fields.title && extractTitle) {
    const found = takeFirstH1(body);
    if (found.title) {
      fields.title = found.title;
      body = found.body;
    }
  }

  if (!fields.slug) {
    const derived = slugifyDocName(invalidSlug || filename) || slugifyDocName(fields.title);
    if (invalidSlug) {
      warnings.push(
        derived
          ? `slug "${invalidSlug}" không hợp lệ — dùng "${derived}".`
          : `slug "${invalidSlug}" không hợp lệ — hãy nhập đường dẫn.`
      );
    }
    if (derived) fields.slug = derived;
  }

  return { fields, body: trimBody(body), hasFrontMatter, warnings };
}

function quote(value) {
  return JSON.stringify(String(value ?? ""));
}

/**
 * Serialise a page to the .md file format parsed above. String values are always
 * double-quoted (JSON escapes), so colons, quotes, '#' and line breaks survive.
 */
export function serializeDocMarkdownFile(doc = {}) {
  const sortOrder = Number.isFinite(Number(doc.sortOrder)) ? Math.trunc(Number(doc.sortOrder)) : 0;
  const lines = [
    "---",
    `title: ${quote(doc.title)}`,
    `slug: ${quote(doc.slug)}`,
    `section: ${quote(doc.section)}`,
    `excerpt: ${quote(doc.excerpt)}`,
    `summary: ${quote(doc.summary)}`,
    `sortOrder: ${sortOrder}`,
    `published: ${doc.isPublished ? "true" : "false"}`,
    "---",
  ];
  const head = lines.join("\n");
  const body = trimBody(String(doc.body ?? "").replace(/\r\n?/g, "\n"));
  // One blank line between the front matter and the body.
  return body ? `${head}\n\n${body}\n` : `${head}\n`;
}

/** Download name for a page: `<slug>.md`. */
export function docFileName(slug) {
  const value = String(slug ?? "").trim();
  return `${validateSlug(value) ? slugifyDocName(value) || "tai-lieu" : value}.md`;
}
