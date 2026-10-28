// Danh mục model của trang bán hàng, dựng từ dữ liệu thật của router.
//
// - Danh sách model: src/shared/constants/models.js (registry provider
//   "opencode-go"), nên trang không thể quảng cáo model mà router không phục vụ.
// - Giá token: open-sse/providers/pricing.js — đúng bảng giá router dùng để
//   tính tiền, nên bảng trên trang không lệch với hoá đơn.
//
// Chỉ server component được import file này (nó kéo cả registry provider vào
// bundle); component phía client nhận dữ liệu đã dựng qua props.
import { getProviderModels } from "@/shared/constants/models";
import { getPricingForModel } from "open-sse/providers/pricing.js";
import { MONTHLY_LIMIT_USD, PROVIDER_ID, SAMPLE_MODEL_ID } from "./salesData";

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

// Danh mục công bố = model có trong registry VÀ có hạn mức trong bảng của
// salesData.js. Thứ tự giữ nguyên thứ tự registry.
export const MODELS = getProviderModels(PROVIDER_ID)
  .filter((model) => MONTHLY_LIMIT_USD[model.id] > 0)
  .map((model) => {
    const rate = resolveRate(model.id) || { input: null, output: null, cached: null };
    return {
      id: model.id,
      name: model.name || model.id,
      formats: model.supportedFormats || ["openai"],
      input: rate.input,
      output: rate.output,
      cached: rate.cached,
      monthlyLimitUsd: MONTHLY_LIMIT_USD[model.id],
    };
  });

export const SAMPLE_MODEL = MODELS.find((model) => model.id === SAMPLE_MODEL_ID) || MODELS[0];
