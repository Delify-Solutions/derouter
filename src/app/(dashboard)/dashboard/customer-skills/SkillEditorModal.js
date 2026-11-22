"use client";

import { useState } from "react";
import { Button, Modal } from "@/shared/components";
import { slugFromName } from "@/lib/skills/frontmatter.js";
import RuntimePicker from "./RuntimePicker";

const LABEL = "font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted";
const INPUT = "h-10 w-full border border-border bg-surface px-3 text-sm text-text-main focus:border-text-main focus:outline-none";

const EMPTY = {
  name: "",
  slug: "",
  summary: "",
  description: "",
  category: "",
  body: "",
  fileName: "SKILL.md",
  targets: [], // [] = every agent
  audience: "customer",
  isPublished: true,
  usageNotes: "",
  version: "",
  sortOrder: 0,
};

/** Form values from a stored skill (or the empty form). */
export function formFromSkill(skill) {
  if (!skill) return { ...EMPTY };
  return {
    name: skill.name || "",
    slug: skill.slug || "",
    summary: skill.summary || "",
    description: skill.description || "",
    category: skill.category || "",
    body: skill.body || "",
    fileName: skill.fileName || "SKILL.md",
    targets: skill.allAgents ? [] : (skill.targets || []),
    audience: skill.audience || "customer",
    isPublished: skill.isPublished !== false,
    usageNotes: skill.usageNotes || "",
    version: skill.version || "",
    sortOrder: skill.sortOrder ?? 0,
  };
}

/**
 * Write or edit ONE skill. The three things that matter are up front — name,
 * the markdown, which agents get it; everything an admin rarely changes sits under
 * "Tuỳ chọn thêm".
 */
export default function SkillEditorModal({ isOpen, editing, initial, categories, onClose, onSaved }) {
  const [form, setForm] = useState(initial);
  const [slugTouched, setSlugTouched] = useState(Boolean(editing));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const set = (patch) => setForm((prev) => ({ ...prev, ...patch }));
  const lines = form.body ? form.body.split("\n").length : 0;
  const kb = new TextEncoder().encode(form.body || "").length / 1024;

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const payload = { ...form, slug: form.slug.trim() || slugFromName(form.name) };
      const res = await fetch(editing ? `/api/skills/${editing.id}` : "/api/skills", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Không lưu được skill");
        return;
      }
      onSaved();
    } catch {
      setError("Không lưu được skill. Kiểm tra kết nối rồi thử lại.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => !saving && onClose()}
      title={editing ? `Sửa: ${editing.name}` : "Viết một skill"}
      size="full"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Huỷ</Button>
          <Button onClick={save} loading={saving}>{editing ? "Lưu thay đổi" : "Phát hành"}</Button>
        </div>
      }
    >
      <div className="flex max-h-[70vh] flex-col gap-5 overflow-y-auto pr-1">
        {error && (
          <p role="alert" className="border border-red-500/40 bg-red-500/5 px-3 py-2 text-sm text-red-700 dark:text-red-400">
            {error}
          </p>
        )}

        <label className="flex flex-col gap-1.5">
          <span className={LABEL}>Tên skill <span className="text-red-600">*</span></span>
          <input
            value={form.name}
            onChange={(e) => {
              const name = e.target.value;
              set(slugTouched ? { name } : { name, slug: slugFromName(name) });
            }}
            className={INPUT}
            placeholder="rt-recon-pipeline"
          />
          <span className="font-mono text-[11px] text-text-subtle">
            Tên thư mục trên máy khách: {form.slug || slugFromName(form.name) || "…"}
          </span>
        </label>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-3">
            <span className={LABEL}>Nội dung markdown <span className="text-red-600">*</span></span>
            <span className="font-mono text-[11px] text-text-subtle">{lines} dòng · {kb.toFixed(1)} KB</span>
          </div>
          <textarea
            value={form.body}
            onChange={(e) => set({ body: e.target.value })}
            rows={14}
            spellCheck={false}
            className="w-full border border-border bg-surface px-3 py-2 font-mono text-[12px] leading-5 text-text-main focus:border-text-main focus:outline-none"
            placeholder={"---\nname: rt-example\ndescription: ...\n---\n\n# Tiêu đề\n\nNội dung skill..."}
          />
        </div>

        <RuntimePicker value={form.targets} onChange={(targets) => set({ targets })} />

        <label className="flex items-center gap-2">
          <input type="checkbox" checked={form.isPublished} onChange={(e) => set({ isPublished: e.target.checked })} className="size-4" />
          <span className="text-sm text-text-main">Phát hành ngay (khách thấy trong khu tài khoản)</span>
        </label>

        <details className="border border-border">
          <summary className="cursor-pointer px-4 py-3 font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">
            Tuỳ chọn thêm
          </summary>
          <div className="flex flex-col gap-4 border-t border-border p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5">
                <span className={LABEL}>Slug (tên thư mục)</span>
                <input
                  value={form.slug}
                  onChange={(e) => { setSlugTouched(true); set({ slug: e.target.value }); }}
                  className={`${INPUT} font-mono`}
                  placeholder="rt-recon-pipeline"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className={LABEL}>Nhóm</span>
                <input value={form.category} onChange={(e) => set({ category: e.target.value })} list="skill-categories" className={INPUT} placeholder="Red team" />
                <datalist id="skill-categories">
                  {categories.map((c) => <option key={c.category} value={c.category} />)}
                </datalist>
              </label>
            </div>

            <label className="flex flex-col gap-1.5">
              <span className={LABEL}>Mô tả ngắn (hiện trên thẻ)</span>
              <input value={form.summary} maxLength={200} onChange={(e) => set({ summary: e.target.value })} className={INPUT} />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className={LABEL}>Mô tả đầy đủ (hiện trên thẻ, dưới mô tả ngắn)</span>
              <textarea
                value={form.description}
                maxLength={2000}
                onChange={(e) => set({ description: e.target.value })}
                rows={3}
                className="w-full border border-border bg-surface px-3 py-2 text-sm text-text-main focus:border-text-main focus:outline-none"
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className={LABEL}>Hướng dẫn sử dụng (hiện dưới nút tải)</span>
              <textarea
                value={form.usageNotes}
                onChange={(e) => set({ usageNotes: e.target.value })}
                rows={3}
                className="w-full border border-border bg-surface px-3 py-2 text-sm text-text-main focus:border-text-main focus:outline-none"
              />
            </label>

            <div className="grid gap-4 sm:grid-cols-4">
              <label className="flex flex-col gap-1.5">
                <span className={LABEL}>Thứ tự (nhỏ lên trước)</span>
                <input
                  type="number"
                  value={form.sortOrder}
                  onChange={(e) => set({ sortOrder: e.target.value === "" ? 0 : Number(e.target.value) })}
                  className={`${INPUT} font-mono`}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className={LABEL}>Đối tượng</span>
                <select value={form.audience} onChange={(e) => set({ audience: e.target.value })} className={INPUT}>
                  <option value="customer">Khách hàng</option>
                  <option value="internal">Nội bộ (khách không thấy)</option>
                </select>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className={LABEL}>Phiên bản</span>
                <input value={form.version} onChange={(e) => set({ version: e.target.value })} className={`${INPUT} font-mono`} placeholder="1.0.0" />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className={LABEL}>Tên file</span>
                <input value={form.fileName} onChange={(e) => set({ fileName: e.target.value })} className={`${INPUT} font-mono`} placeholder="SKILL.md" />
              </label>
            </div>
          </div>
        </details>
      </div>
    </Modal>
  );
}
