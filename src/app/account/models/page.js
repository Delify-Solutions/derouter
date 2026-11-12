import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAccountSession } from "@/lib/auth/userSession";
import { getKeyGroupById } from "@/lib/localDb";
import { buildModelPriceList } from "@/lib/models/priceList.js";
import { Page } from "@/app/account/components/ui";
import ModelPriceTable from "@/app/landing/components/ModelPriceTable";

export const metadata = {
  title: "Model - derouter",
};

export const dynamic = "force-dynamic";

/**
 * `/account/models` ("Model"): the combos this customer's group allows, priced
 * like the usage page, with the customer's own discounts (group + the plan that
 * pays first) and their reasons (spec customer-portal "Model pages").
 */
export default async function AccountModelsPage() {
  const session = await getAccountSession(await cookies());
  if (!session) redirect("/login");
  const { user } = session;

  let rows = [];
  let failed = false;
  let noGroup = false;
  try {
    const group = user.groupId ? await getKeyGroupById(user.groupId) : null;
    // Key enforcement refuses every request without a live group, so listing
    // the catalogue would only advertise models that cannot be called.
    if (!group || group.isActive !== true) {
      noGroup = true;
    } else {
      rows = await buildModelPriceList({
        allowedModels: group.allowedModels ?? null,
        discountContext: { userId: user.id },
      });
    }
  } catch {
    failed = true;
  }

  return (
    <Page
      title="Model"
      description="Các model tài khoản của bạn gọi được, giá theo token và mức giảm giá đang áp dụng cho bạn. Dùng đúng tên model trong trường model của request."
    >
      {failed ? (
        <p role="alert" className="border border-red-500/40 bg-red-500/5 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          Không tải được danh sách model. Tải lại trang để thử lại.
        </p>
      ) : noGroup ? (
        <p className="border border-dashed border-border px-6 py-10 text-center text-sm text-text-muted">
          Tài khoản của bạn chưa thuộc nhóm nào đang hoạt động nên chưa gọi được model. Liên hệ quản trị viên.
        </p>
      ) : (
        <ModelPriceTable rows={rows} showKind emptyText="Nhóm của bạn chưa được mở model nào. Liên hệ quản trị viên." />
      )}
    </Page>
  );
}
