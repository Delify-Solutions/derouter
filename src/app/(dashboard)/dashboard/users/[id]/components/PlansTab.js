"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, CardSkeleton, Input, Select } from "@/shared/components";
import { PlanQueue } from "@/shared/components/billing";
import { fmtUsdNano, usdToNano } from "@/shared/utils/money";
import ReasonModal from "./ReasonModal";

const WINDOW_OPTIONS = [
  { value: "5", label: "5 giờ" },
  { value: "24", label: "1 ngày" },
  { value: "168", label: "1 tuần" },
];

/**
 * `Gói` — the customer's queue in admin mode, plus the six audited actions.
 *
 * The queue renders THE SAME component as the customer page, so "which plan is
 * paying" cannot differ between the two screens. Every action here needs a reason
 * except a reorder (which moves no money and whose audit row already carries the
 * before/after order).
 */
export default function PlansTab({ userId, onChanged }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [data, setData] = useState({ queue: [], history: [] });
  const [plans, setPlans] = useState([]);
  const [action, setAction] = useState(null); // { type, entry }
  const [draft, setDraft] = useState({ planId: "", amountUsd: "", days: "30", deltaUsd: "", limits: [] });
  const [savingOrder, setSavingOrder] = useState(false);
  const [orderError, setOrderError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [res, plansRes] = await Promise.all([
        fetch(`/api/users/${userId}/plans`, { cache: "no-store" }),
        fetch("/api/plans", { cache: "no-store" }),
      ]);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Không tải được gói của người dùng");
      setData({ queue: Array.isArray(body.queue) ? body.queue : [], history: Array.isArray(body.history) ? body.history : [] });

      if (plansRes.ok) {
        const plansBody = await plansRes.json().catch(() => ({}));
        setPlans(Array.isArray(plansBody.plans) ? plansBody.plans : []);
      }
    } catch (e) {
      setError(e.message || "Không tải được gói của người dùng");
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  const refresh = async () => {
    await load();
    if (onChanged) await onChanged();
  };

  const openAction = (type, entry = null) => {
    setNotice("");
    setDraft({
      planId: plans[0]?.id ?? "",
      amountUsd: "",
      days: "30",
      deltaUsd: "",
      limits: (entry?.limits ?? []).map((limit) => ({ hours: String(limit.hours), maxUsd: String(limit.maxNanoUsd / 1e9) })),
    });
    setAction({ type, entry });
  };

  const saveOrder = async (orderedIds) => {
    setSavingOrder(true);
    setOrderError("");
    try {
      const res = await fetch(`/api/users/${userId}/plans/order`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderedIds }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409) {
        setOrderError("Danh sách gói đã thay đổi — đã tải lại");
        await load();
        return false;
      }
      if (!res.ok) {
        setOrderError(body?.error?.message || body?.error || "Không lưu được thứ tự");
        return false;
      }
      setData((current) => ({ ...current, queue: Array.isArray(body.queue) ? body.queue : current.queue }));
      setNotice("Đã lưu thứ tự gói");
      return true;
    } catch (e) {
      setOrderError(e.message || "Không lưu được thứ tự");
      return false;
    } finally {
      setSavingOrder(false);
    }
  };

  const postGrant = async ({ reason }) => {
    const body = action.type === "grant-plan"
      ? { type: "plan", planId: draft.planId, reason }
      : { type: "credit", amountNanoUsd: usdToNano(Number(draft.amountUsd)), durationDays: Number(draft.days), reason };
    const res = await fetch(`/api/users/${userId}/plans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data2 = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data2.error || "Không cấp được" };
    await refresh();
    return { ok: true };
  };

  const patchPurchase = async (payload) => {
    const res = await fetch(`/api/users/${userId}/plans/${action.entry.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body.error || "Không thực hiện được" };
    await refresh();
    return { ok: true };
  };

  const renderActions = (entry) => (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="secondary" onClick={() => openAction("extend", entry)}>Gia hạn</Button>
      <Button size="sm" variant="secondary" onClick={() => openAction("adjust", entry)}>Điều chỉnh credit</Button>
      <Button size="sm" variant="secondary" onClick={() => openAction("limits", entry)}>Sửa hạn mức</Button>
      <Button size="sm" variant="ghost" className="text-danger hover:bg-red-500/10" onClick={() => openAction("revoke", entry)}>
        Thu hồi
      </Button>
    </div>
  );

  const limitsPreview = useMemo(
    () => draft.limits.map((limit) => `${fmtUsdNano(usdToNano(Number(limit.maxUsd) || 0))} mỗi ${limit.hours} giờ`).join(", "),
    [draft.limits]
  );

  if (loading) return <CardSkeleton />;

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <div role="alert" className="flex items-start justify-between gap-3 border border-danger/40 bg-danger/5 px-4 py-3">
          <span className="text-sm text-danger">{error}</span>
          <Button variant="secondary" size="sm" onClick={load}>Thử lại</Button>
        </div>
      )}

      {notice && (
        <p role="status" className="border border-brand-500/40 bg-brand-500/5 px-4 py-2 text-sm text-brand-700 dark:text-brand-400">
          {notice}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" icon="card_giftcard" onClick={() => openAction("grant-plan")}>Cấp gói</Button>
        <Button size="sm" variant="secondary" icon="add_card" onClick={() => openAction("grant-credit")}>Cấp credit</Button>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="meta text-text-muted">Hàng đợi</h2>
        <PlanQueue
          entries={data.queue}
          editable={data.queue.length > 1}
          onSave={saveOrder}
          renderActions={renderActions}
          saving={savingOrder}
          error={orderError}
        />
      </section>

      {data.history.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="meta text-text-muted">Lịch sử gói ({data.history.length})</h2>
          <div className="overflow-x-auto border border-border bg-surface">
            <table className="w-full min-w-[600px] border-collapse text-left">
              <thead>
                <tr className="border-b border-border bg-surface-2">
                  <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Gói</th>
                  <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Nguồn</th>
                  <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Đã nhận</th>
                  <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Hết hạn</th>
                  <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {data.history.map((row) => (
                  <tr key={row.id} className="border-b border-border last:border-b-0">
                    <td className="px-4 py-2 text-sm text-text-main">{row.planName || row.planCode || "Gói"}</td>
                    <td className="px-4 py-2 font-mono text-[12px] text-text-muted">{row.source}</td>
                    <td className="px-4 py-2 font-mono text-[12px] text-text-main">{fmtUsdNano(row.creditTotalNanoUsd)}</td>
                    <td className="px-4 py-2 font-mono text-[12px] text-text-muted">
                      {row.expiresAt ? new Date(row.expiresAt).toLocaleDateString("vi-VN") : "—"}
                    </td>
                    <td className="px-4 py-2 font-mono text-[12px] text-text-muted">{row.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Grant plan */}
      <ReasonModal
        isOpen={action?.type === "grant-plan"}
        title="Cấp gói"
        description="Tạo một gói mới cho khách, không qua đơn hàng. Hạn mức được chụp từ gói ở thời điểm này."
        confirmLabel="Cấp gói"
        onClose={() => setAction(null)}
        values={{ planId: draft.planId }}
        extraValid={Boolean(draft.planId)}
        onConfirm={postGrant}
        renderFields={() => (
          <Select
            label="Gói"
            value={draft.planId}
            onChange={(event) => setDraft((d) => ({ ...d, planId: event.target.value }))}
            options={plans.map((plan) => ({ value: plan.id, label: `${plan.name} · ${fmtUsdNano(plan.creditNanoUsd)}` }))}
          />
        )}
      />

      {/* Grant credit */}
      <ReasonModal
        isOpen={action?.type === "grant-credit"}
        title="Cấp credit"
        description="Cộng credit không kèm gói. Credit này không có hạn mức theo khung giờ."
        confirmLabel="Cấp credit"
        onClose={() => setAction(null)}
        extraValid={Number(draft.amountUsd) > 0}
        onConfirm={postGrant}
        renderFields={() => (
          <>
            <Input
              label="Số credit ($)"
              value={draft.amountUsd}
              onChange={(event) => setDraft((d) => ({ ...d, amountUsd: event.target.value }))}
              inputMode="decimal"
              placeholder="25"
              hint="Từ $0.01 đến $10,000"
            />
            <Input
              label="Số ngày"
              value={draft.days}
              onChange={(event) => setDraft((d) => ({ ...d, days: event.target.value }))}
              inputMode="numeric"
              hint="1–3650"
            />
          </>
        )}
      />

      {/* Extend */}
      <ReasonModal
        isOpen={action?.type === "extend"}
        title="Gia hạn gói"
        description={`Gói ${action?.entry?.planName || action?.entry?.planCode || ""} — cộng thêm số ngày vào ngày hết hạn hiện tại.`}
        confirmLabel="Gia hạn"
        onClose={() => setAction(null)}
        extraValid={Number(draft.days) > 0}
        onConfirm={({ reason }) => patchPurchase({ action: "extend", days: Number(draft.days), reason })}
        renderFields={() => (
          <Input
            label="Số ngày gia hạn"
            value={draft.days}
            onChange={(event) => setDraft((d) => ({ ...d, days: event.target.value }))}
            inputMode="numeric"
            hint="1–3650"
          />
        )}
      />

      {/* Adjust */}
      <ReasonModal
        isOpen={action?.type === "adjust"}
        title="Điều chỉnh credit"
        description={`Còn ${fmtUsdNano(action?.entry?.creditRemainingNanoUsd ?? 0)}. Số âm để trừ, số dương để cộng; không thể trừ quá số còn lại.`}
        confirmLabel="Điều chỉnh"
        onClose={() => setAction(null)}
        extraValid={Number(draft.deltaUsd) !== 0 && draft.deltaUsd !== ""}
        onConfirm={({ reason }) => patchPurchase({ action: "adjust", deltaNanoUsd: usdToNano(Number(draft.deltaUsd)), reason })}
        renderFields={() => (
          <Input
            label="Số credit thay đổi ($)"
            value={draft.deltaUsd}
            onChange={(event) => setDraft((d) => ({ ...d, deltaUsd: event.target.value }))}
            inputMode="decimal"
            placeholder="-30 hoặc 50"
            hint="Khác 0, tối đa $10,000"
          />
        )}
      />

      {/* Limits */}
      <ReasonModal
        isOpen={action?.type === "limits"}
        title="Sửa hạn mức của gói đã mua"
        description={`Hạn mức hiện tại: ${limitsPreview || "không có"}. Khung giờ bị bỏ sẽ xóa trạng thái; khung giờ giữ lại giữ nguyên mức đã dùng.`}
        confirmLabel="Lưu hạn mức"
        onClose={() => setAction(null)}
        extraValid={draft.limits.length > 0}
        onConfirm={({ reason }) =>
          patchPurchase({
            action: "limits",
            limits: draft.limits.map((limit) => ({ hours: Number(limit.hours), maxNanoUsd: usdToNano(Number(limit.maxUsd) || 0) })),
            reason,
          })
        }
        renderFields={() => (
          <div className="flex flex-col gap-2">
            {draft.limits.map((limit, index) => (
              <div key={index} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                <Select
                  label="Khung giờ"
                  value={limit.hours}
                  onChange={(event) =>
                    setDraft((d) => ({
                      ...d,
                      limits: d.limits.map((row, i) => (i === index ? { ...row, hours: event.target.value } : row)),
                    }))
                  }
                  options={WINDOW_OPTIONS}
                />
                <Input
                  label="Tối đa ($)"
                  value={limit.maxUsd}
                  onChange={(event) =>
                    setDraft((d) => ({
                      ...d,
                      limits: d.limits.map((row, i) => (i === index ? { ...row, maxUsd: event.target.value } : row)),
                    }))
                  }
                  inputMode="decimal"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  icon="delete"
                  aria-label={`Xóa hạn mức ${index + 1}`}
                  onClick={() => setDraft((d) => ({ ...d, limits: d.limits.filter((_, i) => i !== index) }))}
                />
              </div>
            ))}
            <Button
              size="sm"
              variant="secondary"
              icon="add"
              onClick={() => setDraft((d) => ({ ...d, limits: [...d.limits, { hours: "24", maxUsd: "" }] }))}
            >
              Thêm hạn mức
            </Button>
          </div>
        )}
      />

      {/* Revoke */}
      <ReasonModal
        isOpen={action?.type === "revoke"}
        title="Thu hồi gói"
        description={`Thu hồi gói ${action?.entry?.planName || action?.entry?.planCode || ""} sẽ đặt credit còn lại (${fmtUsdNano(action?.entry?.creditRemainingNanoUsd ?? 0)}) về 0 và ghi một dòng sổ cái. Không thể hoàn tác.`}
        confirmLabel="Thu hồi"
        onClose={() => setAction(null)}
        onConfirm={({ reason }) => patchPurchase({ action: "revoke", reason })}
      />
    </div>
  );
}
