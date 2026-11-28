"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, Button, Modal, ConfirmModal, Badge, CardSkeleton, Toggle, Input, Select, Toast } from "@/shared/components";

const LABEL = "font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted";
const AUDIENCE_OPTIONS = [
  { value: "customer", label: "Khách hàng" },
  { value: "internal", label: "Nội bộ" },
];

const FILTERS = [
  { value: "all", label: "Tất cả" },
  { value: "published", label: "Đang phát hành" },
  { value: "draft", label: "Bản nháp" },
  { value: "internal", label: "Nội bộ" },
];

const EMPTY = {
  name: "",
  slug: "",
  description: "",
  usageGuide: "",
  packageName: "",
  version: "",
  dshTarget: "",
  repoUrl: "",
  docsUrl: "",
  audience: "customer",
  isPublished: true,
  sortOrder: 0,
};

/** A directory-safe slug from a display name; mirrors slugFromName on the server. */
function suggestSlug(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function fmtDate(value) {
  const ms = Date.parse(value || "");
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleDateString("vi-VN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

/**
 * Admin console for DSH plugins: publish one, edit it, retire it.
 *
 * A plugin row is metadata plus a package name — the code lives in the package, not
 * here. So the page is short: what it is, which package to install, which DSH
 * release it targets, and the guide the customer reads before running the command.
 */
export default function DshPluginsPageClient() {
  const [plugins, setPlugins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [busyId, setBusyId] = useState(null);

  // Customer-area nav visibility + display label (settingsRepo dshPluginsNavEnabled/
  // dshPluginsNavLabel): off hides the "Plugin DSH" item for customers AND redirects
  // a direct visit (src/app/account/plugins/page.js).
  const [navEnabled, setNavEnabled] = useState(true);
  const [navLabel, setNavLabel] = useState("Plugin DSH");
  const [navLabelDraft, setNavLabelDraft] = useState("Plugin DSH");
  const [navSaving, setNavSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/settings");
        if (res.ok) {
          const data = await res.json();
          setNavEnabled(data.dshPluginsNavEnabled !== false);
          setNavLabel(data.dshPluginsNavLabel || "Plugin DSH");
          setNavLabelDraft(data.dshPluginsNavLabel || "Plugin DSH");
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
        body: JSON.stringify({ dshPluginsNavEnabled: value }),
      });
    } catch {}
  };

  const saveNavLabel = async () => {
    const next = navLabelDraft.trim() || "Plugin DSH";
    setNavSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dshPluginsNavLabel: next }),
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
      const res = await fetch("/api/dsh-plugins", { cache: "no-store" });
      if (!res.ok) throw new Error("fetch failed");
      const data = await res.json();
      setPlugins(data.plugins || []);
    } catch {
      setError("Không tải được danh sách plugin. Tải lại trang để thử lại.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const visible = plugins.filter((plugin) => {
    if (filter === "published") return plugin.isPublished && plugin.audience === "customer";
    if (filter === "draft") return !plugin.isPublished;
    if (filter === "internal") return plugin.audience === "internal";
    return true;
  });

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY);
    setFormError("");
    setFormOpen(true);
  };

  const openEdit = (plugin) => {
    setEditing(plugin);
    setForm({
      name: plugin.name || "",
      slug: plugin.slug || "",
      description: plugin.description || "",
      usageGuide: plugin.usageGuide || "",
      packageName: plugin.packageName || "",
      version: plugin.version || "",
      dshTarget: plugin.dshTarget || "",
      repoUrl: plugin.repoUrl || "",
      docsUrl: plugin.docsUrl || "",
      audience: plugin.audience || "customer",
      isPublished: plugin.isPublished !== false,
      sortOrder: plugin.sortOrder ?? 0,
    });
    setFormError("");
    setFormOpen(true);
  };

  const save = async () => {
    setSaving(true);
    setFormError("");
    try {
      const payload = { ...form, slug: form.slug || suggestSlug(form.name) };
      const res = await fetch(editing ? `/api/dsh-plugins/${editing.id}` : "/api/dsh-plugins", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError(data.error || "Không lưu được plugin");
        return;
      }
      setFormOpen(false);
      await load();
    } catch {
      setFormError("Không lưu được plugin. Kiểm tra kết nối rồi thử lại.");
    } finally {
      setSaving(false);
    }
  };

  const togglePublished = async (plugin) => {
    setBusyId(plugin.id);
    try {
      const res = await fetch(`/api/dsh-plugins/${plugin.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isPublished: !plugin.isPublished }),
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
      const res = await fetch(`/api/dsh-plugins/${target.id}`, { method: "DELETE" });
      if (res.ok) await load();
      else setError("Không xoá được plugin.");
    } catch {
      setError("Không xoá được plugin.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-mono text-2xl font-semibold tracking-tight text-text-main">
            <span className="mr-2 text-text-subtle" aria-hidden="true">{"//"}</span>
            Plugin DSH
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-text-muted">
            Plugin DeepSeek Harness phát hành cho khách. Khách cài bằng{" "}
            <code className="font-mono text-[12px]">dsh plugin --profile &lt;p&gt; add &lt;package&gt;</code>.
            Khác với Skill: skill là markdown agent đọc, plugin là package harness nạp lúc khởi động.
          </p>
        </div>
        <Button onClick={openCreate} icon="add">Plugin mới</Button>
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
          <Input
            label="Tên hiển thị trong menu"
            value={navLabelDraft}
            onChange={(e) => setNavLabelDraft(e.target.value)}
            placeholder="Plugin DSH"
            className="flex-1 min-w-[200px]"
          />
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
        <div className="flex items-start gap-3">
          <Toast type="error" message={error} dismissible={false} className="flex-1" />
          <Button size="sm" variant="ghost" onClick={load}>Thử lại</Button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap items-center gap-1 rounded-vx-md bg-vx-surface-2 p-1 w-fit">
          {FILTERS.map((item) => {
            const active = filter === item.value;
            return (
              <button
                key={item.value}
                type="button"
                onClick={() => setFilter(item.value)}
                aria-pressed={active}
                className={`px-4 h-8 rounded-vx-sm text-xs font-medium transition-colors ${
                  active
                    ? "bg-vx-primary text-white"
                    : "text-vx-text-muted hover:text-vx-text hover:bg-vx-surface-3"
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </div>
        <span className="font-mono text-xs text-text-muted">{visible.length} plugin</span>
      </div>

      {loading ? (
        <CardSkeleton />
      ) : visible.length === 0 ? (
        <Card padding="md">
          <p className="py-8 text-center text-sm text-text-muted">
            Chưa có plugin nào. Bấm &quot;Plugin mới&quot; để phát hành plugin đầu tiên.
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((plugin) => (
            <Card key={plugin.id} padding="sm" className="flex flex-wrap items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center border border-border bg-surface-2 text-text-muted">
                <span className="material-symbols-outlined text-[18px]" aria-hidden="true">widgets</span>
              </span>

              <div className="min-w-0 flex-1 basis-64">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-mono text-sm font-semibold text-text-main">{plugin.name}</h3>
                  {plugin.isPublished ? (
                    <Badge variant="success" size="sm" dot>Đang phát hành</Badge>
                  ) : (
                    <Badge variant="default" size="sm" dot>Bản nháp</Badge>
                  )}
                  {plugin.audience === "internal" && <Badge variant="warning" size="sm">Nội bộ</Badge>}
                  {plugin.version && <Badge variant="default" size="sm">v{plugin.version}</Badge>}
                  {plugin.dshTarget && <Badge variant="info" size="sm">DSH {plugin.dshTarget}</Badge>}
                </div>
                <p className="mt-1 font-mono text-[11px] text-text-subtle">
                  {plugin.packageName} · {plugin.installCount ?? 0} lượt cài · cập nhật {fmtDate(plugin.updatedAt)}
                </p>
                {plugin.description && (
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-text-muted">{plugin.description}</p>
                )}
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => togglePublished(plugin)} disabled={busyId === plugin.id}>
                  {plugin.isPublished ? "Ẩn" : "Phát hành"}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => openEdit(plugin)} disabled={busyId === plugin.id}>
                  Sửa
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDeleting(plugin)}
                  disabled={busyId === plugin.id}
                  className="text-red-600 hover:bg-red-500/10"
                >
                  Xoá
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        isOpen={formOpen}
        onClose={() => !saving && setFormOpen(false)}
        title={editing ? `Sửa: ${editing.name}` : "Plugin mới"}
        size="full"
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => setFormOpen(false)} disabled={saving}>Huỷ</Button>
            <Button onClick={save} loading={saving}>{editing ? "Lưu thay đổi" : "Phát hành"}</Button>
          </div>
        }
      >
        <div className="flex max-h-[70vh] flex-col gap-5 overflow-y-auto pr-1">
          {formError && <Toast type="error" message={formError} dismissible={false} />}

          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Tên plugin"
              required
              value={form.name}
              onChange={(e) => {
                const name = e.target.value;
                setForm((prev) => ({
                  ...prev,
                  name,
                  slug: prev.slug && prev.slug !== suggestSlug(prev.name) ? prev.slug : suggestSlug(name),
                }));
              }}
              placeholder="dsh-purge-safe"
            />
            <Input
              label="Slug"
              value={form.slug}
              onChange={(e) => setForm((prev) => ({ ...prev, slug: e.target.value }))}
              inputClassName="font-mono"
              placeholder="dsh-purge-safe"
            />
          </div>

          <Input
            label="Tên package npm"
            required
            value={form.packageName}
            onChange={(e) => setForm((prev) => ({ ...prev, packageName: e.target.value }))}
            inputClassName="font-mono"
            placeholder="dsh-purge-safe hoặc git+https://github.com/a/b.git"
            hint={
              <>
                Nhận tên registry, tên có version (<code>pkg@2.0.1</code>), scope (<code>@scope/pkg</code>),
                hoặc spec <code>git+…</code> / <code>https://…</code> / <code>file:…</code>.
              </>
            }
          />

          <div className="grid gap-4 sm:grid-cols-3">
            <Input
              label="Phiên bản"
              value={form.version}
              onChange={(e) => setForm((prev) => ({ ...prev, version: e.target.value }))}
              inputClassName="font-mono"
              placeholder="2.0.1"
            />
            <Input
              label="DSH target"
              value={form.dshTarget}
              onChange={(e) => setForm((prev) => ({ ...prev, dshTarget: e.target.value }))}
              inputClassName="font-mono"
              placeholder="0.2.2-rc.3"
            />
            <Input
              label="Thứ tự"
              type="number"
              value={form.sortOrder}
              onChange={(e) => setForm((prev) => ({ ...prev, sortOrder: Number(e.target.value) }))}
              inputClassName="font-mono"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Link repo"
              value={form.repoUrl}
              onChange={(e) => setForm((prev) => ({ ...prev, repoUrl: e.target.value }))}
              inputClassName="font-mono"
              placeholder="https://github.com/owner/repo"
            />
            <Input
              label="Link tài liệu"
              value={form.docsUrl}
              onChange={(e) => setForm((prev) => ({ ...prev, docsUrl: e.target.value }))}
              inputClassName="font-mono"
              placeholder="https://…"
            />
          </div>

          <label className="flex flex-col gap-1.5">
            <span className={LABEL}>Mô tả (khách thấy)</span>
            <textarea
              value={form.description}
              onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
              rows={4}
              className="w-full border border-border bg-surface px-3 py-2 text-sm text-text-main focus:border-text-main focus:outline-none"
              placeholder="Plugin này làm gì, dành cho ai. Markdown được."
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className={LABEL}>Hướng dẫn sử dụng (markdown)</span>
            <textarea
              value={form.usageGuide}
              onChange={(e) => setForm((prev) => ({ ...prev, usageGuide: e.target.value }))}
              rows={12}
              spellCheck={false}
              className="w-full border border-border bg-surface px-3 py-2 font-mono text-[12px] leading-5 text-text-main focus:border-text-main focus:outline-none"
              placeholder={"### Cài\n\n```bash\ndsh plugin --profile desktop add dsh-purge-safe\n```\n\n### Dùng\n\nMở panel …"}
            />
            <span className="text-xs leading-5 text-text-subtle">
              {(form.usageGuide || "").length} / 8000 ký tự
            </span>
          </label>

          <div className="grid gap-4 sm:grid-cols-2 items-end">
            <Select
              label="Đối tượng"
              value={form.audience}
              onChange={(e) => setForm((prev) => ({ ...prev, audience: e.target.value }))}
              options={AUDIENCE_OPTIONS}
            />
            <Toggle
              checked={form.isPublished}
              onChange={(value) => setForm((prev) => ({ ...prev, isPublished: value }))}
              label="Phát hành ngay"
              className="pb-2"
            />
          </div>
        </div>
      </Modal>

      <ConfirmModal
        isOpen={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={remove}
        title="Xoá plugin"
        message={deleting ? `Xoá "${deleting.name}"? Khách đã cài vẫn giữ plugin trong profile của họ; chỉ mục này biến mất khỏi danh sách.` : ""}
        confirmText="Xoá"
        variant="danger"
      />
    </div>
  );
}
