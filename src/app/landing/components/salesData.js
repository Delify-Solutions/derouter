// Dựng dữ liệu hiển thị cho trang bán hàng TỪ DATABASE.
//
// Trước đây file này hardcode hai gói Go/Go Plus, nên sửa gói trong
// /dashboard/plans không hề đổi landing — hai nơi nói hai chuyện khác nhau.
// Giờ gói, giá, thời hạn, thứ tự, cờ nổi bật và hạn mức theo model đều đọc từ
// bảng plans + planModelLimits; chỉ những thứ thật sự là câu chữ (perk, nhãn)
// mới nằm trong code.
//
// File này KHÔNG import gì để dùng được ở cả server lẫn client component.

// Provider mà các gói thuê bao này mở ra.
export const PROVIDER_ID = "opencode-go";

// Ba cửa sổ lồng nhau: mỗi request phải lọt qua CẢ BA. Tỷ lệ tính trên hạn mức
// tháng của từng model, khớp với src/lib/db/repos/planLimitsRepo.js.
export const USAGE_WINDOWS = [
  { id: "5h", label: "5 giờ", fraction: 0.2 },
  { id: "week", label: "1 tuần", fraction: 0.5 },
  { id: "month", label: "1 tháng", fraction: 1 },
];

// Perk mặc định cho một gói thuê bao. Đây là lời quảng cáo, không phải dữ liệu:
// chúng mô tả cơ chế mà hệ thống thực sự làm (hạn mức theo model, ba cửa sổ,
// endpoint tương thích OpenAI, header phản hồi). Admin có thể thay bằng cách
// thêm cột perks sau này; hiện giữ trong code để landing không hứa điều hệ thống
// không làm.
export const DEFAULT_PERKS = [
  "Hạn mức tính riêng cho từng model trong danh mục",
  "Ba cửa sổ: 5 giờ, 1 tuần, 1 tháng",
  "Dùng như một provider OpenAI tương thích",
  "Theo dõi hạn mức còn lại qua header phản hồi",
];

// Nhãn cho wire format. Giữ trong code vì đây là tên giao thức, không phải câu
// chữ tiếp thị: "OpenAI" luôn là "OpenAI" ở mọi ngôn ngữ.
export const FORMAT_LABELS = {
  openai: "OpenAI",
  claude: "Claude",
  "openai-responses": "Responses",
  anthropic: "Claude",
};

export function fmtRate(rate) {
  if (rate === null || rate === undefined) return "—";
  const value = Number(rate);
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  if (value < 0.01) return value.toFixed(4).replace(/0+$/, "");
  if (value < 1) return value.toFixed(2).replace(/0+$/, "");
  return value.toFixed(2).replace(/\.00$/, "");
}

export function fmtUsd(usd) {
  const value = Number(usd) || 0;
  return `$${value.toFixed(value % 1 === 0 ? 0 : 2)}`;
}

/**
 * Fill `{name}` placeholders in operator-authored copy.
 *
 * The admin writes prose, and some sentences must state a fact that lives in
 * code (the model count, the plan count). Hard-coding the number in the default
 * text would make it wrong the moment the data changes, so the text carries a
 * placeholder and the value is substituted at render.
 *
 * Unknown placeholders are left untouched — better a visible `{foo}` than a
 * silently mangled sentence.
 */
export function interpolate(template, values = {}) {
  if (typeof template !== "string") return "";
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
  );
}

/**
 * Turn a plans row (already mapped by billingRepo.rowToPlan) plus its per-model
 * limits into the shape the landing sections expect.
 *
 * Deliberately omits anything the public must not see: nothing here is secret,
 * but `allowedGroupIds` and `purchaseLimitPerMonth` are gating rules — they are
 * published as a boolean ("can I buy this") by the account route, not as policy
 * details.
 *
 * @param {object} plan      row from listPlans()
 * @param {Array}  limits    rows from listPlanModelLimits(plan.id)
 */
export function toSalesPlan(plan, limits = []) {
  const priceUsd = (Number(plan.priceNanoUsd) || 0) / 1e9;
  const creditUsd = (Number(plan.creditNanoUsd) || 0) / 1e9;

  // Hạn mức tháng lớn nhất trong các model của gói — dùng cho câu "ví dụ với
  // model X". Không lấy trung bình vì con số đó không tương ứng với model nào.
  const monthlyByModel = {};
  let topModel = null;
  for (const limit of limits) {
    const usd = (Number(limit.monthlyNanoUsd) || 0) / 1e9;
    monthlyByModel[limit.model] = usd;
    if (!topModel || usd > topModel.usd) topModel = { model: limit.model, usd };
  }

  return {
    id: plan.id,
    code: plan.code,
    name: plan.name || plan.code,
    summary: plan.description || "",
    priceUsd,
    creditUsd,
    durationDays: plan.durationDays,
    // `isFeatured` in the admin list decides the highlighted card. Nothing is
    // highlighted when no plan is flagged — inventing an emphasis the operator
    // did not ask for would misrepresent their pricing.
    highlighted: Boolean(plan.isFeatured),
    perks: DEFAULT_PERKS,
    monthlyByModel,
    sampleModel: topModel,
    modelCount: limits.length,
    purchasable: plan.isPurchasable !== false,
    badge: plan.isFeatured ? "Nổi bật" : null,
  };
}

/**
 * Hạn mức tháng (USD) của một model trong một gói. Trả về null khi gói không
 * đặt hạn mức cho model đó — nghĩa là model không được bán trong gói này.
 */
export function monthlyLimitFor(plan, modelId) {
  if (!plan?.monthlyByModel || !modelId) return null;
  const direct = plan.monthlyByModel[modelId];
  if (direct !== undefined) return direct;
  // Provider-prefixed vs bare id: "anthropic/x" và "x" là cùng một model, cùng
  // quy ước với matchesAllowed() ở phía server.
  const bare = String(modelId).includes("/") ? String(modelId).split("/").slice(1).join("/") : null;
  if (bare && plan.monthlyByModel[bare] !== undefined) return plan.monthlyByModel[bare];
  const prefixed = Object.keys(plan.monthlyByModel).find((k) => k.endsWith(`/${modelId}`));
  return prefixed ? plan.monthlyByModel[prefixed] : null;
}

/** Hạn mức của một cửa sổ, suy ra từ hạn mức tháng. */
export function windowLimitFor(plan, modelId, fraction) {
  const monthly = monthlyLimitFor(plan, modelId);
  if (monthly === null) return null;
  return Math.round(monthly * fraction * 100) / 100;
}

/** Các model thực sự bán trong một gói, dùng cho bảng giá. */
export function modelsForPlan(plan) {
  if (!plan?.monthlyByModel) return [];
  return Object.entries(plan.monthlyByModel).map(([id, monthlyUsd]) => ({ id, monthlyUsd }));
}
