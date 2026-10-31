"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import PropTypes from "prop-types";
import Modal, { ConfirmModal } from "./Modal";
import Button from "./Button";
import { percentLabel, dateTimeLabel } from "@/shared/utils/discountFormat";

// "Giảm giá" section of the combo, plan and group screens (spec model-discounts
// "Admin management"). One modal per scope: it lists that scope's rules and lets
// the admin add, edit, switch off and delete them. Rules of OTHER scopes that can
// stack on the same request are not visible here; the overlap figure below only
// covers this scope.

const STATUS = {
  active: { label: "Đang chạy", icon: "play_circle" },
  upcoming: { label: "Chưa bắt đầu", icon: "schedule" },
  expired: { label: "Đã hết hạn", icon: "history" },
  disabled: { label: "Đã tắt", icon: "pause_circle" },
};

const SCOPE_NAMES = { combo: "combo", plan: "gói", group: "nhóm" };

// ISO instant → value of <input type="datetime-local"> in the browser's zone.
function toLocalInput(iso) {
  if (!iso) return "";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

// <input type="datetime-local"> value → ISO instant ("" → null).
function fromLocalInput(value) {
  if (!value) return null;
  const t = new Date(value);
  return Number.isNaN(t.getTime()) ? undefined : t.toISOString();
}

// 1250 → "12.5" (text for the percent input; no float math).
function bpToInput(bp) {
  const n = Math.round(Number(bp) || 0);
  const frac = String(n % 100).padStart(2, "0").replace(/0+$/, "");
  return `${Math.floor(n / 100)}${frac ? `.${frac}` : ""}`;
}

const EMPTY_FORM = { percent: "", allModels: true, models: [], startsAt: "", endsAt: "", label: "", isActive: true };

export default function DiscountsModal({ isOpen, onClose, scopeType, scopeId, scopeLabel }) {
  const [rules, setRules] = useState([]);
  const [overlap, setOverlap] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [editing, setEditing] = useState(null); // null | "new" | rule
  const [form, setForm] = useState(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [combos, setCombos] = useState([]);
  const [modelQuery, setModelQuery] = useState("");

  const needsModels = scopeType !== "combo";

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const res = await fetch(`/api/discounts?scopeType=${encodeURIComponent(scopeType)}&scopeId=${encodeURIComponent(scopeId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Không tải được danh sách giảm giá");
      setRules(data.rules || []);
      setOverlap(data.overlap || null);
    } catch (e) {
      setLoadError(e.message || "Không tải được danh sách giảm giá");
    } finally {
      setLoading(false);
    }
  }, [scopeType, scopeId]);

  useEffect(() => {
    // The modal is mounted fresh each time it is opened, so `loading` starts true.
    if (isOpen) load();
  }, [isOpen, load]);

  // The model picker only exists for plan/group scope: combo names, LLM only.
  useEffect(() => {
    if (!isOpen || !needsModels) return;
    let cancelled = false;
    fetch("/api/combos")
      .then((r) => (r.ok ? r.json() : { combos: [] }))
      .then((data) => {
        if (!cancelled) setCombos((data.combos || []).filter((c) => !c.kind || c.kind === "llm"));
      })
      .catch(() => { if (!cancelled) setCombos([]); });
    return () => { cancelled = true; };
  }, [isOpen, needsModels]);

  const openNew = () => {
    setForm(EMPTY_FORM);
    setFieldErrors({});
    setFormError("");
    setModelQuery("");
    setEditing("new");
  };

  const openEdit = (rule) => {
    setForm({
      percent: bpToInput(rule.percentBp),
      allModels: !rule.models,
      models: rule.models || [],
      startsAt: toLocalInput(rule.startsAt),
      endsAt: toLocalInput(rule.endsAt),
      label: rule.label || "",
      isActive: rule.isActive,
    });
    setFieldErrors({});
    setFormError("");
    setModelQuery("");
    setEditing(rule);
  };

  const submit = async () => {
    const startsAt = fromLocalInput(form.startsAt);
    const endsAt = fromLocalInput(form.endsAt);
    const errors = {};
    if (startsAt === undefined) errors.startsAt = "Thời điểm bắt đầu không hợp lệ";
    if (endsAt === undefined) errors.endsAt = "Thời điểm kết thúc không hợp lệ";
    if (needsModels && !form.allModels && form.models.length === 0) errors.models = "Chọn ít nhất một model hoặc chọn tất cả";
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setSaving(true);
    setFieldErrors({});
    setFormError("");
    const body = {
      percent: form.percent.trim(),
      startsAt,
      endsAt,
      label: form.label.trim() || null,
      isActive: form.isActive,
      models: needsModels && !form.allModels ? form.models : null,
    };
    try {
      const isNew = editing === "new";
      const res = await fetch(isNew ? "/api/discounts" : `/api/discounts/${editing.id}`, {
        method: isNew ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isNew ? { ...body, scopeType, scopeId } : body),
      });
      const data = await res.json();
      if (!res.ok) {
        const byField = {};
        for (const err of data.errors || []) if (!byField[err.field]) byField[err.field] = err.message;
        setFieldErrors(byField);
        if (Object.keys(byField).length === 0) setFormError(data.error || "Không lưu được giảm giá");
        return;
      }
      setEditing(null);
      await load();
    } catch (e) {
      setFormError(e.message || "Không lưu được giảm giá");
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (rule) => {
    setBusyId(rule.id);
    try {
      const res = await fetch(`/api/discounts/${rule.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !rule.isActive }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setLoadError(data.error || "Không đổi được trạng thái giảm giá");
      } else {
        setLoadError("");
      }
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const remove = async () => {
    const rule = confirmDelete;
    setConfirmDelete(null);
    if (!rule) return;
    setBusyId(rule.id);
    try {
      const res = await fetch(`/api/discounts/${rule.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setLoadError(data.error || "Không xóa được giảm giá");
      }
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const filteredCombos = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    return q ? combos.filter((c) => (c.name || "").toLowerCase().includes(q)) : combos;
  }, [combos, modelQuery]);

  const toggleModel = (name) =>
    setForm((f) => ({ ...f, models: f.models.includes(name) ? f.models.filter((m) => m !== name) : [...f.models, name] }));

  const label = "font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted";
  const field = "w-full h-10 px-3 text-sm bg-surface text-text-main border border-border rounded-none focus:border-brand-500 focus:outline-none";
  const errText = (key) =>
    fieldErrors[key] ? (
      <p id={`disc-${key}-err`} role="alert" className="text-[11px] text-red-600 flex items-center gap-1">
        <span className="material-symbols-outlined text-[14px]" aria-hidden="true">error</span>
        {fieldErrors[key]}
      </p>
    ) : null;

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title={`Giảm giá · ${scopeLabel}`}
        size="xl"
        footer={
          editing ? (
            <>
              <Button variant="ghost" onClick={() => setEditing(null)} disabled={saving}>Hủy</Button>
              <Button onClick={submit} loading={saving}>{editing === "new" ? "Thêm giảm giá" : "Lưu thay đổi"}</Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>Đóng</Button>
              <Button icon="add" onClick={openNew} disabled={loading}>Thêm giảm giá</Button>
            </>
          )
        }
      >
        {editing ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => { e.preventDefault(); submit(); }}
            noValidate
          >
            <p className="text-sm text-text-muted">
              Mỗi mức giảm là một quy tắc riêng, áp dụng lên giá niêm yết của model trong khoảng thời gian đã chọn.
              Các quy tắc cùng áp dụng cho một yêu cầu được cộng dồn, tổng tối đa 100%.
            </p>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="disc-percent" className={label}>Mức giảm (%)</label>
              <input
                id="disc-percent"
                type="text"
                inputMode="decimal"
                value={form.percent}
                onChange={(e) => setForm((f) => ({ ...f, percent: e.target.value }))}
                placeholder="Ví dụ 20 hoặc 12.5"
                aria-invalid={!!fieldErrors.percent}
                aria-describedby={fieldErrors.percent ? "disc-percent-err" : "disc-percent-hint"}
                className={`${field} font-mono ${fieldErrors.percent ? "border-red-600" : ""}`}
              />
              {errText("percent")}
              <p id="disc-percent-hint" className="text-[11px] text-text-muted">Từ 0,01 đến 100, bước 0,01. 100% là miễn phí.</p>
            </div>

            {needsModels && (
              <fieldset className="flex flex-col gap-2">
                <legend className={label}>Model áp dụng</legend>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="disc-models-mode"
                    checked={form.allModels}
                    onChange={() => setForm((f) => ({ ...f, allModels: true }))}
                  />
                  Tất cả model
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="disc-models-mode"
                    checked={!form.allModels}
                    onChange={() => setForm((f) => ({ ...f, allModels: false }))}
                  />
                  Chỉ các model đã chọn
                </label>
                {!form.allModels && (
                  <div className="border border-border">
                    <label htmlFor="disc-model-search" className="sr-only">Tìm combo</label>
                    <input
                      id="disc-model-search"
                      type="search"
                      value={modelQuery}
                      onChange={(e) => setModelQuery(e.target.value)}
                      placeholder="Tìm combo…"
                      className="w-full h-9 px-3 text-sm bg-surface border-b border-border focus:outline-none focus:border-brand-500 rounded-none"
                    />
                    <ul className="max-h-44 overflow-y-auto">
                      {filteredCombos.length === 0 ? (
                        <li className="px-3 py-3 text-xs text-text-muted">
                          {combos.length === 0 ? "Chưa có combo nào — tạo combo ở trang Combos trước." : "Không có combo nào khớp."}
                        </li>
                      ) : filteredCombos.map((c) => (
                        <li key={c.id || c.name} className="border-b border-border last:border-b-0">
                          <label className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-surface-2">
                            <input type="checkbox" checked={form.models.includes(c.name)} onChange={() => toggleModel(c.name)} />
                            <span className="font-mono text-xs truncate">{c.name}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {!form.allModels && (
                  <p className="text-[11px] text-text-muted">Đã chọn {form.models.length} model.</p>
                )}
                {errText("models")}
              </fieldset>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="disc-start" className={label}>Bắt đầu</label>
                <input
                  id="disc-start"
                  type="datetime-local"
                  value={form.startsAt}
                  onChange={(e) => setForm((f) => ({ ...f, startsAt: e.target.value }))}
                  aria-invalid={!!fieldErrors.startsAt}
                  className={`${field} font-mono ${fieldErrors.startsAt ? "border-red-600" : ""}`}
                />
                {errText("startsAt")}
                <p className="text-[11px] text-text-muted">Để trống: có hiệu lực ngay. Tính cả thời điểm bắt đầu. Giờ nhập theo múi giờ trình duyệt; danh sách hiển thị giờ Việt Nam.</p>
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="disc-end" className={label}>Kết thúc</label>
                <input
                  id="disc-end"
                  type="datetime-local"
                  value={form.endsAt}
                  onChange={(e) => setForm((f) => ({ ...f, endsAt: e.target.value }))}
                  aria-invalid={!!fieldErrors.endsAt}
                  className={`${field} font-mono ${fieldErrors.endsAt ? "border-red-600" : ""}`}
                />
                {errText("endsAt")}
                <p className="text-[11px] text-text-muted">Để trống: không hết hạn. Không tính thời điểm kết thúc. Giờ nhập theo múi giờ trình duyệt; danh sách hiển thị giờ Việt Nam.</p>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="disc-label" className={label}>Nhãn (tùy chọn)</label>
              <input
                id="disc-label"
                type="text"
                value={form.label}
                maxLength={80}
                onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                placeholder="Ví dụ Khuyến mãi Black Friday"
                className={field}
              />
              {errText("label")}
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
              />
              Đang bật
            </label>

            {fieldErrors.scopeId && errText("scopeId")}
            {formError && (
              <p role="alert" className="text-sm text-red-600 flex items-center gap-1">
                <span className="material-symbols-outlined text-[14px]" aria-hidden="true">error</span>
                {formError}
              </p>
            )}
          </form>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-text-muted">
              Giảm giá niêm yết của {SCOPE_NAMES[scopeType]} này theo thời gian. Mỗi mức giảm là một quy tắc riêng; các quy tắc
              cùng áp dụng cho một yêu cầu được cộng dồn và tổng không vượt quá 100%.
            </p>

            {loadError && (
              <p role="alert" className="text-sm text-red-600 flex items-center gap-1">
                <span className="material-symbols-outlined text-[14px]" aria-hidden="true">error</span>
                {loadError}
              </p>
            )}

            {overlap && (overlap.nowRawBp > 0 || overlap.peakRawBp > 0) && (
              <div className="border border-border bg-surface-2 px-4 py-3 text-sm" aria-live="polite">
                <p>
                  Đang cộng dồn trong {SCOPE_NAMES[scopeType]} này:{" "}
                  <span className="font-mono font-semibold">{percentLabel(overlap.nowTotalBp)}</span>
                  {overlap.nowCapped ? ` (cộng ${percentLabel(overlap.nowRawBp)}, đã giới hạn ở 100%)` : ""}
                </p>
                {(overlap.nowCapped || overlap.peakCapped) && (
                  <p className="mt-1 flex items-start gap-1 text-amber-700 dark:text-amber-400">
                    <span className="material-symbols-outlined text-[16px]" aria-hidden="true">warning</span>
                    <span>
                      Cảnh báo: các quy tắc chồng thời gian cộng lại vượt 100%
                      {!overlap.nowCapped && overlap.peakCapped ? ` (sẽ đạt ${percentLabel(overlap.peakRawBp)} khi quy tắc sắp tới bắt đầu)` : ""}
                      . Phần vượt không có tác dụng.
                    </span>
                  </p>
                )}
                <p className="mt-1 text-[11px] text-text-muted">
                  Chỉ tính các quy tắc của {SCOPE_NAMES[scopeType]} này; quy tắc ở phạm vi khác (combo, gói, nhóm) vẫn cộng thêm khi tính giá.
                </p>
              </div>
            )}

            {loading ? (
              <p className="text-sm text-text-muted">Đang tải…</p>
            ) : rules.length === 0 ? (
              <div className="border border-dashed border-border p-8 text-center">
                <p className="text-sm text-text-main font-medium">Chưa có giảm giá nào</p>
                <p className="mt-1 text-xs text-text-muted">Các đợt giảm giá của {SCOPE_NAMES[scopeType]} này sẽ hiện ở đây.</p>
              </div>
            ) : (
              <ul className="flex flex-col gap-2">
                {rules.map((rule) => {
                  const st = STATUS[rule.status] || STATUS.disabled;
                  return (
                    <li key={rule.id} className={`border border-border bg-surface px-4 py-3 ${rule.status === "expired" || rule.status === "disabled" ? "opacity-70" : ""}`}>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-lg font-semibold">-{percentLabel(rule.percentBp)}</span>
                            <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider border border-border bg-surface-2 px-1.5 py-0.5">
                              <span className="material-symbols-outlined text-[12px]" aria-hidden="true">{st.icon}</span>
                              {st.label}
                            </span>
                            {rule.label && <span className="text-sm text-text-main truncate">{rule.label}</span>}
                          </div>
                          <p className="mt-1 text-xs text-text-muted">
                            {rule.startsAt ? `Từ ${dateTimeLabel(rule.startsAt)}` : "Từ ngay"}
                            {" · "}
                            {rule.endsAt ? `đến ${dateTimeLabel(rule.endsAt)}` : "không hết hạn"}
                          </p>
                          {needsModels && (
                            <p className="mt-0.5 text-xs text-text-muted" title={rule.models ? rule.models.join(", ") : undefined}>
                              {rule.models ? `Model: ${rule.models.length <= 3 ? rule.models.join(", ") : `${rule.models.slice(0, 3).join(", ")} +${rule.models.length - 3}`}` : "Tất cả model"}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => toggle(rule)}
                            disabled={busyId === rule.id}
                            aria-label={rule.isActive ? `Tắt giảm giá ${percentLabel(rule.percentBp)}` : `Bật giảm giá ${percentLabel(rule.percentBp)}`}
                            title={rule.isActive ? "Tắt" : "Bật"}
                            className="size-8 flex items-center justify-center border border-border text-text-muted hover:text-text-main hover:border-text-muted transition-colors disabled:opacity-40"
                          >
                            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">{rule.isActive ? "pause" : "play_arrow"}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => openEdit(rule)}
                            aria-label={`Sửa giảm giá ${percentLabel(rule.percentBp)}`}
                            title="Sửa"
                            className="size-8 flex items-center justify-center border border-border text-text-muted hover:text-text-main hover:border-text-muted transition-colors"
                          >
                            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">edit</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDelete(rule)}
                            disabled={busyId === rule.id}
                            aria-label={`Xóa giảm giá ${percentLabel(rule.percentBp)}`}
                            title="Xóa"
                            className="size-8 flex items-center justify-center border border-border text-red-600 hover:border-red-600 transition-colors disabled:opacity-40"
                          >
                            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">delete</span>
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </Modal>

      <ConfirmModal
        isOpen={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={remove}
        title="Xóa giảm giá"
        message={confirmDelete ? `Xóa mức giảm ${percentLabel(confirmDelete.percentBp)}${confirmDelete.label ? ` “${confirmDelete.label}”` : ""}? Giá sẽ trở về niêm yết ngay nếu không còn quy tắc nào khác.` : ""}
        confirmText="Xóa"
        cancelText="Hủy"
        variant="danger"
      />
    </>
  );
}

DiscountsModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  scopeType: PropTypes.oneOf(["combo", "plan", "group"]).isRequired,
  scopeId: PropTypes.string.isRequired,
  scopeLabel: PropTypes.string,
};
