"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Modal } from "@/shared/components";
import ReasonModal from "./ReasonModal";

/**
 * Header actions on one account (spec admin-user-management "Lock and delete from
 * the user page"): lock / unlock, and delete.
 *
 * Locking is the existing status change to `suspended` (API keys refused at once,
 * every session revoked) with a reason; unlocking sets `active`. Deleting goes
 * through `DELETE /api/users/<id>`, which asks for the account's email typed back.
 */
export default function AccountActions({ user, onChanged }) {
  const router = useRouter();
  const [open, setOpen] = useState(null); // "lock" | "unlock" | "delete"
  const [confirmEmail, setConfirmEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!user) return null;
  const locked = user.status === "suspended";

  const setStatus = async (status, reason) => {
    const res = await fetch(`/api/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, reason }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body.error || "Không thực hiện được" };
    await onChanged?.();
    return { ok: true };
  };

  const remove = async () => {
    setError("");
    setBusy(true);
    try {
      const res = await fetch(`/api/users/${user.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmEmail: confirmEmail.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || "Không xóa được tài khoản");
        return;
      }
      router.replace("/dashboard/users");
    } catch {
      setError("Không kết nối được máy chủ");
    } finally {
      setBusy(false);
    }
  };

  const emailMatches = confirmEmail.trim().toLowerCase() === String(user.email || "").toLowerCase();

  return (
    <div className="flex flex-wrap items-center gap-2">
      {locked ? (
        <Button size="sm" variant="secondary" icon="lock_open" onClick={() => setOpen("unlock")}>Mở khóa</Button>
      ) : (
        <Button size="sm" variant="secondary" icon="lock" onClick={() => setOpen("lock")}>Khóa tài khoản</Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        icon="delete"
        className="text-danger hover:bg-red-500/10"
        onClick={() => { setConfirmEmail(""); setError(""); setOpen("delete"); }}
      >
        Xóa tài khoản
      </Button>

      <ReasonModal
        isOpen={open === "lock"}
        title="Khóa tài khoản"
        description="Tài khoản bị khóa: mọi API key bị từ chối ngay, mọi phiên đăng nhập bị thu hồi, không đăng nhập lại được cho đến khi mở khóa. Gói và credit giữ nguyên."
        confirmLabel="Khóa"
        onClose={() => setOpen(null)}
        onConfirm={({ reason }) => setStatus("suspended", reason)}
      />
      <ReasonModal
        isOpen={open === "unlock"}
        title="Mở khóa tài khoản"
        description="Tài khoản dùng lại được API key và đăng nhập như trước."
        confirmLabel="Mở khóa"
        onClose={() => setOpen(null)}
        onConfirm={({ reason }) => setStatus("active", reason)}
      />

      <Modal
        isOpen={open === "delete"}
        onClose={() => setOpen(null)}
        title="Xóa tài khoản"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(null)} disabled={busy}>Hủy</Button>
            <Button variant="danger" onClick={remove} loading={busy} disabled={!emailMatches}>Xóa vĩnh viễn</Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-main">
            Xóa vĩnh viễn <span className="font-mono text-[12px]">{user.email}</span>: tài khoản, API key, phiên đăng nhập,
            các gói và credit còn lại, sổ cái credit, lượt dùng mã quà, mã giới thiệu và ví hoa hồng; voucher chưa dùng
            của tài khoản bị hủy, không hoàn lại. Không thể hoàn tác.
          </p>
          <p className="text-xs text-text-muted">
            Đơn hàng vẫn được giữ (kèm email) để đối soát, nhật ký chỉ còn một dòng ghi việc xóa. Muốn chặn tạm thời thì dùng
            Khóa tài khoản.
          </p>
          <Input
            label="Nhập lại email để xác nhận"
            value={confirmEmail}
            onChange={(e) => setConfirmEmail(e.target.value)}
            placeholder={user.email}
            autoComplete="off"
          />
          {error && (
            <p role="alert" className="flex items-center gap-1 text-[11px] text-red-700 dark:text-red-400">
              <span className="material-symbols-outlined text-[14px]" aria-hidden="true">error</span>
              {error}
            </p>
          )}
        </div>
      </Modal>
    </div>
  );
}
