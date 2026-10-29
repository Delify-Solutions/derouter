// Danh mục model của trang bán hàng, dựng từ dữ liệu thật của router.
//
// - Danh sách model: nhóm khách mặc định (setting `defaultUserGroupId`, fallback
//   nhóm active cũ nhất) qua buildModelsList — đúng danh sách mà một khách vừa
//   đăng ký gọi được. Nhóm không giới hạn thì lấy toàn bộ chat model; nhóm có
//   allow-list thì chỉ những model đó. Không quảng cáo model mà khách sẽ bị 403.
// - Giá token: bảng giá của router (bảng override trong DB trước, rồi
//   open-sse/providers/pricing.js), đúng giá dùng để trừ credit.
//
// Không có hạn mức nào nằm ở đây: một gói là một pool credit dùng chung cho mọi
// model người mua gọi được, cộng vài hạn mức theo cửa sổ thời gian trên chính
// row plans. Trang chỉ trình bày danh mục và giá token.
//
// Chỉ server component được import file này (nó kéo cả registry provider vào
// bundle); component phía client nhận dữ liệu đã dựng qua props.
import { getPricingForModel } from "open-sse/providers/pricing.js";
import { PROVIDER_ID } from "./salesData";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import { resolveDefaultGroupId, getKeyGroupById } from "@/lib/localDb";
import { resolvePrice } from "@/lib/db/repos/pricingRepo.js";

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

/**
 * The model list a newly registered customer can actually call, with the router's
 * token prices (spec public-landing "Sellable models and pricing explanation").
 *
 * Reads the DEFAULT customer group's allow-list and hands it to buildModelsList —
 * the same builder /v1/models uses — with `skipDynamicFetch` so the landing page
 * never waits on a provider round trip. Prices come from the router's pricing
 * (DB overrides first, then the bundled table), so the page and the invoice agree.
 *
 * @returns {Promise<Array<{id,name,formats,input,output,cached}>>}
 */
export async function buildModelListForGroup() {
  let allowedModels = null;
  try {
    const groupId = await resolveDefaultGroupId();
    const group = groupId ? await getKeyGroupById(groupId) : null;
    allowedModels = Array.isArray(group?.allowedModels) && group.allowedModels.length > 0
      ? group.allowedModels
      : null;
  } catch {
    // No groups table / settings yet → unrestricted, which is the fresh-install case.
    allowedModels = null;
  }

  let listed = [];
  try {
    listed = await buildModelsList(["llm"], { allowedModels, skipDynamicFetch: true });
  } catch {
    listed = [];
  }

  return Promise.all(
    listed.map(async (model) => {
      const id = model.id;
      let rate = null;
      try {
        // resolvePrice returns { pricing, source } and already walks the DB
        // overrides before the bundled table — the same chain calculateCostNano
        // uses, so a displayed price is the price that gets charged.
        const resolved = await resolvePrice({ provider: PROVIDER_ID, model: id, requestedModel: id });
        rate = resolved?.pricing ?? null;
      } catch {
        rate = null;
      }
      if (!rate || (rate.input == null && rate.output == null)) {
        rate = resolveRate(id);
      }
      return {
        id,
        name: model.name || id,
        formats: ["openai"],
        input: rate?.input ?? null,
        output: rate?.output ?? null,
        cached: rate?.cached ?? null,
      };
    })
  );
}

/** Nhãn wire format cho một model. */
export function formatsOf(models, modelId) {
  return models?.find((m) => m.id === modelId)?.formats ?? ["openai"];
}
