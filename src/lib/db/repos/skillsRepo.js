// Skills the operator publishes for customers to download and install into their
// own agent runtime (Claude Code, Codex, Cursor, …).
//
// Why a table: this is operator content — a markdown body the admin types or
// pastes, published and retired over time without a deploy.
//
// The body is the artifact. Everything else exists to help a customer find it and
// to tell them where to put it.
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

export const SKILL_TARGETS = ["claude", "codex", "cursor", "generic"];
export const SKILL_AUDIENCES = ["customer", "internal"];

// A slug becomes a directory name and a URL path segment, so it is restricted to
// the shape every runtime accepts: lower-case, digits, single dashes.
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// A file name lands in a Content-Disposition header and, through the install
// script, inside the skill's directory: ASCII only, no separators, a .md file.
const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,98}\.md$/;
const MAX_SLUG = 64;
const MAX_NAME = 120;
const MAX_SUMMARY = 200;
const MAX_DESCRIPTION = 2000;
const MAX_USAGE_NOTES = 4000;
const MAX_VERSION = 40;
const MAX_CATEGORY = 80;
const MAX_INSTALL_PATH = 300;
const MAX_BODY_BYTES = 512 * 1024; // 512 KB of UTF-8: plenty for a skill, small enough to inline.

/**
 * The slug a payload asks for. A slug the admin typed is used exactly as typed
 * and then validated — "../etc/passwd" or "UPPER" is refused, never quietly
 * rewritten into a different slug. Only a missing slug is derived from the name.
 */
function requestedSlug(input = {}) {
  const typed = String(input.slug ?? "").trim();
  return typed || slugifySkill(input.name);
}

/** 1/0 for a boolean-ish value, `fallback` when absent, null when unrecognisable. */
function parseFlag(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === 1 || value === "1" || value === "true") return 1;
  if (value === false || value === 0 || value === "0" || value === "false") return 0;
  return null;
}

/** Lower-case, dash-separated form of arbitrary text; used to suggest a slug. */
export function slugifySkill(input) {
  return String(input ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining marks: "Kỹ năng" → "Ky nang"
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/, ""); // the cut may land just after a dash
}

/**
 * Vietnamese validation message for a slug, or null when acceptable.
 * Checked before every write: the slug is a directory name on the customer's
 * machine, so ".." or a slash would escape it.
 */
export function slugError(slug) {
  const value = String(slug ?? "").trim();
  if (!value) return "Slug không được để trống";
  if (value.length > MAX_SLUG) return `Slug tối đa ${MAX_SLUG} ký tự`;
  if (!SLUG_RE.test(value)) return "Slug chỉ gồm chữ thường không dấu, số và dấu gạch ngang";
  return null;
}

/**
 * Normalise a skill payload into the stored shape. Never truncates: every limit
 * is enforced by skillInputError(), so a value that does not fit is refused
 * rather than silently cut.
 */
function normalize(input = {}) {
  const fileName = String(input.fileName ?? "").trim() || "SKILL.md";
  return {
    slug: requestedSlug(input),
    name: String(input.name ?? "").trim().slice(0, MAX_NAME),
    summary: String(input.summary ?? "").trim().slice(0, MAX_SUMMARY),
    description: String(input.description ?? "").trim().slice(0, MAX_DESCRIPTION),
    category: String(input.category ?? "").trim(),
    body: String(input.body ?? ""),
    fileName,
    target: String(input.target ?? "").trim() || "generic",
    installPath: String(input.installPath ?? "").trim(),
    audience: String(input.audience ?? "").trim() || "customer",
    isPublished: parseFlag(input.isPublished, 1),
    usageNotes: String(input.usageNotes ?? "").trim(),
    version: String(input.version ?? "").trim(),
    sortOrder: Number.isFinite(Number(input.sortOrder)) ? Math.trunc(Number(input.sortOrder)) : 0,
  };
}

/**
 * Vietnamese error for a full skill payload, or null when it may be written.
 * Runs before normalize() so the message names what the admin typed.
 */
export function skillInputError(input = {}) {
  const name = String(input.name ?? "").trim();
  if (!name) return "Tên skill không được để trống";
  if (name.length > MAX_NAME) return `Tên skill tối đa ${MAX_NAME} ký tự`;

  const slugProblem = slugError(requestedSlug(input));
  if (slugProblem) return slugProblem;

  const body = String(input.body ?? "");
  if (!body.trim()) return "Nội dung skill không được để trống";
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    return `Nội dung skill tối đa ${Math.round(MAX_BODY_BYTES / 1024)} KB`;
  }

  const fileName = String(input.fileName ?? "").trim();
  if (fileName && !FILE_NAME_RE.test(fileName)) {
    return "Tên file chỉ gồm chữ không dấu, số, dấu chấm, gạch ngang, gạch dưới và phải kết thúc bằng .md";
  }

  const target = String(input.target ?? "").trim();
  if (target && !SKILL_TARGETS.includes(target)) return "Runtime không hợp lệ";
  const audience = String(input.audience ?? "").trim();
  if (audience && !SKILL_AUDIENCES.includes(audience)) return "Đối tượng không hợp lệ";
  if (parseFlag(input.isPublished, 1) === null) return "Trạng thái phát hành không hợp lệ";

  const summary = String(input.summary ?? "").trim();
  if (summary.length > MAX_SUMMARY) return `Mô tả ngắn tối đa ${MAX_SUMMARY} ký tự`;

  const description = String(input.description ?? "").trim();
  if (description.length > MAX_DESCRIPTION) return `Mô tả tối đa ${MAX_DESCRIPTION} ký tự`;

  if (String(input.usageNotes ?? "").trim().length > MAX_USAGE_NOTES) {
    return `Ghi chú sử dụng tối đa ${MAX_USAGE_NOTES} ký tự`;
  }
  if (String(input.version ?? "").trim().length > MAX_VERSION) {
    return `Phiên bản tối đa ${MAX_VERSION} ký tự`;
  }
  if (String(input.category ?? "").trim().length > MAX_CATEGORY) {
    return `Nhóm tối đa ${MAX_CATEGORY} ký tự`;
  }
  if (String(input.installPath ?? "").trim().length > MAX_INSTALL_PATH) {
    return `Đường dẫn cài tối đa ${MAX_INSTALL_PATH} ký tự`;
  }

  return null;
}

function rowToSkill(row, { withBody = true } = {}) {
  if (!row) return null;
  const skill = {
    id: row.id,
    slug: row.slug,
    name: row.name,
    summary: row.summary || "",
    description: row.description || "",
    category: row.category || "",
    fileName: row.fileName || "SKILL.md",
    target: row.target || "generic",
    installPath: row.installPath || "",
    audience: row.audience || "customer",
    isPublished: row.isPublished === 1 || row.isPublished === true,
    usageNotes: row.usageNotes || "",
    version: row.version || "",
    downloadCount: row.downloadCount ?? 0,
    sortOrder: row.sortOrder ?? 0,
    createdBy: row.createdBy || null,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
  // The list endpoint omits bodies: a 40-skill page would otherwise ship
  // half a megabyte of markdown the customer has not asked for.
  if (withBody) skill.body = row.body || "";
  return skill;
}

function nowIso() {
  return new Date().toISOString();
}

/** Columns that are not the body — the projection the list endpoints use. */
const LIST_COLUMNS =
  "id, slug, name, summary, description, category, fileName, target, installPath, " +
  "audience, isPublished, usageNotes, version, downloadCount, sortOrder, createdBy, createdAt, updatedAt";

/**
 * Admin list: every row, by sort order then name. `filter` may narrow by
 * audience, published state or category.
 */
export async function listSkills(filter = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (filter.audience) {
    where.push("audience = ?");
    params.push(filter.audience);
  }
  if (filter.category) {
    where.push("category = ?");
    params.push(filter.category);
  }
  if (filter.isPublished !== undefined) {
    where.push("isPublished = ?");
    params.push(filter.isPublished ? 1 : 0);
  }
  const sql = `SELECT ${LIST_COLUMNS} FROM skills${
    where.length ? ` WHERE ${where.join(" AND ")}` : ""
  } ORDER BY sortOrder ASC, name ASC`;
  return db.all(sql, params).map((row) => rowToSkill(row, { withBody: false }));
}

/**
 * Customer list: published, customer-audience rows only. An internal skill is a
 * staging/blind spot the operator never intended to hand out, so it is filtered
 * here rather than in the page — every caller gets the same answer.
 */
export async function listPublishedSkills(filter = {}) {
  const rows = await listSkills({ ...filter, audience: "customer", isPublished: true });
  return rows.map(forCustomer);
}

/** Admin-only fields a customer must not see: who published the skill is an admin identity. */
function forCustomer(skill) {
  const { createdBy, ...visible } = skill;
  return visible;
}

/** Distinct category labels present in the customer-visible set, for the tabs. */
export async function listSkillCategories() {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT category, COUNT(*) AS count
       FROM skills
      WHERE isPublished = 1 AND audience = 'customer' AND category <> ''
      GROUP BY category
      ORDER BY category ASC`
  );
  return rows.map((row) => ({ category: row.category, count: row.count }));
}

export async function getSkillById(id) {
  if (!id) return null;
  const db = await getAdapter();
  return rowToSkill(db.get(`SELECT * FROM skills WHERE id = ?`, [id]));
}

export async function getSkillBySlug(slug, { publishedOnly = false } = {}) {
  if (!slug) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM skills WHERE slug = ?`, [String(slug)]);
  if (!row) return null;
  const skill = rowToSkill(row);
  if (publishedOnly) {
    if (!skill.isPublished || skill.audience !== "customer") return null;
    return forCustomer(skill);
  }
  return skill;
}

export async function createSkill(input, { createdBy = null } = {}) {
  const problem = skillInputError(input);
  if (problem) throw new Error(problem);

  const db = await getAdapter();
  const data = normalize(input);
  const existing = db.get(`SELECT id FROM skills WHERE slug = ?`, [data.slug]);
  if (existing) throw new Error(`Slug "${data.slug}" đã được dùng`);

  const now = nowIso();
  const id = uuidv4();
  db.run(
    `INSERT INTO skills(
       id, slug, name, summary, description, category, body, fileName, target,
       installPath, audience, isPublished, usageNotes, version, downloadCount,
       sortOrder, createdBy, createdAt, updatedAt
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [
      id, data.slug, data.name, data.summary, data.description, data.category,
      data.body, data.fileName, data.target, data.installPath, data.audience,
      data.isPublished, data.usageNotes, data.version, data.sortOrder,
      createdBy, now, now,
    ]
  );
  return { id, slug: data.slug };
}

/**
 * Update a skill. Only fields present in `patch` change, so a rename does not
 * wipe the body. A slug change is allowed but re-validated and de-duplicated.
 */
export async function updateSkill(id, patch = {}) {
  const db = await getAdapter();
  const current = db.get(`SELECT * FROM skills WHERE id = ?`, [id]);
  if (!current) return null;

  const merged = {
    name: patch.name !== undefined ? patch.name : current.name,
    summary: patch.summary !== undefined ? patch.summary : current.summary,
    description: patch.description !== undefined ? patch.description : current.description,
    category: patch.category !== undefined ? patch.category : current.category,
    body: patch.body !== undefined ? patch.body : current.body,
    fileName: patch.fileName !== undefined ? patch.fileName : current.fileName,
    target: patch.target !== undefined ? patch.target : current.target,
    installPath: patch.installPath !== undefined ? patch.installPath : current.installPath,
    audience: patch.audience !== undefined ? patch.audience : current.audience,
    isPublished: patch.isPublished !== undefined ? patch.isPublished : current.isPublished === 1,
    usageNotes: patch.usageNotes !== undefined ? patch.usageNotes : current.usageNotes,
    version: patch.version !== undefined ? patch.version : current.version,
    sortOrder: patch.sortOrder !== undefined ? patch.sortOrder : current.sortOrder,
    // A blank slug on an update means "keep it": renaming a skill renames the
    // directory customers installed it under, so it must be asked for explicitly.
    slug: patch.slug !== undefined && String(patch.slug).trim() ? patch.slug : current.slug,
  };

  const problem = skillInputError(merged);
  if (problem) throw new Error(problem);

  const data = normalize(merged);
  const clash = db.get(`SELECT id FROM skills WHERE slug = ? AND id <> ?`, [data.slug, id]);
  if (clash) throw new Error(`Slug "${data.slug}" đã được dùng`);

  db.run(
    `UPDATE skills SET
       slug = ?, name = ?, summary = ?, description = ?, category = ?, body = ?,
       fileName = ?, target = ?, installPath = ?, audience = ?, isPublished = ?,
       usageNotes = ?, version = ?, sortOrder = ?, updatedAt = ?
     WHERE id = ?`,
    [
      data.slug, data.name, data.summary, data.description, data.category, data.body,
      data.fileName, data.target, data.installPath, data.audience, data.isPublished,
      data.usageNotes, data.version, data.sortOrder, nowIso(), id,
    ]
  );
  return { id, slug: data.slug };
}

export async function deleteSkill(id) {
  const db = await getAdapter();
  const current = db.get(`SELECT id FROM skills WHERE id = ?`, [id]);
  if (!current) return false;
  db.run(`DELETE FROM skills WHERE id = ?`, [id]);
  return true;
}

/**
 * Count a download. Deliberately not awaited by the download route: a failed
 * counter increment must never fail a customer's download, and the count is
 * analytics rather than a rule.
 */
export async function incrementSkillDownload(id) {
  const db = await getAdapter();
  db.run(`UPDATE skills SET downloadCount = COALESCE(downloadCount, 0) + 1 WHERE id = ?`, [id]);
}
