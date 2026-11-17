"use client";

import { Button, Input, Select, AllowedModelsPicker } from "@/shared/components";
import { usdToNano } from "@/shared/utils/money";
import { WINDOW_PRESETS, windowLabel } from "@/lib/billing/limits.js";
import { validateModelCaps, MAX_MODEL_CAPS } from "@/lib/billing/modelCaps.js";

// Admin editor for a plan's model caps (spec plan-templates "A plan may cap the spend of a
// group of models"): rows of (name, models, maximum in dollars, whole term or a window).
// The rules come from the shared pure module, so the form cannot disagree with the API.
const CUSTOM = "custom";
const TERM = "term";

/** Draft rows: strings while typing. `scope` is "term" (whole life of the purchase) or "window". */
export function capsToDraft(caps) {
  return (Array.isArray(caps) ? caps : []).map((cap) => ({
    id: cap.id || "",
    label: cap.label || "",
    models: Array.isArray(cap.models) ? cap.models : [],
    maxUsd: String(Math.round((Number(cap.maxNanoUsd) || 0) / 1e7) / 100),
    scope: cap.hours == null ? "term" : "window",
    hours: cap.hours == null ? "" : String(cap.hours),
  }));
}

/** Draft rows → the array the API wants. An existing row keeps its id (its spend stays attached). */
export function draftToCaps(rows) {
  return (rows || []).map((row) => ({
    ...(row.id ? { id: row.id } : {}),
    label: String(row.label ?? "").trim(),
    models: Array.isArray(row.models) ? row.models : [],
    maxNanoUsd: usdToNano(Number(row.maxUsd) || 0),
    hours: row.scope === "window" ? Number(row.hours) || -1 : null,
  }));
}

/** Vietnamese error for the caps block, from the same rules as the API; null when valid. */
export function draftCapsError(rows, { creditUsd, unlimitedCredit, durationDays, kind = "llm" }) {
  if (!rows || rows.length === 0) return null;
  return validateModelCaps(draftToCaps(rows), {
    kind,
    creditNanoUsd: usdToNano(Number(creditUsd) || 0),
    unlimited: unlimitedCredit === true,
    durationDays: Number(durationDays) || 0,
  });
}

export default function ModelCapsEditor({ rows, onChange, creditUsd, unlimitedCredit = false, durationDays, error }) {
  const update = (index, patch) => onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const remove = (index) => onChange(rows.filter((_, i) => i !== index));
  const add = () => onChange([...rows, { id: "", label: "", models: [], maxUsd: "", scope: "term", hours: "" }]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="meta text-text-subtle">Giới hạn riêng theo model (USD)</h3>
        <Button type="button" variant="secondary" size="sm" icon="add" onClick={add} disabled={rows.length >= MAX_MODEL_CAPS}>
          Thêm giới hạn
        </Button>
      </div>

      <p className="text-xs text-text-muted">
        Một nhóm model chỉ được tiêu tối đa bấy nhiêu tiền trong pool của gói (ví dụ ảnh tối đa $15 trong gói $150). Tiền vẫn
        trừ chung vào pool; hết hạn mức thì chỉ nhóm model đó bị chặn, các model khác vẫn dùng tiếp phần còn lại.
        Thay đổi áp dụng ngay cho mọi khách đang giữ gói này.
      </p>

      {rows.length === 0 && (
        <p className="border border-border bg-surface-2 px-3 py-2 text-xs text-text-muted">
          Không có giới hạn riêng — mọi model dùng chung pool không phân biệt.
        </p>
      )}

      {rows.map((row, index) => {
        const isPreset = WINDOW_PRESETS.some((preset) => String(preset.hours) === row.hours);
        const periodValue = row.scope === "term" ? TERM : isPreset ? row.hours : CUSTOM;
        return (
          <div key={row.id || index} className="flex flex-col gap-3 border border-border p-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,9rem)_minmax(0,1fr)_auto] sm:items-end">
              <Input
                label="Tên nhóm"
                value={row.label}
                onChange={(event) => update(index, { label: event.target.value })}
                placeholder="Ảnh"
                aria-label={`Tên nhóm (giới hạn ${index + 1})`}
              />
              <Input
                label="Tối đa ($)"
                value={row.maxUsd}
                onChange={(event) => update(index, { maxUsd: event.target.value })}
                inputMode="decimal"
                placeholder="15"
                aria-label={`Tối đa ($) (giới hạn ${index + 1})`}
              />
              <div className="flex flex-col gap-1.5">
                <label className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">Tính theo</label>
                <Select
                  value={periodValue}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === TERM) update(index, { scope: "term", hours: "" });
                    else if (value === CUSTOM) update(index, { scope: "window", hours: "" });
                    else update(index, { scope: "window", hours: value });
                  }}
                  options={[
                    { value: TERM, label: "Cả thời hạn gói" },
                    ...WINDOW_PRESETS.map((preset) => ({ value: String(preset.hours), label: `Mỗi ${preset.label}` })),
                    { value: CUSTOM, label: "Mỗi … giờ (tuỳ chỉnh)" },
                  ]}
                  selectClassName="h-10"
                  aria-label={`Tính theo (giới hạn ${index + 1})`}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                icon="delete"
                onClick={() => remove(index)}
                aria-label={`Xoá giới hạn ${index + 1}`}
              />
            </div>

            {periodValue === CUSTOM && (
              <Input
                label="Số giờ"
                value={row.hours}
                onChange={(event) => update(index, { hours: event.target.value })}
                inputMode="numeric"
                placeholder="72"
                hint={row.hours ? `Chu kỳ ${windowLabel(row.hours)}` : undefined}
                aria-label={`Số giờ (giới hạn ${index + 1})`}
              />
            )}

            <div className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">Model thuộc nhóm</span>
              <AllowedModelsPicker value={row.models} onChange={(names) => update(index, { models: names })} />
              {row.models.length > 0 && (
                <p className="text-[11px] text-text-muted">
                  {row.models.length} model: {row.models.join(", ")}
                </p>
              )}
            </div>
          </div>
        );
      })}

      {unlimitedCredit && rows.length > 0 && (
        <p className="text-[11px] text-text-muted">
          Gói không giới hạn credit: giới hạn này là mức chặn duy nhất của nhóm model đó.
        </p>
      )}
      {creditUsd && !unlimitedCredit && rows.length > 0 && (
        <p className="text-[11px] text-text-muted">Mỗi mức tối đa phải nhỏ hơn credit của gói (${creditUsd}).</p>
      )}
      {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}
