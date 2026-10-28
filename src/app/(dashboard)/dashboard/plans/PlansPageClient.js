"use client";

import { useState, useEffect, useCallback } from "react";
import { Button, Input, Modal, ConfirmModal, CardSkeleton, Toggle } from "@/shared/components";
import { fmtUsdNano, usdToNano } from "@/shared/utils/money";
import PlanModelLimits from "./components/PlanModelLimits";

const CODE_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

const EMPTY_FORM = {
  code: "",
  name: "",
  description: "",
  priceUsd: "",
  creditUsd: "",
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
  const credit = Number(draft.creditUsd);
  if (!Number.isFinite(credit) || credit <= 0) errors.creditUsd = "Credit must be greater than 0";

  const days = Number(draft.durationDays);
  if (!Number.isInteger(days) || days < 1) errors.durationDays = "Duration must be a whole number of days, at least 1";

  if (draft.sortOrder !== "" && !Number.isInteger(Number(draft.sortOrder))) {
    errors.sortOrder = "Sort order must be a whole number";
  }
  return errors;
}

function planToDraft(plan) {
  return {
    code: plan.code || "",
    name: plan.name || "",
    description: plan.description || "",
    priceUsd: String(plan.priceNanoUsd / 1e9),
    creditUsd: String(plan.creditNanoUsd / 1e9),
    durationDays: String(plan.durationDays ?? 30),
    isActive: plan.isActive !== false,
    isPurchasable: plan.isPurchasable !== false,
    isFeatured: plan.isFeatured === true,
    allowedGroupIds: Array.isArray(plan.allowedGroupIds) ? plan.allowedGroupIds : [],
    purchaseLimitPerMonth: plan.purchaseLimitPerMonth == null ? "" : String(plan.purchaseLimitPerMonth),
    sortOrder: plan.sortOrder == null ? "" : String(plan.sortOrder),
  };
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
      creditNanoUsd: usdToNano(Number(draft.creditUsd)),
      durationDays: Number(draft.durationDays),
      isActive: draft.isActive,
      isPurchasable: draft.isPurchasable,
      isFeatured: draft.isFeatured,
      allowedGroupIds: draft.allowedGroupIds.length ? draft.allowedGroupIds : null,
      purchaseLimitPerMonth: draft.purchaseLimitPerMonth === "" ? null : Number(draft.purchaseLimitPerMonth),
      sortOrder: draft.sortOrder === "" ? null : Number(draft.sortOrder),
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
                  <dt className="meta text-text-subtle">Price</dt>
                  <dd className="font-mono text-sm text-text-main mt-1">{fmtUsdNano(plan.priceNanoUsd)}</dd>
                </div>
                <div className="bg-surface px-4 py-3">
                  <dt className="meta text-text-subtle">Credit</dt>
                  <dd className="font-mono text-sm text-text-main mt-1">{fmtUsdNano(plan.creditNanoUsd)}</dd>
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

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Price (USD)"
              type="number"
              step="0.01"
              min="0"
              value={draft.priceUsd}
              onChange={(e) => setField("priceUsd", e.target.value)}
              placeholder="20.00"
              hint="What the customer transfers."
              error={touched ? errors.priceUsd : ""}
              required
            />
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
                  Tắt thì gói vẫn hiện nhưng nút mua bị khoá — dùng khi chưa có đủ hạn mức.
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
                hint="Tính theo tháng dương lịch. Đơn đã huỷ không tính."
              />
            </div>
          </div>

          <div className="border-t border-border pt-4">
            <h3 className="meta text-text-subtle mb-3">Hạn mức theo model</h3>
            <PlanModelLimits planId={editing?.id ?? null} />
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
