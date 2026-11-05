"use client";

import { useMemo, useState } from "react";
import { Button, Input, Select, Modal, Toggle } from "@/shared/components";
import { fmtUsdNano, fmtCreditNano, usdToNano, NANO } from "@/shared/utils/money";
import { formatVnd } from "@/lib/payments/amounts.js";
import { topupCreditForAmount } from "@/lib/billing/topup.js";
import UserPicker from "./UserPicker";

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

/** "" or digits only, for an RPM/TPM field. */
function rateFieldValid(value) {
  return value.trim() === "" || /^\d{1,10}$/.test(value.trim());
}

/**
 * Create a gift code, or edit every field of an existing one (spec gift-codes
 * "Edit a gift code"): the code string, what it grants, RPM/TPM, limits, dates,
 * the new-user flag and the note. An edit applies to later redemptions only;
 * purchases already granted keep what they received.
 */
export default function GiftCodeFormModal({ plans, gift = null, onClose, onSaved }) {
  const editing = Boolean(gift);
  const redeemed = Number(gift?.redeemedCount) || 0;
  // A code may keep a plan that has since been retired; new picks are active plans.
  const pickablePlans = useMemo(
    () => plans.filter((p) => p.isActive || (editing && p.id === gift.planId)),
    [plans, editing, gift]
  );

  // Mounted only while open, so these initialisers are the reset.
  const [grantType, setGrantType] = useState(gift?.grantKind || (pickablePlans.length ? "plan" : "credit"));
  const [planId, setPlanId] = useState(gift?.planId || pickablePlans.find((p) => p.isActive)?.id || "");
  const [creditUsd, setCreditUsd] = useState(gift?.creditNanoUsd ? String(gift.creditNanoUsd / NANO) : "");
  const [durationDays, setDurationDays] = useState(String(gift?.grantKind === "credit" ? gift.durationDays ?? 30 : 30));
  const [amountVnd, setAmountVnd] = useState(gift?.amountVnd != null ? String(gift.amountVnd) : "");
  const [maxRedemptions, setMaxRedemptions] = useState(String(gift?.maxRedemptions ?? 1));
  const [perUserLimit, setPerUserLimit] = useState(String(gift?.perUserLimit ?? 1));
  const [newUserOnly, setNewUserOnly] = useState(Boolean(gift?.newUserOnly));
  const [startsOn, setStartsOn] = useState(isoToDateInput(gift?.startsAt));
  const [expiresOn, setExpiresOn] = useState(isoToDateInput(gift?.expiresAt));
  const [note, setNote] = useState(gift?.note || "");
  const [customCode, setCustomCode] = useState(gift?.displayCode || gift?.code || "");
  const [rpm, setRpm] = useState(gift?.rpm == null ? "" : String(gift.rpm));
  const [tpm, setTpm] = useState(gift?.tpm == null ? "" : String(gift.tpm));
  const [assignees, setAssignees] = useState([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const selectedPlan = pickablePlans.find((p) => p.id === planId) ?? null;
  const topupPlan = grantType === "plan" && selectedPlan?.allowCustomAmount === true;
  const amountCredit = topupPlan && amountVnd ? topupCreditForAmount(selectedPlan, Number(amountVnd)) : 0;
  // A code that gifts an amount of a plan which has since stopped selling custom
  // amounts: the amount field is hidden, but the saved amount must not be wiped
  // by an unrelated edit (a note, more uses). It is kept and flagged instead.
  const strandedAmount = editing && grantType === "plan" && planId === gift.planId && !topupPlan && gift.amountVnd != null;

  // Picking accounts raises the total so every one of them can receive the code.
  const pickAssignees = (next) => {
    setAssignees(next);
    if (next.length > (Number(maxRedemptions) || 0)) setMaxRedemptions(String(next.length));
  };

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
    // A new-user code is one per account; the server pins it too.
    const perUser = newUserOnly ? 1 : Number(perUserLimit);
    if (!Number.isInteger(perUser) || perUser < 1) {
      setError("Lượt mỗi người phải là số nguyên từ 1 trở lên.");
      return;
    }
    if (perUser > max) {
      setError("Lượt mỗi người không được lớn hơn tổng lượt dùng.");
      return;
    }

    // Code string: the admin's own (WELCOME2026) or, for a new code, empty = random.
    const typedCode = customCode.trim();
    const typedKey = typedCode.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const codeChanged = !editing || typedKey !== String(gift.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (typedCode && codeChanged) {
      if (!/^[A-Za-z0-9 -]+$/.test(typedCode)) {
        setError("Mã chỉ gồm chữ không dấu, số và dấu gạch ngang.");
        return;
      }
      if (typedKey.length < 4 || typedKey.length > 32) {
        setError("Mã phải dài từ 4 đến 32 ký tự (không tính dấu gạch).");
        return;
      }
    }
    if (editing && !typedCode) {
      setError("Mã không được để trống.");
      return;
    }

    if (!rateFieldValid(rpm) || !rateFieldValid(tpm)) {
      setError("RPM/TPM phải là số nguyên không âm, hoặc để trống.");
      return;
    }

    // A date is sent only when the admin picked a different day: re-sending the
    // shown day would round an exact start/expiry (set through the API, or from
    // another timezone) to local midnight / end of day on every unrelated edit.
    const startsChanged = startsOn !== isoToDateInput(gift?.startsAt);
    const expiresChanged = expiresOn !== isoToDateInput(gift?.expiresAt);
    const startsAt = startsChanged ? dateInputToIso(startsOn, { endOfDay: false }) : gift?.startsAt || null;
    const expiresAt = expiresChanged ? dateInputToIso(expiresOn, { endOfDay: true }) : gift?.expiresAt || null;
    if (startsAt && expiresAt && startsAt > expiresAt) {
      setError("Ngày bắt đầu phải trước ngày hết hạn.");
      return;
    }

    const body = {
      maxRedemptions: max,
      perUserLimit: perUser,
      newUserOnly,
      rpm: rpm.trim(),
      tpm: tpm.trim(),
      note: note.trim() || (editing ? "" : null),
    };
    if (codeChanged && typedCode) body.code = typedCode;
    if (editing) {
      // "" clears a date on the server; an untouched date is not sent at all.
      if (startsChanged) body.startsAt = startsAt || "";
      if (expiresChanged) body.expiresAt = expiresAt || "";
    } else {
      body.startsAt = startsAt;
      body.expiresAt = expiresAt;
    }

    if (grantType === "plan") {
      if (!planId) {
        setError("Chọn một gói.");
        return;
      }
      body.planId = planId;
      body.creditNanoUsd = null;
      body.durationDays = null;
      body.amountVnd = strandedAmount ? gift.amountVnd : null;
      if (topupPlan && String(amountVnd).trim() !== "") {
        if (!(Number(amountVnd) > 0) || amountCredit <= 0) {
          setError("Số tiền phải là số đồng nguyên dương, đủ lớn để quy đổi ra credit.");
          return;
        }
        body.amountVnd = Number(amountVnd);
      }
    } else {
      const usd = Number(creditUsd);
      if (!Number.isFinite(usd) || usd <= 0) {
        setError("Nhập số credit lớn hơn 0.");
        return;
      }
      const days = Number(durationDays);
      if (!Number.isInteger(days) || days < 1) {
        setError("Số ngày phải từ 1 trở lên.");
        return;
      }
      body.planId = null;
      body.amountVnd = null;
      body.creditNanoUsd = usdToNano(usd);
      body.durationDays = days;
    }

    if (!editing) {
      if (assignees.length > max) {
        setError("Tổng lượt dùng phải đủ cho số tài khoản được gắn.");
        return;
      }
      if (assignees.length > 0) body.assignUserIds = assignees.map((user) => user.id);
    }

    setSaving(true);
    try {
      const res = await fetch(editing ? `/api/gift-codes/${gift.id}` : "/api/gift-codes", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Không lưu được mã.");
        return;
      }
      await onSaved(data.code, data.assigned);
    } catch {
      setError("Không kết nối được máy chủ.");
    } finally {
      setSaving(false);
    }
  };

  const planOptions = pickablePlans.map((p) => ({
    value: p.id,
    label: `${p.name} · ${p.allowCustomAmount ? "nạp tùy ý" : fmtCreditNano(p.creditNanoUsd, p.unlimitedCredit)} · ${p.durationDays}d${p.isActive ? "" : " · đã ngừng bán"}`,
  }));

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={editing ? `Sửa mã ${gift.displayCode || gift.code}` : "Tạo mã quà tặng"}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Hủy</Button>
          <Button onClick={submit} loading={saving}>{editing ? "Lưu" : "Tạo mã"}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {editing && (
          <p className="border border-border bg-surface-2 px-3 py-2 text-xs text-text-muted">
            Đã dùng <span className="font-mono text-text-main">{redeemed}</span> lượt.
            {redeemed > 0
              ? " Thay đổi chỉ áp dụng cho các lượt dùng sau; gói và credit đã cấp trước đó giữ nguyên."
              : " Chưa ai dùng: sửa thoải mái."}
          </p>
        )}

        <Input
          label={editing ? "Mã" : "Mã tự đặt (tùy chọn)"}
          value={customCode}
          onChange={(e) => setCustomCode(e.target.value.toUpperCase())}
          placeholder="WELCOME2026"
          maxLength={40}
          hint={editing
            ? "4–32 chữ hoặc số. Đổi mã thì mã cũ không nhập được nữa."
            : "4–32 chữ hoặc số. Để trống để tạo mã ngẫu nhiên 16 ký tự."}
        />

        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">Quà tặng</span>
          <div className="inline-flex w-full border border-border">
            {[
              { value: "plan", label: "Gói" },
              { value: "credit", label: "Credit tùy chỉnh" },
            ].map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setGrantType(opt.value)}
                aria-pressed={grantType === opt.value}
                className={`h-9 flex-1 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors duration-150 ${
                  grantType === opt.value
                    ? "bg-brand-500 text-white"
                    : "bg-transparent text-text-muted hover:text-text-main"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {grantType === "plan" ? (
          pickablePlans.length === 0 ? (
            <p className="border border-border bg-surface-2 px-3 py-2 text-sm text-text-muted">
              Chưa có gói nào đang bán. Tạo gói trước, hoặc tặng credit tùy chỉnh.
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              <Select
                label="Gói"
                options={planOptions}
                value={planId}
                onChange={(e) => setPlanId(e.target.value)}
                placeholder="Chọn gói"
              />
              {strandedAmount && (
                <p role="status" className="border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-text-main">
                  Mã đang tặng {formatVnd(gift.amountVnd)} của gói này, nhưng gói không còn cho nạp số tiền tùy ý nên lượt dùng
                  mới sẽ bị từ chối. Chọn một gói nạp tùy ý khác, hoặc đổi sang tặng credit.
                </p>
              )}
              {topupPlan && (
                // A custom-amount plan is gifted like a top-up: an amount in đồng,
                // credited at the plan's own rate, with its duration and limits.
                <Input
                  label="Số tiền tặng (đồng)"
                  inputMode="numeric"
                  value={amountVnd}
                  onChange={(e) => setAmountVnd(e.target.value.replace(/\D/g, ""))}
                  placeholder={selectedPlan?.priceVnd ? String(selectedPlan.priceVnd) : "100000"}
                  hint={amountVnd
                    ? (amountCredit > 0
                        ? `${formatVnd(Number(amountVnd))} = ${fmtUsdNano(amountCredit)} credit theo tỷ lệ của gói (${formatVnd(selectedPlan.priceVnd)} = ${fmtUsdNano(selectedPlan.creditNanoUsd)}), dùng ${selectedPlan.durationDays} ngày.`
                        : "Số tiền quá nhỏ để quy đổi ra credit.")
                    : `Để trống = tặng ${fmtUsdNano(selectedPlan.creditNanoUsd)} credit như mua 1 lần với giá gốc.`}
                />
              )}
            </div>
          )
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Số credit (USD)"
              type="number"
              min="0"
              step="0.01"
              value={creditUsd}
              onChange={(e) => setCreditUsd(e.target.value)}
              placeholder="5.00"
              hint={creditUsd && Number.isFinite(Number(creditUsd))
                ? fmtUsdNano(usdToNano(Number(creditUsd)))
                : undefined}
            />
            <Input
              label="Hạn dùng (ngày)"
              type="number"
              min="1"
              step="1"
              value={durationDays}
              onChange={(e) => setDurationDays(e.target.value)}
            />
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="RPM (request mỗi phút)"
            inputMode="numeric"
            value={rpm}
            onChange={(e) => setRpm(e.target.value.replace(/\D/g, ""))}
            placeholder={grantType === "plan" ? "theo gói" : "không giới hạn"}
            hint={grantType === "plan" ? "Để trống = theo gói · 0 = không giới hạn" : "Để trống hoặc 0 = không giới hạn"}
          />
          <Input
            label="TPM (token mỗi phút)"
            inputMode="numeric"
            value={tpm}
            onChange={(e) => setTpm(e.target.value.replace(/\D/g, ""))}
            placeholder={grantType === "plan" ? "theo gói" : "không giới hạn"}
            hint={grantType === "plan" ? "Để trống = theo gói · 0 = không giới hạn" : "Để trống hoặc 0 = không giới hạn"}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Tổng lượt dùng"
            inputMode="numeric"
            value={maxRedemptions}
            onChange={(e) => setMaxRedemptions(e.target.value)}
            hint={editing ? `Tối thiểu ${Math.max(1, redeemed)}.` : "Tổng số lần mã được dùng."}
          />
          <Input
            label="Lượt mỗi người"
            inputMode="numeric"
            value={newUserOnly ? "1" : perUserLimit}
            onChange={(e) => setPerUserLimit(e.target.value)}
            disabled={newUserOnly}
            hint={newUserOnly ? "Mã người mới: mỗi tài khoản 1 lần." : "Mỗi tài khoản dùng được tối đa chừng này lần."}
          />
        </div>

        <div className="flex flex-col gap-1 border border-border p-3">
          <Toggle
            checked={newUserOnly}
            onChange={setNewUserOnly}
            label="Mã người mới (cần liên kết Telegram)"
          />
          <p className="text-xs text-text-muted">
            Chỉ tài khoản chưa từng mua gói và đã liên kết Telegram mới nhập được. Mỗi Telegram chỉ nhận một mã
            người mới, tính chung mọi mã người mới. Gắn trực tiếp cho tài khoản thì bỏ qua các điều kiện này.
          </p>
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

        {!editing && (
          <UserPicker
            value={assignees}
            onChange={pickAssignees}
            label="Gắn trực tiếp cho tài khoản (tùy chọn)"
            hint="Tài khoản được chọn nhận quà ngay khi tạo mã, không cần nhập mã. Mỗi tài khoản tính 1 lượt dùng."
          />
        )}

        <Input
          label="Ghi chú (tùy chọn)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Khuyến mãi ra mắt, bù lỗi, ..."
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
