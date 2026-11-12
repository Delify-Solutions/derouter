"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/shared/utils/cn";
import { ActionButton, Empty, Page, Section, Tag } from "@/app/account/components/ui";
import { TelegramLinkCard, useTelegramLink } from "@/app/account/components/TelegramLink";
import { dateTimeOf } from "@/shared/components/billing/StatusTag";

const TABS = [
  { value: "announcements", label: "Thông báo chung", icon: "campaign" },
  { value: "personal", label: "Của bạn", icon: "person" },
];

const KIND = {
  billing: { label: "Thanh toán", icon: "receipt" },
  expiry: { label: "Gói", icon: "event" },
  security: { label: "Bảo mật", icon: "shield" },
};

/**
 * Customer notifications (spec customer-portal "Notifications page"): admin
 * announcements, the customer's own notifications, the Telegram channel and
 * Telegram settings. Opening the page marks everything read, then refreshes the
 * layout so the menu badge drops.
 */
export default function NotificationsClient() {
  const router = useRouter();
  const [tab, setTab] = useState("announcements");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const marked = useRef(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await fetch("/api/account/notifications", { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Không tải được thông báo");
      setData(body);
      // Unread own notifications but no unread announcement: open that tab.
      if (body.personal?.some((n) => n.unread) && !body.announcements?.some((a) => a.unread)) setTab("personal");
      if (!marked.current && body.unread > 0) {
        marked.current = true;
        await fetch("/api/account/notifications/seen", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ upTo: body.asOf }),
        }).catch(() => {});
        router.refresh();
      }
    } catch (e) {
      setError(e.message || "Không tải được thông báo");
    }
  }, [router]);

  useEffect(() => { load(); }, [load]);

  const unreadOf = (list) => (list || []).filter((item) => item.unread).length;

  return (
    <Page title="Thông báo" description="Tin từ quản trị viên và các thông báo về tài khoản của bạn.">
      {data?.channelUrl ? (
        <a
          href={data.channelUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="-mt-4 flex items-center justify-between gap-4 border border-border bg-surface px-5 py-4 transition-colors duration-150 hover:border-text-main"
        >
          <span className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center border border-border bg-surface-2 text-text-main">
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">send</span>
            </span>
            <span className="flex flex-col">
              <span className="text-sm font-medium text-text-main">Tham gia kênh Telegram</span>
              <span className="text-xs text-text-muted">Tin bảo trì, model mới và khuyến mãi, cập nhật sớm nhất.</span>
            </span>
          </span>
          <span className="material-symbols-outlined text-[18px] text-text-muted" aria-hidden="true">open_in_new</span>
        </a>
      ) : null}

      <div className="flex flex-col gap-6">
        <div role="tablist" aria-label="Thông báo" className="flex items-stretch border-b border-border">
          {TABS.map((entry) => {
            const active = tab === entry.value;
            const count = data ? unreadOf(entry.value === "announcements" ? data.announcements : data.personal) : 0;
            return (
              <button
                key={entry.value}
                id={`ntab-${entry.value}`}
                role="tab"
                type="button"
                aria-selected={active}
                aria-controls={active ? `npanel-${entry.value}` : undefined}
                tabIndex={active ? 0 : -1}
                onClick={() => setTab(entry.value)}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                  event.preventDefault();
                  const next = TABS[(TABS.findIndex((t) => t.value === tab) + 1) % TABS.length];
                  setTab(next.value);
                  document.getElementById(`ntab-${next.value}`)?.focus();
                }}
                className={cn(
                  "-mb-px flex h-11 items-center gap-2 border-b-2 px-4 text-sm font-medium transition-colors duration-150",
                  active ? "border-b-text-main text-text-main" : "border-b-transparent text-text-muted hover:text-text-main"
                )}
              >
                <span className="material-symbols-outlined text-[18px]" aria-hidden="true">{entry.icon}</span>
                {entry.label}
                {count > 0 ? <span className="font-mono text-xs">({count} mới)</span> : null}
              </button>
            );
          })}
        </div>

        <div id={`npanel-${tab}`} role="tabpanel" aria-labelledby={`ntab-${tab}`}>
          {error ? (
            <div role="alert" className="flex items-center justify-between gap-3 border border-red-500/40 bg-red-500/5 px-4 py-3 text-sm text-red-700 dark:text-red-400">
              <span>{error}</span>
              <ActionButton size="sm" type="button" onClick={load}>Thử lại</ActionButton>
            </div>
          ) : !data ? (
            <div className="flex flex-col gap-2" aria-busy="true" aria-label="Đang tải thông báo">
              {[0, 1, 2].map((i) => <div key={i} className="h-20 animate-pulse border border-border bg-surface-2" />)}
            </div>
          ) : tab === "announcements" ? (
            data.announcements.length === 0 ? (
              <Empty icon="campaign" title="Chưa có thông báo nào" body="Thông báo từ quản trị viên sẽ hiện ở đây." />
            ) : (
              <ol className="flex flex-col gap-3">
                {data.announcements.map((a) => (
                  <li
                    key={a.id}
                    className={cn("flex flex-col gap-2 border bg-surface px-5 py-4", a.important ? "border-amber-500/50" : "border-border")}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold text-text-main">{a.title}</h3>
                      {a.important ? <Tag tone="warning" icon="priority_high">Quan trọng</Tag> : null}
                      {a.unread ? <Tag tone="success">Mới</Tag> : null}
                    </div>
                    <p className="whitespace-pre-line text-sm leading-6 text-text-muted [overflow-wrap:anywhere]">{a.body}</p>
                    <time dateTime={a.createdAt} className="font-mono text-xs text-text-subtle">{dateTimeOf(a.createdAt)}</time>
                  </li>
                ))}
              </ol>
            )
          ) : data.personal.length === 0 ? (
            <Empty icon="notifications" title="Chưa có thông báo nào cho bạn" body="Thanh toán, gói sắp hết hạn và cảnh báo bảo mật sẽ hiện ở đây." />
          ) : (
            <ol className="flex flex-col border border-border bg-surface">
              {data.personal.map((n) => {
                const kind = KIND[n.kind] || { label: n.kind, icon: "notifications" };
                return (
                  <li key={n.id} className="flex items-start gap-4 border-b border-border px-5 py-3.5 last:border-b-0">
                    <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center border border-border bg-surface-2 text-text-muted">
                      <span className="material-symbols-outlined text-[16px]" aria-hidden="true">{kind.icon}</span>
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-text-main">{n.title}</span>
                        <Tag>{kind.label}</Tag>
                        {n.unread ? <Tag tone="success">Mới</Tag> : null}
                      </div>
                      {n.body ? <p className="whitespace-pre-line text-xs leading-5 text-text-muted [overflow-wrap:anywhere]">{n.body}</p> : null}
                    </div>
                    <time dateTime={n.createdAt} className="shrink-0 font-mono text-xs text-text-muted">{dateTimeOf(n.createdAt)}</time>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>

      <TelegramSection />
    </Page>
  );
}

/** Link + per-type Telegram settings; hidden while the bot is not configured. */
function TelegramSection() {
  const { status } = useTelegramLink();
  if (!status?.configured) return null;
  return (
    <Section title="Telegram" description="Liên kết Telegram để nhận các thông báo này ngay trên điện thoại, và chọn loại thông báo muốn nhận.">
      <TelegramLinkCard className="border border-border bg-surface" />
    </Section>
  );
}
