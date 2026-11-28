"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import Modal from "./Modal";
import Button from "./Button";
import Input from "./Input";

// Self-service "Đổi mật khẩu" (spec admin-accounts "Self-service password
// change") — opened from a standalone icon button in Header.js (shell chrome,
// rendered on every dashboard page) for ANY signed-in account, independent of
// which dashboard pages that account can view (unlike the Super Admin's existing
// password field on /dashboard/profile, which that account may not have view on).
export default function ChangePasswordModal({ isOpen, onClose }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const reset = () => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setError("");
    setDone(false);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    if (newPassword.length < 8) {
      setError("Mật khẩu mới tối thiểu 8 ký tự");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Xác nhận mật khẩu không khớp");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Đổi mật khẩu thất bại");
        return;
      }
      setDone(true);
    } catch {
      setError("Đã có lỗi xảy ra. Vui lòng thử lại.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Đổi mật khẩu" size="sm">
      {done ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-main">Đổi mật khẩu thành công.</p>
          <Button variant="primary" className="w-full" onClick={handleClose}>
            Đóng
          </Button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label className="meta text-text-muted">Mật khẩu hiện tại</label>
            <Input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              required
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-2">
            <label className="meta text-text-muted">Mật khẩu mới</label>
            <Input
              type="password"
              placeholder="Tối thiểu 8 ký tự"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <label className="meta text-text-muted">Xác nhận mật khẩu mới</label>
            <Input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              required
            />
          </div>
          {error && <p className="text-xs text-red-500">{error}</p>}
          <Button type="submit" variant="primary" className="w-full" loading={loading}>
            Đổi mật khẩu
          </Button>
        </form>
      )}
    </Modal>
  );
}

ChangePasswordModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
};
