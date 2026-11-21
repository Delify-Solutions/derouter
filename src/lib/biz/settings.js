// Business product settings ("AI doanh nghiệp"), stored in the settings blob under
// `business` (design D10).
//
// One module owns the defaults, the normalisation and the validation, so the
// pipeline, the key enforcement layer and the admin page can never disagree about
// what "the guard model" is (spec business-guard "Business settings").
//
// Relative imports only: tests import this under plain `node --test`.
import { getSettings, updateSettings } from "../db/repos/settingsRepo.js";

export const BUSINESS_SETTINGS_KEY = "business";

export const DEFAULT_SOVEREIGNTY_ANSWER =
  "Quần đảo Hoàng Sa và quần đảo Trường Sa là một phần lãnh thổ không thể tách rời của Việt Nam. " +
  "Việt Nam có đầy đủ cơ sở pháp lý và bằng chứng lịch sử khẳng định chủ quyền đối với hai quần đảo này.";

export const DEFAULT_POLITICAL_REFUSAL =
  "Xin lỗi, tôi không thảo luận về các chủ đề chính trị. Tôi có thể hỗ trợ bạn về các nội dung liên quan đến doanh nghiệp.";

export const DEFAULT_RELEVANCE_THRESHOLD = 0.3;

export const SOVEREIGNTY_ANSWER_MAX = 1000;
export const POLITICAL_REFUSAL_MAX = 500;

/** The settings as the rest of the product reads them. */
export const DEFAULT_BUSINESS_SETTINGS = Object.freeze({
  businessModels: [],
  guardModel: "",
  embeddingModel: "",
  sovereigntyAnswer: DEFAULT_SOVEREIGNTY_ANSWER,
  politicalRefusal: DEFAULT_POLITICAL_REFUSAL,
  relevanceThreshold: DEFAULT_RELEVANCE_THRESHOLD,
});

function text(value, fallback) {
  return typeof value === "string" ? value : fallback;
}

function models(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry === "object" && typeof entry.id === "string" && entry.id.trim())
    .map((entry) => ({ id: entry.id.trim(), label: text(entry.label, "").trim() }));
}

/**
 * Merge a stored (possibly partial, possibly absent) `business` blob with the
 * defaults. Pure so the pipeline can normalise what it already read.
 */
export function readBusinessSettings(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const threshold = Number(value.relevanceThreshold);
  return {
    businessModels: models(value.businessModels),
    guardModel: text(value.guardModel, "").trim(),
    embeddingModel: text(value.embeddingModel, "").trim(),
    sovereigntyAnswer: text(value.sovereigntyAnswer, DEFAULT_SOVEREIGNTY_ANSWER) || DEFAULT_SOVEREIGNTY_ANSWER,
    politicalRefusal: text(value.politicalRefusal, DEFAULT_POLITICAL_REFUSAL) || DEFAULT_POLITICAL_REFUSAL,
    relevanceThreshold:
      Number.isFinite(threshold) && threshold >= 0 && threshold <= 1 ? threshold : DEFAULT_RELEVANCE_THRESHOLD,
  };
}

/** The business settings as stored today (defaults applied). */
export async function getBusinessSettings() {
  const settings = await getSettings();
  return readBusinessSettings(settings?.[BUSINESS_SETTINGS_KEY]);
}

/** Ids of the combos reserved for bots (spec api-access-enforcement). */
export function businessModelIds(business) {
  return (business?.businessModels ?? []).map((entry) => entry.id);
}

/** Is `model` one of the reserved business models? */
export function isBusinessModel(business, model) {
  if (!model || !business) return false;
  return businessModelIds(business).includes(String(model));
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Vietnamese error for a settings patch, or null. Combos are checked against the
 * caller-supplied names so this stays pure and testable.
 */
export function validateBusinessSettings(input = {}, { comboNames = [] } = {}) {
  const known = new Set(comboNames);
  const list = input.businessModels;
  if (list !== undefined) {
    if (!Array.isArray(list)) return "Danh sách model doanh nghiệp không hợp lệ";
    const seen = new Set();
    const labels = new Set();
    for (const entry of list) {
      const id = typeof entry?.id === "string" ? entry.id.trim() : "";
      const label = typeof entry?.label === "string" ? entry.label.trim() : "";
      if (!id) return "Model doanh nghiệp cần id combo";
      if (!known.has(id)) return `Model doanh nghiệp phải là một combo đã có: ${id}`;
      if (seen.has(id)) return `Model doanh nghiệp bị trùng: ${id}`;
      if (label && seen.has(label)) return `Nhãn model doanh nghiệp không được trùng với id: ${label}`;
      seen.add(id);
      if (label) labels.add(label);
    }
    for (const label of labels) {
      if (seen.has(label)) return `Nhãn model doanh nghiệp không được trùng với id: ${label}`;
    }
  }
  if (input.sovereigntyAnswer !== undefined) {
    const answer = typeof input.sovereigntyAnswer === "string" ? input.sovereigntyAnswer.trim() : "";
    if (answer.length < 1 || answer.length > SOVEREIGNTY_ANSWER_MAX) {
      return `Nội dung chủ quyền phải từ 1 đến ${SOVEREIGNTY_ANSWER_MAX} ký tự`;
    }
  }
  if (input.politicalRefusal !== undefined) {
    const refusal = typeof input.politicalRefusal === "string" ? input.politicalRefusal.trim() : "";
    if (refusal.length < 1 || refusal.length > POLITICAL_REFUSAL_MAX) {
      return `Câu từ chối chính trị phải từ 1 đến ${POLITICAL_REFUSAL_MAX} ký tự`;
    }
  }
  if (input.relevanceThreshold !== undefined) {
    const threshold = Number(input.relevanceThreshold);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      return "Ngưỡng liên quan phải là số từ 0 đến 1";
    }
  }
  for (const field of ["guardModel", "embeddingModel"]) {
    if (input[field] !== undefined && input[field] !== null && typeof input[field] !== "string") {
      return `Giá trị ${field} không hợp lệ`;
    }
  }
  return null;
}

/**
 * Persist a patch after validating it against the router's combos.
 *
 * @returns {Promise<{ ok:true, business:object } | { ok:false, error:string }>}
 */
export async function saveBusinessSettings(patch = {}, { listCombos = null } = {}) {
  const loadCombos = listCombos ?? (await import("../db/repos/combosRepo.js")).getCombos;
  const combos = await loadCombos();
  const invalid = validateBusinessSettings(patch, { comboNames: (combos ?? []).map((combo) => combo.name) });
  if (invalid) return { ok: false, error: invalid };

  const current = await getBusinessSettings();
  const next = readBusinessSettings({ ...current, ...patch });
  await updateSettings({ [BUSINESS_SETTINGS_KEY]: next });
  return { ok: true, business: next };
}

/** Both models set? Until then every business request answers 503 (spec fail-closed). */
export function businessReady(business) {
  return nonEmpty(business?.guardModel) && nonEmpty(business?.embeddingModel);
}
