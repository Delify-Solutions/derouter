// Số liệu bán hàng của landing page — nguồn duy nhất.
//
// Đổi giá gói, hạn mức hay tỷ lệ cửa sổ thì sửa DUY NHẤT ở file này; không
// component nào được phép tự viết con số vào JSX.
//
// File này KHÔNG import gì, nên dùng được ở cả server component lẫn client
// component. Danh mục model thật do ./modelCatalog.js dựng từ registry của
// router rồi truyền xuống dưới dạng props.

// Provider mà hai gói thuê bao này mở ra
// (xem open-sse/providers/registry/opencode-go.js).
export const PROVIDER_ID = "opencode-go";

// Ba cửa sổ lồng nhau: mỗi request phải lọt qua CẢ BA. Tỷ lệ tính trên hạn mức
// tháng của từng model, khớp với src/lib/db/repos/planLimitsRepo.js.
export const USAGE_WINDOWS = [
  { id: "5h", label: "5 giờ", fraction: 0.2 },
  { id: "week", label: "1 tuần", fraction: 0.5 },
  { id: "month", label: "1 tháng", fraction: 1 },
];

// Hai gói thuê bao. limitMultiplier nhân với MONTHLY_LIMIT_USD của từng model.
export const PLANS = [
  {
    id: "go",
    name: "Go",
    summary: "Cho một người dùng hằng ngày với chi phí cố định.",
    priceUsd: 10,
    limitMultiplier: 1,
    badge: "Tiêu chuẩn",
    highlighted: false,
    perks: [
      "Hạn mức tính riêng cho từng model trong danh mục",
      "Ba cửa sổ: 5 giờ, 1 tuần, 1 tháng",
      "Dùng như một provider OpenAI tương thích",
      "Theo dõi hạn mức còn lại qua header phản hồi",
    ],
  },
  {
    id: "go-plus",
    name: "Go Plus",
    summary: "Cùng danh mục model, hạn mức cao hơn cho công việc nặng.",
    priceUsd: 40,
    limitMultiplier: 4,
    badge: "Hạn mức cao",
    highlighted: true,
    perks: [
      "Hạn mức mỗi model cao hơn Go",
      "Cùng cửa sổ 5 giờ, 1 tuần, 1 tháng",
      "Đủ cho agent chạy liên tục trong ngày",
      "Theo dõi hạn mức còn lại qua header phản hồi",
    ],
  },
];

// Hạn mức THÁNG của gói Go cho từng model, tính bằng USD.
// Gói Go Plus lấy số ở đây nhân với limitMultiplier của gói đó.
// Model nào không có trong bảng này thì không được bán trong gói.
export const MONTHLY_LIMIT_USD = {
  "glm-5.3-flash": 60,
  "glm-5.2": 60,
  "glm-5.1": 60,
  "kimi-k2.7-code": 60,
  "kimi-k2.6": 40,
  "deepseek-v4-pro": 20,
  "deepseek-v4-flash": 80,
  "deepseek-v4-flash-vision-exp": 30,
  "mimo-v2.5": 60,
  "mimo-v2.5-pro": 30,
  "minimax-m3": 60,
  "minimax-m2.7": 40,
  "minimax-m2.5": 40,
  "qwen3.7-max": 15,
  "qwen3.7-plus": 60,
  "qwen3.6-plus": 60,
};

// Model dùng làm ví dụ minh hoạ hạn mức ở phần so sánh gói.
export const SAMPLE_MODEL_ID = "glm-5.2";

// Nhãn hiển thị cho wire format mà model khai báo trong registry.
export const FORMAT_LABELS = {
  openai: "OpenAI",
  claude: "Claude",
  "openai-responses": "Responses",
};

/** Hạn mức tháng (USD) của một model trong một gói. */
export function monthlyLimitFor(plan, model) {
  return Math.round(model.monthlyLimitUsd * plan.limitMultiplier);
}

/** Hạn mức (USD) của một model trong một cửa sổ. `fraction` nằm trong 0..1. */
export function windowLimitFor(plan, model, fraction) {
  return Math.round(monthlyLimitFor(plan, model) * fraction * 100) / 100;
}

/** Giá token: USD cho 1 triệu token. */
export function fmtRate(rate) {
  if (rate === null || rate === undefined) return "—";
  if (rate === 0) return "Miễn phí";
  if (rate >= 1) return `$${rate.toFixed(2)}`;
  if (rate >= 0.01) return `$${rate.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
  return `$${rate.toFixed(6)}`;
}

/** Số tiền USD của gói và hạn mức. */
export function fmtUsd(usd) {
  const value = Number(usd) || 0;
  if (value === 0) return "$0";
  return `$${Number.isInteger(value) ? value : value.toFixed(2)}`;
}

/**
 * Fill `{name}` placeholders in operator-authored copy.
 *
 * The admin writes prose, and some sentences must state a fact that lives in
 * code (the model count, the Go Plus multiplier). Hard-coding the number in the
 * default text would make it wrong the moment the catalogue changes, so the text
 * carries a placeholder and the value is substituted at render.
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
