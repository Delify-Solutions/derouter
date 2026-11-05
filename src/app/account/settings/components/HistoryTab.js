"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/shared/utils/cn";
import { ActionButton, Empty, Panel, Stat, Tag } from "@/app/account/components/ui";
import { dateOf, timeOf, dateTimeOf } from "@/shared/components/billing/StatusTag";
import { fmtUsdNano, fmtCreditNano } from "@/shared/utils/money";
import { formatVnd } from "@/lib/payments/amounts.js";

const PAGE_SIZE = 30;

const GROUPS = [
  { value: "all", label: "Tất cả" },
  { value: "security", label: "Bảo mật" },
  { value: "orders", label: "Đơn hàng" },
  { value: "plans", label: "Gói & quà" },
];

const SECURITY = {
  register: { icon: "person_add", label: "Tạo tài khoản" },
  login: { icon: "login", label: "Đăng nhập" },
  logout: { icon: "logout", label: "Đăng xuất" },
  login_failed: { icon: "warning", label: "Đăng nhập sai mật khẩu", tone: "warning" },
  login_blocked: { icon: "block", label: "Đăng nhập bị chặn", tone: "danger" },
  password_change: { icon: "password", label: "Đổi mật khẩu" },
  password_reset: { icon: "lock_reset", label: "Đặt lại mật khẩu" },
  email_verified: { icon: "mark_email_read", label: "Xác minh email" },
  email_change_requested: { icon: "alternate_email", label: "Yêu cầu đổi email" },
  email_changed: { icon: "alternate_email", label: "Đổi email đăng nhập" },
  telegram_link: { icon: "send", label: "Liên kết Telegram" },
  telegram_unlink: { icon: "link_off", label: "Gỡ liên kết Telegram" },
  key_create: { icon: "key", label: "Tạo API key" },
  key_delete: { icon: "key_off", label: "Xóa API key" },
};

const ORDER_STATUS = {
  paid: { label: "Đã thanh toán", tone: "success" },
  pending: { label: "Chờ thanh toán", tone: "warning" },
  expired: { label: "Hết hạn", tone: "neutral" },
  cancelled: { label: "Đã hủy", tone: "neutral" },
  refunded: { label: "Đã hoàn tiền", tone: "neutral" },
};

const SOURCE = {
  purchase: "Mua gói",
  gift: "Nhập mã quà",
  admin: "Quản trị viên cấp",
  affiliate: "Đổi hoa hồng thành credit",
  referral_bonus: "Quà người được giới thiệu",
};

/** Amount in the currency the customer paid (orders schema units). */
function payText(currency, amount) {
  const value = Number(amount) || 0;
  if (currency === "VND") return formatVnd(value);
  if (currency === "USDT") return `${(value / 1e9).toFixed(2)} USDT`;
  return fmtUsdNano(value);
}

function describe(entry) {
  if (entry.group === "security") {
    const spec = SECURITY[entry.type] || { icon: "shield", label: entry.type };
    const parts = [];
    if (entry.type === "email_change_requested" && entry.details?.newEmail) parts.push(`sang ${entry.details.newEmail}`);
    if (entry.type === "email_changed" && entry.details?.to) parts.push(`${entry.details.from || "?"} → ${entry.details.to}`);
    if (entry.type.startsWith("key_") && entry.details?.name) parts.push(`“${entry.details.name}”`);
    if (entry.type === "telegram_unlink" && entry.details?.by === "admin") parts.push("do quản trị viên gỡ");
    if (entry.device) parts.push(entry.device);
    if (entry.ip) parts.push(`IP ${entry.ip}`);
    return { icon: spec.icon, title: spec.label, detail: parts.join(" · "), tag: spec.tone ? { tone: spec.tone, text: spec.tone === "danger" ? "Bị chặn" : "Cảnh báo" } : null };
  }
  if (entry.group === "orders") {
    const status = ORDER_STATUS[entry.status] || { label: entry.status, tone: "neutral" };
    const parts = [payText(entry.payCurrency, entry.payAmount)];
    if (entry.periods > 1) parts.push(`${entry.periods} kỳ`);
    if (entry.paidAt) parts.push(`thanh toán ${dateTimeOf(entry.paidAt)}`);
    return {
      icon: "receipt",
      title: `Đơn hàng ${entry.planName || ""}`.trim(),
      detail: parts.join(" · "),
      tag: { tone: status.tone, text: status.label },
      href: `/account/orders/${entry.orderId}`,
    };
  }
  if (entry.type === "plan_expired") {
    return { icon: "event_busy", title: `Gói hết hạn${entry.planName ? `: ${entry.planName}` : ""}`, detail: "", tag: null };
  }
  const label = SOURCE[entry.source] || "Nhận gói";
  const title = entry.source === "gift" && entry.giftCode ? `${label} ${entry.giftCode}` : label;
  const parts = [];
  if (entry.planName) parts.push(entry.planName);
  parts.push(`credit ${fmtCreditNano(entry.creditNanoUsd, entry.unlimitedCredit)}`);
  if (entry.expiresAt) parts.push(`hết hạn ${dateOf(entry.expiresAt)}`);
  return {
    icon: entry.source === "gift" ? "redeem" : entry.source === "purchase" ? "workspace_premium" : "add_card",
    title,
    detail: parts.join(" · "),
    tag: entry.revoked ? { tone: "danger", text: "Đã thu hồi" } : null,
  };
}

/** "Lịch sử" tab: summary figures, group chips, one timeline (spec "Account history"). */
export default function HistoryTab() {
  const [group, setGroup] = useState("all");
  const [entries, setEntries] = useState([]);
  const [summary, setSummary] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [moreError, setMoreError] = useState("");
  // Only the latest request may write: a slow answer for an earlier filter must
  // not replace the list of the filter chosen since.
  const requestSeq = useRef(0);

  const fetchPage = useCallback(async (g, offset) => {
    const params = new URLSearchParams({ group: g, offset: String(offset), limit: String(PAGE_SIZE) });
    const res = await fetch(`/api/account/history?${params.toString()}`, { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Không tải được lịch sử");
    return data;
  }, []);

  const load = useCallback(async (g) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError("");
    setMoreError("");
    try {
      const data = await fetchPage(g, 0);
      if (seq !== requestSeq.current) return;
      setEntries(data.entries || []);
      setHasMore(Boolean(data.hasMore));
      if (data.summary) setSummary(data.summary);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setError(e.message || "Không tải được lịch sử");
      setEntries([]);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [fetchPage]);

  useEffect(() => { load(group); }, [group, load]);

  const more = async () => {
    const seq = requestSeq.current;
    setLoadingMore(true);
    setMoreError("");
    try {
      const data = await fetchPage(group, entries.length);
      if (seq !== requestSeq.current) return;
      // A new event between two pages shifts the offset by one: drop the repeat.
      setEntries((prev) => {
        const seen = new Set(prev.map((entry) => entry.id));
        return [...prev, ...(data.entries || []).filter((entry) => !seen.has(entry.id))];
      });
      setHasMore(Boolean(data.hasMore));
    } catch (e) {
      // Keep what is already shown; the error sits next to the button.
      if (seq === requestSeq.current) setMoreError(e.message || "Không tải thêm được");
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      {summary ? <Summary summary={summary} /> : null}

      <div className="flex flex-wrap gap-2" role="group" aria-label="Lọc lịch sử">
        {GROUPS.map((entry) => (
          <button
            key={entry.value}
            type="button"
            aria-pressed={group === entry.value}
            onClick={() => setGroup(entry.value)}
            className={cn(
              "h-8 border px-3 font-mono text-xs transition-colors duration-150",
              group === entry.value
                ? "border-text-main bg-text-main text-bg"
                : "border-border text-text-muted hover:bg-surface-2 hover:text-text-main"
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {error ? (
        <div role="alert" className="flex items-center justify-between gap-3 border border-red-500/40 bg-red-500/5 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          <span>{error}</span>
          <ActionButton size="sm" type="button" onClick={() => load(group)}>Thử lại</ActionButton>
        </div>
      ) : loading ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Đang tải lịch sử">
          {[0, 1, 2, 3, 4].map((i) => <div key={i} className="h-16 animate-pulse border border-border bg-surface-2" />)}
        </div>
      ) : entries.length === 0 ? (
        <Empty icon="history" title="Chưa có gì trong mục này" body="Các hoạt động của tài khoản sẽ xuất hiện ở đây." />
      ) : (
        <ol className="flex flex-col border border-border bg-surface">
          {entries.map((entry, index) => {
            const view = describe(entry);
            const newDay = index === 0 || dateOf(entries[index - 1].at) !== dateOf(entry.at);
            return (
              <li key={entry.id} className="border-b border-border last:border-b-0">
                {newDay ? (
                  <p className="meta border-b border-border bg-surface-2 px-5 py-2 text-text-muted">{dateOf(entry.at)}</p>
                ) : null}
                <div className="flex items-start gap-4 px-5 py-3.5">
                  <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center border border-border bg-surface-2 text-text-muted">
                    <span className="material-symbols-outlined text-[16px]" aria-hidden="true">{view.icon}</span>
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {view.href ? (
                        <Link href={view.href} className="text-sm font-medium text-text-main underline-offset-4 hover:underline">
                          {view.title}
                        </Link>
                      ) : (
                        <span className="text-sm font-medium text-text-main">{view.title}</span>
                      )}
                      {view.tag ? <Tag tone={view.tag.tone}>{view.tag.text}</Tag> : null}
                    </div>
                    {view.detail ? (
                      <p className="text-xs text-text-muted [overflow-wrap:anywhere]">{view.detail}</p>
                    ) : null}
                  </div>
                  <time dateTime={entry.at} className="shrink-0 font-mono text-xs text-text-muted">{timeOf(entry.at)}</time>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {hasMore && !loading && !error ? (
        <div className="flex flex-wrap items-center gap-3">
          <ActionButton type="button" loading={loadingMore} onClick={more}>Xem thêm</ActionButton>
          {moreError ? <p role="alert" className="text-sm text-red-700 dark:text-red-400">{moreError}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function Summary({ summary }) {
  const paid = Object.entries(summary.paidTotals || {})
    .map(([currency, amount]) => payText(currency, amount))
    .join(" · ");
  return (
    <Panel className="grid grid-cols-2 gap-x-6 gap-y-8 p-6 xl:grid-cols-4">
      <Stat label="Đơn đã thanh toán" value={String(summary.paidOrders ?? 0)} hint={paid || "Chưa có"} />
      <Stat label="Credit đã dùng" value={fmtUsdNano(summary.creditSpentNanoUsd ?? 0)} />
      <Stat label="Request đã tính phí" value={Number(summary.requestsCharged ?? 0).toLocaleString("vi-VN")} />
      <div className="col-span-2 flex min-w-0 flex-col gap-3 xl:col-span-1">
        <p className="meta text-text-muted">Tài khoản</p>
        <p className="text-sm text-text-main">
          Tạo ngày <span className="font-mono">{dateOf(summary.createdAt)}</span>
        </p>
        <p className="text-sm text-text-muted">
          Đăng nhập gần nhất <span className="font-mono">{dateTimeOf(summary.lastLoginAt)}</span>
        </p>
      </div>
    </Panel>
  );
}
