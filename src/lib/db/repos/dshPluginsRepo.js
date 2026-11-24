// DSH plugins the operator publishes to customers.
//
// A DSH plugin is not a skill. A skill is markdown an agent reads; a plugin is an npm
// package the harness loads — it registers tools, patches behaviour, adds panels. So
// installing one is not "write a file": it is "add this package to your profile and
// let your package manager resolve it".
//
// That difference is why this lives in its own table and its own page rather than
// being another kind of `skillBundles` row. The two share conventions — same slug
// shape, same Vietnamese error style, same audience/published flags — because an
// admin moving between the two pages should not have to learn a second dialect.
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { slugFromName } from "../../skills/frontmatter.js";

export const PLUGIN_AUDIENCES = ["customer", "internal"];

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// A package name becomes a shell argument and a pnpm argument: npm's own charset for
// a (possibly scoped) package, plus the spec forms pnpm accepts for a git or tarball
// source. Anything with whitespace, quotes or a shell metacharacter is refused.
const PACKAGE_RE = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:@[A-Za-z0-9^~<>=*.-]+)?$/;
const SPEC_RE = /^(?:git\+|https?:\/\/|file:)[^\s"'`;|&$<>]+$/;
// A URL shown to a customer and rendered as a link: http(s) only, no javascript:.
const URL_RE = /^https?:\/\/[^\s"'`<>]+$/;

const MAX_SLUG = 64;
const MAX_NAME = 120;
const MAX_DESCRIPTION = 4000;
const MAX_USAGE_GUIDE = 8000;
const MAX_PACKAGE = 200;
const MAX_VERSION = 40;
const MAX_DSH_TARGET = 40;

/** The slug a payload asks for; only a missing slug is derived from the name. */
function requestedSlug(input = {}) {
  const typed = String(input.slug ?? "").trim();
  return typed || slugFromName(input.name);
}

/** 1/0 for a boolean-ish value, `fallback` when absent, null when unrecognisable. */
function parseFlag(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === 1 || value === "1" || value === "true") return 1;
  if (value === false || value === 0 || value === "0" || value === "false") return 0;
  return null;
}

/** Vietnamese message for a bad slug, or null. */
export function pluginSlugError(slug) {
  const value = String(slug ?? "").trim();
  if (!value) return "Slug không được để trống";
  if (value.length > MAX_SLUG) return `Slug tối đa ${MAX_SLUG} ký tự`;
  if (!SLUG_RE.test(value)) return "Slug chỉ gồm chữ thường không dấu, số và dấu gạch ngang";
  return null;
}

/**
 * Vietnamese message for a package spec, or null.
 *
 * A registry name and a git/tarball spec are both legitimate: plenty of DSH plugins
 * are installed straight from a repository and never published to npm.
 */
export function packageError(value) {
  const spec = String(value ?? "").trim();
  if (!spec) return "Tên package không được để trống";
  if (spec.length > MAX_PACKAGE) return `Tên package tối đa ${MAX_PACKAGE} ký tự`;
  if (PACKAGE_RE.test(spec) || SPEC_RE.test(spec)) return null;
  return "Tên package không hợp lệ (chỉ chữ, số, dấu chấm, gạch ngang, @ và /)";
}

/** Vietnamese error for a whole payload, or null. */
export function pluginInputError(input = {}) {
  const name = String(input.name ?? "").trim();
  if (!name) return "Tên plugin không được để trống";
  if (name.length > MAX_NAME) return `Tên plugin tối đa ${MAX_NAME} ký tự`;

  const slugProblem = pluginSlugError(requestedSlug(input));
  if (slugProblem) return slugProblem;

  const packageProblem = packageError(input.packageName);
  if (packageProblem) return packageProblem;

  const description = String(input.description ?? "").trim();
  if (description.length > MAX_DESCRIPTION) return `Mô tả tối đa ${MAX_DESCRIPTION} ký tự`;

  const usageGuide = String(input.usageGuide ?? "").trim();
  if (usageGuide.length > MAX_USAGE_GUIDE) return `Hướng dẫn sử dụng tối đa ${MAX_USAGE_GUIDE} ký tự`;

  const version = String(input.version ?? "").trim();
  if (version.length > MAX_VERSION) return `Phiên bản tối đa ${MAX_VERSION} ký tự`;

  const dshTarget = String(input.dshTarget ?? "").trim();
  if (dshTarget.length > MAX_DSH_TARGET) return `DSH target tối đa ${MAX_DSH_TARGET} ký tự`;

  for (const [key, label] of [["repoUrl", "Link repo"], ["docsUrl", "Link tài liệu"]]) {
    const value = String(input[key] ?? "").trim();
    if (value && !URL_RE.test(value)) return `${label} phải là http(s) URL`;
  }

  const audience = String(input.audience ?? "").trim();
  if (audience && !PLUGIN_AUDIENCES.includes(audience)) return "Đối tượng không hợp lệ";
  if (parseFlag(input.isPublished, 1) === null) return "Trạng thái phát hành không hợp lệ";

  return null;
}

function normalize(input = {}) {
  return {
    slug: requestedSlug(input),
    name: String(input.name ?? "").trim().slice(0, MAX_NAME),
    description: String(input.description ?? "").trim(),
    usageGuide: String(input.usageGuide ?? "").trim(),
    packageName: String(input.packageName ?? "").trim(),
    version: String(input.version ?? "").trim(),
    dshTarget: String(input.dshTarget ?? "").trim(),
    repoUrl: String(input.repoUrl ?? "").trim(),
    docsUrl: String(input.docsUrl ?? "").trim(),
    audience: String(input.audience ?? "").trim() || "customer",
    isPublished: parseFlag(input.isPublished, 1),
    sortOrder: Number.isFinite(Number(input.sortOrder)) ? Math.trunc(Number(input.sortOrder)) : 0,
  };
}

function rowToPlugin(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description || "",
    usageGuide: row.usageGuide || "",
    packageName: row.packageName || "",
    version: row.version || "",
    dshTarget: row.dshTarget || "",
    repoUrl: row.repoUrl || "",
    docsUrl: row.docsUrl || "",
    audience: row.audience || "customer",
    isPublished: row.isPublished === 1 || row.isPublished === true,
    sortOrder: row.sortOrder ?? 0,
    installCount: row.installCount ?? 0,
    createdBy: row.createdBy || null,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

function nowIso() {
  return new Date().toISOString();
}

/** Admin-only field: who published the plugin is an admin identity. */
function forCustomer(plugin) {
  const { createdBy, ...visible } = plugin;
  return visible;
}

export async function listPlugins(filter = {}) {
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
  const sql = `SELECT * FROM dshPlugins${
    where.length ? ` WHERE ${where.join(" AND ")}` : ""
  } ORDER BY sortOrder ASC, name ASC`;
  return db.all(sql, params).map(rowToPlugin);
}

/** Customer list: published, customer-audience rows only. */
export async function listPublishedPlugins() {
  const rows = await listPlugins({ audience: "customer", isPublished: true });
  return rows.map(forCustomer);
}

export async function getPluginById(id) {
  if (!id) return null;
  const db = await getAdapter();
  return rowToPlugin(db.get(`SELECT * FROM dshPlugins WHERE id = ?`, [id]));
}

export async function getPluginBySlug(slug, { publishedOnly = false } = {}) {
  if (!slug) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM dshPlugins WHERE slug = ?`, [String(slug)]);
  if (!row) return null;
  const plugin = rowToPlugin(row);
  if (publishedOnly) {
    if (!plugin.isPublished || plugin.audience !== "customer") return null;
    return forCustomer(plugin);
  }
  return plugin;
}

export async function createPlugin(input, { createdBy = null } = {}) {
  const problem = pluginInputError(input);
  if (problem) throw new Error(problem);

  const db = await getAdapter();
  const data = normalize(input);
  if (db.get(`SELECT id FROM dshPlugins WHERE slug = ?`, [data.slug])) {
    throw new Error(`Slug "${data.slug}" đã được dùng`);
  }

  const now = nowIso();
  const id = uuidv4();
  db.run(
    `INSERT INTO dshPlugins(
       id, slug, name, description, usageGuide, packageName, version, dshTarget,
       repoUrl, docsUrl, audience, isPublished, sortOrder, installCount,
       createdBy, createdAt, updatedAt
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    [
      id, data.slug, data.name, data.description, data.usageGuide, data.packageName,
      data.version, data.dshTarget, data.repoUrl, data.docsUrl, data.audience,
      data.isPublished, data.sortOrder, createdBy, now, now,
    ],
  );
  return { id, slug: data.slug };
}

/** Update: only the fields present in `patch` change. */
export async function updatePlugin(id, patch = {}) {
  const db = await getAdapter();
  const current = db.get(`SELECT * FROM dshPlugins WHERE id = ?`, [id]);
  if (!current) return null;

  const merged = {
    name: patch.name !== undefined ? patch.name : current.name,
    slug: patch.slug !== undefined && String(patch.slug).trim() ? patch.slug : current.slug,
    description: patch.description !== undefined ? patch.description : current.description,
    usageGuide: patch.usageGuide !== undefined ? patch.usageGuide : current.usageGuide,
    packageName: patch.packageName !== undefined ? patch.packageName : current.packageName,
    version: patch.version !== undefined ? patch.version : current.version,
    dshTarget: patch.dshTarget !== undefined ? patch.dshTarget : current.dshTarget,
    repoUrl: patch.repoUrl !== undefined ? patch.repoUrl : current.repoUrl,
    docsUrl: patch.docsUrl !== undefined ? patch.docsUrl : current.docsUrl,
    audience: patch.audience !== undefined ? patch.audience : current.audience,
    isPublished: patch.isPublished !== undefined ? patch.isPublished : current.isPublished === 1,
    sortOrder: patch.sortOrder !== undefined ? patch.sortOrder : current.sortOrder,
  };

  const problem = pluginInputError(merged);
  if (problem) throw new Error(problem);

  const data = normalize(merged);
  const clash = db.get(`SELECT id FROM dshPlugins WHERE slug = ? AND id <> ?`, [data.slug, id]);
  if (clash) throw new Error(`Slug "${data.slug}" đã được dùng`);

  db.run(
    `UPDATE dshPlugins SET
       slug = ?, name = ?, description = ?, usageGuide = ?, packageName = ?,
       version = ?, dshTarget = ?, repoUrl = ?, docsUrl = ?, audience = ?,
       isPublished = ?, sortOrder = ?, updatedAt = ?
     WHERE id = ?`,
    [
      data.slug, data.name, data.description, data.usageGuide, data.packageName,
      data.version, data.dshTarget, data.repoUrl, data.docsUrl, data.audience,
      data.isPublished, data.sortOrder, nowIso(), id,
    ],
  );
  return { id, slug: data.slug };
}

export async function deletePlugin(id) {
  const db = await getAdapter();
  if (!db.get(`SELECT id FROM dshPlugins WHERE id = ?`, [id])) return false;
  db.run(`DELETE FROM dshPlugins WHERE id = ?`, [id]);
  return true;
}

/** Count an install click. Best-effort: analytics, never a rule. */
export async function incrementPluginInstall(id) {
  const db = await getAdapter();
  db.run(`UPDATE dshPlugins SET installCount = COALESCE(installCount, 0) + 1 WHERE id = ?`, [id]);
}
