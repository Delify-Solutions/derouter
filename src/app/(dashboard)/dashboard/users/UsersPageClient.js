"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, Input, Modal, Pagination, Select, CardSkeleton } from "@/shared/components";
import { fmtUsdNano } from "@/shared/utils/money";

const STATUS_FILTERS = [
  { id: "", label: "Mọi trạng thái" },
  { id: "active", label: "Đang hoạt động" },
  { id: "unverified", label: "Chưa xác minh" },
  { id: "suspended", label: "Đang khóa" },
];

const PLAN_FILTERS = [
  { id: "", label: "Mọi gói" },
  { id: "active", label: "Đang có gói" },
  { id: "none", label: "Không có gói" },
  { id: "debt", label: "Đang nợ" },
];

const STATUS_STYLES = {
  active: "border-brand-500/30 bg-brand-500/10 text-brand-700 dark:text-brand-400",
  unverified: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  suspended: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400",
};

const STATUS_LABEL = { active: "Hoạt động", unverified: "Chưa xác minh", suspended: "Đang khóa" };

const PAGE_SIZE = 50;

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function StatusBadge({ status }) {
  const cls = STATUS_STYLES[status] || "border-border bg-surface-2 text-text-muted";
  return (
    <span className={`inline-flex items-center gap-1.5 border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${cls}`}>
      <span className="size-1.5 bg-current" aria-hidden="true" />
      {STATUS_LABEL[status] || status}
    </span>
  );
}

/**
 * Admin users list (spec admin-user-management "Users list").
 *
 * Server-driven now: search, the three filters, sorting and pagination are query
 * parameters, so the list shows the customers the operator asked for instead of
 * filtering a full download in the browser.
 *
 * A row navigates to `/dashboard/users/<id>`; the inline destructive controls are
 * gone from here on purpose — suspensions and deletions belong on the detail page
 * where they have a reason field and an audit trail.
 */
export default function UsersPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [data, setData] = useState({ users: [], total: 0, page: 1, pageSize: PAGE_SIZE, groups: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [settings, setSettings] = useState(null);

  const [q, setQ] = useState(searchParams.get("q") || "");
  const [groupFilter, setGroupFilter] = useState(searchParams.get("groupId") || "");
  const [statusFilter, setStatusFilter] = useState(searchParams.get("status") || "");
  const [planFilter, setPlanFilter] = useState(searchParams.get("planState") || "");
  const [sort, setSort] = useState(searchParams.get("sort") || "createdAt");
  const [dir, setDir] = useState(searchParams.get("dir") || "desc");
  const [page, setPage] = useState(Number(searchParams.get("page")) || 1);

  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState({ email: "", displayName: "", password: "", groupId: "" });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), sort, dir });
      if (q.trim()) params.set("q", q.trim());
      if (groupFilter) params.set("groupId", groupFilter);
      if (statusFilter) params.set("status", statusFilter);
      if (planFilter) params.set("planState", planFilter);

      const [res, settingsRes] = await Promise.all([
        fetch(`/api/users?${params.toString()}`, { cache: "no-store" }),
        fetch("/api/settings", { cache: "no-store" }),
      ]);

      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || "Không tải được danh sách người dùng");
        return;
      }
      setData({
        users: Array.isArray(body.users) ? body.users : [],
        total: Number(body.total) || 0,
        page: Number(body.page) || 1,
        pageSize: Number(body.pageSize) || PAGE_SIZE,
        groups: Array.isArray(body.groups) ? body.groups : [],
      });
      if (settingsRes.ok) setSettings(await settingsRes.json().catch(() => null));
    } catch {
      setError("Không kết nối được máy chủ");
    } finally {
      setLoading(false);
    }
  }, [page, sort, dir, q, groupFilter, statusFilter, planFilter]);

  useEffect(() => { load(); }, [load]);

  // Filter changes restart at page 1: page 7 of a different result set shows an
  // empty table the operator cannot explain.
  useEffect(() => { setPage(1); }, [q, groupFilter, statusFilter, planFilter, sort, dir]);

  const relayWarning =
    settings?.requireEmailVerification === true && !String(settings?.smtpRelayUrl || "").trim();

  const activeGroups = useMemo(
    () => data.groups.filter((group) => group.isActive !== false),
    [data.groups]
  );

  const toggleSort = (column) => {
    if (sort === column) {
      setDir(dir === "asc" ? "desc" : "asc");
    } else {
      setSort(column);
      setDir("desc");
    }
  };

  const sortLabel = (column) => (sort === column ? (dir === "asc" ? " ↑" : " ↓") : "");

  const submitCreate = async () => {
    setCreating(true);
    setCreateError("");
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: createDraft.email.trim(),
          displayName: createDraft.displayName.trim() || null,
          password: createDraft.password,
          groupId: createDraft.groupId || null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCreateError(body.error || "Không tạo được tài khoản");
        return;
      }
      setCreateOpen(false);
      setCreateDraft({ email: "", displayName: "", password: "", groupId: "" });
      await load();
    } catch {
      setCreateError("Không kết nối được máy chủ");
    } finally {
      setCreating(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <p className="meta text-text-muted">Khách hàng</p>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-text-main">Người dùng</h1>
            <p className="mt-1 max-w-2xl text-sm text-text-muted">
              Nhóm quyết định credit và model mà API key của khách được dùng. Bấm vào một dòng để
              quản lý gói, credit và phiên đăng nhập.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" icon="refresh" onClick={load}>Tải lại</Button>
            <Button size="sm" icon="person_add" onClick={() => setCreateOpen(true)}>Tạo tài khoản</Button>
          </div>
        </div>
      </header>

      {relayWarning && (
        <div
          role="alert"
          className="flex items-start gap-2 border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300"
        >
          <span className="material-symbols-outlined text-[18px] shrink-0" aria-hidden="true">warning</span>
          <span>
            Đang bật xác minh email nhưng chưa cấu hình mail relay — khách mới sẽ không nhận được
            mail xác minh. Cấu hình relay hoặc tắt xác minh email.
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[220px] flex-1">
          <Input
            label="Tìm kiếm"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="Email hoặc tên hiển thị"
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="meta text-text-muted">Nhóm</span>
          <Select
            value={groupFilter}
            onChange={(event) => setGroupFilter(event.target.value)}
            options={[{ value: "", label: "Mọi nhóm" }, ...data.groups.map((g) => ({ value: g.id, label: g.name }))]}
            selectClassName="h-10 py-0 text-[12px] font-mono"
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="meta text-text-muted">Trạng thái</span>
          <Select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            options={STATUS_FILTERS.map((f) => ({ value: f.id, label: f.label }))}
            selectClassName="h-10 py-0 text-[12px] font-mono"
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="meta text-text-muted">Gói</span>
          <Select
            value={planFilter}
            onChange={(event) => setPlanFilter(event.target.value)}
            options={PLAN_FILTERS.map((f) => ({ value: f.id, label: f.label }))}
            selectClassName="h-10 py-0 text-[12px] font-mono"
          />
        </div>
        <p className="ml-auto font-mono text-[11px] text-text-muted">{data.total} tài khoản</p>
      </div>

      {error && (
        <div role="alert" className="flex items-start justify-between gap-4 border border-danger/40 bg-danger/5 px-4 py-3">
          <span className="flex items-start gap-2 text-sm text-danger">
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">error</span>
            {error}
          </span>
          <Button variant="secondary" size="sm" onClick={load}>Thử lại</Button>
        </div>
      )}

      {loading ? (
        <CardSkeleton />
      ) : data.users.length === 0 ? (
        <div className="flex flex-col items-start gap-3 border border-border bg-surface px-6 py-14">
          <span className="material-symbols-outlined text-[28px] text-text-muted" aria-hidden="true">group</span>
          <p className="font-medium text-text-main">
            {data.total === 0 && !q && !groupFilter && !statusFilter && !planFilter
              ? "Chưa có người dùng nào"
              : "Không có người dùng khớp bộ lọc"}
          </p>
          <p className="max-w-md text-sm text-text-muted">
            {data.total === 0 && !q && !groupFilter && !statusFilter && !planFilter
              ? "Khi có người đăng ký qua trang công khai, họ sẽ hiện ở đây."
              : "Bỏ bộ lọc để xem toàn bộ tài khoản."}
          </p>
          {(q || groupFilter || statusFilter || planFilter) && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => { setQ(""); setGroupFilter(""); setStatusFilter(""); setPlanFilter(""); }}
            >
              Xóa bộ lọc
            </Button>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto border border-border bg-surface">
          <table className="w-full min-w-[980px] border-collapse text-left">
            <thead>
              <tr className="border-b border-border bg-surface-2">
                <th scope="col" className="meta px-4 py-2.5 font-medium text-text-muted">Email</th>
                <th scope="col" className="meta px-4 py-2.5 font-medium text-text-muted">Nhóm</th>
                <th scope="col" className="meta px-4 py-2.5 font-medium text-text-muted">Trạng thái</th>
                <th scope="col" className="meta px-4 py-2.5 font-medium text-text-muted">Gói</th>
                <th scope="col" className="meta px-4 py-2.5 text-right font-medium text-text-muted">
                  <button type="button" onClick={() => toggleSort("available")} className="hover:text-text-main">
                    Credit khả dụng{sortLabel("available")}
                  </button>
                </th>
                <th scope="col" className="meta px-4 py-2.5 text-right font-medium text-text-muted">
                  <button type="button" onClick={() => toggleSort("spend30d")} className="hover:text-text-main">
                    Chi 30 ngày{sortLabel("spend30d")}
                  </button>
                </th>
                <th scope="col" className="meta px-4 py-2.5 font-medium text-text-muted">Dùng gần nhất</th>
                <th scope="col" className="meta px-4 py-2.5 font-medium text-text-muted">
                  <button type="button" onClick={() => toggleSort("createdAt")} className="hover:text-text-main">
                    Tạo{sortLabel("createdAt")}
                  </button>
                </th>
                <th scope="col" className="meta px-4 py-2.5 font-medium text-text-muted">
                  <button type="button" onClick={() => toggleSort("lastLoginAt")} className="hover:text-text-main">
                    Đăng nhập{sortLabel("lastLoginAt")}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.users.map((user) => (
                <tr
                  key={user.id}
                  onClick={() => router.push(`/dashboard/users/${user.id}`)}
                  className="cursor-pointer border-b border-border last:border-b-0 transition-colors duration-150 hover:bg-surface-2/60"
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/dashboard/users/${user.id}`}
                      onClick={(event) => event.stopPropagation()}
                      className="block font-mono text-[12px] text-text-main break-all hover:underline"
                    >
                      {user.email}
                    </Link>
                    {user.displayName && <span className="text-xs text-text-muted">{user.displayName}</span>}
                  </td>
                  <td className="px-4 py-3 font-mono text-[12px] text-text-muted">{user.groupName || "—"}</td>
                  <td className="px-4 py-3"><StatusBadge status={user.status} /></td>
                  <td className="px-4 py-3 font-mono text-[12px] text-text-main">{user.queuedPlans}</td>
                  <td className="px-4 py-3 text-right font-mono text-[12px] text-text-main">
                    {fmtUsdNano(user.availableNanoUsd)}
                    {user.debtNanoUsd > 0 && (
                      <span className="ml-1 text-[10px] text-amber-600 dark:text-amber-400">
                        nợ {fmtUsdNano(user.debtNanoUsd)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-[12px] text-text-muted">
                    {fmtUsdNano(user.spend30dNanoUsd)}
                  </td>
                  <td className="px-4 py-3 font-mono text-[12px] text-text-muted">{formatDate(user.lastUsageAt)}</td>
                  <td className="px-4 py-3 font-mono text-[12px] text-text-muted">{formatDate(user.createdAt)}</td>
                  <td className="px-4 py-3 font-mono text-[12px] text-text-muted">{formatDate(user.lastLoginAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.total > data.pageSize && (
        <Pagination
          currentPage={data.page}
          pageSize={data.pageSize}
          totalItems={data.total}
          onPageChange={setPage}
        />
      )}

      <Modal
        isOpen={createOpen}
        onClose={() => { setCreateOpen(false); setCreateError(""); }}
        title="Tạo tài khoản"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setCreateOpen(false); setCreateError(""); }} disabled={creating}>
              Hủy
            </Button>
            <Button onClick={submitCreate} loading={creating}>Tạo</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Email"
            value={createDraft.email}
            onChange={(event) => setCreateDraft((d) => ({ ...d, email: event.target.value }))}
          />
          <Input
            label="Tên hiển thị"
            value={createDraft.displayName}
            onChange={(event) => setCreateDraft((d) => ({ ...d, displayName: event.target.value }))}
            placeholder="Không bắt buộc"
          />
          <Input
            label="Mật khẩu"
            type="password"
            value={createDraft.password}
            onChange={(event) => setCreateDraft((d) => ({ ...d, password: event.target.value }))}
            hint="10–200 ký tự"
          />
          <div className="flex flex-col gap-1">
            <label className="meta text-text-subtle">Nhóm</label>
            <Select
              value={createDraft.groupId}
              onChange={(event) => setCreateDraft((d) => ({ ...d, groupId: event.target.value }))}
              options={[
                { value: "", label: "Nhóm mặc định" },
                ...activeGroups.map((group) => ({ value: group.id, label: group.name })),
              ]}
            />
          </div>
          {createError && (
            <p role="alert" className="flex items-center gap-1 text-[11px] text-danger">
              <span className="material-symbols-outlined text-[14px]" aria-hidden="true">error</span>
              {createError}
            </p>
          )}
          <p className="text-[11px] text-text-subtle">
            Tài khoản được tạo ở trạng thái đã xác minh — admin bảo lãnh địa chỉ này.
          </p>
        </div>
      </Modal>
    </div>
  );
}
