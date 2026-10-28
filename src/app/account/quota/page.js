import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getAccountSession } from "@/lib/auth/userSession";
import { getAdapter } from "@/lib/db/driver.js";
import { getModelCostSinceNano } from "@/lib/db/repos/usageRepo.js";
import { listAllPlanModelLimits, PLAN_WINDOWS, windowLimitNano } from "@/lib/db/repos/planLimitsRepo.js";
import { fmtUsdNano } from "@/shared/utils/money.js";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Hạn mức - derouter",
};

// Remaining allowance per model, for the signed-in customer.
//
// Server component: the whole page is a read of one snapshot, so there is no
// interaction to justify shipping it to the client.
export default async function AccountQuotaPage() {
  const cookieStore = await cookies();
  const session = await getAccountSession(cookieStore);
  if (!session) redirect("/login");

  const db = await getAdapter();
  const now = new Date();
  const at = now.toISOString();

  const plans = db.all(
    `SELECT p.id, p.code, p.name, up.startsAt, up.expiresAt
       FROM userPlans up
       JOIN plans p ON p.id = up.planId
      WHERE up.userId = ? AND up.status = 'active' AND up.expiresAt > ? AND p.id IS NOT NULL
      ORDER BY up.startsAt ASC, up.createdAt ASC`,
    [session.userId, at]
  );

  if (!plans.length) {
    return (
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-2">
          <p className="meta text-text-muted">Hạn mức</p>
          <h1 className="text-2xl font-semibold text-text-main">Chưa có gói thuê bao</h1>
        </header>
        <div className="border border-border bg-surface p-6">
          <p className="text-sm text-text-muted">
            Tài khoản này chưa có gói đang hoạt động, nên lưu lượng được trừ vào credit.
          </p>
          <Link
            href="/account/plans"
            className="mt-4 inline-flex h-9 items-center border border-brand-500 bg-brand-500 px-4 font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-white"
          >
            Xem các gói
          </Link>
        </div>
      </div>
    );
  }

  const limitsByPlan = await listAllPlanModelLimits();
  const ceilings = new Map();
  for (const plan of plans) {
    for (const limit of limitsByPlan.get(plan.id) ?? []) {
      const existing = ceilings.get(limit.model);
      if (existing) existing.monthlyNanoUsd += limit.monthlyNanoUsd;
      else ceilings.set(limit.model, { model: limit.model, monthlyNanoUsd: limit.monthlyNanoUsd });
    }
  }

  const spendByWindow = {};
  for (const w of PLAN_WINDOWS) {
    spendByWindow[w.id] = await getModelCostSinceNano(
      session.userId,
      new Date(now.getTime() - w.ms).toISOString()
    );
  }

  const rows = [...ceilings.values()]
    .map((entry) => ({
      model: entry.model,
      monthlyNanoUsd: entry.monthlyNanoUsd,
      windows: PLAN_WINDOWS.map((w) => {
        const cap = windowLimitNano(entry.monthlyNanoUsd, w.id);
        const spent = spendByWindow[w.id].get(entry.model) ?? 0;
        const remaining = Math.max(0, cap - spent);
        return {
          id: w.id,
          label: w.label,
          cap,
          spent,
          remaining,
          pct: cap > 0 ? Math.min(100, Math.round((spent / cap) * 100)) : 0,
        };
      }),
    }))
    .sort((a, b) => a.model.localeCompare(b.model));

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <p className="meta text-text-muted">Hạn mức</p>
        <h1 className="text-2xl font-semibold text-text-main">Còn dùng được bao nhiêu</h1>
        <p className="max-w-2xl text-sm text-text-muted">
          Mỗi model có hạn mức riêng, kiểm tra đồng thời trên ba cửa sổ: 5 giờ, 1 tuần và 1 tháng.
          Hạn mức tự nạp lại khi cửa sổ trôi qua — không cần làm gì.
        </p>
      </header>

      <section className="border border-border bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
          <h2 className="meta text-text-main">Gói đang dùng</h2>
          <Link
            href="/account/plans"
            className="font-mono text-[12px] uppercase tracking-[0.08em] text-brand-600 dark:text-brand-400 hover:underline"
          >
            Mua thêm
          </Link>
        </div>
        <ul className="divide-y divide-border">
          {plans.map((plan) => (
            <li key={plan.id} className="flex flex-wrap items-center justify-between gap-3 px-6 py-3">
              <div>
                <p className="text-sm font-medium text-text-main">{plan.name || plan.code}</p>
                <p className="font-mono text-[11px] text-text-subtle">
                  bắt đầu {new Date(plan.startsAt).toLocaleDateString("vi-VN")} · hết hạn{" "}
                  {new Date(plan.expiresAt).toLocaleDateString("vi-VN")}
                </p>
              </div>
            </li>
          ))}
        </ul>
        {plans.length > 1 ? (
          <p className="border-t border-border px-6 py-3 text-[11px] text-text-subtle">
            Hạn mức bên dưới là tổng của {plans.length} gói đang hoạt động.
          </p>
        ) : null}
      </section>

      {rows.length === 0 ? (
        <p className="border border-border bg-surface p-6 text-sm text-text-muted">
          Gói hiện tại không giới hạn theo model.
        </p>
      ) : (
        <section className="flex flex-col gap-3">
          {rows.map((row) => (
            <div key={row.model} className="border border-border bg-surface">
              <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-5 py-3">
                <h3 className="font-mono text-sm text-text-main">{row.model}</h3>
                <p className="font-mono text-[11px] text-text-subtle">
                  {fmtUsdNano(row.monthlyNanoUsd)} / tháng
                </p>
              </div>
              <dl className="grid grid-cols-1 gap-px bg-border sm:grid-cols-3">
                {row.windows.map((w) => (
                  <div key={w.id} className="bg-surface px-5 py-4">
                    <div className="flex items-baseline justify-between gap-2">
                      <dt className="meta text-text-subtle">{w.label}</dt>
                      <dd className="font-mono text-[13px] text-text-main">
                        {fmtUsdNano(w.remaining)}
                        <span className="text-text-subtle"> / {fmtUsdNano(w.cap)}</span>
                      </dd>
                    </div>
                    {/* Thanh đã dùng: đọc nhanh hơn một con số khi sắp chạm trần. */}
                    <div className="mt-2 h-1 w-full bg-border" role="presentation">
                      <div
                        className={`h-1 ${w.pct >= 100 ? "bg-red-500" : w.pct >= 80 ? "bg-yellow-500" : "bg-brand-500"}`}
                        style={{ width: `${w.pct}%` }}
                      />
                    </div>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </section>
      )}

      <p className="font-mono text-[11px] text-text-subtle">
        Hạn mức tính bằng chi phí quy đổi theo bảng giá token, không phải số request. Request dài
        tốn nhiều hơn request ngắn.
      </p>
    </div>
  );
}
