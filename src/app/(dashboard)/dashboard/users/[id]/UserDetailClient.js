"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Button, CardSkeleton } from "@/shared/components";
import { fmtUsdNano } from "@/shared/utils/money";

import OverviewTab from "./components/OverviewTab";
import PlansTab from "./components/PlansTab";
import OrdersTab from "./components/OrdersTab";
import LedgerTab from "./components/LedgerTab";
import UsageTab from "./components/UsageTab";
import KeysTab from "./components/KeysTab";
import SessionsTab from "./components/SessionsTab";
import GiftsTab from "./components/GiftsTab";
import AuditTab from "./components/AuditTab";

// The nine tabs of the spec, in its order. `?tab=<id>` selects one; an unknown value
// falls back to the overview rather than a blank screen.
const TABS = [
  { id: "overview", label: "Tổng quan" },
  { id: "plans", label: "Gói" },
  { id: "orders", label: "Đơn hàng" },
  { id: "ledger", label: "Sổ cái" },
  { id: "usage", label: "Usage" },
  { id: "keys", label: "API key" },
  { id: "sessions", label: "Phiên đăng nhập" },
  { id: "gifts", label: "Mã quà tặng" },
  { id: "audit", label: "Nhật ký" },
];

const STATUS_LABEL = { active: "Hoạt động", unverified: "Chưa xác minh", suspended: "Đang khoá" };

/**
 * `/dashboard/users/[id]` — everything about one customer, on nine tabs.
 *
 * The shell owns the load and the header; each tab owns its own data so switching
 * tabs does not refetch what is already on screen, and a slow tab (usage, audit)
 * never blocks the summary.
 */
export default function UserDetailClient() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = params?.id;

  const tabParam = searchParams.get("tab") || "overview";
  const activeTab = TABS.some((tab) => tab.id === tabParam) ? tabParam : "overview";

  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState({ user: null, summary: null });

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/users/${id}`, { cache: "no-store" });
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || "Không tải được người dùng");
        return;
      }
      setData({ user: body.user ?? null, summary: body.summary ?? null });
    } catch {
      setError("Không kết nối được máy chủ");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const selectTab = (tabId) => {
    const next = new URLSearchParams(searchParams.toString());
    next.set("tab", tabId);
    router.replace(`/dashboard/users/${id}?${next.toString()}`, { scroll: false });
  };

  const user = data.user;
  const summary = data.summary;

  const headerLine = useMemo(() => {
    if (!user) return "";
    const parts = [user.groupName || "Chưa có nhóm", STATUS_LABEL[user.status] || user.status];
    if (summary) parts.push(`${fmtUsdNano(summary.availableNanoUsd)} khả dụng`);
    if (summary?.debtNanoUsd > 0) parts.push(`nợ ${fmtUsdNano(summary.debtNanoUsd)}`);
    return parts.join(" · ");
  }, [user, summary]);

  if (notFound) {
    return (
      <div className="flex flex-col items-start gap-3 border border-border bg-surface px-6 py-14">
        <span className="material-symbols-outlined text-[28px] text-text-muted" aria-hidden="true">person_off</span>
        <p className="font-medium text-text-main">Không tìm thấy người dùng này</p>
        <p className="max-w-md text-sm text-text-muted">
          Tài khoản có thể đã bị xoá. Nhật ký của tài khoản đã xoá vẫn xem được ở tab Nhật ký nếu bạn
          còn id.
        </p>
        <Link
          href="/dashboard/users"
          className="inline-flex h-9 items-center border border-border px-4 font-mono text-[12px] uppercase tracking-[0.08em] text-text-main hover:bg-surface-2"
        >
          Về danh sách người dùng
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link href="/dashboard/users" className="meta text-text-muted hover:text-text-main">
          ← Người dùng
        </Link>
        {loading ? (
          <div className="h-8 w-64 bg-surface-2" aria-hidden="true" />
        ) : (
          <>
            <h1 className="break-all text-2xl font-semibold text-text-main">{user?.displayName || user?.email}</h1>
            <p className="font-mono text-[12px] text-text-muted">{headerLine}</p>
          </>
        )}
      </div>

      {error && (
        <div role="alert" className="flex items-start justify-between gap-4 border border-danger/40 bg-danger/5 px-4 py-3">
          <span className="flex items-start gap-2 text-sm text-danger">
            <span className="material-symbols-outlined text-[18px] inline" aria-hidden="true">error</span>
            {error}
          </span>
          <Button variant="secondary" size="sm" onClick={load}>Thử lại</Button>
        </div>
      )}

      <nav aria-label="Các tab của người dùng" className="flex overflow-x-auto border-b border-border">
        {TABS.map((tab) => {
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => selectTab(tab.id)}
              aria-current={isActive ? "page" : undefined}
              className={`h-10 whitespace-nowrap border-b-2 px-4 font-mono text-[12px] uppercase tracking-[0.08em] transition-colors duration-150 ${
                isActive
                  ? "border-b-brand-500 text-text-main"
                  : "border-b-transparent text-text-muted hover:text-text-main"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>

      {loading ? (
        <CardSkeleton />
      ) : (
        <>
          {activeTab === "overview" && <OverviewTab user={user} summary={summary} onChanged={load} />}
          {activeTab === "plans" && <PlansTab userId={id} onChanged={load} />}
          {activeTab === "orders" && <OrdersTab userId={id} />}
          {activeTab === "ledger" && <LedgerTab userId={id} />}
          {activeTab === "usage" && <UsageTab userId={id} />}
          {activeTab === "keys" && <KeysTab userId={id} />}
          {activeTab === "sessions" && <SessionsTab userId={id} />}
          {activeTab === "gifts" && <GiftsTab userId={id} />}
          {activeTab === "audit" && <AuditTab userId={id} />}
        </>
      )}
    </div>
  );
}
