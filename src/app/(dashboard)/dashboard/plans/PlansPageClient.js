"use client";

import { useState, useEffect, useCallback } from "react";
import { Button, Input, Modal, ConfirmModal, CardSkeleton, Toggle } from "@/shared/components";
import { fmtUsdNano, fmtCreditNano, usdToNano } from "@/shared/utils/money";
import { formatVnd } from "@/lib/payments/amounts.js";
import { windowLabel } from "@/lib/billing/limits.js";
import { topupBounds } from "@/lib/billing/topup.js";
import LimitsEditor, { limitsToDraft, draftToLimits, draftLimitsError } from "./components/LimitsEditor";

const CODE_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

const EMPTY_FORM = {
  code: "",
  name: "",
  description: "",
  priceUsd: "",
  // VietQR price in integer đồng. Empty or 0 = not sold by bank transfer
  // (spec plan-dual-pricing "Two prices per plan").
  priceVnd: "",
  creditUsd: "",
  // On = no credit ceiling; the credit field is hidden and the plan is bounded only
  // by its limits, RPM and TPM (at least one of them is then required).
  unlimitedCredit: false,
  // On = the customer may type any amount in đồng and gets credit at this plan's
  // own rate (price VND : credit). Bounds in đồng; empty min = the plan price,
  // empty max = the built-in ceiling.
  allowCustomAmount: false,
  customMinVnd: "",
  customMaxVnd: "",
  durationDays: "30",
  // Two separate switches: listed vs buyable. A plan can be advertised before
  // its capacity exists ("coming soon"), which neither flag expresses alone.
  isActive: true,
  isPurchasable: true,
  isFeatured: false,
  // Empty array = any group may buy. Stored in the plan row as JSON.
  allowedGroupIds: [],
  // "" = unlimited. Counted per calendar month over orders.
  purchaseLimitPerMonth: "",
  sortOrder: "",
  // Request / token rate while this plan is the one paying. "" = unlimited.
  rpm: "",
  tpm: "",
  // Per-window limits as draft rows (strings while typing).
  limits: [],
  // Only meaningful while editing: rewrite the ACTIVE purchases too.
  applyToActive: false,
};

/**
 * Validate a draft the same way `validatePlanInput` does server-side, so the
 * button state and the error text agree with what the API will answer.
 * Returns a map of field -> message; empty means valid.
 */
function validateDraft(draft) {
  const errors = {};
  if (!CODE_RE.test(String(draft.code || "").trim().toLowerCase())) {
    errors.code = "2-32 chars: a-z, 0-9, _ or -, starting with a letter or digit";
  }
  if (!String(draft.name || "").trim()) errors.name = "Name is required";

  const price = Number(draft.priceUsd);
  if (!Number.isFinite(price) || price < 0) errors.priceUsd = "Price must be 0 or more";

  // Integer đồng only: a fractional đồng is not a thing a bank can transfer.
  if (String(draft.priceVnd ?? "").trim() !== "") {
    const priceVnd = Number(draft.priceVnd);
    if (!Number.isInteger(priceVnd) || priceVnd < 0) {
      errors.priceVnd = "Giá VND phải là số nguyên không âm";
    }
  }
  if (!draft.unlimitedCredit) {
    const credit = Number(draft.creditUsd);
    if (!Number.isFinite(credit) || credit <= 0) errors.creditUsd = "Credit must be greater than 0";
  }

  const days = Number(draft.durationDays);
  if (!Number.isInteger(days) || days < 1) errors.durationDays = "Duration must be a whole number of days, at least 1";

  if (draft.sortOrder !== "" && !Number.isInteger(Number(draft.sortOrder))) {
    errors.sortOrder = "Sort order must be a whole number";
  }

  for (const [field, label] of [["rpm", "RPM"], ["tpm", "TPM"]]) {
    const raw = String(draft[field] ?? "").trim();
    if (raw !== "" && (!Number.isInteger(Number(raw)) || Number(raw) < 0)) {
      errors[field] = `${label} phải là số nguyên không âm`;
    }
  }

  // Same rules as the API (spec plan-templates "Limit validation"), evaluated
  // against this draft's own credit and duration so the message names the limit.
  const limitsError = draftLimitsError(draft.limits, {
    creditUsd: draft.unlimitedCredit ? 0 : draft.creditUsd,
    durationDays: draft.durationDays,
  });
  if (limitsError) errors.limits = limitsError;

  if (draft.allowCustomAmount && !draft.unlimitedCredit) {
    if (!(Number(draft.priceVnd) > 0)) {
      errors.customAmount = "Nạp số tiền tùy ý cần giá VND của gói để tính tỷ lệ quy đổi";
    }
    for (const [field, label] of [["customMinVnd", "tối thiểu"], ["customMaxVnd", "tối đa"]]) {
      const raw = String(draft[field] ?? "").trim();
      if (raw !== "" && (!Number.isInteger(Number(raw)) || Number(raw) <= 0)) {
        errors[field] = `Số tiền ${label} phải là số đồng nguyên dương`;
      }
    }
    const { minVnd, maxVnd } = topupBounds({
      priceVnd: draft.priceVnd,
      customMinVnd: draft.customMinVnd,
      customMaxVnd: draft.customMaxVnd,
    });
    if (!errors.customMinVnd && !errors.customMaxVnd && minVnd > maxVnd) {
      errors.customMaxVnd = "Số tiền tối đa phải lớn hơn hoặc bằng tối thiểu";
    }
  }

  // An unlimited plan must keep some other bound on spend.
  if (draft.unlimitedCredit && !limitsError) {
    const hasWindow = (draftToLimits(draft.limits) ?? []).length > 0;
    const hasRate = Number(draft.rpm) > 0 || Number(draft.tpm) > 0;
    if (!hasWindow && !hasRate) {
      errors.unlimited = "Gói không giới hạn credit cần ít nhất một hạn mức: theo khung giờ, RPM hoặc TPM";
    }
  }

  return errors;
}

function planToDraft(plan) {
  return {
    code: plan.code || "",
    name: plan.name || "",
    description: plan.description || "",
    priceUsd: String(plan.priceNanoUsd / 1e9),
    priceVnd: plan.priceVnd == null ? "" : String(plan.priceVnd),
    creditUsd: plan.unlimitedCredit ? "" : String(plan.creditNanoUsd / 1e9),
    unlimitedCredit: plan.unlimitedCredit === true,
    allowCustomAmount: plan.allowCustomAmount === true,
    customMinVnd: plan.customMinVnd == null ? "" : String(plan.customMinVnd),
    customMaxVnd: plan.customMaxVnd == null ? "" : String(plan.customMaxVnd),
    durationDays: String(plan.durationDays ?? 30),
    isActive: plan.isActive !== false,
    isPurchasable: plan.isPurchasable !== false,
    isFeatured: plan.isFeatured === true,
    allowedGroupIds: Array.isArray(plan.allowedGroupIds) ? plan.allowedGroupIds : [],
    purchaseLimitPerMonth: plan.purchaseLimitPerMonth == null ? "" : String(plan.purchaseLimitPerMonth),
    sortOrder: plan.sortOrder == null ? "" : String(plan.sortOrder),
    rpm: plan.rpm == null ? "" : String(plan.rpm),
    tpm: plan.tpm == null ? "" : String(plan.tpm),
    limits: limitsToDraft(plan.limits),
    applyToActive: false,
  };
}

/** Whether the two limit lists differ — decides whether to offer apply-to-active. */
function limitsChanged(draftRows, originalLimits) {
  const next = JSON.stringify(draftToLimits(draftRows) ?? []);
  const before = JSON.stringify(Array.isArray(originalLimits) ? originalLimits : []);
  return next !== before;
}

export default function PlansPageClient() {
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState(EMPTY_FORM);
  const [touched, setTouched] = useState(false);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmState, setConfirmState] = useState(null);
  const [busyId, setBusyId] = useState(null);
  // Key groups offered in the "restricted to" picker; loaded with the plan list
  // so the form does not need a second round trip when it opens.
  const [groups, setGroups] = useState([]);

  const errors = validateDraft(draft);
  const invalid = Object.keys(errors).length > 0;

  const loadPlans = useCallback(async () => {
    setLoadError("");
    try {
      const res = await fetch("/api/plans", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to load plans");
      setPlans(Array.isArray(data.plans) ? data.plans : []);
      setGroups(Array.isArray(data.groups) ? data.groups : []);
    } catch (e) {
      setLoadError(e.message || "Failed to load plans");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadPlans(); }, [loadPlans]);

  const setField = (field, value) => setDraft((d) => ({ ...d, [field]: value }));

  const openCreate = () => {
    setDraft(EMPTY_FORM);
    setEditing(null);
    setTouched(false);
    setFormError("");
    setShowModal(true);
  };

  const openEdit = (plan) => {
    setDraft(planToDraft(plan));
    setEditing(plan);
    setTouched(false);
    setFormError("");
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditing(null);
    setTouched(false);
  };

  const handleSubmit = async () => {
    setTouched(true);
    if (invalid) return;

    setSaving(true);
    setFormError("");

    const body = {
      code: draft.code.trim().toLowerCase(),
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      priceNanoUsd: usdToNano(Number(draft.priceUsd)),
      // 0 and "" both mean "not sold by VietQR"; the server normalises both to NULL.
      priceVnd: String(draft.priceVnd ?? "").trim() === "" ? null : Number(draft.priceVnd),
      creditNanoUsd: draft.unlimitedCredit ? 0 : usdToNano(Number(draft.creditUsd)),
      unlimitedCredit: draft.unlimitedCredit,
      allowCustomAmount: draft.allowCustomAmount && !draft.unlimitedCredit,
      customMinVnd: String(draft.customMinVnd ?? "").trim() === "" ? null : Number(draft.customMinVnd),
      customMaxVnd: String(draft.customMaxVnd ?? "").trim() === "" ? null : Number(draft.customMaxVnd),
      durationDays: Number(draft.durationDays),
      isActive: draft.isActive,
      isPurchasable: draft.isPurchasable,
      isFeatured: draft.isFeatured,
      allowedGroupIds: draft.allowedGroupIds.length ? draft.allowedGroupIds : null,
      purchaseLimitPerMonth: draft.purchaseLimitPerMonth === "" ? null : Number(draft.purchaseLimitPerMonth),
      sortOrder: draft.sortOrder === "" ? null : Number(draft.sortOrder),
      rpm: String(draft.rpm).trim() === "" ? null : Number(draft.rpm),
      tpm: String(draft.tpm).trim() === "" ? null : Number(draft.tpm),
      limits: draftToLimits(draft.limits) ?? [],
      // Only sent when the admin ticked the box; the API ignores it otherwise.
      ...(editing && draft.applyToActive ? { applyToActive: true } : {}),
    };

    try {
      const res = await fetch(editing ? `/api/plans/${editing.id}` : "/api/plans", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError(data.error || "Failed to save plan");
        return;
      }
      await loadPlans();
      closeModal();
    } catch (e) {
      setFormError(e.message || "Failed to save plan");
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (plan) => {
    setBusyId(plan.id);
    try {
      const res = await fetch(`/api/plans/${plan.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !plan.isActive }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to update plan");
      await loadPlans();
    } catch (e) {
      setLoadError(e.message || "Failed to update plan");
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = (plan) => {
    setConfirmState({
      title: "Deactivate plan",
      message: `Deactivate "${plan.name || plan.code}"? It disappears from the shop. Orders already placed and credit already granted keep their reference to it.`,
      onConfirm: async () => {
        setConfirmState(null);
        setBusyId(plan.id);
        try {
          const res = await fetch(`/api/plans/${plan.id}`, { method: "DELETE" });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || "Failed to deactivate plan");
          }
          await loadPlans();
        } catch (e) {
          setLoadError(e.message || "Failed to deactivate plan");
        } finally {
          setBusyId(null);
        }
      },
    });
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-6 max-w-7xl">
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-10 max-w-7xl">
      {/* Header */}
      <header className="flex flex-wrap items-end justify-between gap-4 pb-6 border-b border-border">
        <div className="flex flex-col gap-1.5">
          <span className="meta text-text-subtle">Billing</span>
          <h1 className="text-2xl font-semibold text-text-main">Plans</h1>
          <p className="text-sm text-text-muted max-w-xl">
            A plan is a price, the credit it buys, and how long that credit lasts.
            Orders snapshot these numbers, so editing a plan never rewrites a sale.
          </p>
        </div>
        <Button icon="add" onClick={openCreate}>New plan</Button>
      </header>

      {loadError && (
        <div className="flex items-start gap-2 border border-danger/40 bg-danger/5 px-4 py-3">
          <span className="material-symbols-outlined text-[18px] text-danger">error</span>
          <p className="text-sm text-danger flex-1">{loadError}</p>
          <Button size="sm" variant="ghost" onClick={loadPlans}>Retry</Button>
        </div>
      )}

      {plans.length === 0 ? (
        <div className="border border-border px-6 py-16 flex flex-col items-center text-center gap-3">
          <span className="material-symbols-outlined text-[32px] text-text-subtle">sell</span>
          <p className="text-text-main font-medium">No plans yet</p>
          <p className="text-sm text-text-muted max-w-sm">
            Plans appear on the customer shop once created. Nothing is purchasable until there is at least one.
          </p>
          <Button icon="add" onClick={openCreate}>New plan</Button>
        </div>
      ) : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {plans.map((plan) => (
            <li
              key={plan.id}
              className={`flex flex-col border border-border bg-surface ${plan.isActive ? "" : "opacity-60"}`}
            >
              <div className="flex items-start justify-between gap-3 px-6 pt-6">
                <div className="flex flex-col gap-1 min-w-0">
                  <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-subtle truncate">
                    {plan.code}
                  </span>
                  <h2 className="text-base font-semibold text-text-main truncate">{plan.name}</h2>
                </div>
                <span
                  className={`font-mono text-[10px] uppercase tracking-wider border px-2 py-0.5 shrink-0 ${
                    plan.isActive
                      ? "border-brand-500/30 bg-brand-500/10 text-brand-700 dark:text-brand-400"
                      : "border-border bg-surface-2 text-text-muted"
                  }`}
                >
                  {!plan.isActive ? "Ẩn" : plan.isPurchasable === false ? "Chưa mở bán" : "Đang bán"}
                </span>
              </div>

              {plan.description && (
                <p className="px-6 pt-3 text-sm text-text-muted">{plan.description}</p>
              )}

              <dl className="grid grid-cols-2 lg:grid-cols-3 gap-px bg-border mx-6 my-5 border border-border">
                <div className="bg-surface px-4 py-3">
                  <dt className="meta text-text-subtle">Giá USD</dt>
                  <dd className="font-mono text-sm text-text-main mt-1">{fmtUsdNano(plan.priceNanoUsd)}</dd>
                </div>
                <div className="bg-surface px-4 py-3">
                  <dt className="meta text-text-subtle">Giá VND</dt>
                  <dd className="font-mono text-sm text-text-main mt-1">
                    {plan.priceVnd ? formatVnd(plan.priceVnd) : "—"}
                  </dd>
                </div>
                <div className="bg-surface px-4 py-3">
                  <dt className="meta text-text-subtle">Credit</dt>
                  <dd className="font-mono text-sm text-text-main mt-1">{fmtCreditNano(plan.creditNanoUsd, plan.unlimitedCredit)}</dd>
                </div>
                <div className="bg-surface px-4 py-3">
                  <dt className="meta text-text-subtle">Duration</dt>
                  <dd className="font-mono text-sm text-text-main mt-1">
                    {plan.durationDays} {plan.durationDays === 1 ? "day" : "days"}
                  </dd>
                </div>
                <div className="bg-surface px-4 py-3">
                  <dt className="meta text-text-subtle">Sort</dt>
                  <dd className="font-mono text-sm text-text-main mt-1">{plan.sortOrder ?? "—"}</dd>
                </div>
                <div className="bg-surface px-4 py-3">
                  <dt className="meta text-text-subtle">Nhóm</dt>
                  <dd className="font-mono text-sm text-text-main mt-1">
                    {Array.isArray(plan.allowedGroupIds) && plan.allowedGroupIds.length
                      ? `${plan.allowedGroupIds.length} nhóm`
                      : "Mọi nhóm"}
                  </dd>
                </div>
                <div className="bg-surface px-4 py-3">
                  <dt className="meta text-text-subtle">Giới hạn / tháng</dt>
                  <dd className="font-mono text-sm text-text-main mt-1">
                    {plan.purchaseLimitPerMonth ? `${plan.purchaseLimitPerMonth} lần` : "Không"}
                  </dd>
                </div>
              </dl>

              {plan.allowCustomAmount && (
                <div className="px-6 pb-4">
                  <p className="meta text-text-subtle mb-1">Nạp tùy ý</p>
                  <p className="font-mono text-[12px] text-text-muted">
                    {formatVnd(topupBounds(plan).minVnd)} – {formatVnd(topupBounds(plan).maxVnd)} · {formatVnd(plan.priceVnd)} = {fmtUsdNano(plan.creditNanoUsd)}
                  </p>
                </div>
              )}

              <div className="px-6 pb-4">
                <p className="meta text-text-subtle mb-1">Tốc độ</p>
                <p className="font-mono text-[12px] text-text-muted">
                  {plan.rpm ? `${plan.rpm} RPM` : "RPM không giới hạn"} · {plan.tpm ? `${plan.tpm} TPM` : "TPM không giới hạn"}
                </p>
              </div>

              {/* Hạn mức theo khung giờ: câu chữ đọc nhanh hơn bảng số. */}
              <div className="px-6 pb-4">
                <p className="meta text-text-subtle mb-1">Hạn mức</p>
                {Array.isArray(plan.limits) && plan.limits.length ? (
                  <ul className="flex flex-col gap-0.5">
                    {plan.limits.map((limit) => (
                      <li key={limit.hours} className="font-mono text-[12px] text-text-muted">
                        {fmtUsdNano(limit.maxNanoUsd)} mỗi {windowLabel(limit.hours)}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="font-mono text-[12px] text-text-muted">Không giới hạn theo khung giờ</p>
                )}
              </div>

              {/* Số liệu của spec plan-templates "Plan statistics" + doanh thu
                  tách theo tiền tệ (spec plan-dual-pricing "Revenue per currency"). */}
              <dl className="grid grid-cols-2 sm:grid-cols-3 gap-px bg-border mx-6 mb-5 border border-border">
                <div className="bg-surface px-3 py-2">
                  <dt className="meta text-text-subtle">Gói chạy</dt>
                  <dd className="font-mono text-[12px] text-text-main mt-1">{plan.stats?.activeCount ?? 0}</dd>
                </div>
                <div className="bg-surface px-3 py-2">
                  <dt className="meta text-text-subtle">Khách</dt>
                  <dd className="font-mono text-[12px] text-text-main mt-1">{plan.stats?.activeUsers ?? 0}</dd>
                </div>
                <div className="bg-surface px-3 py-2">
                  <dt className="meta text-text-subtle">Thu VND</dt>
                  <dd className="font-mono text-[12px] text-text-main mt-1">
                    {formatVnd(plan.stats?.revenueVnd ?? 0)}
                  </dd>
                </div>
                <div className="bg-surface px-3 py-2">
                  <dt className="meta text-text-subtle">Thu USD</dt>
                  <dd className="font-mono text-[12px] text-text-main mt-1">
                    {fmtUsdNano(plan.stats?.revenueUsdNano ?? 0)}
                  </dd>
                </div>
                <div className="bg-surface px-3 py-2">
                  <dt className="meta text-text-subtle">Đã dùng</dt>
                  <dd className="font-mono text-[12px] text-text-main mt-1">{fmtUsdNano(plan.stats?.consumedNanoUsd ?? 0)}</dd>
                </div>
              </dl>

              <div className="mt-auto flex items-center justify-between gap-3 px-6 py-4 border-t border-border">
                <Toggle
                  size="sm"
                  checked={plan.isActive}
                  disabled={busyId === plan.id}
                  onChange={() => toggleActive(plan)}
                  label={
                    <span className="font-mono text-[11px] uppercase tracking-wider text-text-muted">
                      {plan.isActive ? "Active" : "Inactive"}
                    </span>
                  }
                />
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => openEdit(plan)}
                    aria-label={`Edit ${plan.name || plan.code}`}
                    className="size-8 flex items-center justify-center border border-border text-text-muted hover:text-text-main hover:border-text-muted transition-colors"
                  >
                    <span className="material-symbols-outlined text-[18px]">edit</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(plan)}
                    disabled={busyId === plan.id || !plan.isActive}
                    aria-label={`Deactivate ${plan.name || plan.code}`}
                    className="size-8 flex items-center justify-center border border-border text-danger hover:border-danger transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <span className="material-symbols-outlined text-[18px]">block</span>
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal
        isOpen={showModal}
        onClose={closeModal}
        title={editing ? "Edit plan" : "New plan"}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={closeModal} disabled={saving}>Cancel</Button>
            <Button onClick={handleSubmit} loading={saving} disabled={touched && invalid}>
              {editing ? "Save plan" : "Create plan"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Code"
              value={draft.code}
              onChange={(e) => setField("code", e.target.value)}
              placeholder="pro-monthly"
              hint="Shown to customers. Lowercase, immutable in spirit."
              error={touched ? errors.code : ""}
              required
            />
            <Input
              label="Name"
              value={draft.name}
              onChange={(e) => setField("name", e.target.value)}
              placeholder="Pro"
              error={touched ? errors.name : ""}
              required
            />
          </div>

          <Input
            label="Description"
            value={draft.description}
            onChange={(e) => setField("description", e.target.value)}
            placeholder="Credit for heavy months, expires after 30 days."
          />

          {/* Two independent prices, no exchange rate between them: the admin
              decides what 250.000đ and what $10 buy (spec plan-dual-pricing). */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Giá USD (Binance)"
              type="number"
              step="0.01"
              min="0"
              value={draft.priceUsd}
              onChange={(e) => setField("priceUsd", e.target.value)}
              placeholder="10.00"
              hint="Khách trả bằng USDT, 1 USDT = 1 USD. Để 0 = không bán bằng Binance."
              error={touched ? errors.priceUsd : ""}
            />
            <Input
              label="Giá VND (VietQR)"
              type="number"
              step="1"
              min="0"
              value={draft.priceVnd}
              onChange={(e) => setField("priceVnd", e.target.value)}
              placeholder="250000"
              hint="Số nguyên đồng, khách chuyển khoản đúng số này. Để trống = không bán bằng VietQR."
              error={touched ? errors.priceVnd : ""}
              inputMode="numeric"
            />
          </div>

          <div className="flex items-center justify-between border border-border bg-surface px-4 py-3">
            <div className="flex flex-col">
              <span className="meta text-text-subtle">Credit không giới hạn</span>
              <span className="text-sm text-text-muted">
                Bật thì gói không bị trừ hết credit: chỉ hạn mức theo khung giờ, RPM và TPM chặn chi tiêu.
              </span>
            </div>
            <Toggle checked={draft.unlimitedCredit} onChange={(v) => setField("unlimitedCredit", v)} />
          </div>

          {draft.unlimitedCredit ? (
            <p className="border border-border bg-surface-2 px-3 py-2 text-xs text-text-muted">
              Cần ít nhất một hạn mức theo khung giờ, RPM hoặc TPM ở bên dưới. Nợ credit hiện có của khách
              không được trả bằng gói này.
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input
                label="Credit (USD)"
                type="number"
                step="0.01"
                min="0"
                value={draft.creditUsd}
                onChange={(e) => setField("creditUsd", e.target.value)}
                placeholder="25.00"
                hint="Usable balance the plan grants."
                error={touched ? errors.creditUsd : ""}
                required
              />
            </div>
          )}

          {!draft.unlimitedCredit && (
            <div className="flex flex-col gap-3 border border-border bg-surface px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex flex-col">
                  <span className="meta text-text-subtle">Cho nạp số tiền tùy ý</span>
                  <span className="text-sm text-text-muted">
                    Khách nhập số đồng và nhận credit theo tỷ lệ của gói:
                    {" "}{Number(draft.priceVnd) > 0 && Number(draft.creditUsd) > 0
                      ? `${formatVnd(Number(draft.priceVnd))} = $${draft.creditUsd}`
                      : "cần giá VND và credit để tính"}.
                  </span>
                </div>
                <Toggle checked={draft.allowCustomAmount} onChange={(v) => setField("allowCustomAmount", v)} />
              </div>
              {draft.allowCustomAmount && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Input
                    label="Nạp tối thiểu (đồng)"
                    value={draft.customMinVnd}
                    onChange={(e) => setField("customMinVnd", e.target.value)}
                    placeholder={draft.priceVnd ? `Để trống = ${draft.priceVnd}` : "Để trống = giá gói"}
                    inputMode="numeric"
                    error={touched ? errors.customMinVnd : null}
                  />
                  <Input
                    label="Nạp tối đa (đồng)"
                    value={draft.customMaxVnd}
                    onChange={(e) => setField("customMaxVnd", e.target.value)}
                    placeholder="Để trống = 50.000.000"
                    inputMode="numeric"
                    error={touched ? errors.customMaxVnd : null}
                  />
                </div>
              )}
              {touched && errors.customAmount && (
                <p role="alert" className="flex items-center gap-1.5 text-[11px] text-danger">
                  <span className="material-symbols-outlined text-[14px]" aria-hidden="true">error</span>
                  {errors.customAmount}
                </p>
              )}
            </div>
          )}

          {touched && errors.unlimited && (
            <p role="alert" className="flex items-center gap-1.5 text-[11px] text-danger">
              <span className="material-symbols-outlined text-[14px]" aria-hidden="true">error</span>
              {errors.unlimited}
            </p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Duration (days)"
              type="number"
              step="1"
              min="1"
              value={draft.durationDays}
              onChange={(e) => setField("durationDays", e.target.value)}
              error={touched ? errors.durationDays : ""}
              required
            />
            <Input
              label="Sort order"
              type="number"
              step="1"
              value={draft.sortOrder}
              onChange={(e) => setField("sortOrder", e.target.value)}
              placeholder="Optional"
              error={touched ? errors.sortOrder : ""}
            />
          </div>

          {/* Ba công tắc độc lập: hiển thị, mua được, nổi bật. Tách khỏi nhau để
              một gói có thể đang quảng cáo mà chưa mở bán. */}
          <div className="flex flex-col gap-px border border-border bg-border">
            <div className="flex items-center justify-between bg-surface px-4 py-3">
              <div className="flex flex-col">
                <span className="meta text-text-subtle">Hiển thị trên trang giá</span>
                <span className="text-sm text-text-muted">
                  Tắt thì gói không xuất hiện ở trang chủ; đơn cũ vẫn giữ nguyên.
                </span>
              </div>
              <Toggle checked={draft.isActive} onChange={(v) => setField("isActive", v)} />
            </div>

            <div className="flex items-center justify-between bg-surface px-4 py-3">
              <div className="flex flex-col">
                <span className="meta text-text-subtle">Cho phép mua</span>
                <span className="text-sm text-text-muted">
                  Tắt thì gói vẫn hiện nhưng nút mua bị khóa — dùng khi chưa có đủ hạn mức.
                </span>
              </div>
              <Toggle
                checked={draft.isPurchasable}
                disabled={!draft.isActive}
                onChange={(v) => setField("isPurchasable", v)}
              />
            </div>

            <div className="flex items-center justify-between bg-surface px-4 py-3">
              <div className="flex flex-col">
                <span className="meta text-text-subtle">Gói nổi bật</span>
                <span className="text-sm text-text-muted">
                  Đánh dấu thẻ này trên trang chủ. Chỉ nên chọn một gói.
                </span>
              </div>
              <Toggle checked={draft.isFeatured} onChange={(v) => setField("isFeatured", v)} />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="flex flex-col gap-2">
              <span className="meta text-text-subtle">Nhóm được mua</span>
              <span className="text-[11px] text-text-muted">
                Để trống = mọi nhóm. Chọn một hay nhiều nhóm thì chỉ người thuộc nhóm đó mua được.
              </span>
              {groups.length === 0 ? (
                <p className="text-[11px] text-text-subtle">
                  Chưa có nhóm nào. Tạo ở mục Groups nếu muốn giới hạn.
                </p>
              ) : (
                <div className="flex max-h-40 flex-col gap-1 overflow-auto border border-border p-2">
                  {groups.map((group) => {
                    const checked = draft.allowedGroupIds.includes(group.id);
                    return (
                      <label
                        key={group.id}
                        className="flex items-center gap-2 text-sm text-text-main"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) =>
                            setField(
                              "allowedGroupIds",
                              e.target.checked
                                ? [...draft.allowedGroupIds, group.id]
                                : draft.allowedGroupIds.filter((id) => id !== group.id)
                            )
                          }
                        />
                        {group.name}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-1">
              <Input
                label="Số lần mua tối đa mỗi tháng"
                value={draft.purchaseLimitPerMonth}
                onChange={(e) => setField("purchaseLimitPerMonth", e.target.value)}
                placeholder="Để trống = không giới hạn"
                inputMode="numeric"
                hint="Tính theo tháng dương lịch. Đơn đã hủy không tính."
              />
            </div>
          </div>

          <div className="border-t border-border pt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input
              label="RPM (request mỗi phút)"
              value={draft.rpm}
              onChange={(e) => setField("rpm", e.target.value)}
              placeholder="Để trống = không giới hạn"
              inputMode="numeric"
              error={touched ? errors.rpm : null}
              hint="Tính chung mọi API key của khách, khi gói này đang trả."
            />
            <Input
              label="TPM (token mỗi phút)"
              value={draft.tpm}
              onChange={(e) => setField("tpm", e.target.value)}
              placeholder="Để trống = không giới hạn"
              inputMode="numeric"
              error={touched ? errors.tpm : null}
              hint="Vượt TPM thì request chờ tối đa 30 giây rồi mới báo 429."
            />
          </div>

          <div className="border-t border-border pt-4 flex flex-col gap-3">
            <LimitsEditor
              rows={draft.limits}
              onChange={(rows) => setField("limits", rows)}
              creditUsd={draft.creditUsd}
              unlimitedCredit={draft.unlimitedCredit}
              durationDays={draft.durationDays}
              error={touched ? errors.limits : null}
            />

            {/* The price half of the spec's preview sentence: the editor renders
                the credit/limits half, this line completes it. */}
            <p className="text-xs text-text-muted">
              Xem trước: Khách trả ${draft.priceUsd || "—"} → {draft.unlimitedCredit ? "credit không giới hạn" : draft.creditUsd ? `$${draft.creditUsd}` : "—"} dùng
              chung mọi model trong {draft.durationDays || "—"} ngày
              {draftToLimits(draft.limits)?.length
                ? `; ${draftToLimits(draft.limits)
                    .map((limit) => `tối đa $${limit.maxNanoUsd / 1e9} mỗi ${limit.hours === 5 ? "5 giờ" : limit.hours === 24 ? "1 ngày" : limit.hours === 168 ? "1 tuần" : `${limit.hours} giờ`}`)
                    .join(", ")}`
                : ""}
              .
            </p>

            {editing && limitsChanged(draft.limits, editing.limits) && (
              <label className="flex items-start gap-2 text-sm text-text-main">
                <input
                  type="checkbox"
                  checked={draft.applyToActive}
                  onChange={(event) => setField("applyToActive", event.target.checked)}
                  className="mt-1 size-4"
                />
                <span>
                  Áp dụng hạn mức mới cho {editing.stats?.activeCount ?? 0} gói đang chạy
                  <span className="block text-xs text-text-muted">
                    Credit và ngày hết hạn của các gói đã bán không đổi. Bỏ trống thì chỉ gói mua sau
                    mới dùng hạn mức này.
                  </span>
                </span>
              </label>
            )}
          </div>

          {formError && (
            <p className="flex items-center gap-1.5 text-[11px] text-danger">
              <span className="material-symbols-outlined text-[14px]">error</span>
              {formError}
            </p>
          )}
        </div>
      </Modal>

      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        confirmText="Deactivate"
        variant="danger"
      />
    </div>
  );
}
