"use client";

import { useState } from "react";
import { Button, Input, Modal, Toggle } from "@/shared/components";

/** ISO instant → "YYYY-MM-DD" in local time for a date input. Empty when unset. */
function isoToDateInput(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "YYYY-MM-DD" → ISO at the start (from) or end (until) of that local day. */
function dateInputToIso(value, { endOfDay }) {
  if (!value) return null;
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return null;
  return endOfDay
    ? new Date(y, m - 1, d, 23, 59, 59, 999).toISOString()
    : new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
}

/**
 * Edit an existing gift code: limits, dates, the new-user flag and the note.
 *
 * The code itself and what it grants are not editable here: once anyone redeemed
 * it, a different gift under the same code would not match the redemptions
 * already made (the server refuses that too). To change the gift, make a new code.
 */
export default function EditGiftCodeModal({ gift, onClose, onSaved }) {
  const redeemed = Number(gift.redeemedCount) || 0;
  // Mounted only while open, so these initialisers are the reset.
  const [maxRedemptions, setMaxRedemptions] = useState(String(gift.maxRedemptions ?? 1));
  const [perUserLimit, setPerUserLimit] = useState(String(gift.perUserLimit ?? 1));
  const [newUserOnly, setNewUserOnly] = useState(Boolean(gift.newUserOnly));
  const [startsOn, setStartsOn] = useState(isoToDateInput(gift.startsAt));
  const [expiresOn, setExpiresOn] = useState(isoToDateInput(gift.expiresAt));
  const [note, setNote] = useState(gift.note || "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setError("");
    const max = Number(maxRedemptions);
    if (!/^\d+$/.test(maxRedemptions.trim()) || !Number.isInteger(max) || max < 1) {
      setError("Tổng lượt dùng phải là số nguyên từ 1 trở lên.");
      return;
    }
    if (max < redeemed) {
      setError(`Tổng lượt dùng không được nhỏ hơn số lượt đã dùng (${redeemed}).`);
      return;
    }
    const perUser = newUserOnly ? 1 : Number(perUserLimit);
    if (!Number.isInteger(perUser) || perUser < 1) {
      setError("Lượt mỗi người phải là số nguyên từ 1 trở lên.");
      return;
    }
    if (perUser > max) {
      setError("Lượt mỗi người không được lớn hơn tổng lượt dùng.");
      return;
    }
    // A date is sent only when the admin picked a different day: re-sending the
    // shown day would round an exact start/expiry (set through the API, or from
    // another timezone) to local midnight / end of day on every unrelated edit.
    const startsChanged = startsOn !== isoToDateInput(gift.startsAt);
    const expiresChanged = expiresOn !== isoToDateInput(gift.expiresAt);
    const startsAt = startsChanged ? dateInputToIso(startsOn, { endOfDay: false }) : gift.startsAt || null;
    const expiresAt = expiresChanged ? dateInputToIso(expiresOn, { endOfDay: true }) : gift.expiresAt || null;
    if (startsAt && expiresAt && startsAt > expiresAt) {
      setError("Ngày bắt đầu phải trước ngày hết hạn.");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/gift-codes/${gift.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          maxRedemptions: max,
          perUserLimit: perUser,
          newUserOnly,
          // "" clears a date on the server; a picked day sets it; an untouched
          // date is not sent at all.
          ...(startsChanged ? { startsAt: startsAt || "" } : {}),
          ...(expiresChanged ? { expiresAt: expiresAt || "" } : {}),
          note: note.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Không lưu được mã.");
        return;
      }
      onSaved(data.code);
    } catch {
      setError("Không kết nối được máy chủ.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`Sửa mã ${gift.displayCode || gift.code}`}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Hủy</Button>
          <Button onClick={submit} loading={saving}>Lưu</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-xs text-text-muted">
          Đã dùng <span className="font-mono text-text-main">{redeemed}</span> lượt. Chuỗi mã không đổi được;
          quà tặng không đổi được khi mã đã có người dùng — muốn đổi quà hãy tạo mã mới.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Tổng lượt dùng"
            inputMode="numeric"
            value={maxRedemptions}
            onChange={(e) => setMaxRedemptions(e.target.value)}
            hint={`Tối thiểu ${Math.max(1, redeemed)}.`}
          />
          <Input
            label="Lượt mỗi người"
            inputMode="numeric"
            value={newUserOnly ? "1" : perUserLimit}
            onChange={(e) => setPerUserLimit(e.target.value)}
            disabled={newUserOnly}
            hint={newUserOnly ? "Mã người mới: mỗi tài khoản 1 lần." : undefined}
          />
        </div>

        <div className="flex flex-col gap-1 border border-border p-3">
          <Toggle
            checked={newUserOnly}
            onChange={setNewUserOnly}
            label="Mã người mới (cần liên kết Telegram)"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Bắt đầu từ (tùy chọn)"
            type="date"
            value={startsOn}
            onChange={(e) => setStartsOn(e.target.value)}
          />
          <Input
            label="Hết hạn (tùy chọn)"
            type="date"
            value={expiresOn}
            onChange={(e) => setExpiresOn(e.target.value)}
            hint="Để trống = không hết hạn."
          />
        </div>

        <Input
          label="Ghi chú"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={200}
        />

        {error && (
          <p role="alert" className="flex items-center gap-1 text-[11px] text-red-700 dark:text-red-400">
            <span className="material-symbols-outlined text-[14px]" aria-hidden="true">error</span>
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
