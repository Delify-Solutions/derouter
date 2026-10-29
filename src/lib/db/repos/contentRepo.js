// Operator-authored site content: landing copy, announcement banner, docs pages.
//
// Why a table instead of more keys in `settings`: docs pages are rows (a slug, a
// title, an ordering) and settings is one JSON blob. Putting a growing set of
// documents inside that blob would make every settings write rewrite all of
// them, and there is no way to query one page out of it.
//
// Landing copy stays in settings (see landingCopy below) because it is a single
// fixed-shape object, not a collection.
import { getAdapter } from "../driver.js";
import { v4 as uuidv4 } from "uuid";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Slugs that would shadow a real route or an existing static asset. */
const RESERVED_SLUGS = new Set([
  "api", "dashboard", "account", "login", "register", "verify-email", "admin",
  "usage", "landing", "docs", "callback", "v1", "v1beta", "responses", "codex",
]);

export function validateSlug(slug) {
  const value = typeof slug === "string" ? slug.trim() : "";
  if (!value) return "Đường dẫn không được để trống";
  if (!SLUG_RE.test(value)) {
    return "Đường dẫn chỉ dùng chữ thường, số và dấu gạch ngang (tối đa 64 ký tự)";
  }
  if (RESERVED_SLUGS.has(value)) return `"${value}" trùng với một đường dẫn hệ thống`;
  return null;
}

function rowToDoc(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    title: row.title || "",
    summary: row.summary || "",
    excerpt: row.excerpt || "",
    section: row.section || "",
    body: row.body || "",
    isPublished: row.isPublished === 1 || row.isPublished === true,
    sortOrder: row.sortOrder ?? 0,
    updatedAt: row.updatedAt ?? null,
    createdAt: row.createdAt ?? null,
  };
}

/** Published docs for the public index. Body omitted — the index only needs titles. */
export async function listPublishedDocs() {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT id, slug, title, summary, excerpt, section, isPublished, sortOrder, updatedAt, createdAt
       FROM docsPages
      WHERE isPublished = 1
      ORDER BY sortOrder ASC, title ASC`
  );
  return rows.map(rowToDoc);
}

/**
 * Published pages grouped by section, ordered for the sidebar.
 *
 * The section list is derived from the rows, not from a fixed enum: an admin who
 * types a new section name gets a new group, which is what keeps the docs
 * navigation editable without a schema change.
 */
export async function listDocsBySection() {
  const docs = await listPublishedDocs();
  const groups = new Map();
  for (const doc of docs) {
    const key = doc.section || "Khác";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(doc);
  }
  return [...groups.entries()].map(([section, pages]) => ({ section, pages }));
}

/** Every page, including drafts, for the admin list. */
export async function listAllDocs() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM docsPages ORDER BY sortOrder ASC, title ASC`);
  return rows.map(rowToDoc);
}

/**
 * One page by slug. `includeDrafts` is the admin path: a customer must never
 * see an unpublished page, so the public caller leaves it false and a draft
 * resolves to null — the same shape as a page that does not exist.
 */
export async function getDocBySlug(slug, { includeDrafts = false } = {}) {
  const db = await getAdapter();
  const row = includeDrafts
    ? db.get(`SELECT * FROM docsPages WHERE slug = ?`, [slug])
    : db.get(`SELECT * FROM docsPages WHERE slug = ? AND isPublished = 1`, [slug]);
  return rowToDoc(row);
}

export async function getDocById(id) {
  const db = await getAdapter();
  return rowToDoc(db.get(`SELECT * FROM docsPages WHERE id = ?`, [id]));
}

export async function createDoc({ slug, title, summary = "", excerpt = "", section = "", body = "", isPublished = true, sortOrder = 0 } = {}) {
  const invalid = validateSlug(slug);
  if (invalid) throw new Error(invalid);
  if (!title || !String(title).trim()) throw new Error("Tiêu đề không được để trống");

  const db = await getAdapter();
  const exists = db.get(`SELECT id FROM docsPages WHERE slug = ?`, [String(slug).trim()]);
  if (exists) throw new Error(`Đường dẫn "${slug}" đã được dùng`);

  const now = new Date().toISOString();
  const doc = {
    id: uuidv4(),
    slug: String(slug).trim(),
    title: String(title).trim(),
    summary: summary ? String(summary).trim() : "",
    excerpt: excerpt ? String(excerpt).trim() : "",
    section: section ? String(section).trim() : "",
    body: body ?? "",
    isPublished: isPublished !== false,
    sortOrder: Number.isFinite(Number(sortOrder)) ? Number(sortOrder) : 0,
  };
  db.run(
    `INSERT INTO docsPages(id, slug, title, summary, excerpt, section, body, isPublished, sortOrder, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      doc.id, doc.slug, doc.title, doc.summary, doc.excerpt, doc.section,
      doc.body, doc.isPublished ? 1 : 0, doc.sortOrder, now, now,
    ]
  );
  return getDocById(doc.id);
}

export async function updateDoc(id, patch = {}) {
  const db = await getAdapter();
  const current = db.get(`SELECT * FROM docsPages WHERE id = ?`, [id]);
  if (!current) return null;

  // A slug change is allowed but must stay unique: two pages resolving to the
  // same URL would make one of them unreachable with no error anywhere.
  if (patch.slug !== undefined) {
    const invalid = validateSlug(patch.slug);
    if (invalid) throw new Error(invalid);
    const clash = db.get(`SELECT id FROM docsPages WHERE slug = ? AND id <> ?`, [String(patch.slug).trim(), id]);
    if (clash) throw new Error(`Đường dẫn "${patch.slug}" đã được dùng`);
  }
  if (patch.title !== undefined && !String(patch.title).trim()) {
    throw new Error("Tiêu đề không được để trống");
  }

  const merged = {
    slug: patch.slug !== undefined ? String(patch.slug).trim() : current.slug,
    title: patch.title !== undefined ? String(patch.title).trim() : current.title,
    summary: patch.summary !== undefined ? String(patch.summary).trim() : current.summary,
    excerpt: patch.excerpt !== undefined ? String(patch.excerpt).trim() : current.excerpt,
    section: patch.section !== undefined ? String(patch.section).trim() : current.section,
    body: patch.body !== undefined ? patch.body : current.body,
    isPublished: patch.isPublished !== undefined ? (patch.isPublished ? 1 : 0) : current.isPublished,
    sortOrder: patch.sortOrder !== undefined ? Number(patch.sortOrder) || 0 : current.sortOrder,
  };

  db.run(
    `UPDATE docsPages SET slug = ?, title = ?, summary = ?, excerpt = ?, section = ?, body = ?, isPublished = ?, sortOrder = ?, updatedAt = ? WHERE id = ?`,
    [
      merged.slug, merged.title, merged.summary, merged.excerpt, merged.section,
      merged.body, merged.isPublished, merged.sortOrder, new Date().toISOString(), id,
    ]
  );
  return getDocById(id);
}

export async function deleteDoc(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM docsPages WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

// ── Landing copy ──────────────────────────────────────────────────────────

/**
 * Shape of the editable landing copy. Every field is a single string; the
 * sections render them verbatim, so an admin can change the words without
 * touching the layout or the numbers (prices and limits stay derived from
 * plansData / the provider registry, which are facts, not copy).
 */
export const LANDING_COPY_DEFAULTS = {
  // Announcement bar above the hero — same role as the "New … is now available"
  // strip on opencode.ai/go. Empty text hides it even when enabled is true, so an
  // admin who clears the text is never left with an empty coloured bar.
  bannerText: "",
  bannerHref: "",
  bannerEnabled: false,

  // Copy describes ONE shared credit per purchase, per-window limits and the plan
  // queue — never a per-model ceiling (spec public-landing "Default copy and FAQ"),
  // because the system has none: a purchase is a single pool drained in queue order.
  heroTitle: "Một khoản credit dùng chung mọi model lập trình",
  heroPrimaryCta: "Mua gói",
  heroSecondaryCta: "Đọc tài liệu",

  plansEyebrow: "Các gói",
  plansTitle: "Trả một lần, nhận credit dùng chung",
  plansSubtitle:
    "Mỗi gói cấp một khoản credit dùng cho mọi model trong nhóm của bạn, trong thời hạn của gói, có thể kèm hạn mức theo khung giờ. Mua thêm gói thì gói mới xếp vào hàng đợi.",
  plansFootnote:
    "Credit bị trừ theo bảng giá token bên dưới, nên model đắt dùng credit nhanh hơn. Request dài tốn nhiều credit hơn request ngắn.",

  modelsEyebrow: "Danh mục",
  modelsTitle: "Model bạn dùng được ngay",
  modelsSubtitle: "",

  pricingEyebrow: "Bảng giá",
  pricingTitle: "Giá token trừ vào credit của bạn",
  pricingSubtitle: "",

  getStartedEyebrow: "Bắt đầu",
  getStartedTitle: "Bốn bước để chạy request đầu tiên",
  getStartedSubtitle: "",

  faqEyebrow: "Câu hỏi thường gặp",
  faqTitle: "Năm câu hỏi trước khi mua",
  faqSubtitle: "Credit còn lại giữ nguyên khi bạn mua thêm gói; hạn mức theo khung giờ tính lại sau mỗi khung giờ.",
};

/** Merge stored copy over defaults so a new field appears without a migration. */
export function mergeLandingCopy(raw) {
  const out = { ...LANDING_COPY_DEFAULTS };
  if (raw && typeof raw === "object") {
    for (const key of Object.keys(LANDING_COPY_DEFAULTS)) {
      if (typeof raw[key] === "string") out[key] = raw[key];
      else if (key === "bannerEnabled" && typeof raw[key] === "boolean") out[key] = raw[key];
    }
  }
  return out;
}
