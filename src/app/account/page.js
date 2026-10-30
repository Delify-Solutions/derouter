import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAccountSession } from "@/lib/auth/userSession";
import { getApiKeys, getKeyGroupById, getSettings } from "@/lib/localDb";
import { getAdapter } from "@/lib/db/driver.js";
import { getQueueSync } from "@/lib/db/repos/accountPlansRepo.js";
import { getDebtNanoSync } from "@/lib/billing/ledger.js";
import { buildModelsList } from "@/app/api/v1/models/route.js";
import { fmtUsdNano } from "@/shared/utils/money";
import { Page, Section, Panel, Stat, Tag, IconBox, ButtonLink, Eyebrow } from "./components/ui";
import CopyBlock from "./components/CopyBlock";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tổng quan - derouter" };

const STATUS_TAG = {
  active: { label: "Đang hoạt động", tone: "success", icon: "check_circle" },
  unverified: { label: "Chưa xác minh", tone: "warning", icon: "mark_email_unread" },
  suspended: { label: "Đang bị khóa", tone: "danger", icon: "block" },
};

function StatusTag({ status }) {
  const spec = STATUS_TAG[status] || { label: status || "—", tone: "neutral", icon: "help" };
  return <Tag tone={spec.tone} icon={spec.icon}>{spec.label}</Tag>;
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

/** Where a customer's client should point: the configured public URL, else this request's origin. */
async function apiBaseUrl() {
  try {
    const settings = await getSettings();
    const configured = typeof settings?.publicBaseUrl === "string" ? settings.publicBaseUrl.trim() : "";
    if (configured) return `${configured.replace(/\/+$/, "")}/v1`;
  } catch {
    // fall through to the request origin
  }
  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host") || "localhost";
  const proto = h.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}/v1`;
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

  // The models this account can actually call: the configured combos the group's
  // allow-list lets through, from the same builder /v1/models uses (which lists
  // combos only and never touches the network). A customer with no group sees an
  // empty list and is told why.
  let models = [];
  try {
    models = await buildModelsList(["llm"], { allowedModels: group?.allowedModels ?? null });
  } catch {
    models = [];
  }

  const baseUrl = await apiBaseUrl();

  const availableNanoUsd = queue.reduce((sum, entry) => sum + Math.max(0, entry.creditRemainingNanoUsd), 0);
  const nearestReset = paying
    ? paying.windows
        .filter((window) => window.open && window.resetAt)
        .map((window) => window.resetAt)
        .sort()[0] ?? null
    : null;

  const firstName = user.displayName || user.email.split("@")[0];

  return (
    <Page
      title={`Xin chào, ${firstName}`}
      description="Tổng quan tài khoản: credit còn lại, gói đang trả và cách kết nối."
      actions={<StatusTag status={user.status} />}
    >
      {/* 1 + 2: the plan paying now and the total credit */}
      <div className="grid gap-px border border-border bg-border md:grid-cols-3">
        <div className="bg-surface p-6">
          <Stat
            label="Credit khả dụng"
            value={fmtUsdNano(availableNanoUsd)}
            hint={`${queue.length} gói trong hàng đợi`}
          />
        </div>
        <div className="bg-surface p-6">
          {paying ? (
            <Stat
              label="Gói đang trả"
              value={paying.planName || paying.planCode || "Gói"}
              hint={`Còn ${fmtUsdNano(paying.creditRemainingNanoUsd)} / ${fmtUsdNano(paying.creditTotalNanoUsd)} · hết hạn ${fmtDate(paying.expiresAt)}${nearestReset ? ` · reset ${fmtTime(nearestReset)}` : ""}`}
            />
          ) : (
            <Stat label="Gói đang trả" value="Chưa có" hint="Mua gói hoặc nhập mã quà tặng để nhận credit." />
          )}
        </div>
        <div className="bg-surface p-6">
          <Stat
            label="API key"
            value={`${liveKeys.length}`}
            unit={`/ ${myKeys.length} đang dùng`}
            hint="Key dùng để gọi API với credit của bạn."
          />
        </div>
      </div>

      {/* 3: debt, only when it exists */}
      {debtNanoUsd > 0 && (
        <div role="status" className="flex items-start gap-3 border border-amber-500/40 bg-amber-500/5 px-5 py-4">
          <span className="material-symbols-outlined text-[20px] text-amber-700 dark:text-amber-400" aria-hidden="true">
            warning
          </span>
          <div>
            <p className="text-sm font-medium text-amber-700 dark:text-amber-400">Đang nợ {fmtUsdNano(debtNanoUsd)}</p>
            <p className="text-sm text-text-muted">Khoản này được trừ vào credit của gói tiếp theo bạn nhận.</p>
          </div>
        </div>
      )}

      {!paying && (
        <div className="flex flex-wrap gap-2">
          <ButtonLink href="/account/plans" tone="solid">Mua gói</ButtonLink>
          <ButtonLink href="/account/gift">Nhập mã quà tặng</ButtonLink>
        </div>
      )}

      <Section title="Bắt đầu" description="Ba bước để gọi API bằng credit của bạn. Base URL dùng được với cả giao thức OpenAI và Claude.">
        <Panel className="flex flex-col gap-6 p-6">
          <div className="flex flex-col gap-2">
            <p className="text-sm text-text-main"><span className="mr-2 font-mono text-xs text-text-subtle">[01]</span>Tạo API key</p>
            <p className="pl-8 text-sm text-text-muted">
              Vào <a href="/account/keys" className="underline hover:text-text-main">API key</a> và tạo một key mới.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-sm text-text-main"><span className="mr-2 font-mono text-xs text-text-subtle">[02]</span>Trỏ client tới</p>
            <CopyBlock prompt="url" value={baseUrl} />
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-sm text-text-main"><span className="mr-2 font-mono text-xs text-text-subtle">[03]</span>Gọi thử</p>
            <CopyBlock value={`curl ${baseUrl}/models -H "Authorization: Bearer <API_KEY>"`} />
          </div>
        </Panel>
      </Section>

      {/* 4: group + models */}
      <Section
        title="Nhóm và model"
        description="Nhóm quyết định model nào tài khoản được gọi. Admin có thể đổi nhóm của bạn."
      >
        <Panel>
          <div className="flex items-center justify-between gap-4 p-6">
            <div className="flex items-center gap-3">
              <IconBox icon="group" />
              <div>
                <Eyebrow>Nhóm của bạn</Eyebrow>
                <p className="mt-1 text-sm font-medium text-text-main">{group?.name || "Chưa được gán nhóm"}</p>
              </div>
            </div>
            <Tag>{models.length} model</Tag>
          </div>

          {models.length === 0 ? (
            <p className="border-t border-border px-6 py-5 text-sm text-text-muted">
              {group
                ? "Nhóm này chưa mở model nào. Liên hệ admin để được cấp quyền."
                : "Tài khoản chưa được gán nhóm hợp lệ — liên hệ admin."}
            </p>
          ) : (
            <details className="border-t border-border px-6 py-4">
              <summary className="cursor-pointer text-sm font-medium text-text-muted hover:text-text-main">
                Xem danh sách model
              </summary>
              <ul className="mt-4 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
                {models.map((model) => (
                  <li key={model.id} className="truncate font-mono text-xs text-text-main" title={model.id}>
                    {model.id}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Panel>
      </Section>

      <Section title="Tài khoản" description="Thông tin đăng ký của bạn.">
        <Panel>
          <dl className="divide-y divide-border">
            {[
              ["Email", user.email],
              ["Nhóm", group?.name || "—"],
              ["Tham gia", fmtDate(user.createdAt)],
              ["Đăng nhập gần nhất", user.lastLoginAt ? `${fmtDate(user.lastLoginAt)} ${fmtTime(user.lastLoginAt)}` : "—"],
            ].map(([label, value]) => (
              <div key={label} className="flex items-center justify-between gap-4 px-6 py-4">
                <dt className="text-sm text-text-muted">{label}</dt>
                <dd className="min-w-0 truncate font-mono text-xs text-text-main">{value}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </Section>
    </Page>
  );
}
