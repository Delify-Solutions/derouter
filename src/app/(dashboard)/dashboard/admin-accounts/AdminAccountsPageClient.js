"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Card,
  Button,
  Input,
  Modal,
  Badge,
  Table,
  CardSkeleton,
} from "@/shared/components";
import { ADMIN_PAGES } from "@/lib/auth/adminPages";

const EMPTY_PERMISSIONS = {};

function emptyMatrix() {
  const matrix = {};
  for (const page of ADMIN_PAGES) matrix[page.key] = { view: false, edit: false, delete: false };
  return matrix;
}

/**
 * Admin account management (spec admin-accounts "Admin account management").
 * Reskinned to Vuexy (tasks.md 10.3): account list on the shared `Table`
 * primitive, permission matrix retoned to vx-* tokens inside its own scroll
 * region. Data fetching, validation and the permission-matrix logic are
 * unchanged from the Group 5 implementation — this pass is markup/className
 * only.
 */
export default function AdminAccountsPageClient() {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");

  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null); // account being edited, or null = create

  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [matrix, setMatrix] = useState(emptyMatrix());
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [confirmUsername, setConfirmUsername] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);

  const [statusBusyId, setStatusBusyId] = useState(null);

  const fetchAccounts = useCallback(async () => {
    try {
      const res = await fetch("/api/admin-accounts", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setListError(data.error || "Không tải được danh sách tài khoản");
        return;
      }
      setAccounts(Array.isArray(data.accounts) ? data.accounts : []);
      setListError("");
    } catch {
      setListError("Không kết nối được máy chủ");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAccounts(); }, [fetchAccounts]);

  const resetForm = () => {
    setUsername("");
    setDisplayName("");
    setPassword("");
    setMatrix(emptyMatrix());
    setFormError("");
    setEditing(null);
  };

  const openCreate = () => {
    resetForm();
    setShowModal(true);
  };

  const openEdit = (account) => {
    setUsername(account.username);
    setDisplayName(account.displayName || "");
    setPassword("");
    const next = emptyMatrix();
    for (const [key, perm] of Object.entries(account.permissions || EMPTY_PERMISSIONS)) {
      if (next[key]) next[key] = { view: !!perm.view, edit: !!perm.edit, delete: !!perm.delete };
    }
    setMatrix(next);
    setFormError("");
    setEditing(account);
    setShowModal(true);
  };

  const togglePerm = (pageKey, field, value) => {
    setMatrix((prev) => {
      const current = prev[pageKey] || { view: false, edit: false, delete: false };
      const next = { ...current, [field]: value };
      // Client-side convenience mirroring the server rule: edit/delete imply view.
      if ((field === "edit" || field === "delete") && value) next.view = true;
      // Turning view off clears edit/delete too, so the UI never shows an
      // impossible combination while the user is still filling the form.
      if (field === "view" && !value) { next.edit = false; next.delete = false; }
      return { ...prev, [pageKey]: next };
    });
  };

  const handleSubmit = async () => {
    setFormError("");
    if (!editing && !/^[A-Za-z0-9_-]{3,32}$/.test(username.trim())) {
      setFormError("Tên đăng nhập phải dài 3-32 ký tự, chỉ gồm chữ/số/_/-");
      return;
    }
    if (!editing && password.length < 8) {
      setFormError("Mật khẩu tạm thời tối thiểu 8 ký tự");
      return;
    }
    if (editing && password && password.length < 8) {
      setFormError("Mật khẩu mới tối thiểu 8 ký tự");
      return;
    }

    setSaving(true);
    try {
      if (editing) {
        const patchBody = { displayName: displayName.trim() };
        if (password) patchBody.newPassword = password;
        const res = await fetch(`/api/admin-accounts/${editing.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patchBody),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { setFormError(data.error || "Không lưu được tài khoản"); return; }

        const permRes = await fetch(`/api/admin-accounts/${editing.id}/permissions`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ permissions: matrix }),
        });
        const permData = await permRes.json().catch(() => ({}));
        if (!permRes.ok) { setFormError(permData.error || "Không lưu được quyền"); return; }
      } else {
        const res = await fetch("/api/admin-accounts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: username.trim(),
            password,
            displayName: displayName.trim(),
            permissions: matrix,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { setFormError(data.error || "Không tạo được tài khoản"); return; }
      }
      await fetchAccounts();
      setShowModal(false);
      resetForm();
    } catch {
      setFormError("Không kết nối được máy chủ");
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (account) => {
    setStatusBusyId(account.id);
    try {
      const nextStatus = account.status === "active" ? "disabled" : "active";
      const res = await fetch(`/api/admin-accounts/${account.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      if (res.ok) await fetchAccounts();
    } catch { /* ignore */ }
    finally { setStatusBusyId(null); }
  };

  const openDelete = (account) => {
    setDeleteTarget(account);
    setConfirmUsername("");
    setDeleteError("");
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError("");
    try {
      const res = await fetch(`/api/admin-accounts/${deleteTarget.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmUsername: confirmUsername.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setDeleteError(data.error || "Không xoá được tài khoản"); return; }
      setDeleteTarget(null);
      await fetchAccounts();
    } catch {
      setDeleteError("Không kết nối được máy chủ");
    } finally {
      setDeleting(false);
    }
  };

  const usernameMatches = deleteTarget && confirmUsername.trim().toLowerCase() === deleteTarget.username.toLowerCase();

  if (loading) {
    return (
      <div className="flex flex-col gap-8">
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">admin_panel_settings</span>
            Tài khoản Admin
          </h2>
          <Button icon="add" onClick={openCreate}>Tạo tài khoản</Button>
        </div>

        <p className="text-sm text-text-muted mb-4">
          Mỗi admin đăng nhập bằng tài khoản riêng. Super Admin luôn có toàn quyền; mỗi
          cộng tác viên (CTV) chỉ xem/sửa/xoá đúng những trang được cấp.
        </p>

        {listError && <p className="text-sm text-red-500 mb-4">{listError}</p>}

        <Table bare className="min-w-[640px]">
          <Table.Head>
            <Table.Row>
              <Table.HeaderCell>Tên đăng nhập</Table.HeaderCell>
              <Table.HeaderCell>Tên hiển thị</Table.HeaderCell>
              <Table.HeaderCell>Vai trò</Table.HeaderCell>
              <Table.HeaderCell>Trạng thái</Table.HeaderCell>
              <Table.HeaderCell align="right">Hành động</Table.HeaderCell>
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {accounts.length === 0 ? (
              <Table.Empty colSpan={5}>Chưa có tài khoản nào.</Table.Empty>
            ) : accounts.map((account) => {
              const isSuperAdmin = account.role === "super_admin";
              return (
                <Table.Row key={account.id}>
                  <Table.Cell className="font-mono truncate">{account.username}</Table.Cell>
                  <Table.Cell className="text-vx-text-muted truncate">{account.displayName || "—"}</Table.Cell>
                  <Table.Cell>
                    <Badge variant={isSuperAdmin ? "primary" : "default"}>
                      {isSuperAdmin ? "Super Admin" : "Thành viên"}
                    </Badge>
                  </Table.Cell>
                  <Table.Cell>
                    <Badge variant={account.status === "active" ? "success" : "error"} dot>
                      {account.status === "active" ? "Hoạt động" : "Đã khoá"}
                    </Badge>
                  </Table.Cell>
                  <Table.Cell>
                    <div className="flex items-center justify-end gap-1">
                      {!isSuperAdmin && (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            icon="edit"
                            onClick={() => openEdit(account)}
                            title="Sửa"
                            aria-label={`Sửa tài khoản ${account.username}`}
                            className="size-9 px-0"
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={account.status === "active" ? "block" : "check_circle"}
                            onClick={() => toggleStatus(account)}
                            disabled={statusBusyId === account.id}
                            title={account.status === "active" ? "Vô hiệu hoá" : "Kích hoạt lại"}
                            aria-label={
                              account.status === "active"
                                ? `Vô hiệu hoá tài khoản ${account.username}`
                                : `Kích hoạt lại tài khoản ${account.username}`
                            }
                            className="size-9 px-0"
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            icon="delete"
                            onClick={() => openDelete(account)}
                            title="Xoá"
                            aria-label={`Xoá tài khoản ${account.username}`}
                            className="size-9 px-0 text-vx-danger hover:bg-vx-danger/10"
                          />
                        </>
                      )}
                    </div>
                  </Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table>
      </Card>

      {/* Create / Edit modal */}
      <Modal
        isOpen={showModal}
        title={editing ? `Sửa tài khoản — ${editing.username}` : "Tạo tài khoản"}
        onClose={() => { setShowModal(false); resetForm(); }}
        size="xl"
      >
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Tên đăng nhập"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="ctv_hoa"
              disabled={!!editing}
            />
            <Input
              label="Tên hiển thị"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Nguyễn Thị Hoa"
            />
          </div>
          <Input
            type="password"
            label={editing ? "Đặt lại mật khẩu (để trống nếu không đổi)" : "Mật khẩu tạm thời"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Tối thiểu 8 ký tự"
          />
          {!editing && (
            <p className="text-xs text-text-muted -mt-2">
              Tài khoản mới sẽ phải đổi mật khẩu này ngay ở lần đăng nhập đầu tiên.
            </p>
          )}

          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-vx-text-muted mb-2">
              Ma trận quyền truy cập
            </p>
            <Table
              bare
              wrapperClassName="rounded-vx-md border border-vx-border max-h-80 overflow-y-auto custom-scrollbar"
            >
              <Table.Head>
                <Table.Row>
                  <Table.HeaderCell className="sticky top-0 z-10 bg-vx-surface px-3 py-2">Trang</Table.HeaderCell>
                  <Table.HeaderCell align="center" className="sticky top-0 z-10 bg-vx-surface w-14 px-2 py-2">
                    Xem
                  </Table.HeaderCell>
                  <Table.HeaderCell align="center" className="sticky top-0 z-10 bg-vx-surface w-14 px-2 py-2">
                    Sửa
                  </Table.HeaderCell>
                  <Table.HeaderCell align="center" className="sticky top-0 z-10 bg-vx-surface w-14 px-2 py-2">
                    Xoá
                  </Table.HeaderCell>
                </Table.Row>
              </Table.Head>
              <Table.Body>
                {ADMIN_PAGES.map((page) => {
                  const perm = matrix[page.key] || { view: false, edit: false, delete: false };
                  return (
                    <Table.Row key={page.key}>
                      <Table.Cell className="px-3 py-1.5 truncate">{page.label}</Table.Cell>
                      <Table.Cell className="px-2 py-1.5 text-center">
                        <input
                          type="checkbox"
                          checked={perm.view}
                          onChange={(e) => togglePerm(page.key, "view", e.target.checked)}
                          className="size-4 accent-brand-500"
                          aria-label={`Xem ${page.label}`}
                        />
                      </Table.Cell>
                      <Table.Cell className="px-2 py-1.5 text-center">
                        <input
                          type="checkbox"
                          checked={perm.edit}
                          onChange={(e) => togglePerm(page.key, "edit", e.target.checked)}
                          className="size-4 accent-brand-500"
                          aria-label={`Sửa ${page.label}`}
                        />
                      </Table.Cell>
                      <Table.Cell className="px-2 py-1.5 text-center">
                        <input
                          type="checkbox"
                          checked={perm.delete}
                          onChange={(e) => togglePerm(page.key, "delete", e.target.checked)}
                          className="size-4 accent-brand-500"
                          aria-label={`Xoá ${page.label}`}
                        />
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table>
          </div>

          {formError && (
            <p className="text-sm text-red-500 flex items-center gap-1">
              <span className="material-symbols-outlined text-[14px]">error</span>
              {formError}
            </p>
          )}

          <div className="flex gap-2">
            <Button onClick={handleSubmit} fullWidth loading={saving}>
              {editing ? "Lưu" : "Tạo tài khoản"}
            </Button>
            <Button onClick={() => { setShowModal(false); resetForm(); }} variant="ghost" fullWidth>
              Huỷ
            </Button>
          </div>
        </div>
      </Modal>

      {/* Delete confirmation — type the username back */}
      <Modal
        isOpen={!!deleteTarget}
        title="Xoá tài khoản"
        onClose={() => setDeleteTarget(null)}
        size="sm"
      >
        {deleteTarget && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-text-main">
              Xoá vĩnh viễn tài khoản <span className="font-mono">{deleteTarget.username}</span>? Hành động này
              không thể hoàn tác. Nhập lại tên đăng nhập để xác nhận.
            </p>
            <Input
              value={confirmUsername}
              onChange={(e) => setConfirmUsername(e.target.value)}
              placeholder={deleteTarget.username}
              autoFocus
            />
            {deleteError && <p className="text-sm text-red-500">{deleteError}</p>}
            <div className="flex gap-2">
              <Button
                onClick={handleDelete}
                variant="danger"
                fullWidth
                loading={deleting}
                disabled={!usernameMatches}
              >
                Xoá vĩnh viễn
              </Button>
              <Button onClick={() => setDeleteTarget(null)} variant="ghost" fullWidth>
                Huỷ
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
