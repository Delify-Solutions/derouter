"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Input } from "@/shared/components";
import { fmtUsdNano, usdToNano } from "@/shared/utils/money";
import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";

// Mirrors the derivation in planLimitsRepo: a plan stores only the monthly
// ceiling and the shorter windows are fractions of it. Duplicated here so the
// admin sees the exact numbers enforcement will use while typing, without a
// round trip; the source of truth stays server-side.
const WINDOWS = [
  { id: "5h", label: "5 giờ", fraction: 0.2 },
  { id: "week", label: "1 tuần", fraction: 0.5 },
  { id: "month", label: "1 tháng", fraction: 1 },
];

function windowAmount(monthlyNano, fraction) {
  return Math.round((Number(monthlyNano) || 0) * fraction);
}

// Flat list of model ids the admin can pick from. Keys of PROVIDER_MODELS are
// provider ALIASES, not provider ids, so each key is mapped back to its id for
// the option value — the same shape a client sends in `model`.
function modelOptions() {
  const out = [];
  for (const [alias, models] of Object.entries(PROVIDER_MODELS || {})) {
    if (!Array.isArray(models)) continue;
    const providerId =
      Object.keys(PROVIDER_ID_TO_ALIAS).find((id) => PROVIDER_ID_TO_ALIAS[id] === alias) || alias;
    for (const m of models) {
      if (!m?.id) continue;
      out.push({ id: `${providerId}/${m.id}`, name: m.name || m.id });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Searchable model picker.
 *
 * The catalog has ~900 entries, so a native <select> is unusable: scrolling to a
 * model is impractical and there is no type-ahead on most platforms. This keeps
 * the closed control looking like a field and only renders the filtered list
 * while open, capping the row count so opening it stays cheap.
 */
const MAX_VISIBLE = 40;

function ModelPicker({ value, options, disabled, onChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? options.filter((o) => o.id.toLowerCase().includes(q))
      : options;
    return list.slice(0, MAX_VISIBLE);
  }, [options, query]);

  const total = query.trim()
    ? options.filter((o) => o.id.toLowerCase().includes(query.trim().toLowerCase())).length
    : options.length;

  if (!open) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => { setOpen(true); setQuery(""); }}
        className="h-9 border border-border bg-surface px-2 text-left text-sm font-mono text-text-main truncate disabled:opacity-50"
      >
        {value || <span className="text-text-subtle">— chọn model —</span>}
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-1 border border-border bg-surface p-2">
      <input
        autoFocus
        value={query}
        disabled={disabled}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Tìm model…"
        className="h-8 border border-border bg-surface px-2 text-sm text-text-main"
      />
      <ul className="max-h-56 overflow-auto">
        {filtered.length === 0 && (
          <li className="px-2 py-1 text-[12px] text-text-subtle">Không tìm thấy model</li>
        )}
        {filtered.map((o) => (
          <li key={o.id}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => { onChange(o.id); setOpen(false); }}
              className={`w-full px-2 py-1 text-left text-[12px] font-mono hover:bg-surface-2 ${
                o.id === value ? "text-brand-700 dark:text-brand-400" : "text-text-main"
              }`}
            >
              {o.id}
            </button>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-text-subtle">
          {total > MAX_VISIBLE ? `${MAX_VISIBLE}/${total} kết quả — gõ để lọc` : `${total} model`}
        </span>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Đóng</Button>
      </div>
    </div>
  );
}

/**
 * Editor for a plan's per-model monthly ceilings.
 *
 * Rows are kept in local state and saved as a whole set, which is what the API
 * expects: a partial save would leave removed models metering traffic.
 */
export default function PlanModelLimits({ planId, disabled = false }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const options = useMemo(() => modelOptions(), []);

  const load = useCallback(async () => {
    if (!planId) {
      setRows([]);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/plans/${planId}/model-limits`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Không tải được hạn mức");
      setRows((data.limits || []).map((l) => ({
        model: l.model,
        monthlyUsd: String(l.monthlyNanoUsd / 1e9),
      })));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [planId]);

  useEffect(() => { load(); }, [load]);

  const addRow = () => {
    const used = new Set(rows.map((r) => r.model));
    const next = options.find((o) => !used.has(o.id));
    setRows([...rows, { model: next?.id || "", monthlyUsd: "" }]);
    setSaved(false);
  };

  const updateRow = (index, patch) => {
    setRows(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
    setSaved(false);
  };

  const removeRow = (index) => {
    setRows(rows.filter((_, i) => i !== index));
    setSaved(false);
  };

  // A row is only submittable when the model is set once and the amount parses
  // to a positive number; otherwise the API would reject the whole set and the
  // admin would lose their other edits.
  const invalid = useMemo(() => {
    const seen = new Set();
    for (const r of rows) {
      if (!r.model) return true;
      if (seen.has(r.model)) return true;
      seen.add(r.model);
      const n = Number(r.monthlyUsd);
      if (!Number.isFinite(n) || n <= 0) return true;
    }
    return false;
  }, [rows]);

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/plans/${planId}/model-limits`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          limits: rows.map((r) => ({
            model: r.model,
            monthlyNanoUsd: usdToNano(Number(r.monthlyUsd)),
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Không lưu được hạn mức");
      setRows((data.limits || []).map((l) => ({
        model: l.model,
        monthlyUsd: String(l.monthlyNanoUsd / 1e9),
      })));
      setSaved(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (!planId) {
    return (
      <p className="text-[12px] text-text-muted">
        Lưu gói trước, sau đó mới đặt được hạn mức theo model.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p className="text-[12px] text-text-muted">
          Hạn mức tính bằng USD cho từng model, trong một tháng. Cửa sổ 5 giờ và
          1 tuần được suy ra tự động (20% và 50%), không đặt riêng.
        </p>
        <p className="text-[11px] text-text-subtle">
          Để trống danh sách nghĩa là gói không giới hạn theo model — chỉ tiêu
          theo hạn mức tín dụng chung của gói.
        </p>
      </div>

      {loading ? (
        <p className="text-[12px] text-text-muted">Đang tải…</p>
      ) : rows.length === 0 ? (
        <p className="text-[12px] text-text-subtle">Chưa đặt hạn mức model nào.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row, i) => (
            <li key={i} className="border border-border bg-surface-2 p-3 flex flex-col gap-3">
              <div className="grid grid-cols-1 sm:grid-cols-[1fr_140px_auto] gap-3 items-end">
                <div className="flex flex-col gap-1 min-w-0">
                  <span className="meta text-text-subtle">Model</span>
                  <ModelPicker
                    value={row.model}
                    options={options}
                    disabled={disabled}
                    onChange={(model) => updateRow(i, { model })}
                  />
                </div>
                <Input
                  label="Hạn mức / tháng (USD)"
                  value={row.monthlyUsd}
                  disabled={disabled}
                  onChange={(e) => updateRow(i, { monthlyUsd: e.target.value })}
                  inputMode="decimal"
                />
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => removeRow(i)}
                  disabled={disabled}
                >
                  Xóa
                </Button>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-text-subtle">
                {WINDOWS.map((w) => (
                  <span key={w.id}>
                    {w.label}: <span className="text-text-main">
                      {fmtUsdNano(windowAmount(usdToNano(Number(row.monthlyUsd) || 0), w.fraction))}
                    </span>
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p className="flex items-center gap-1.5 text-[11px] text-danger">
          <span className="material-symbols-outlined text-[14px]">error</span>
          {error}
        </p>
      )}
      {saved && !error && (
        <p className="flex items-center gap-1.5 text-[11px] text-brand-700 dark:text-brand-400">
          <span className="material-symbols-outlined text-[14px]">check_circle</span>
          Đã lưu hạn mức
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" onClick={addRow} disabled={disabled || saving}>
          Thêm model
        </Button>
        <Button onClick={save} loading={saving} disabled={disabled || invalid || rows.length === 0}>
          Lưu hạn mức
        </Button>
      </div>
    </div>
  );
}
