"use client";

import { useRef, useState } from "react";
import { Button, Modal, Input, Select, Badge } from "@/shared/components";
import { readSkillFrontmatter, slugFromName } from "@/lib/skills/frontmatter.js";
import { pickSkillFiles, draftFields, draftProblem } from "@/lib/skills/importDrafts.js";
import RuntimePicker from "./RuntimePicker";

const LABEL = "font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted";
const MAX_ITEMS = 100;
const OUTCOME = { created: "Đã thêm", updated: "Đã cập nhật", skipped: "Bỏ qua", error: "Lỗi" };

let nextKey = 1;

/** Every file under a dropped folder (or the loose files), each with its folder path. */
async function filesFromDrop(dataTransfer) {
  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      out.push({ file, name: file.name, path: `${prefix}${file.name}` });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      } while (batch.length);
    }
  };
  const entries = [...(dataTransfer.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length) {
    for (const entry of entries) await walk(entry, "");
  } else {
    for (const file of dataTransfer.files || []) out.push({ file, name: file.name, path: file.name });
  }
  return out;
}

function toDraft(fields, source) {
  return { key: nextKey++, include: true, source, outcome: null, ...fields };
}

/**
 * Add several skills at once: pick files or a whole skills folder, drop them, or
 * paste one; check the list; choose the agents; publish. Each row reports its own
 * outcome. Rows that were added are locked; rows that failed or were skipped stay
 * editable so they can be fixed and sent again without picking the files again.
 */
export default function SkillImportModal({ isOpen, existingSlugs, categories, onClose, onDone }) {
  const filesRef = useRef(null);
  const folderRef = useRef(null);
  const countRef = useRef(0);
  const [items, setItems] = useState([]);
  const [pasted, setPasted] = useState("");
  const [targets, setTargets] = useState([]); // [] = every agent
  const [category, setCategory] = useState("");
  const [audience, setAudience] = useState("customer");
  const [isPublished, setIsPublished] = useState(true);
  const [mode, setMode] = useState("skip");
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  countRef.current = items.length;

  const addEntries = async (entries) => {
    const { picked, ignored } = pickSkillFiles(entries);
    if (picked.length === 0) {
      setError("Không có file SKILL.md hoặc .md nào trong lựa chọn.");
      return;
    }
    const room = Math.max(0, MAX_ITEMS - countRef.current);
    const batch = picked.slice(0, room);
    setError("");
    setReading(true);
    try {
      const settled = await Promise.allSettled(
        batch.map(async (entry) => {
          const text = await entry.file.text();
          return toDraft(draftFields({ path: entry.path, name: entry.name, text }), entry.path);
        })
      );
      const drafts = settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
      const unreadable = settled.length - drafts.length;
      setItems((prev) => [...prev, ...drafts].slice(0, MAX_ITEMS));
      const notes = [];
      if (picked.length > room) notes.push(`Chỉ lấy ${room} skill đầu tiên (tối đa ${MAX_ITEMS}).`);
      if (ignored) notes.push(`Bỏ qua ${ignored} file không phải skill (README, tài liệu kèm…).`);
      if (unreadable) notes.push(`${unreadable} file không đọc được.`);
      setNotice(notes.join(" "));
    } finally {
      setReading(false);
    }
  };

  const fromInput = (fileList) =>
    addEntries([...fileList].map((file) => ({ file, name: file.name, path: file.webkitRelativePath || file.name })));

  const onDrop = async (event) => {
    event.preventDefault();
    try {
      addEntries(await filesFromDrop(event.dataTransfer));
    } catch {
      setError("Không đọc được thư mục vừa thả. Thử nút chọn thư mục.");
    }
  };

  const addPasted = () => {
    if (!pasted.trim()) return;
    const fm = readSkillFrontmatter(pasted);
    const fields = {
      name: fm.name,
      slug: slugFromName(fm.name),
      summary: fm.description.slice(0, 200),
      body: pasted,
      bytes: new TextEncoder().encode(pasted).length,
    };
    setItems((prev) => [...prev, toDraft(fields, "dán")].slice(0, MAX_ITEMS));
    setPasted("");
    setError("");
  };

  const update = (key, patch) => setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch, outcome: null } : it)));
  const remove = (key) => setItems((prev) => prev.filter((it) => it.key !== key));

  const locked = (it) => it.outcome?.action === "created" || it.outcome?.action === "updated";
  const slugOf = (it) => it.slug.trim() || slugFromName(it.name);
  const chosen = items.filter((it) => it.include && !locked(it) && !draftProblem(it));
  const counts = new Map();
  for (const it of chosen) counts.set(slugOf(it), (counts.get(slugOf(it)) || 0) + 1);
  const duplicate = (it) => (counts.get(slugOf(it)) || 0) > 1;
  const exists = (it) => !locked(it) && existingSlugs.has(slugOf(it));
  const anyOutcome = items.some((it) => it.outcome);

  const submit = async () => {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const payload = chosen.map((it) => ({
        name: it.name.trim() || slugOf(it),
        slug: slugOf(it),
        summary: it.summary,
        body: it.body,
        fileName: "SKILL.md",
        targets,
        category,
        audience,
        isPublished,
      }));
      const res = await fetch("/api/skills/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: payload, mode }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Không thêm được skill");
        return;
      }
      // Results come back in request order, so they map to rows by position: two rows
      // that share a slug each get their own outcome.
      const byKey = new Map(chosen.map((it, i) => [it.key, data.results?.[i] || null]));
      setItems((prev) =>
        prev.map((it) => {
          const outcome = byKey.get(it.key);
          if (!outcome) return it;
          return { ...it, outcome, include: outcome.action === "created" || outcome.action === "updated" ? false : it.include };
        })
      );
      setNotice(
        `Thêm ${data.created || 0}, cập nhật ${data.updated || 0}, bỏ qua ${data.skipped || 0}, lỗi ${data.failed || 0}.`
      );
      onDone();
    } catch {
      setError("Không thêm được skill. Kiểm tra kết nối rồi thử lại.");
    } finally {
      setSaving(false);
    }
  };

  const label = (it) => it.name || it.slug || it.source;

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => !saving && onClose()}
      title="Thêm nhiều skill"
      size="full"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>{anyOutcome && chosen.length === 0 ? "Đóng" : "Huỷ"}</Button>
          {(chosen.length > 0 || !anyOutcome) && (
            <Button onClick={submit} loading={saving} disabled={chosen.length === 0}>
              {chosen.length ? `Thêm ${chosen.length} skill` : "Thêm skill"}
            </Button>
          )}
        </div>
      }
    >
      <div className="flex max-h-[70vh] flex-col gap-5 overflow-y-auto pr-1">
        {error && (
          <p role="alert" className="border border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger">{error}</p>
        )}
        {notice && <p role="status" className="border border-border bg-surface-2 px-3 py-2 text-sm text-text-main">{notice}</p>}

        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
          className="flex flex-col items-center gap-3 border border-dashed border-border px-4 py-8 text-center"
        >
          <p className="text-sm text-text-main">Kéo thả file <code>.md</code> hoặc cả thư mục vào đây, hoặc chọn:</p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="secondary" onClick={() => filesRef.current?.click()} loading={reading}>Chọn nhiều file</Button>
            <Button variant="secondary" onClick={() => folderRef.current?.click()} loading={reading}>Chọn cả thư mục skills</Button>
          </div>
          <p className="max-w-lg text-xs leading-5 text-text-muted">
            Trong thư mục chỉ lấy file <code>SKILL.md</code> của mỗi skill (<code>skills/ten-skill/SKILL.md</code>): tên
            thư mục thành slug. Tên và mô tả lấy từ phần <code>---</code> đầu file.
          </p>
          <input ref={filesRef} type="file" multiple accept=".md,.markdown" className="hidden" onChange={(e) => { fromInput(e.target.files); e.target.value = ""; }} />
          <input ref={folderRef} type="file" multiple webkitdirectory="" className="hidden" onChange={(e) => { fromInput(e.target.files); e.target.value = ""; }} />
        </div>

        <details className="border border-border">
          <summary className="cursor-pointer px-4 py-3 font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">Hoặc dán một skill</summary>
          <div className="flex flex-col gap-2 border-t border-border p-4">
            <textarea
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              rows={8}
              spellCheck={false}
              aria-label="Nội dung skill dán vào"
              className="w-full border border-border bg-surface px-3 py-2 font-mono text-[12px] leading-5 text-text-main focus:border-text-main focus:outline-none"
              placeholder={"---\nname: rt-example\ndescription: ...\n---\n\n# Nội dung"}
            />
            <div><Button variant="secondary" size="sm" onClick={addPasted} disabled={!pasted.trim()}>Thêm vào danh sách</Button></div>
          </div>
        </details>

        {items.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className={LABEL}>{items.length} skill · sẽ thêm {chosen.length}</span>
            {items.map((it) => {
              const problem = draftProblem(it) || (duplicate(it) ? "Trùng slug với dòng khác" : "");
              const done = locked(it);
              return (
                <div key={it.key} className="flex flex-col gap-2 border border-border bg-surface p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="checkbox"
                      checked={it.include && !done && !draftProblem(it)}
                      disabled={done || Boolean(draftProblem(it))}
                      onChange={(e) => update(it.key, { include: e.target.checked })}
                      aria-label={`Chọn ${label(it)}`}
                      className="size-4"
                    />
                    <span className="font-mono text-[11px] text-text-subtle">{it.source} · {(it.bytes / 1024).toFixed(1)} KB</span>
                    {exists(it) && <Badge variant="default" size="xs">Slug đã có</Badge>}
                    {problem && <Badge variant="error" size="xs">{problem}</Badge>}
                    {it.outcome && (
                      <Badge variant={it.outcome.error ? "error" : "default"} size="xs">
                        {OUTCOME[it.outcome.action]}{it.outcome.error ? `: ${it.outcome.error}` : ""}
                      </Badge>
                    )}
                    {!done && (
                      <button type="button" onClick={() => remove(it.key)} aria-label={`Bỏ ${label(it)} khỏi danh sách`} className="ml-auto flex size-7 items-center justify-center border border-border text-text-muted hover:bg-surface-2 hover:text-text-main">
                        <span className="material-symbols-outlined text-[16px]" aria-hidden="true">close</span>
                      </button>
                    )}
                  </div>
                  {!done && (
                    <div className="grid gap-2 sm:grid-cols-[1fr_1fr_2fr]">
                      <Input value={it.name} onChange={(e) => update(it.key, { name: e.target.value, slug: it.slug === slugFromName(it.name) ? slugFromName(e.target.value) : it.slug })} placeholder="Tên skill" aria-label={`Tên skill (${label(it)})`} inputClassName="h-9 py-0" />
                      <Input value={it.slug} onChange={(e) => update(it.key, { slug: e.target.value })} inputClassName="h-9 py-0 font-mono" placeholder="slug" aria-label={`Slug (${label(it)})`} />
                      <Input value={it.summary} maxLength={200} onChange={(e) => update(it.key, { summary: e.target.value })} inputClassName="h-9 py-0" placeholder="Mô tả ngắn" aria-label={`Mô tả ngắn (${label(it)})`} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {items.length > 0 && (
          <div className="flex flex-col gap-4 border border-border p-4">
            <span className={LABEL}>Áp dụng cho tất cả skill sẽ thêm</span>
            <RuntimePicker value={targets} onChange={setTargets} />
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <Input label="Nhóm" value={category} onChange={(e) => setCategory(e.target.value)} list="skill-import-categories" placeholder="Red team" />
                <datalist id="skill-import-categories">{categories.map((c) => <option key={c.category} value={c.category} />)}</datalist>
              </div>
              <Select
                label="Đối tượng"
                value={audience}
                onChange={(e) => setAudience(e.target.value)}
                options={[
                  { value: "customer", label: "Khách hàng" },
                  { value: "internal", label: "Nội bộ (khách không thấy)" },
                ]}
              />
              <Select
                label="Slug đã có"
                value={mode}
                onChange={(e) => setMode(e.target.value)}
                options={[
                  { value: "skip", label: "Bỏ qua, giữ bản cũ" },
                  { value: "update", label: "Chỉ thay nội dung, giữ cài đặt cũ" },
                ]}
              />
            </div>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={isPublished} onChange={(e) => setIsPublished(e.target.checked)} className="size-4" />
              <span className="text-sm text-text-main">Phát hành ngay (chỉ áp dụng cho skill mới)</span>
            </label>
          </div>
        )}
      </div>
    </Modal>
  );
}
