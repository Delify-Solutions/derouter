import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAccountSession } from "@/lib/auth/userSession";
import { getApiKeys, getKeyGroupById } from "@/lib/localDb";
import { getAdapter } from "@/lib/db/driver.js";
import { getQueueSync } from "@/lib/db/repos/accountPlansRepo.js";
import { getDebtNanoSync } from "@/lib/billing/ledger.js";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import { fmtUsdNano } from "@/shared/utils/money";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tổng quan - derouter" };

const STATUS_LABEL = {
  active: { label: "Đang hoạt động", cls: "border-brand-500/30 bg-brand-500/10 text-brand-700 dark:text-brand-400", icon: "check_circle" },
  unverified: { label: "Chưa xác minh", cls: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400", icon: "mark_email_unread" },
  suspended: { label: "Đang bị khoá", cls: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400", icon: "block" },
};

function StatusBadge({ status }) {
  const spec = STATUS_LABEL[status] || { label: status || "—", cls: "border-border bg-surface-2 text-text-muted", icon: "help" };
  return (
    <span className={`inline-flex items-center gap-1.5 border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${spec.cls}`}>
      <span className="material-symbols-outlined text-[13px]" aria-hidden="true">{spec.icon}</span>
      {spec.label}
    </span>
  );
}

function fmtDate(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function fmtTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Overview (spec customer-portal "Overview page").
 *
 * Four answers, in the order a customer needs them:
 *   1. "Gói đang trả" — the plan admission would pick right now, its remaining
 *      credit and the nearest window reset, or an empty state offering the two ways
 *      to get credit (buy / redeem);
 *   2. total available credit;
 *   3. the debt, only when there is one (a $0 debt card would be noise);
 *   4. the group with how many models it allows and an expandable list of them.
 *
 * Nothing here is computed twice: the queue comes from the same queueViewSync the
 * request path uses, and the model list from buildModelsList with the group's
 * allow-list.
 */
export default async function AccountOverviewPage() {
  const cookieStore = await cookies();
  const session = await getAccountSession(cookieStore);
  if (!session) redirect("/login");

  const user = session.user;
  const db = await getAdapter();

  const queue = getQueueSync(db, user.id);
  const paying = queue.find((entry) => entry.statusLabel === "paying") ?? null;
  const debtNanoUsd = getDebtNanoSync(db, user.id);

  const [keys, group] = await Promise.all([
    getApiKeys(),
    user.groupId ? getKeyGroupById(user.groupId).catch(() => null) : Promise.resolve(null),
  ]);

  const myKeys = keys.filter((key) => key.userId === user.id);
  const liveKeys = myKeys.filter((key) => key.isActive);

  // The models this account can actually call: the group's allow-list, resolved
  // through the same builder /v1/models uses. skipDynamicFetch keeps the overview
  // off the network; a customer with no group sees an empty list and is told why.
  let models = [];
  try {
    models = await buildModelsList(["llm"], {
      allowedModels: group?.allowedModels ?? null,
      skipDynamicFetch: true,
    });
  } catch {
    models = [];
  }

  const availableNanoUsd = queue.reduce((sum, entry) => sum + Math.max(0, entry.creditRemainingNanoUsd), 0);
  const nearestReset = paying
    ? paying.windows
        .filter((window) => window.open && window.resetAt)
        .map((window) => window.resetAt)
        .sort()[0] ?? null
    : null;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <p className="meta text-text-muted">Tài khoản</p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-text-main">{user.displayName || user.email}</h1>
          <StatusBadge status={user.status} />
        </div>
        <p className="break-all font-mono text-[12px] text-text-muted">{user.email}</p>
      </header>

      {/* 1 + 2: the plan paying now and the total credit */}
      <section className="grid gap-4 sm:grid-cols-2">
        <div className="border border-border bg-surface p-6">
          <p className="meta text-text-muted">Gói đang trả</p>
          {paying ? (
            <>
              <p className="mt-3 text-lg font-semibold text-text-main">
                {paying.planName || paying.planCode || "Gói"}
              </p>
              <p className="mt-2 font-mono text-[28px] leading-none text-text-main">
                {fmtUsdNano(paying.creditRemainingNanoUsd)}
              </p>
              <p className="mt-2 text-xs text-text-muted">
                còn lại trên {fmtUsdNano(paying.creditTotalNanoUsd)} · hết hạn {fmtDate(paying.expiresAt)}
                {nearestReset ? ` · cửa sổ reset lúc ${fmtTime(nearestReset)}` : ""}
              </p>
              <Link href="/account/plans" className="mt-3 inline-block text-xs underline text-text-muted hover:text-text-main">
                Xem hàng đợi gói
              </Link>
            </>
          ) : (
            <>
              <p className="mt-3 text-sm text-text-main">Chưa có gói nào đang trả.</p>
              <p className="mt-1 max-w-md text-sm text-text-muted">
                Mua một gói để nhận credit dùng chung cho mọi model, hoặc nhập mã quà tặng nếu bạn
                được tặng.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Link
                  href="/account/plans"
                  className="inline-flex h-9 items-center border border-brand-500 bg-brand-500 px-4 font-mono text-[11px] uppercase tracking-[0.08em] text-white hover:bg-brand-600 transition-colors duration-150"
                >
                  Mua gói
                </Link>
                <Link
                  href="/account/gift"
                  className="inline-flex h-9 items-center border border-border px-4 font-mono text-[11px] uppercase tracking-[0.08em] text-text-main hover:bg-surface-2 transition-colors duration-150"
                >
                  Nhập mã quà tặng
                </Link>
              </div>
            </>
          )}
        </div>

        <div className="border border-border bg-surface p-6">
          <p className="meta text-text-muted">Tổng credit khả dụng</p>
          <p className="mt-3 font-mono text-[32px] leading-none text-text-main">{fmtUsdNano(availableNanoUsd)}</p>
          <p className="mt-2 text-xs text-text-muted">
            {queue.length} gói trong hàng đợi · {liveKeys.length}/{myKeys.length} API key đang dùng
          </p>
          <Link href="/account/ledger" className="mt-3 inline-block text-xs underline text-text-muted hover:text-text-main">
            Xem sổ cái
          </Link>
        </div>
      </section>

      {/* 3: debt, only when it exists */}
      {debtNanoUsd > 0 && (
        <section className="flex items-start gap-2 border border-amber-500/40 bg-amber-500/5 px-4 py-3">
          <span className="material-symbols-outlined text-[18px] text-amber-700 dark:text-amber-400" aria-hidden="true">
            warning
          </span>
          <div>
            <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
              Đang nợ {fmtUsdNano(debtNanoUsd)}
            </p>
            <p className="text-xs text-text-muted">
              Khoản này được trừ vào credit của gói tiếp theo bạn nhận.
            </p>
          </div>
        </section>
      )}

      {/* 4: group + models */}
      <section className="border border-border bg-surface">
        <div className="flex items-center justify-between gap-4 border-b border-border px-6 py-4">
          <div>
            <h2 className="meta text-text-main">Nhóm của bạn</h2>
            <p className="mt-1 text-sm text-text-main">{group?.name || "Chưa được gán nhóm"}</p>
          </div>
          <p className="font-mono text-[12px] text-text-muted">{models.length} model gọi được</p>
        </div>

        {models.length === 0 ? (
          <div className="px-6 py-6">
            <p className="text-sm text-text-muted">
              {group
                ? "Nhóm này chưa mở model nào. Liên hệ admin để được cấp quyền."
                : "Tài khoản chưa được gán nhóm hợp lệ — liên hệ admin."}
            </p>
          </div>
        ) : (
          <details className="px-6 py-4">
            <summary className="cursor-pointer font-mono text-[12px] uppercase tracking-[0.08em] text-text-muted hover:text-text-main">
              Xem danh sách model
            </summary>
            <ul className="mt-3 grid grid-cols-1 gap-1 sm:grid-cols-2">
              {models.map((model) => (
                <li key={model.id} className="truncate font-mono text-[12px] text-text-main" title={model.id}>
                  {model.id}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="border border-border bg-surface">
        <div className="flex h-14 items-center border-b border-border px-6">
          <h2 className="meta text-text-main">Thông tin tài khoản</h2>
        </div>
        <dl className="divide-y divide-border">
          <div className="flex items-center justify-between gap-4 px-6 py-3">
            <dt className="text-sm text-text-muted">Nhóm</dt>
            <dd className="font-mono text-[12px] text-text-main">{group?.name || "—"}</dd>
          </div>
          <div className="flex items-center justify-between gap-4 px-6 py-3">
            <dt className="text-sm text-text-muted">Tham gia</dt>
            <dd className="font-mono text-[12px] text-text-main">{fmtDate(user.createdAt)}</dd>
          </div>
          <div className="flex items-center justify-between gap-4 px-6 py-3">
            <dt className="text-sm text-text-muted">Đăng nhập gần nhất</dt>
            <dd className="font-mono text-[12px] text-text-main">
              {user.lastLoginAt ? `${fmtDate(user.lastLoginAt)} ${fmtTime(user.lastLoginAt)}` : "—"}
            </dd>
          </div>
        </dl>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        {[
          { href: "/account/keys", label: "API key", body: "Tạo và thu hồi key", icon: "key" },
          { href: "/account/usage", label: "Lịch sử dùng", body: "Request và chi phí", icon: "monitoring" },
          { href: "/account/gift", label: "Mã quà tặng", body: "Nhập mã", icon: "redeem" },
        ].map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="flex flex-col gap-2 border border-border bg-surface p-5 transition-colors duration-150 hover:bg-surface-2"
          >
            <span className="material-symbols-outlined text-[20px] text-text-muted" aria-hidden="true">{item.icon}</span>
            <span className="meta text-text-main">{item.label}</span>
            <span className="text-sm text-text-muted">{item.body}</span>
          </Link>
        ))}
      </section>
    </div>
  );
}
