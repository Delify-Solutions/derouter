import { cookies } from "next/headers";
import Link from "next/link";
import { verifyUserToken, USER_COOKIE } from "@/lib/auth/userSession";
import { getSettings } from "@/lib/db/repos/settingsRepo.js";
import { channelUrlOf } from "@/lib/telegram/channel.js";
import Navigation from "@/app/landing/components/Navigation";
import ModelPriceTable from "@/app/landing/components/ModelPriceTable";
import { buildModelListForGroup } from "@/app/landing/components/modelCatalog";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Model - derouter",
  description: "Danh sách model derouter và giá theo token, kèm các mức giảm giá đang áp dụng.",
};

/**
 * Public `/models` (change models-notifications): what a newly registered
 * customer can call, priced like the landing pricing table (same builder), with
 * the discounts in force, their end and their reasons.
 */
export default async function ModelsPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(USER_COOKIE)?.value;
  const session = token && (await verifyUserToken(token)) ? "customer" : null;
  let settings = {};
  try {
    settings = await getSettings();
  } catch {
    settings = {};
  }
  let models = [];
  try {
    models = await buildModelListForGroup();
  } catch {
    models = [];
  }
  const rows = models.map((m) => ({
    name: m.id,
    input: m.input,
    output: m.output,
    cached: m.cached,
    discount: m.discount ? { percentBp: m.discount.percentBp, endsAt: m.discount.endsAt, reasons: m.discount.reasons } : null,
    discounted: m.discount ? { input: m.discount.input, output: m.discount.output, cached: m.discount.cached } : null,
  }));

  return (
    <div className="min-h-screen bg-bg text-text-main antialiased">
      <Navigation session={session} channelUrl={channelUrlOf(settings)} />
      <main className="shell flex flex-col gap-8 py-12">
        <div className="flex flex-col gap-3">
          <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Model</h1>
          <p className="max-w-2xl text-text-muted">
            {rows.length} model dùng chung một khoản credit, trừ theo giá token của từng model. Model đang giảm giá hiện giá mới, giá cũ gạch ngang và lý do giảm.
          </p>
        </div>
        <ModelPriceTable rows={rows} emptyText="Chưa có model nào được mở bán." />
        <p className="text-sm text-text-muted">
          Đã có tài khoản? Xem đúng các model và mức giá của bạn trong{" "}
          <Link href="/account/models" className="text-text-main underline underline-offset-4">trang Model của tài khoản</Link>.
        </p>
      </main>
    </div>
  );
}
