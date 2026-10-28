// Danh mục model của trang bán hàng, dựng từ dữ liệu thật của router.
//
// - Danh sách model: registry provider "opencode-go" — trang không thể quảng cáo
//   model mà router không phục vụ.
// - Giá token: open-sse/providers/pricing.js, đúng bảng giá router dùng để tính
//   tiền, nên bảng trên trang không lệch với hoá đơn.
//
// Hạn mức theo model KHÔNG còn nằm ở đây: nó là dữ liệu của từng gói
// (planModelLimits) và được truyền vào từ LandingPage. Trước đây file này giữ
// một bảng MONTHLY_LIMIT_USD cố định, tức là landing tự quyết định model nào
// được bán thay vì hỏi gói — sửa gói trong admin không có tác dụng gì.
//
// Chỉ server component được import file này (nó kéo cả registry provider vào
// bundle); component phía client nhận dữ liệu đã dựng qua props.
import { getProviderModels } from "@/shared/constants/models";
import { getPricingForModel } from "open-sse/providers/pricing.js";
import { PROVIDER_ID } from "./salesData";

// Bảng giá nội bộ chưa phủ hết mọi id. Model nào không tra được theo provider
// thì tra tiếp bảng của một provider bán cùng model đó — không có fallback này
// trang sẽ phải bịa giá.
const RATE_FALLBACKS = [{ provider: "tokenrouter", vendor: "xiaomi" }];

function resolveRate(modelId) {
  const direct = getPricingForModel(PROVIDER_ID, modelId);
  if (direct) return direct;
  for (const { provider, vendor } of RATE_FALLBACKS) {
    const rate = getPricingForModel(provider, `${vendor}/${modelId}`);
    if (rate) return rate;
  }
  return null;
}

// Toàn bộ model của provider. Lọc theo gói là việc của PlansSection /
// PricingSection, nơi biết gói nào đang bán model nào.
export const MODELS = getProviderModels(PROVIDER_ID).map((model) => {
  const rate = resolveRate(model.id) || { input: null, output: null, cached: null };
  return {
    id: model.id,
    name: model.name || model.id,
    formats: model.supportedFormats || ["openai"],
    input: rate.input,
    output: rate.output,
    cached: rate.cached,
  };
});

/** Nhãn wire format cho một model. */
export function formatsOf(modelId) {
  return MODELS.find((m) => m.id === modelId)?.formats ?? ["openai"];
}
