// Danh mục model của trang bán hàng, dựng từ dữ liệu thật của router.
//
// - Danh sách model: CHỈ các combo đã cấu hình (đúng thứ /v1/models công khai trả
//   về), lọc theo allow-list của nhóm khách mặc định (setting `defaultUserGroupId`,
//   fallback nhóm active cũ nhất). Không liệt kê model thô của provider: khách gọi
//   bằng tên combo, và quảng cáo model họ không gọi được là sai.
// - Giá token: giá combo nếu admin đã đặt; nếu không thì giá của model đầu tiên
//   trong combo, qua cùng chuỗi tra giá dùng để trừ credit.
//
// Không có hạn mức nào nằm ở đây: một gói là một pool credit dùng chung cho mọi
// model người mua gọi được, cộng vài hạn mức theo khung giờ trên chính
// row plans. Trang chỉ trình bày danh mục và giá token.
//
// Chỉ server component được import file này (nó kéo cả registry provider vào
// bundle); component phía client nhận dữ liệu đã dựng qua props.
import { getPricingForModel } from "open-sse/providers/pricing.js";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import { resolveDefaultGroupId, getKeyGroupById, getCombos } from "@/lib/localDb";
import { resolvePrice } from "@/lib/db/repos/pricingRepo.js";
import { PROTOCOLS } from "./salesData";

// Bảng giá nội bộ chưa phủ hết mọi id. Model nào không tra được theo provider
// thì tra tiếp bảng của một provider bán cùng model đó — không có fallback này
// trang sẽ phải bịa giá.
const RATE_FALLBACKS = [{ provider: "tokenrouter", vendor: "xiaomi" }];

function resolveRate(modelId) {
  const direct = getPricingForModel("opencode-go", modelId);
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

  // No `skipDynamicFetch`: that flag switches ON the provider-pool listing used for
  // cross-instance discovery. The default path returns combos only, with no network.
  let listed = [];
  try {
    listed = await buildModelsList(["llm"], { allowedModels });
  } catch {
    listed = [];
  }

  let comboByName = new Map();
  try {
    comboByName = new Map((await getCombos()).map((combo) => [combo.name, combo]));
  } catch {
    comboByName = new Map();
  }

  return Promise.all(
    listed.map(async (model) => {
      const id = model.id;
      // The combo's first pool model stands in for its price when the admin set no
      // combo price: it is what the router serves first.
      const first = comboByName.get(id)?.models?.[0];
      const slash = typeof first === "string" ? first.indexOf("/") : -1;
      const provider = slash > 0 ? first.slice(0, slash) : undefined;
      const poolModel = typeof first === "string" ? (slash > 0 ? first.slice(slash + 1) : first) : id;

      let rate = null;
      try {
        // resolvePrice returns { pricing, source }: a combo price first (keyed by
        // `requestedModel`), then the same chain calculateCostNano uses, so a
        // displayed price is the price that gets charged.
        const resolved = await resolvePrice({ provider, model: poolModel, requestedModel: id });
        rate = resolved?.pricing ?? null;
      } catch {
        rate = null;
      }
      if (!rate || (rate.input == null && rate.output == null)) {
        rate = resolveRate(poolModel);
      }
      return {
        id,
        name: model.name || id,
        formats: PROTOCOLS.map((p) => p.id),
        input: rate?.input ?? null,
        output: rate?.output ?? null,
        cached: rate?.cached ?? null,
      };
    })
  );
}

/** Nhãn wire format cho một model. */
export function formatsOf(models, modelId) {
  return models?.find((m) => m.id === modelId)?.formats ?? PROTOCOLS.map((p) => p.id);
}
