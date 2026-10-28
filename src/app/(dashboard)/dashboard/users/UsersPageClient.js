"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, CardSkeleton, ConfirmModal, Select, Modal, Input } from "@/shared/components";
import { fmtUsdNano } from "@/shared/utils/money";

const STATUS_FILTERS = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "unverified", label: "Unverified" },
  { id: "suspended", label: "Suspended" },
];

const STATUS_STYLES = {
  active: "border-brand-500/30 bg-brand-500/10 text-brand-700 dark:text-brand-400",
  unverified: "border-yellow-500/30 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400",
  suspended: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
};

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().replace("T", " ").slice(0, 16);
}

function StatusBadge({ status }) {
  const cls = STATUS_STYLES[status] || "border-border bg-surface-2 text-text-muted";
  return (
    <span className={`inline-flex items-center gap-1.5 border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${cls}`}>
      <span className="size-1.5 bg-current" aria-hidden="true" />
      {status}
    </span>
  );
}

export default function UsersPageClient() {
  const [users, setUsers] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [confirmState, setConfirmState] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState({ email: "", displayName: "", password: "", groupId: "" });
  const [creating, setCreating] = useState(false);
  const [resetTarget, setResetTarget] = useState(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetting, setResetting] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const [usersRes, groupsRes] = await Promise.all([fetch("/api/users"), fetch("/api/groups")]);
      const usersData = await usersRes.json().catch(() => ({}));
      if (!usersRes.ok) {
        setError(usersData.error || "Could not load users");
        return;
      }
      setUsers(Array.isArray(usersData.users) ? usersData.users : []);

      if (groupsRes.ok) {
        const groupsData = await groupsRes.json().catch(() => ({}));
        setGroups(Array.isArray(groupsData.groups) ? groupsData.groups : []);
      }
    } catch {
      setError("Could not reach the server");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(
    () => (statusFilter === "all" ? users : users.filter((user) => user.status === statusFilter)),
    [users, statusFilter]
  );

  const counts = useMemo(() => {
    const base = { all: users.length, active: 0, unverified: 0, suspended: 0 };
    for (const user of users) {
      if (base[user.status] != null) base[user.status] += 1;
    }
    return base;
  }, [users]);

  const groupOptions = useMemo(
    () => groups.map((group) => ({ value: group.id, label: group.name })),
    [groups]
  );

  const patchUser = async (id, body) => {
    setBusyId(id);
    setError("");
    try {
      const res = await fetch(`/api/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Could not update the user");
        return;
      }
      setUsers((prev) =>
        prev.map((user) =>
          user.id === id
            ? {
                ...user,
                ...data.user,
                groupName:
                  data.user?.groupId != null
                    ? groups.find((group) => group.id === data.user.groupId)?.name ?? null
                    : null,
              }
            : user
        )
      );
    } catch {
      setError("Could not reach the server");
    } finally {
      setBusyId(null);
    }
  };

  const submitCreate = async () => {
    setCreating(true);
    setError("");
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
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Không tạo được tài khoản");
        return;
      }
      setCreateOpen(false);
      setCreateDraft({ email: "", displayName: "", password: "", groupId: "" });
      await load();
    } catch {
      setError("Không kết nối được máy chủ");
    } finally {
      setCreating(false);
    }
  };

  const submitReset = async () => {
    if (!resetTarget) return;
    setResetting(true);
    setError("");
    try {
      const res = await fetch(`/api/users/${resetTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: resetPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Không đặt lại được mật khẩu");
        return;
      }
      setResetTarget(null);
      setResetPassword("");
    } catch {
      setError("Không kết nối được máy chủ");
    } finally {
      setResetting(false);
    }
  };

  const removeUser = (user) => {
    setConfirmState({
      title: "Delete user",
      message: `Delete ${user.email}?\n\nTheir API keys and sessions are revoked immediately. This cannot be undone.`,
      onConfirm: async () => {
        setConfirmState(null);
        setBusyId(user.id);
        setError("");
        try {
          const res = await fetch(`/api/users/${user.id}`, { method: "DELETE" });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            setError(data.error || "Could not delete the user");
            return;
          }
          setUsers((prev) => prev.filter((row) => row.id !== user.id));
        } catch {
          setError("Could not reach the server");
        } finally {
          setBusyId(null);
        }
      },
    });
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-8">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <p className="meta text-text-muted">Khách hàng</p>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h1 className="text-2xl font-semibold text-text-main">Người dùng</h1>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" icon="refresh" onClick={load}>
              Tải lại
            </Button>
            <Button size="sm" icon="person_add" onClick={() => setCreateOpen(true)}>
              Tạo tài khoản
            </Button>
          </div>
        </div>
        <p className="text-sm text-text-muted max-w-2xl">
          Tài khoản khách hàng. Nhóm quyết định hạn mức mà API key của họ kế thừa.
        </p>
      </header>

      {error && (
        <div
          role="alert"
          className="border border-red-600/30 bg-red-500/10 text-red-600 dark:text-red-400 text-sm px-4 py-3 flex items-start justify-between gap-4"
        >
          <span className="flex items-start gap-2">
            <span className="material-symbols-outlined text-[18px] mt-0.5">error</span>
            {error}
          </span>
          <button
            type="button"
            onClick={load}
            className="meta text-red-600 dark:text-red-400 hover:underline shrink-0"
          >
            Retry
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {STATUS_FILTERS.map((filter) => (
          <button
            key={filter.id}
            type="button"
            onClick={() => setStatusFilter(filter.id)}
            aria-pressed={statusFilter === filter.id}
            className={`h-8 px-3 border font-mono text-[11px] uppercase tracking-[0.08em] transition-colors duration-150 ${
              statusFilter === filter.id
                ? "border-brand-500 text-brand-600 dark:text-brand-400 bg-brand-500/10"
                : "border-border text-text-muted hover:text-text-main hover:bg-surface-2"
            }`}
          >
            {filter.label}
            <span className="ml-2 text-text-subtle">{counts[filter.id] ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="border border-border bg-surface">
        {filtered.length === 0 ? (
          <div className="px-6 py-14 flex flex-col items-start gap-3">
            <span className="material-symbols-outlined text-[28px] text-text-muted">group</span>
            <p className="text-text-main font-medium">
              {users.length === 0 ? "No users yet" : "No users match this filter"}
            </p>
            <p className="text-sm text-text-muted max-w-md">
              {users.length === 0
                ? "Once someone registers through the public signup form they appear here with their group, status and balance."
                : "Switch back to All to see every account."}
            </p>
            {users.length === 0 ? (
              <a
                href="/dashboard/profile"
                className="inline-flex items-center h-9 px-4 border border-border font-mono text-[12px] uppercase tracking-[0.08em] text-text-main hover:bg-surface-2 transition-colors duration-150"
              >
                Configure public signup
              </a>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => setStatusFilter("all")}>
                Show all
              </Button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className="meta text-text-muted font-medium px-4 py-3">Email</th>
                  <th className="meta text-text-muted font-medium px-4 py-3">Group</th>
                  <th className="meta text-text-muted font-medium px-4 py-3">Status</th>
                  <th className="meta text-text-muted font-medium px-4 py-3">Keys</th>
                  <th className="meta text-text-muted font-medium px-4 py-3">Balance</th>
                  <th className="meta text-text-muted font-medium px-4 py-3">Created</th>
                  <th className="meta text-text-muted font-medium px-4 py-3">Last login</th>
                  <th className="meta text-text-muted font-medium px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((user) => (
                  <tr key={user.id} className="border-b border-border last:border-b-0 hover:bg-surface-2/50 transition-colors duration-150">
                    <td className="px-4 py-3">
                      <div className="flex flex-col">
                        <span className="font-mono text-[12px] text-text-main break-all">{user.email}</span>
                        {user.displayName && (
                          <span className="text-xs text-text-muted">{user.displayName}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Select
                        options={groupOptions}
                        value={user.groupId || ""}
                        placeholder="No group"
                        disabled={busyId === user.id}
                        onChange={(event) => patchUser(user.id, { groupId: event.target.value })}
                        selectClassName="h-8 py-0 text-[12px] font-mono"
                        aria-label={`Group for ${user.email}`}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={user.status} />
                    </td>
                    <td className="px-4 py-3 font-mono text-[12px] text-text-main">{user.keyCount ?? 0}</td>
                    <td className="px-4 py-3 font-mono text-[12px] text-text-main">
                      {fmtUsdNano(user.availableNanoUsd ?? 0)}
                    </td>
                    <td className="px-4 py-3 font-mono text-[12px] text-text-muted">{formatDate(user.createdAt)}</td>
                    <td className="px-4 py-3 font-mono text-[12px] text-text-muted">{formatDate(user.lastLoginAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        {user.status === "suspended" ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            icon="play_arrow"
                            disabled={busyId === user.id}
                            onClick={() => patchUser(user.id, { status: "active" })}
                          >
                            Activate
                          </Button>
                        ) : (
                          <Button
                            variant="secondary"
                            size="sm"
                            icon="pause"
                            disabled={busyId === user.id}
                            onClick={() => patchUser(user.id, { status: "suspended" })}
                          >
                            Suspend
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          icon="key"
                          aria-label={`Đặt lại mật khẩu cho ${user.email}`}
                          title="Đặt lại mật khẩu"
                          disabled={busyId === user.id}
                          onClick={() => { setResetTarget(user); setResetPassword(""); }}
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          icon="delete"
                          aria-label={`Delete ${user.email}`}
                          disabled={busyId === user.id}
                          onClick={() => removeUser(user)}
                          className="text-red-600 hover:bg-red-500/10"
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Tạo tài khoản"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={creating}>Huỷ</Button>
            <Button onClick={submitCreate} loading={creating}>Tạo</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Email"
            value={createDraft.email}
            onChange={(e) => setCreateDraft((d) => ({ ...d, email: e.target.value }))}
          />
          <Input
            label="Tên hiển thị"
            value={createDraft.displayName}
            onChange={(e) => setCreateDraft((d) => ({ ...d, displayName: e.target.value }))}
            placeholder="Không bắt buộc"
          />
          <Input
            label="Mật khẩu"
            type="password"
            value={createDraft.password}
            onChange={(e) => setCreateDraft((d) => ({ ...d, password: e.target.value }))}
            hint="Ít nhất 8 ký tự"
          />
          <div className="flex flex-col gap-1">
            <label className="meta text-text-subtle">Nhóm</label>
            <Select
              value={createDraft.groupId}
              onChange={(e) => setCreateDraft((d) => ({ ...d, groupId: e.target.value }))}
              options={[
                { value: "", label: "Không nhóm (dùng mặc định)" },
                ...groups.map((g) => ({ value: g.id, label: g.name })),
              ]}
            />
          </div>
          <p className="text-[11px] text-text-subtle">
            Tài khoản được tạo ở trạng thái đã xác minh — admin bảo lãnh địa chỉ này, nên không
            cần chờ email.
          </p>
        </div>
      </Modal>

      <Modal
        isOpen={!!resetTarget}
        onClose={() => setResetTarget(null)}
        title="Đặt lại mật khẩu"
        footer={
          <>
            <Button variant="ghost" onClick={() => setResetTarget(null)} disabled={resetting}>Huỷ</Button>
            <Button onClick={submitReset} loading={resetting}>Đặt lại</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-muted">
            {resetTarget?.email}
          </p>
          <Input
            label="Mật khẩu mới"
            type="password"
            value={resetPassword}
            onChange={(e) => setResetPassword(e.target.value)}
            hint="Ít nhất 8 ký tự. Mọi phiên đăng nhập hiện tại sẽ bị đăng xuất."
          />
        </div>
      </Modal>

      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || ""}
        message={confirmState?.message || ""}
        confirmText="Delete"
        cancelText="Cancel"
        variant="danger"
      />
    </div>
  );
}
