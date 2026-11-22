// Skill bundles: one row per imported repository that ships an engine (an MCP
// server the skill markdown calls tools on), plus the agent presets and command
// that repository's own installer produces.
//
// A bundle groups skills that came from the same repository without changing how
// those skills themselves behave: `skills.bundleId` is an optional link, and a
// skill with none behaves exactly as it always has (skillsRepo.js).
//
// Mirrors skillsRepo.js's conventions on purpose: same normalize()/validation
// shape, same Vietnamese error style, same slug uniqueness check.
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { slugFromName } from "../../skills/frontmatter.js";

export const BUNDLE_AUDIENCES = ["customer", "internal"];

// The hosts repoImport.js knows how to read a repository from.
const SOURCE_HOSTS = ["github.com", "gitlab.com", "codeberg.org"];

// Same shape as a skill's slug: it becomes a directory name
// (`~/.engines/<slug>`) and an MCP server registration key.
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// A repo name goes straight into a host API path and a generated shell script:
// no separators, no dot segments.
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const isSafeSegment = (value) => SAFE_SEGMENT.test(value) && value !== "." && value !== "..";
// An owner is usually one such segment, but GitLab nests groups
// (`group/subgroup/repo`), so repoImport.js's own `parsed.owner` for that host can
// itself contain slashes — each slash-separated part is checked on its own, same
// rule as repoImport.js's `checkedRepo()`.
const isSafeOwner = (value) => String(value ?? "").split("/").filter(Boolean).length > 0
  && String(value ?? "").split("/").every(isSafeSegment);
// A git ref (branch or tag): no spaces, quotes or shell metacharacters.
const SAFE_REF = /^[A-Za-z0-9._/-]+$/;
// The installer entrypoint is a relative path inside the unpacked repository: no
// leading slash, no '..' segment, no empty segment — mirrors the SAFE_PATH
// convention in installScript.js, because this value is later interpolated into
// the generated install script and used to build a filesystem path.
const SAFE_ENTRYPOINT = /^(?!\/)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]+$/;

const MAX_SLUG = 64;
const MAX_NAME = 120;
const MAX_DESCRIPTION = 4000;
const MAX_USAGE_GUIDE = 8000;
const MAX_ENTRYPOINT = 200;

/** The slug a payload asks for; only a missing slug is derived from the name. */
function requestedSlug(input = {}) {
  const typed = String(input.slug ?? "").trim();
  return typed || slugFromName(input.name);
}

/** The installer entrypoint a payload asks for, defaulting to the repository's
 * own conventional file name when none is given (mirrors fileName's default in
 * skillsRepo.js). */
function requestedInstallerEntrypoint(input = {}) {
  const typed = String(input.installerEntrypoint ?? "").trim();
  return typed || "install.mjs";
}

/** 1/0 for a boolean-ish value, `fallback` when absent, null when unrecognisable. */
function parseFlag(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === 1 || value === "1" || value === "true") return 1;
  if (value === false || value === 0 || value === "0" || value === "false") return 0;
  return null;
}

/** Vietnamese validation message for a bundle slug, or null when acceptable. */
export function bundleSlugError(slug) {
  const value = String(slug ?? "").trim();
  if (!value) return "Slug không được để trống";
  if (value.length > MAX_SLUG) return `Slug tối đa ${MAX_SLUG} ký tự`;
  if (!SLUG_RE.test(value)) return "Slug chỉ gồm chữ thường không dấu, số và dấu gạch ngang";
  return null;
}

/**
 * Vietnamese validation message for an installer entrypoint path, or null when
 * acceptable. Refuses anything that could escape the bundle's own unpacked
 * repository: a leading slash, a `..` segment, or an empty one.
 */
export function installerEntrypointError(path) {
  const value = String(path ?? "").trim();
  if (!value) return "Đường dẫn installer không được để trống";
  if (value.length > MAX_ENTRYPOINT) return `Đường dẫn installer tối đa ${MAX_ENTRYPOINT} ký tự`;
  if (!SAFE_ENTRYPOINT.test(value)) {
    return "Đường dẫn installer không hợp lệ (không được bắt đầu bằng / hoặc chứa ..)";
  }
  return null;
}

function normalize(input = {}) {
  return {
    slug: requestedSlug(input),
    name: String(input.name ?? "").trim().slice(0, MAX_NAME),
    description: String(input.description ?? "").trim().slice(0, MAX_DESCRIPTION),
    usageGuide: String(input.usageGuide ?? "").trim().slice(0, MAX_USAGE_GUIDE),
    sourceHost: String(input.sourceHost ?? "").trim(),
    sourceOwner: String(input.sourceOwner ?? "").trim(),
    sourceRepo: String(input.sourceRepo ?? "").trim(),
    sourceRef: String(input.sourceRef ?? "").trim(),
    installerEntrypoint: requestedInstallerEntrypoint(input),
    audience: String(input.audience ?? "").trim() || "customer",
    isPublished: parseFlag(input.isPublished, 1),
    sortOrder: Number.isFinite(Number(input.sortOrder)) ? Math.trunc(Number(input.sortOrder)) : 0,
  };
}

/**
 * Vietnamese error for a full bundle payload, or null when it may be written.
 * Runs before normalize() so the message names what the admin typed.
 */
export function bundleInputError(input = {}) {
  const name = String(input.name ?? "").trim();
  if (!name) return "Tên bundle không được để trống";
  if (name.length > MAX_NAME) return `Tên bundle tối đa ${MAX_NAME} ký tự`;

  const slugProblem = bundleSlugError(requestedSlug(input));
  if (slugProblem) return slugProblem;

  const sourceOwner = String(input.sourceOwner ?? "").trim();
  const sourceRepo = String(input.sourceRepo ?? "").trim();
  if (!sourceOwner || !sourceRepo) return "Thiếu owner/tên repo nguồn";
  if (!isSafeOwner(sourceOwner) || !isSafeSegment(sourceRepo)) {
    return "Owner/tên repo nguồn có ký tự không hợp lệ";
  }

  const sourceHost = String(input.sourceHost ?? "").trim();
  if (!SOURCE_HOSTS.includes(sourceHost)) {
    return `Host repo nguồn không hợp lệ (dùng ${SOURCE_HOSTS.join(", ")})`;
  }

  const sourceRef = String(input.sourceRef ?? "").trim();
  if (!sourceRef) return "Thiếu nhánh/ref repo nguồn";
  if (!SAFE_REF.test(sourceRef)) return "Nhánh/ref repo nguồn có ký tự không hợp lệ";

  const entrypointProblem = installerEntrypointError(requestedInstallerEntrypoint(input));
  if (entrypointProblem) return entrypointProblem;

  const audience = String(input.audience ?? "").trim();
  if (audience && !BUNDLE_AUDIENCES.includes(audience)) return "Đối tượng không hợp lệ";
  if (parseFlag(input.isPublished, 1) === null) return "Trạng thái phát hành không hợp lệ";

  const description = String(input.description ?? "").trim();
  if (description.length > MAX_DESCRIPTION) return `Mô tả tối đa ${MAX_DESCRIPTION} ký tự`;

  const usageGuide = String(input.usageGuide ?? "").trim();
  if (usageGuide.length > MAX_USAGE_GUIDE) return `Hướng dẫn sử dụng tối đa ${MAX_USAGE_GUIDE} ký tự`;

  return null;
}

function rowToBundle(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description || "",
    usageGuide: row.usageGuide || "",
    sourceHost: row.sourceHost || "",
    sourceOwner: row.sourceOwner || "",
    sourceRepo: row.sourceRepo || "",
    sourceRef: row.sourceRef || "",
    installerEntrypoint: row.installerEntrypoint || "install.mjs",
    audience: row.audience || "customer",
    isPublished: row.isPublished === 1 || row.isPublished === true,
    sortOrder: row.sortOrder ?? 0,
    createdBy: row.createdBy || null,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

function nowIso() {
  return new Date().toISOString();
}

/** Admin-only field a customer must not see: who imported the bundle is an admin identity. */
function forCustomer(bundle) {
  const { createdBy, ...visible } = bundle;
  return visible;
}

/** Admin list: every row, by sort order then name. `filter` may narrow by audience or published state. */
export async function listBundles(filter = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (filter.audience) {
    where.push("audience = ?");
    params.push(filter.audience);
  }
  if (filter.isPublished !== undefined) {
    where.push("isPublished = ?");
    params.push(filter.isPublished ? 1 : 0);
  }
  const sql = `SELECT * FROM skillBundles${
    where.length ? ` WHERE ${where.join(" AND ")}` : ""
  } ORDER BY sortOrder ASC, name ASC`;
  return db.all(sql, params).map(rowToBundle);
}

/** Customer list: published, customer-audience rows only. */
export async function listPublishedBundles() {
  const rows = await listBundles({ audience: "customer", isPublished: true });
  return rows.map(forCustomer);
}

export async function getBundleById(id) {
  if (!id) return null;
  const db = await getAdapter();
  return rowToBundle(db.get(`SELECT * FROM skillBundles WHERE id = ?`, [id]));
}

export async function getBundleBySlug(slug, { publishedOnly = false } = {}) {
  if (!slug) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM skillBundles WHERE slug = ?`, [String(slug)]);
  if (!row) return null;
  const bundle = rowToBundle(row);
  if (publishedOnly) {
    if (!bundle.isPublished || bundle.audience !== "customer") return null;
    return forCustomer(bundle);
  }
  return bundle;
}

export async function createBundle(input, { createdBy = null } = {}) {
  const problem = bundleInputError(input);
  if (problem) throw new Error(problem);

  const db = await getAdapter();
  const data = normalize(input);
  const existing = db.get(`SELECT id FROM skillBundles WHERE slug = ?`, [data.slug]);
  if (existing) throw new Error(`Slug "${data.slug}" đã được dùng`);

  const now = nowIso();
  const id = uuidv4();
  db.run(
    `INSERT INTO skillBundles(
       id, slug, name, description, usageGuide, sourceHost, sourceOwner, sourceRepo,
       sourceRef, installerEntrypoint, audience, isPublished, sortOrder, createdBy,
       createdAt, updatedAt
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, data.slug, data.name, data.description, data.usageGuide, data.sourceHost,
      data.sourceOwner, data.sourceRepo, data.sourceRef, data.installerEntrypoint,
      data.audience, data.isPublished, data.sortOrder, createdBy, now, now,
    ]
  );
  return { id, slug: data.slug };
}

/**
 * Update a bundle. Only fields present in `patch` change, so renaming the bundle
 * does not wipe its description. A slug change is allowed but re-validated and
 * de-duplicated, same as a skill's.
 */
export async function updateBundle(id, patch = {}) {
  const db = await getAdapter();
  const current = db.get(`SELECT * FROM skillBundles WHERE id = ?`, [id]);
  if (!current) return null;

  for (const key of ["isPublished", "audience"]) {
    if (patch[key] === null || patch[key] === "") {
      throw new Error(key === "audience" ? "Đối tượng không hợp lệ" : "Trạng thái phát hành không hợp lệ");
    }
  }

  const merged = {
    name: patch.name !== undefined ? patch.name : current.name,
    description: patch.description !== undefined ? patch.description : current.description,
    usageGuide: patch.usageGuide !== undefined ? patch.usageGuide : current.usageGuide,
    sourceHost: patch.sourceHost !== undefined ? patch.sourceHost : current.sourceHost,
    sourceOwner: patch.sourceOwner !== undefined ? patch.sourceOwner : current.sourceOwner,
    sourceRepo: patch.sourceRepo !== undefined ? patch.sourceRepo : current.sourceRepo,
    sourceRef: patch.sourceRef !== undefined ? patch.sourceRef : current.sourceRef,
    installerEntrypoint: patch.installerEntrypoint !== undefined ? patch.installerEntrypoint : current.installerEntrypoint,
    audience: patch.audience !== undefined ? patch.audience : current.audience,
    isPublished: patch.isPublished !== undefined ? patch.isPublished : current.isPublished === 1,
    sortOrder: patch.sortOrder !== undefined ? patch.sortOrder : current.sortOrder,
    slug: patch.slug !== undefined && String(patch.slug).trim() ? patch.slug : current.slug,
  };

  const problem = bundleInputError(merged);
  if (problem) throw new Error(problem);

  const data = normalize(merged);
  const clash = db.get(`SELECT id FROM skillBundles WHERE slug = ? AND id <> ?`, [data.slug, id]);
  if (clash) throw new Error(`Slug "${data.slug}" đã được dùng`);

  db.run(
    `UPDATE skillBundles SET
       slug = ?, name = ?, description = ?, usageGuide = ?, sourceHost = ?,
       sourceOwner = ?, sourceRepo = ?, sourceRef = ?, installerEntrypoint = ?,
       audience = ?, isPublished = ?, sortOrder = ?, updatedAt = ?
     WHERE id = ?`,
    [
      data.slug, data.name, data.description, data.usageGuide, data.sourceHost,
      data.sourceOwner, data.sourceRepo, data.sourceRef, data.installerEntrypoint,
      data.audience, data.isPublished, data.sortOrder, nowIso(), id,
    ]
  );
  return { id, slug: data.slug };
}

/**
 * Delete a bundle. Detach, not cascade: every skill that pointed at it keeps
 * existing, now with no bundle — its own publish state, audience and category are
 * not this operation's to change. Done inside one transaction so a crash between
 * the two writes can never leave a skill pointing at a bundle that no longer
 * exists.
 */
export async function deleteBundle(id) {
  const db = await getAdapter();
  let removed = false;
  db.transaction(() => {
    const current = db.get(`SELECT id FROM skillBundles WHERE id = ?`, [id]);
    if (!current) return;
    db.run(`UPDATE skills SET bundleId = NULL WHERE bundleId = ?`, [id]);
    db.run(`DELETE FROM skillBundles WHERE id = ?`, [id]);
    removed = true;
  });
  return removed;
}
