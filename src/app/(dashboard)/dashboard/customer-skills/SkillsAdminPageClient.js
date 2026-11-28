"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, Button, Input, Select, Toggle, ConfirmModal, CardSkeleton } from "@/shared/components";
import RuntimePicker from "./RuntimePicker";
import SkillEditorModal, { formFromSkill } from "./SkillEditorModal";
import SkillImportModal from "./SkillImportModal";
import RepoImportModal from "./RepoImportModal";
import SkillRow from "./SkillRow";
import BundleManager from "./BundleManager";

const FILTERS = [
  { value: "all", label: "Tất cả" },
  { value: "published", label: "Đang phát hành" },
  { value: "draft", label: "Bản nháp" },
  { value: "internal", label: "Nội bộ" },
];

/**
 * Admin skills console. Add many skills at once from files or a folder, give each
 * the agents it installs into, select rows to publish, hide or re-target them in
 * bulk, or open one to edit.
 */
export default function SkillsAdminPageClient() {
  const [skills, setSkills] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");

  const [selected, setSelected] = useState(() => new Set());
  const [bulkTargets, setBulkTargets] = useState(null); // runtime ids while the picker is open
  const [busy, setBusy] = useState(false);

  const [importOpen, setImportOpen] = useState(false);
  const [importKey, setImportKey] = useState(0);
  const [repoOpen, setRepoOpen] = useState(false);
  const [repoKey, setRepoKey] = useState(0);
  const [editor, setEditor] = useState(null); // { key, editing, initial }
  const [deleting, setDeleting] = useState(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [busyId, setBusyId] = useState(null);

  // Customer-area nav visibility + display label (settingsRepo skillsNavEnabled/
  // skillsNavLabel): off hides the "Skill" item for customers AND redirects a
  // direct visit (src/app/account/skills/page.js).
  const [navEnabled, setNavEnabled] = useState(true);
  const [navLabel, setNavLabel] = useState("Skill");
  const [navLabelDraft, setNavLabelDraft] = useState("Skill");
  const [navSaving, setNavSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/settings");
        if (res.ok) {
          const data = await res.json();
          setNavEnabled(data.skillsNavEnabled !== false);
          setNavLabel(data.skillsNavLabel || "Skill");
          setNavLabelDraft(data.skillsNavLabel || "Skill");
        }
      } catch {}
    })();
  }, []);

  const handleNavEnabled = async (value) => {
    setNavEnabled(value);
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillsNavEnabled: value }),
      });
    } catch {}
  };

  const saveNavLabel = async () => {
    const next = navLabelDraft.trim() || "Skill";
    setNavSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillsNavLabel: next }),
      });
      if (res.ok) { setNavLabel(next); setNavLabelDraft(next); }
    } catch {} finally {
      setNavSaving(false);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/skills", { cache: "no-store" });
      if (!res.ok) throw new Error("fetch failed");
      const data = await res.json();
      const rows = data.skills || [];
      setSkills(rows);
      setCategories(data.categories || []);
      // A row someone else deleted must not stay selected (and counted) behind the scenes.
      setSelected((prev) => {
        const ids = new Set(rows.map((r) => r.id));
        const kept = [...prev].filter((id) => ids.has(id));
        return kept.length === prev.size ? prev : new Set(kept);
      });
    } catch {
      setError("Không tải được danh sách skill.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // A skill that belongs to a bundle is managed from the bundle's own card (see
  // BundleManager below), not duplicated here — the flat list is the skills nobody
  // grouped.
  const standalone = useMemo(() => skills.filter((s) => !s.bundleId), [skills]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return standalone.filter((s) => {
      if (filter === "published" && !s.isPublished) return false;
      if (filter === "draft" && s.isPublished) return false;
      if (filter === "internal" && s.audience !== "internal") return false;
      if (category && s.category !== category) return false;
      if (q && !`${s.name} ${s.slug} ${s.summary} ${s.category}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [standalone, filter, search, category]);

  const existingSlugs = useMemo(() => new Set(skills.map((s) => s.slug)), [skills]);
  const selectedRows = skills.filter((s) => selected.has(s.id));
  const hiddenSelected = selectedRows.filter((s) => !visible.some((v) => v.id === s.id)).length;
  const selectable = visible.slice(0, 100); // one bulk request carries at most 100 skills
  const allVisibleSelected = selectable.length > 0 && selectable.every((s) => selected.has(s.id));

  const toggleOne = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) selectable.forEach((s) => next.delete(s.id));
      else selectable.forEach((s) => next.add(s.id));
      return next;
    });

  const openImport = () => { setImportKey((k) => k + 1); setImportOpen(true); };
  const openRepo = () => { setRepoKey((k) => k + 1); setRepoOpen(true); };
  const openCreate = () => setEditor({ key: Date.now(), editing: null, initial: formFromSkill(null) });

  const openEdit = async (row) => {
    setBusyId(row.id);
    setError("");
    try {
      // The list omits bodies, so the editor fetches the one row it needs.
      const res = await fetch(`/api/skills/${row.id}`, { cache: "no-store" });
      if (!res.ok) throw new Error("fetch failed");
      const { skill } = await res.json();
      setEditor({ key: Date.now(), editing: skill, initial: formFromSkill(skill) });
    } catch {
      setError("Không mở được skill để sửa.");
    } finally {
      setBusyId(null);
    }
  };

  const bulk = async (patch) => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/skills/bulk", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [...selected], patch }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Không cập nhật được skill.");
        return;
      }
      const failed = (data.results || []).filter((r) => !r.ok);
      setBulkTargets(null);
      // Only the skills that failed stay selected, so the admin can see which ones and retry.
      setSelected(new Set(failed.map((r) => r.id)));
      await load(); // load() clears the error, so the message is set after it
      if (failed.length) setError(`${failed.length} skill không cập nhật được: ${failed[0].error || "lỗi không rõ"}`);
    } catch {
      setError("Không cập nhật được skill. Kiểm tra kết nối rồi thử lại.");
    } finally {
      setBusy(false);
    }
  };

  const togglePublished = async (row) => {
    setBusyId(row.id);
    try {
      const res = await fetch(`/api/skills/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isPublished: !row.isPublished }),
      });
      if (res.ok) await load();
      else setError("Không đổi được trạng thái phát hành.");
    } catch {
      setError("Không đổi được trạng thái phát hành.");
    } finally {
      setBusyId(null);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    const target = deleting;
    setDeleting(null);
    setBusyId(target.id);
    try {
      const res = await fetch(`/api/skills/${target.id}`, { method: "DELETE" });
      if (res.ok) {
        setSelected((prev) => { const next = new Set(prev); next.delete(target.id); return next; });
        await load();
      } else setError("Không xoá được skill.");
    } catch {
      setError("Không xoá được skill.");
    } finally {
      setBusyId(null);
    }
  };

  const removeSelected = async () => {
    setBulkDeleting(false);
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/skills/bulk", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [...selected] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Không xoá được skill.");
        return;
      }
      const failed = (data.results || []).filter((r) => !r.ok);
      // Only the skills that failed stay selected, so the admin can see which ones and retry.
      setSelected(new Set(failed.map((r) => r.id)));
      await load();
      if (failed.length) setError(`${failed.length} skill không xoá được: ${failed[0].error || "lỗi không rõ"}`);
    } catch {
      setError("Không xoá được skill. Kiểm tra kết nối rồi thử lại.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="meta text-text-subtle">Skill</span>
          <h1 className="text-2xl font-semibold tracking-tight text-text-main">Skill khách hàng</h1>
          <p className="max-w-2xl text-sm leading-6 text-text-muted">
            Skill markdown khách tải về hoặc cài bằng một lệnh vào agent của họ (Claude Code, Codex, Cursor).
            Mỗi skill chọn được nhiều agent. Skill đánh dấu nội bộ thì khách không thấy.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={openCreate}>Viết một skill</Button>
          <Button variant="secondary" onClick={openImport} icon="upload_file">Thêm nhiều skill</Button>
          <Button onClick={openRepo} icon="link">Nhập từ repo</Button>
        </div>
      </div>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <p className="font-medium">Hiển thị cho khách hàng</p>
            <p className="text-sm text-text-muted">
              Tắt sẽ ẩn mục này khỏi menu tài khoản và chặn truy cập trực tiếp bằng URL.
            </p>
          </div>
          <Toggle checked={navEnabled} onChange={() => handleNavEnabled(!navEnabled)} />
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-border pt-4">
          <div className="flex-1 min-w-[200px]">
            <label htmlFor="skills-nav-label" className="mb-1 block text-xs text-text-muted">Tên hiển thị trong menu</label>
            <Input
              id="skills-nav-label"
              value={navLabelDraft}
              onChange={(e) => setNavLabelDraft(e.target.value)}
              placeholder="Skill"
            />
          </div>
          <Button
            size="sm"
            variant="secondary"
            loading={navSaving}
            disabled={navLabelDraft.trim() === navLabel || !navLabelDraft.trim()}
            onClick={saveNavLabel}
          >
            Lưu tên
          </Button>
        </div>
      </Card>

      {error && (
        <p role="alert" className="border border-danger/40 bg-danger/5 px-4 py-3 text-sm text-danger">
          {error}{" "}
          <button type="button" onClick={load} className="underline">Thử lại</button>
        </p>
      )}

      <BundleManager
        skills={skills}
        busyId={busyId}
        onTogglePublished={togglePublished}
        onEditSkill={openEdit}
        onDeleteSkill={setDeleting}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Tìm theo tên, slug, nhóm…"
          aria-label="Tìm skill"
          icon="search"
          className="w-56"
          inputClassName="h-9 py-0"
        />
        {FILTERS.map((item) => (
          <Button
            key={item.value}
            type="button"
            size="sm"
            variant={filter === item.value ? "primary" : "outline"}
            onClick={() => setFilter(item.value)}
            aria-pressed={filter === item.value}
          >
            {item.label}
          </Button>
        ))}
        {categories.length > 0 && (
          <Select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            aria-label="Lọc theo nhóm"
            className="w-48"
            options={[
              { value: "", label: "Mọi nhóm" },
              ...categories.map((c) => ({ value: c.category, label: `${c.category} (${c.count})` })),
            ]}
          />
        )}
        <span className="ml-auto font-mono text-xs text-text-muted">{visible.length} / {standalone.length} skill</span>
      </div>

      {selected.size > 0 && (
        <div className="flex flex-col gap-3 border border-text-main bg-surface-2 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-text-main">
              Đã chọn {selected.size} skill
              {hiddenSelected > 0 && ` (${hiddenSelected} đang bị bộ lọc ẩn, vẫn được áp dụng)`}
            </span>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setBulkTargets(selectedRows[0]?.allAgents ? [] : (selectedRows[0]?.targets || []))}>Đặt agent</Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => bulk({ isPublished: true })}>Phát hành</Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => bulk({ isPublished: false })}>Ẩn</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setBulkDeleting(true)} className="text-danger hover:bg-red-500/10">Xoá tất cả</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setSelected(new Set()); setBulkTargets(null); }}>Bỏ chọn</Button>
          </div>
          {bulkTargets && (
            <div className="flex flex-col gap-2">
              <RuntimePicker value={bulkTargets} onChange={setBulkTargets} label="Cài cho agent (ghi đè cho mọi skill đã chọn)" />
              <div><Button size="sm" loading={busy} onClick={() => bulk({ targets: bulkTargets })}>Áp dụng cho {selected.size} skill</Button></div>
            </div>
          )}
        </div>
      )}

      {loading ? (
        <CardSkeleton />
      ) : visible.length === 0 && error && standalone.length === 0 ? null : visible.length === 0 ? (
        <Card padding="md">
          <p className="py-8 text-center text-sm text-text-muted">
            {standalone.length === 0 ? (
              skills.length > 0 ? (
                <>Mọi skill đang nằm trong một bundle ở trên. Quản lý từng skill ở đó, hoặc bấm &quot;Nhập từ repo&quot; để thêm skill đứng riêng.</>
              ) : (
                <>Chưa có skill nào. Bấm &quot;Thêm nhiều skill&quot; rồi kéo thả các file <code>SKILL.md</code> vào.</>
              )
            ) : (
              <>Không có skill nào khớp bộ lọc. <button type="button" className="underline" onClick={() => { setFilter("all"); setSearch(""); setCategory(""); }}>Xoá bộ lọc</button></>
            )}
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 px-1 text-xs text-text-muted">
            <input type="checkbox" checked={allVisibleSelected} onChange={toggleAll} className="size-4" />
            Chọn tất cả {Math.min(visible.length, 100)} skill đang hiện{visible.length > 100 ? " (tối đa 100 mỗi lần)" : ""}
          </label>
          <Card padding="sm">
            {visible.map((row) => (
              <SkillRow
                key={row.id}
                row={row}
                busy={busyId === row.id}
                checked={selected.has(row.id)}
                onToggleChecked={toggleOne}
                onTogglePublished={togglePublished}
                onEdit={openEdit}
                onDelete={setDeleting}
              />
            ))}
          </Card>
        </div>
      )}

      {importOpen && (
        <SkillImportModal
          key={importKey}
          isOpen
          existingSlugs={existingSlugs}
          categories={categories}
          onClose={() => setImportOpen(false)}
          onDone={load}
        />
      )}

      {repoOpen && (
        <RepoImportModal
          key={repoKey}
          isOpen
          existingSlugs={existingSlugs}
          categories={categories}
          onClose={() => setRepoOpen(false)}
          onDone={load}
        />
      )}

      {editor && (
        <SkillEditorModal
          key={editor.key}
          isOpen
          editing={editor.editing}
          initial={editor.initial}
          categories={categories}
          onClose={() => setEditor(null)}
          onSaved={() => { setEditor(null); load(); }}
        />
      )}

      <ConfirmModal
        isOpen={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={remove}
        title="Xoá skill"
        message={deleting ? `Xoá "${deleting.name}"? Khách đã tải bản sao vẫn giữ được file, nhưng mục này biến mất khỏi danh sách.` : ""}
        confirmText="Xoá"
        variant="danger"
      />

      <ConfirmModal
        isOpen={bulkDeleting}
        onClose={() => setBulkDeleting(false)}
        onConfirm={removeSelected}
        title="Xoá nhiều skill"
        message={`Xoá ${selected.size} skill đã chọn? Khách đã tải bản sao vẫn giữ được file, nhưng các mục này biến mất khỏi danh sách. Không hoàn tác được.`}
        confirmText={`Xoá ${selected.size} skill`}
        variant="danger"
      />
    </div>
  );
}
