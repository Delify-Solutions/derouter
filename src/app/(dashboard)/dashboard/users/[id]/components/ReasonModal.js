"use client";

import { useEffect, useState } from "react";
import { Button, Input, Modal } from "@/shared/components";

/**
 * One modal for every audited action: a title, the change being made, an optional
 * extra field, and the reason.
 *
 * The reason is required by the API (3–500 characters) for everything that changes
 * what the customer can do, so the field is disabled-submit until it fits — the
 * operator gets the rule in the UI instead of a 400 after clicking.
 *
 * `renderFields` lets an action add its own input (an amount, a day count, a plan
 * picker) without every action re-implementing the modal, the reason rule and the
 * error area.
 */
export default function ReasonModal({
  isOpen,
  title,
  description = "",
  confirmLabel = "Lưu",
  onClose,
  onConfirm,
  renderFields = null,
  values = {},
  extraValid = true,
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (isOpen) {
      setReason("");
      setError("");
      setBusy(false);
    }
  }, [isOpen]);

  const trimmed = reason.trim();
  const reasonOk = trimmed.length >= 3 && trimmed.length <= 500;

  const submit = async () => {
    if (!reasonOk || !extraValid) return;
    setBusy(true);
    setError("");
    try {
      const result = await onConfirm({ reason: trimmed, ...values });
      if (result && result.ok === false) setError(result.error || "Không thực hiện được");
      else onClose();
    } catch (e) {
      setError(e.message || "Không thực hiện được");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Hủy</Button>
          <Button onClick={submit} loading={busy} disabled={!reasonOk || !extraValid}>{confirmLabel}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {description && <p className="text-sm text-text-muted">{description}</p>}

        {renderFields ? renderFields(values) : null}

        <Input
          label="Lý do"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Ví dụ: hoàn tiền ngoài hệ thống"
          hint="3–500 ký tự. Lý do được ghi vào nhật ký của tài khoản."
          error={reason.length > 0 && !reasonOk ? "Lý do phải có từ 3 đến 500 ký tự" : ""}
          autoFocus
        />

        {error && (
          <p role="alert" className="flex items-center gap-1 text-[11px] text-danger">
            <span className="material-symbols-outlined text-[14px]" aria-hidden="true">error</span>
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
