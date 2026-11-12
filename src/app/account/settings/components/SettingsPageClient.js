"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/shared/utils/cn";
import { Page, Section, Panel, Tag } from "@/app/account/components/ui";
import { TelegramLinkCard, useTelegramLink } from "@/app/account/components/TelegramLink";
import { dateTimeOf } from "@/shared/components/billing/StatusTag";
import EmailChangeForm from "./EmailChangeForm";
import PasswordChangeForm from "./PasswordChangeForm";
import HistoryTab from "./HistoryTab";

const TABS = [
  { value: "security", label: "Bảo mật", icon: "shield_person" },
  { value: "history", label: "Lịch sử", icon: "history" },
];

/** Tabs of the account page; the choice is kept in `?tab=` so it survives a reload. */
export default function SettingsPageClient({ initialTab = "security", account }) {
  const [tab, setTab] = useState(initialTab);
  const email = account.email;
  const router = useRouter();
  const pathname = usePathname();

  const choose = (value) => {
    setTab(value);
    router.replace(value === "history" ? `${pathname}?tab=history` : pathname, { scroll: false });
  };

  return (
    <Page title="Tài khoản" description="Email đăng nhập, mật khẩu, Telegram và toàn bộ lịch sử của tài khoản.">
      <div
        role="tablist"
        aria-label="Tài khoản"
        className="-mt-4 flex items-stretch border-b border-border"
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const index = TABS.findIndex((entry) => entry.value === tab);
          const nextTab = TABS[(index + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
          choose(nextTab.value);
          document.getElementById(`tab-${nextTab.value}`)?.focus();
        }}
      >
        {TABS.map((entry) => {
          const active = tab === entry.value;
          return (
            <button
              key={entry.value}
              id={`tab-${entry.value}`}
              role="tab"
              type="button"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              aria-controls={`panel-${entry.value}`}
              onClick={() => choose(entry.value)}
              className={cn(
                "-mb-px flex h-11 items-center gap-2 border-b-2 px-4 text-sm font-medium transition-colors duration-150",
                active ? "border-b-text-main text-text-main" : "border-b-transparent text-text-muted hover:text-text-main"
              )}
            >
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">{entry.icon}</span>
              {entry.label}
            </button>
          );
        })}
      </div>

      {tab === "security" ? (
        <div id="panel-security" role="tabpanel" aria-labelledby="tab-security" className="flex flex-col gap-12">
          <Section title="Thông tin" description="Email dùng để đăng nhập và nhận thư về tài khoản.">
            <Panel className="grid gap-5 p-6 sm:grid-cols-2">
              <Info label="Email đăng nhập" value={email} mono />
              <Info
                label="Trạng thái"
                value={account.status === "unverified"
                  ? <Tag tone="warning" icon="mark_email_unread">Chưa xác minh email</Tag>
                  : <Tag tone="success" icon="verified_user">Đang hoạt động</Tag>}
              />
              <Info label="Ngày tạo" value={dateTimeOf(account.createdAt)} mono />
              <Info label="Đăng nhập gần nhất" value={dateTimeOf(account.lastLoginAt)} mono />
            </Panel>
          </Section>

          <Section
            title="Đổi email"
            description="Nhập email mới và mật khẩu hiện tại. Email chỉ đổi sau khi bạn mở liên kết xác nhận gửi tới địa chỉ mới."
          >
            <EmailChangeForm currentEmail={email} />
          </Section>

          <Section
            title="Đổi mật khẩu"
            description="Sau khi đổi, các phiên đăng nhập khác sẽ bị đăng xuất. Phiên này vẫn giữ."
          >
            <PasswordChangeForm />
          </Section>

          <TelegramSection />
        </div>
      ) : (
        <div id="panel-history" role="tabpanel" aria-labelledby="tab-history">
          <HistoryTab />
        </div>
      )}
    </Page>
  );
}

/** Hidden entirely while the Telegram bot is not configured. */
function TelegramSection() {
  const { status } = useTelegramLink();
  if (!status?.configured) return null;
  return (
    <Section title="Telegram" description="Nhận thông báo bảo mật và thanh toán qua Telegram.">
      <TelegramLinkCard className="border border-border bg-surface" />
    </Section>
  );
}

function Info({ label, value, mono = false }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className="meta text-text-muted">{label}</p>
      <div className={cn("min-w-0 text-sm text-text-main [overflow-wrap:anywhere]", mono && "font-mono")}>{value}</div>
    </div>
  );
}
