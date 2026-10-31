// Dựng dữ liệu hiển thị cho trang bán hàng TỪ DATABASE.
//
// Gói, giá, credit, thời hạn, thứ tự, cờ nổi bật và hạn mức theo khung giờ đều đọc
// từ bảng plans; chỉ những thứ thật sự là câu chữ (nhãn) nằm trong code.
//
// Một gói = MỘT pool credit dùng chung cho mọi model người mua gọi được, có thể
// có vài hạn mức theo khung giờ (5 giờ / 1 ngày / 1 tuần / tuỳ chỉnh).
// Không còn khái niệm hạn mức riêng từng model.
//
// File này KHÔNG import gì để dùng được ở cả server lẫn client component.

// Provider mà danh mục model của trang lấy từ registry của router. Giữ ở đây vì
// modelCatalog đọc hằng này và cả hai file là dữ liệu của trang bán hàng.
export const PROVIDER_ID = "opencode-go";

// Nhãn cho wire format. Giữ trong code vì đây là tên giao thức, không phải câu
// chữ tiếp thị: "OpenAI" luôn là "OpenAI" ở mọi ngôn ngữ.
export const FORMAT_LABELS = {
  openai: "OpenAI",
  claude: "Claude",
  "openai-responses": "Responses",
  anthropic: "Claude",
};

// Giao thức client có thể dùng để gọi cùng một danh mục model. Router tự chuyển đổi
// giữa các định dạng, nên mọi model đều gọi được qua cả ba đường dẫn.
export const PROTOCOLS = [
  { id: "openai", label: "OpenAI", path: "/v1/chat/completions" },
  { id: "claude", label: "Claude", path: "/v1/messages" },
  { id: "openai-responses", label: "Responses", path: "/v1/responses" },
];

/**
 * A token price per 1M tokens: at least two decimals from $0.01 up ("0.60", "3.00"),
 * more only when the price needs them ("0.075"), and a short tail below that.
 */
export function fmtRate(rate) {
  if (rate === null || rate === undefined) return "—";
  const value = Number(rate);
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  if (value < 0.01) return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return value.toFixed(4).replace(/(\.\d\d\d?)0+$/, "$1").replace(/(\.\d\d)0$/, "$1");
}

/** "250.000đ" — the same grouping VietQR prices use everywhere else. */
function vndText(value) {
  const amount = Math.round(Number(value) || 0);
  if (amount <= 0) return null;
  const digits = String(amount);
  let out = "";
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ".";
    out += digits[i];
  }
  return `${out}đ`;
}

/** USD với số lẻ vừa đủ: $10, $19.50. */
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

// Perk mặc định cho một gói. Đây là lời quảng cáo, không phải dữ liệu: chúng mô
// tả đúng cơ chế hệ thống làm (một pool credit dùng chung, hạn mức theo khung giờ,
// hàng đợi gói, endpoint tương thích OpenAI). Admin thay được bằng cách sửa nội
// dung ở /dashboard/content.
export const DEFAULT_PERKS = [
  "Credit dùng được cho mọi model trong nhóm của bạn",
  "Mua thêm gói thì credit còn lại vẫn giữ nguyên",
  "Dùng được với client OpenAI và Claude, chỉ cần đổi base URL",
  "Gói đầu hàng đợi chạm hạn mức thì request chuyển sang gói kế tiếp",
];

const WINDOW_LABELS = { 5: "5 giờ", 24: "1 ngày", 168: "1 tuần" };

/** Nhãn khung giờ: 5 → "5 giờ", 24 → "1 ngày", 168 → "1 tuần", còn lại "<N> giờ". */
export function windowLabel(hours) {
  const n = Number(hours);
  return WINDOW_LABELS[n] ?? `${Number.isFinite(n) ? Math.round(n) : 0} giờ`;
}

/** "Tối đa $20 mỗi 5 giờ" */
export function describeLimit(limit) {
  if (!limit) return "";
  return `Tối đa ${fmtUsd((Number(limit.maxNanoUsd) || 0) / 1e9)} mỗi ${windowLabel(limit.hours)}`;
}

/**
 * Turn a plans row (already mapped by billingRepo.rowToPlan) into the shape the
 * landing sections expect.
 *
 * Deliberately omits anything the public must not see: nothing here is secret,
 * but `allowedGroupIds` and `purchaseLimitPerMonth` are gating rules — they are
 * published as a boolean ("can I buy this") by the account route, not as policy
 * details.
 *
 * @param {object} plan row from listPlans()
 */
export function toSalesPlan(plan, offeredMethods = []) {
  const priceUsd = (Number(plan.priceNanoUsd) || 0) / 1e9;
  const creditUsd = (Number(plan.creditNanoUsd) || 0) / 1e9;
  // Integer đồng, NULL when the plan is not sold by bank transfer. Shown next to
  // the USD price rather than instead of it (spec plan-dual-pricing "Prices on
  // public and customer pages").
  const priceVnd = plan.priceVnd == null ? null : Number(plan.priceVnd);
  const limits = Array.isArray(plan.limits) ? plan.limits : [];
  const limitsText = limits.map(describeLimit);
  // Rates are part of what the plan promises, so they sit with the other limits.
  if (Number(plan.rpm) > 0) limitsText.push(`${Number(plan.rpm).toLocaleString("vi-VN")} request mỗi phút`);
  if (Number(plan.tpm) > 0) limitsText.push(`${Number(plan.tpm).toLocaleString("vi-VN")} token mỗi phút`);
  const methods = Array.isArray(offeredMethods) ? offeredMethods : [];

  return {
    id: plan.id,
    code: plan.code,
    name: plan.name || plan.code,
    summary: plan.description || "",
    priceUsd,
    priceVnd,
    priceVndText: vndText(priceVnd),
    priceUsdText: priceUsd > 0 ? `$${priceUsd % 1 === 0 ? priceUsd.toFixed(0) : priceUsd.toFixed(2)}` : null,
    // Offered methods drive the card: a plan with none is "Chưa mở bán".
    offeredMethods: methods,
    soldOut: methods.length === 0,
    creditUsd,
    // No credit ceiling: the card says so instead of showing "$0".
    unlimitedCredit: plan.unlimitedCredit === true,
    durationDays: Number(plan.durationDays) || 0,
    // `isFeatured` in the admin list decides the highlighted card. Nothing is
    // highlighted when no plan is flagged — inventing an emphasis the operator
    // did not ask for would misrepresent their pricing.
    highlighted: Boolean(plan.isFeatured),
    limits,
    limitsText,
    purchasable: plan.isPurchasable !== false,
    badge: plan.isFeatured ? "Nổi bật" : null,
  };
}
