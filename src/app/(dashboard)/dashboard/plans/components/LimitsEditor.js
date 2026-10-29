"use client";

import { Button, Input, Select } from "@/shared/components";
import { usdToNano } from "@/shared/utils/money";
import { WINDOW_PRESETS, validateLimits, windowLabel, describeLimit } from "@/lib/billing/limits.js";

// Limits editor for the admin plan form (spec plan-templates "Admin plan form").
//
// Rows of (window length, USD maximum). The window is one of the presets or a
// custom number of hours. Validation and labels come from the shared pure module,
// so the form cannot disagree with the API about what is valid.
const CUSTOM = "custom";

/** Draft rows: `{ hours: string, maxUsd: string }` — plain strings while typing. */
export function limitsToDraft(limits) {
  return (Array.isArray(limits) ? limits : []).map((limit) => ({
    hours: String(limit.hours),
    maxUsd: String(Math.round((Number(limit.maxNanoUsd) || 0) / 1e7) / 100),
  }));
}

/** Draft rows → the array the API wants, or `null` when the list is empty. */
export function draftToLimits(rows) {
  const limits = (rows || [])
    .filter((row) => row.hours !== "" && row.maxUsd !== "")
    .map((row) => ({
      hours: Number(row.hours),
      maxNanoUsd: usdToNano(Number(row.maxUsd)),
    }))
    .sort((a, b) => a.hours - b.hours);
  return limits.length ? limits : null;
}

/** Vietnamese errors for the limits block, computed from the same rules as the API. */
export function draftLimitsError(rows, { creditUsd, durationDays }) {
  const limits = draftToLimits(rows);
  if (!limits) return null;
  return validateLimits(limits, {
    creditNanoUsd: usdToNano(Number(creditUsd) || 0),
    durationDays: Number(durationDays) || 0,
  });
}

export default function LimitsEditor({ rows, onChange, creditUsd, durationDays, error }) {
  const update = (index, patch) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const remove = (index) => onChange(rows.filter((_, i) => i !== index));

  const add = () => {
    // Offer the first preset not already used, so a fresh row is normally valid.
    const used = new Set(rows.map((row) => row.hours));
    const next = WINDOW_PRESETS.find((preset) => !used.has(String(preset.hours)));
    onChange([...rows, { hours: next ? String(next.hours) : "", maxUsd: "" }]);
  };

  // The live preview sentence of the spec, e.g.
  // "Khách trả $10 → nhận $250 dùng chung mọi model trong 30 ngày; tối đa $20 mỗi 5 giờ".
  // Price is not a prop of this editor, so it renders the credit half; the form
  // wraps it with the price (see PlansPageClient).
  const preview = (() => {
    const limits = draftToLimits(rows);
    if (!limits) return null;
    const days = Number(durationDays) || 0;
    return `nhận $${formatNumber(creditUsd)} dùng chung mọi model trong ${days} ngày; ${limits
      .map(describeLimit)
      .join(", ")}`;
  })();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="meta text-text-subtle">Hạn mức theo cửa sổ</h3>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          icon="add"
          onClick={add}
          disabled={rows.length >= 5}
        >
          Thêm hạn mức
        </Button>
      </div>

      <p className="text-xs text-text-muted">
        Mỗi hạn mức giới hạn số tiền một gói được dùng trong một cửa sổ thời gian. Cửa sổ mở ở lần
        trừ tiền đầu tiên và tính lại sau đúng độ dài đó.
      </p>

      {rows.length === 0 && (
        <p className="border border-border bg-surface-2 px-3 py-2 text-xs text-text-muted">
          Không có hạn mức — gói chỉ dừng khi hết credit.
        </p>
      )}

      {rows.map((row, index) => {
        const isPreset = WINDOW_PRESETS.some((preset) => String(preset.hours) === row.hours);
        const windowValue = isPreset ? row.hours : CUSTOM;
        return (
          <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2">
            <div className="flex flex-col gap-1.5">
              <label className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">
                Cửa sổ
              </label>
              <Select
                value={windowValue}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === CUSTOM) update(index, { hours: "" });
                  else update(index, { hours: value });
                }}
                options={[
                  ...WINDOW_PRESETS.map((preset) => ({ value: String(preset.hours), label: preset.label })),
                  { value: CUSTOM, label: "Tuỳ chỉnh" },
                ]}
                selectClassName="h-10"
                aria-label={`Cửa sổ của hạn mức ${index + 1}`}
              />
            </div>

            {windowValue === CUSTOM ? (
              <Input
                label="Số giờ"
                value={row.hours}
                onChange={(event) => update(index, { hours: event.target.value })}
                inputMode="numeric"
                placeholder="72"
                aria-label={`Số giờ của hạn mức ${index + 1}`}
              />
            ) : (
              <div className="flex flex-col gap-1.5">
                <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">
                  Độ dài
                </span>
                <span className="h-10 flex items-center font-mono text-[12px] text-text-muted">
                  {windowLabel(row.hours)}
                </span>
              </div>
            )}

            <div className="flex items-end gap-2">
              <Input
                label="Tối đa ($)"
                value={row.maxUsd}
                onChange={(event) => update(index, { maxUsd: event.target.value })}
                inputMode="decimal"
                placeholder="20"
                aria-label={`Mức tối đa của hạn mức ${index + 1}`}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                icon="delete"
                onClick={() => remove(index)}
                aria-label={`Xoá hạn mức ${index + 1}`}
                className="text-red-600 hover:bg-red-500/10 mb-1"
              />
            </div>
          </div>
        );
      })}

      {error && (
        <p role="alert" className="flex items-center gap-1.5 text-[11px] text-danger">
          <span className="material-symbols-outlined text-[14px]" aria-hidden="true">error</span>
          {error}
        </p>
      )}

      {preview && !error && (
        <p className="border border-border bg-surface-2 px-3 py-2 text-sm text-text-main">
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-subtle">
            Xem trước
          </span>
          <span className="mt-1 block">{preview}</span>
        </p>
      )}
    </div>
  );
}

/** "$10" for a round draft string, "$19.5" kept as typed. */
function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? "").trim() || "0";
  return String(n);
}
