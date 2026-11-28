"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, Input, Modal, Pagination, Select, CardSkeleton, Table, Badge, Card } from "@/shared/components";
import { fmtUsdNano, fmtCreditNano } from "@/shared/utils/money";
import { cn } from "@/shared/utils/cn";

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

const UNLIMITED_FILTERS = [
  { id: "", label: "Mọi tài khoản" },
  { id: "yes", label: "Chỉ unlimited" },
  { id: "no", label: "Không unlimited" },
];

// Every value userPlans.source is ever written with (adminUsersRepo.js SOURCE_COLUMN) —
// "nạp" (purchase) vs "gift" split further into who actually granted it.
const SOURCES = [
  { id: "purchase", label: "Nạp", short: "Nạp" },
  { id: "gift", label: "Gift (mã quà tặng)", short: "Gift" },
  { id: "admin", label: "Admin cấp tay", short: "Admin" },
  { id: "affiliate", label: "Hoa hồng affiliate", short: "Affiliate" },
  { id: "referral_bonus", label: "Thưởng giới thiệu", short: "Giới thiệu" },
];

const EMPTY_SUMMARY = {
  totalAvailableNanoUsd: 0,
  unlimitedCount: 0,
  bySource: { purchase: 0, gift: 0, admin: 0, affiliate: 0, referral_bonus: 0 },
};

const STATUS_VARIANT = { active: "success", unverified: "warning", suspended: "error" };

const STATUS_LABEL = { active: "Hoạt động", unverified: "Chưa xác minh", suspended: "Đang khóa" };

const PAGE_SIZE = 50;

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/** One tile in the KPI strip: a label and a mono value, square-bordered, no fill. */
function Kpi({ label, value }) {
  return (
    <div className="flex flex-col gap-1 border border-border bg-surface px-3 py-2.5">
      <span className="meta text-text-muted">{label}</span>
      <span className="font-mono text-sm font-semibold text-text-main">{value}</span>
    </div>
  );
}

/**
 * Totals for the currently filtered (but unpaged) result set: how much credit is
 * left in total, split by who granted it, and how many of the matching accounts
 * are on an unlimited plan. Lets the operator read the numbers straight off the
 * page instead of exporting and summing them by hand.
 */
function SummaryKpis({ summary }) {
  const bySource = summary?.bySource || EMPTY_SUMMARY.bySource;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-7">
      <Kpi label="Tổng số dư còn lại" value={fmtUsdNano(summary?.totalAvailableNanoUsd ?? 0)} />
      {SOURCES.map((s) => (
        <Kpi key={s.id} label={s.short} value={fmtUsdNano(bySource[s.id] ?? 0)} />
      ))}
      <Kpi label="Tài khoản unlimited" value={String(summary?.unlimitedCount ?? 0)} />
    </div>
  );
}

function StatusBadge({ status }) {
  return (
    <Badge variant={STATUS_VARIANT[status] || "default"} dot>
      {STATUS_LABEL[status] || status}
    </Badge>
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

  const [data, setData] = useState({ users: [], total: 0, page: 1, pageSize: PAGE_SIZE, groups: [], summary: EMPTY_SUMMARY });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [settings, setSettings] = useState(null);

  const [q, setQ] = useState(searchParams.get("q") || "");
  const [groupFilter, setGroupFilter] = useState(searchParams.get("groupId") || "");
  const [statusFilter, setStatusFilter] = useState(searchParams.get("status") || "");
  const [planFilter, setPlanFilter] = useState(searchParams.get("planState") || "");
  const [unlimitedFilter, setUnlimitedFilter] = useState(searchParams.get("unlimited") || "");
  const [balanceMin, setBalanceMin] = useState(searchParams.get("balanceMinUsd") || "");
  const [balanceMax, setBalanceMax] = useState(searchParams.get("balanceMaxUsd") || "");
  const [sourcesFilter, setSourcesFilter] = useState(() => new Set(
    (searchParams.get("sources") || "").split(",").map((s) => s.trim()).filter(Boolean)
  ));
  const [sort, setSort] = useState(searchParams.get("sort") || "createdAt");
  const [dir, setDir] = useState(searchParams.get("dir") || "desc");
  const [page, setPage] = useState(Number(searchParams.get("page")) || 1);

  const toggleSource = (id) => {
    setSourcesFilter((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Bulk selection. Cleared whenever the visible page changes (filter, sort, page),
  // because a selection the operator can no longer see is a mis-delete waiting to
  // happen.
  const [selected, setSelected] = useState(() => new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkReason, setBulkReason] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState(null);

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
      if (unlimitedFilter) params.set("unlimited", unlimitedFilter);
      if (balanceMin.trim()) params.set("balanceMinUsd", balanceMin.trim());
      if (balanceMax.trim()) params.set("balanceMaxUsd", balanceMax.trim());
      if (sourcesFilter.size > 0) params.set("sources", [...sourcesFilter].join(","));

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
        summary: body.summary && typeof body.summary === "object" ? body.summary : EMPTY_SUMMARY,
      });
      if (settingsRes.ok) setSettings(await settingsRes.json().catch(() => null));
    } catch {
      setError("Không kết nối được máy chủ");
    } finally {
      setLoading(false);
    }
  }, [page, sort, dir, q, groupFilter, statusFilter, planFilter, unlimitedFilter, balanceMin, balanceMax, sourcesFilter]);

  useEffect(() => { load(); }, [load]);

  // Filter changes restart at page 1: page 7 of a different result set shows an
  // empty table the operator cannot explain.
  useEffect(() => {
    setPage(1);
  }, [q, groupFilter, statusFilter, planFilter, unlimitedFilter, balanceMin, balanceMax, sourcesFilter, sort, dir]);

  const relayWarning =
    settings?.requireEmailVerification === true && !String(settings?.smtpRelayUrl || "").trim();

  const activeGroups = useMemo(
    () => data.groups.filter((group) => group.isActive !== false),
    [data.groups]
  );

  // A new page/filter/sort means a different result set; keeping hidden ids selected
  // is how an operator deletes accounts they never looked at.
  useEffect(() => {
    setSelected(new Set());
    setBulkResult(null);
  }, [page, q, groupFilter, statusFilter, planFilter, unlimitedFilter, balanceMin, balanceMax, sourcesFilter, sort, dir]);

  const hasAnyFilter = Boolean(
    q || groupFilter || statusFilter || planFilter || unlimitedFilter || balanceMin || balanceMax || sourcesFilter.size > 0
  );

  const pageIds = useMemo(() => data.users.map((user) => user.id), [data.users]);
  const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));

  const toggleOne = (id) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllOnPage = () => {
    setSelected((current) => {
      const next = new Set(current);
      if (pageIds.every((id) => next.has(id))) pageIds.forEach((id) => next.delete(id));
      else pageIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const runBulkDelete = async () => {
    const reason = bulkReason.trim();
    if (reason.length < 3) return;
    setBulkBusy(true);
    setBulkResult(null);
    try {
      const res = await fetch("/api/users", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userIds: [...selected], reason }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setBulkResult({ error: body.error || "Không xoá được" });
        return;
      }
      setBulkResult(body);
      setSelected(new Set());
      setBulkReason("");
      setBulkOpen(false);
      await load();
    } catch {
      setBulkResult({ error: "Không kết nối được máy chủ" });
    } finally {
      setBulkBusy(false);
    }
  };

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

      <SummaryKpis summary={data.summary} />

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[220px] flex-1">
          <Input
            label="Tìm kiếm"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="Email, tên hiển thị hoặc IP"
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
        <div className="flex flex-col gap-1">
          <span className="meta text-text-muted">Unlimited</span>
          <Select
            value={unlimitedFilter}
            onChange={(event) => setUnlimitedFilter(event.target.value)}
            options={UNLIMITED_FILTERS.map((f) => ({ value: f.id, label: f.label }))}
            selectClassName="h-10 py-0 text-[12px] font-mono"
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="meta text-text-muted">Số dư từ ($)</span>
          <Input
            type="number"
            value={balanceMin}
            onChange={(event) => setBalanceMin(event.target.value)}
            placeholder="0"
            className="w-24"
            inputClassName="h-10 py-0"
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="meta text-text-muted">đến ($)</span>
          <Input
            type="number"
            value={balanceMax}
            onChange={(event) => setBalanceMax(event.target.value)}
            placeholder="∞"
            className="w-24"
            inputClassName="h-10 py-0"
          />
        </div>
        <p className="ml-auto font-mono text-[11px] text-text-muted">{data.total} tài khoản</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="meta text-text-muted">Nguồn credit</span>
        {SOURCES.map((s) => {
          const active = sourcesFilter.has(s.id);
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => toggleSource(s.id)}
              aria-pressed={active}
              title={s.label}
              className={cn(
                "h-8 border px-3 font-mono text-xs font-medium transition-colors duration-150",
                active
                  ? "border-text-main bg-text-main text-bg"
                  : "border-border bg-surface text-text-muted hover:text-text-main"
              )}
            >
              {s.short}
            </button>
          );
        })}
        {sourcesFilter.size > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setSourcesFilter(new Set())}>Bỏ lọc nguồn</Button>
        )}
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
        <Card padding="lg" className="flex flex-col items-start gap-3">
          <span className="material-symbols-outlined text-[28px] text-text-muted" aria-hidden="true">group</span>
          <p className="font-medium text-text-main">
            {data.total === 0 && !hasAnyFilter
              ? "Chưa có người dùng nào"
              : "Không có người dùng khớp bộ lọc"}
          </p>
          <p className="max-w-md text-sm text-text-muted">
            {data.total === 0 && !hasAnyFilter
              ? "Khi có người đăng ký qua trang công khai, họ sẽ hiện ở đây."
              : "Bỏ bộ lọc để xem toàn bộ tài khoản."}
          </p>
          {hasAnyFilter && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setQ(""); setGroupFilter(""); setStatusFilter(""); setPlanFilter("");
                setUnlimitedFilter(""); setBalanceMin(""); setBalanceMax(""); setSourcesFilter(new Set());
              }}
            >
              Xóa bộ lọc
            </Button>
          )}
        </Card>
      ) : (
        <>
        {selected.size > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border border-danger/40 bg-danger/5 px-4 py-3">
            <span className="text-sm text-text-main">
              Đã chọn <b>{selected.size}</b> tài khoản
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>Bỏ chọn</Button>
              <Button
                variant="secondary"
                size="sm"
                className="text-danger"
                onClick={() => { setBulkResult(null); setBulkOpen(true); }}
              >
                Xoá đã chọn
              </Button>
            </div>
          </div>
        )}
        <Table className="min-w-[1480px] text-left">
          <Table.Head>
            <tr>
              <Table.HeaderCell className="w-10">
                <input
                  type="checkbox"
                  className="size-4 accent-brand-500"
                  checked={allOnPageSelected}
                  onChange={toggleAllOnPage}
                  aria-label="Chọn tất cả tài khoản trên trang này"
                />
              </Table.HeaderCell>
              <Table.HeaderCell>Email</Table.HeaderCell>
              <Table.HeaderCell>Nhóm</Table.HeaderCell>
              <Table.HeaderCell>Trạng thái</Table.HeaderCell>
              <Table.HeaderCell>Gói</Table.HeaderCell>
              <Table.HeaderCell className="text-right">
                <button type="button" onClick={() => toggleSort("available")} className="hover:text-text-main">
                  Credit khả dụng{sortLabel("available")}
                </button>
              </Table.HeaderCell>
              {SOURCES.map((s) => (
                <Table.HeaderCell key={s.id} className="text-right" title={s.label}>
                  {s.short}
                </Table.HeaderCell>
              ))}
              <Table.HeaderCell className="text-right">
                <button type="button" onClick={() => toggleSort("spend30d")} className="hover:text-text-main">
                  Chi 30 ngày{sortLabel("spend30d")}
                </button>
              </Table.HeaderCell>
              <Table.HeaderCell>Dùng gần nhất</Table.HeaderCell>
              <Table.HeaderCell>
                <button type="button" onClick={() => toggleSort("createdAt")} className="hover:text-text-main">
                  Tạo{sortLabel("createdAt")}
                </button>
              </Table.HeaderCell>
              <Table.HeaderCell>
                <button type="button" onClick={() => toggleSort("lastLoginAt")} className="hover:text-text-main">
                  Đăng nhập{sortLabel("lastLoginAt")}
                </button>
              </Table.HeaderCell>
            </tr>
          </Table.Head>
          <Table.Body>
            {data.users.map((user) => (
              <Table.Row
                key={user.id}
                onClick={() => router.push(`/dashboard/users/${user.id}`)}
              >
                <Table.Cell onClick={(event) => event.stopPropagation()}>
                  <input
                    type="checkbox"
                    className="size-4 accent-brand-500"
                    checked={selected.has(user.id)}
                    onChange={() => toggleOne(user.id)}
                    aria-label={`Chọn ${user.email}`}
                  />
                </Table.Cell>
                <Table.Cell>
                  <Link
                    href={`/dashboard/users/${user.id}`}
                    onClick={(event) => event.stopPropagation()}
                    className="block font-mono text-[12px] text-text-main break-all hover:underline"
                  >
                    {user.email}
                  </Link>
                  {user.displayName && <span className="text-xs text-text-muted">{user.displayName}</span>}
                </Table.Cell>
                <Table.Cell className="font-mono text-[12px] text-text-muted">{user.groupName || "—"}</Table.Cell>
                <Table.Cell><StatusBadge status={user.status} /></Table.Cell>
                <Table.Cell className="font-mono text-[12px] text-text-main">{user.queuedPlans}</Table.Cell>
                <Table.Cell className="text-right font-mono text-[12px] text-text-main">
                  {user.hasUnlimitedCredit ? fmtCreditNano(0, true) : fmtUsdNano(user.availableNanoUsd)}
                  {user.debtNanoUsd > 0 && (
                    <span className="ml-1 text-[10px] text-amber-600 dark:text-amber-400">
                      nợ {fmtUsdNano(user.debtNanoUsd)}
                    </span>
                  )}
                </Table.Cell>
                {SOURCES.map((s) => {
                  const amount = user.bySource?.[s.id] ?? 0;
                  return (
                    <Table.Cell key={s.id} className="text-right font-mono text-[12px] text-text-muted">
                      {amount > 0 ? fmtUsdNano(amount) : "—"}
                    </Table.Cell>
                  );
                })}
                <Table.Cell className="text-right font-mono text-[12px] text-text-muted">
                  {fmtUsdNano(user.spend30dNanoUsd)}
                </Table.Cell>
                <Table.Cell className="font-mono text-[12px] text-text-muted">{formatDate(user.lastUsageAt)}</Table.Cell>
                <Table.Cell className="font-mono text-[12px] text-text-muted">{formatDate(user.createdAt)}</Table.Cell>
                <Table.Cell className="font-mono text-[12px] text-text-muted">{formatDate(user.lastLoginAt)}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
        </>
      )}

      {data.total > data.pageSize && (
        <Pagination
          currentPage={data.page}
          pageSize={data.pageSize}
          totalItems={data.total}
          onPageChange={setPage}
        />
      )}

      {/* Bulk delete: the single-account route confirms with the account's email,
          which is unusable for a selection — a written reason plus an explicit
          count is the confirmation here. */}
      <Modal
        isOpen={bulkOpen}
        onClose={() => { if (!bulkBusy) setBulkOpen(false); }}
        title="Xoá tài khoản đã chọn"
        footer={
          <>
            <Button variant="ghost" onClick={() => setBulkOpen(false)} disabled={bulkBusy}>Huỷ</Button>
            <Button
              variant="secondary"
              className="text-danger"
              onClick={runBulkDelete}
              disabled={bulkBusy || bulkReason.trim().length < 3}
            >
              {bulkBusy ? "Đang xoá…" : `Xoá ${selected.size} tài khoản`}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-main">
            Xoá vĩnh viễn <b>{selected.size}</b> tài khoản cùng gói, API key, credit, nhật ký và hội thoại hỗ trợ.
            Đơn hàng đã thanh toán vẫn được giữ để đối soát. Không khôi phục được.
          </p>
          <ul className="max-h-40 overflow-y-auto border border-border bg-surface-2 px-4 py-2 font-mono text-[12px] text-text-muted">
            {data.users.filter((user) => selected.has(user.id)).map((user) => (
              <li key={user.id} className="truncate py-0.5">{user.email}</li>
            ))}
          </ul>
          <label className="flex flex-col gap-2">
            <span className="meta text-text-muted">Lý do*</span>
            <Input
              value={bulkReason}
              onChange={(event) => setBulkReason(event.target.value)}
              placeholder="Ví dụ: dọn tài khoản test do trùng email"
              maxLength={500}
              autoFocus
            />
            <span className="text-xs text-text-muted">3–500 ký tự. Ghi vào nhật ký của từng tài khoản.</span>
          </label>
          {bulkResult?.error && (
            <p role="alert" className="text-sm text-red-700 dark:text-red-400">{bulkResult.error}</p>
          )}
        </div>
      </Modal>

      {bulkResult && !bulkResult.error && (
        <div role="status" className="border border-border bg-surface-2 px-4 py-3 text-sm text-text-main">
          Đã xoá {bulkResult.deleted?.length ?? 0} tài khoản
          {bulkResult.missing?.length ? ` · ${bulkResult.missing.length} không còn tồn tại` : ""}
          {bulkResult.failed?.length ? ` · ${bulkResult.failed.length} lỗi` : ""}.
        </div>
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
