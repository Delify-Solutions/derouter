"use client";

import { Button, Input, Select } from "@/shared/components";
import { usdToNano } from "@/shared/utils/money";
import { WINDOW_PRESETS, validateLimits, windowLabel, describeLimit, limitCeiling } from "@/lib/billing/limits.js";
import { isImagePlan } from "@/lib/billing/planKind.js";

// Limits editor for the admin plan form (spec plan-templates "Admin plan form").
//
// Rows of (window length, maximum). The window is one of the presets or a custom
// number of hours. The maximum is in the plan's own unit — dollars for a credit
// plan, a number of images for an image plan — so a window is never compared with
// the wrong balance. Validation and labels come from the shared pure module, so the
// form cannot disagree with the API about what is valid.
const CUSTOM = "custom";

/** Draft rows: `{ hours: string, maxUsd: string, maxImages: string }` — strings while typing. */
export function limitsToDraft(limits) {
  return (Array.isArray(limits) ? limits : []).map((limit) => {
    const ceiling = limitCeiling(limit);
    return {
      hours: String(limit.hours),
      maxUsd: ceiling.images ? "" : String(Math.round((Number(limit.maxNanoUsd) || 0) / 1e7) / 100),
      maxImages: ceiling.images ? String(ceiling.max) : "",
    };
  });
}

/**
 * Draft rows → the array the API wants, or `null` when the list is empty.
 * `kind` decides which column carries the maximum: a row typed in the other unit
 * is dropped rather than silently converted (images have no dollar price).
 */
export function draftToLimits(rows, kind = "llm") {
  const images = isImagePlan(kind);
  const limits = (rows || [])
    .filter((row) => row.hours !== "" && (images ? row.maxImages : row.maxUsd) !== "")
    .map((row) => ({
      hours: Number(row.hours),
      maxNanoUsd: images ? 0 : usdToNano(Number(row.maxUsd)),
      maxImages: images ? Math.floor(Number(row.maxImages)) : 0,
    }))
    .sort((a, b) => a.hours - b.hours);
  return limits.length ? limits : null;
}

/** Vietnamese errors for the limits block, computed from the same rules as the API. */
export function draftLimitsError(rows, { creditUsd, durationDays, kind = "llm", imageCount = 0 }) {
  const limits = draftToLimits(rows, kind);
  if (!limits) return null;
  return validateLimits(limits, {
    kind,
    imageTotal: Number(imageCount) || 0,
    creditNanoUsd: usdToNano(Number(creditUsd) || 0),
    durationDays: Number(durationDays) || 0,
  });
}

export default function LimitsEditor({
  rows,
  onChange,
  creditUsd,
  imageCount = 0,
  kind = "llm",
  unlimitedCredit = false,
  durationDays,
  error,
}) {
  const imagePlan = isImagePlan(kind);
  const update = (index, patch) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const remove = (index) => onChange(rows.filter((_, i) => i !== index));

  const add = () => {
    // Offer the first preset not already used, so a fresh row is normally valid.
    const used = new Set(rows.map((row) => row.hours));
    const next = WINDOW_PRESETS.find((preset) => !used.has(String(preset.hours)));
    onChange([...rows, { hours: next ? String(next.hours) : "", maxUsd: "", maxImages: "" }]);
  };

  // The live preview sentence of the spec, e.g.
  // "Khách trả $10 → nhận $250 dùng chung mọi model trong 30 ngày; tối đa $20 mỗi 5 giờ".
  // Price is not a prop of this editor, so it renders the credit half; the form
  // wraps it with the price (see PlansPageClient).
  const preview = (() => {
    const limits = draftToLimits(rows, kind);
    if (!limits) return null;
    const days = Number(durationDays) || 0;
    const what = imagePlan
      ? `nhận ${Number(imageCount || 0).toLocaleString("vi-VN")} ảnh`
      : unlimitedCredit ? "credit không giới hạn" : `nhận $${formatNumber(creditUsd)}`;
    return `${what} trong ${days} ngày; ${limits.map(describeLimit).join(", ")}`;
  })();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="meta text-text-subtle">
          Hạn mức theo khung giờ {imagePlan ? "(số ảnh)" : "(USD)"}
        </h3>
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
        {imagePlan
          ? "Mỗi hạn mức giới hạn số ảnh một gói được tạo trong một khung giờ. Khung giờ mở ở lần trừ đầu tiên và tính lại sau đúng độ dài đó."
          : "Mỗi hạn mức giới hạn số tiền một gói được dùng trong một khung giờ. Khung giờ mở ở lần trừ tiền đầu tiên và tính lại sau đúng độ dài đó."}
      </p>

      {rows.length === 0 && (
        <p className="border border-border bg-surface-2 px-3 py-2 text-xs text-text-muted">
          {imagePlan
            ? "Không có hạn mức — gói chỉ dừng khi hết số ảnh."
            : unlimitedCredit
              ? "Chưa có hạn mức theo khung giờ — gói không giới hạn credit cần ít nhất một hạn mức, hoặc RPM/TPM."
              : "Không có hạn mức — gói chỉ dừng khi hết credit."}
        </p>
      )}

      {rows.map((row, index) => {
        const isPreset = WINDOW_PRESETS.some((preset) => String(preset.hours) === row.hours);
        const windowValue = isPreset ? row.hours : CUSTOM;
        return (
          <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2">
            <div className="flex flex-col gap-1.5">
              <label className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">
                Khung giờ
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
                aria-label={`Khung giờ của hạn mức ${index + 1}`}
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
              {imagePlan ? (
                <Input
                  label="Tối đa (ảnh)"
                  value={row.maxImages}
                  onChange={(event) => update(index, { maxImages: event.target.value })}
                  inputMode="numeric"
                  placeholder="20"
                  aria-label={`Số ảnh tối đa của hạn mức ${index + 1}`}
                />
              ) : (
                <Input
                  label="Tối đa ($)"
                  value={row.maxUsd}
                  onChange={(event) => update(index, { maxUsd: event.target.value })}
                  inputMode="decimal"
                  placeholder="20"
                  aria-label={`Mức tối đa của hạn mức ${index + 1}`}
                />
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                icon="delete"
                onClick={() => remove(index)}
                aria-label={`Xóa hạn mức ${index + 1}`}
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
