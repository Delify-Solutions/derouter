"use client";

import { useMemo, useState } from "react";
import { Button, Modal } from "@/shared/components";
import { slugFromName } from "@/lib/skills/frontmatter.js";
import RuntimePicker from "./RuntimePicker";

const LABEL = "font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted";
const INPUT = "h-9 w-full border border-border bg-surface px-3 text-sm text-text-main focus:border-text-main focus:outline-none";
const OUTCOME = { created: "Đã thêm", updated: "Đã cập nhật", skipped: "Bỏ qua", error: "Lỗi" };
const MAX_ITEMS = 100;


/**
 * Import a whole skill library by pasting its repository URL.
 *
 * Two steps, deliberately separate: "Đọc repo" only fetches and parses (nothing is
 * written), then the admin reviews the rows — ticking, renaming, or skipping a path
 * — and "Thêm" posts the chosen ones. A wrong URL, or a repository that turns out to
 * hold forty skills when you wanted three, costs a click instead of a cleanup.
 *
 * `path` narrows the read to one folder, so pasting a repository root and typing
 * `skills` is the same as pasting the /tree/ link to that folder.
 */
export default function RepoImportModal({ isOpen, existingSlugs, categories, onClose, onDone }) {
  const [url, setUrl] = useState("");
  const [path, setPath] = useState("");
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [targets, setTargets] = useState([]); // [] = every agent
  const [category, setCategory] = useState("");
  const [audience, setAudience] = useState("customer");
  const [isPublished, setIsPublished] = useState(true);
  const [mode, setMode] = useState("skip");

  // Bundle mode: the repository ships an engine (lib/mcp-server.mjs), so the admin
  // may import it as one bundle instead of loose skill rows.
  const [asBundle, setAsBundle] = useState(false);
  const [bundleName, setBundleName] = useState("");
  const [bundleDescription, setBundleDescription] = useState("");
  const [bundleUsageGuide, setBundleUsageGuide] = useState("");
  const [bundleEntrypoint, setBundleEntrypoint] = useState("install.mjs");
  const [bundleVersion, setBundleVersion] = useState("");

  const reset = () => {
    setRows([]);
    setMeta(null);
    setError("");
    setNotice("");
    setAsBundle(false);
    setBundleName("");
    setBundleDescription("");
    setBundleUsageGuide("");
    setBundleEntrypoint("install.mjs");
    setBundleVersion("");
  };

  const readRepo = async () => {
    if (!url.trim()) {
      setError("Nhập link repo trước");
      return;
    }
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/skills/import-repo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), path: path.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Không đọc được repo");
        setRows([]);
        setMeta(null);
        return;
      }
      setMeta(data);
      setRows(
        (data.skills || []).map((skill, index) => ({
          key: `${index}:${skill.path}`,
          include: !skill.problem,
          outcome: null,
          ...skill,
        })),
      );
      // Prefill the folder from what was actually read, so the field shows the scope
      // that produced these rows rather than what was typed.
      if (data.path) setPath(data.path);

      // An engine (lib/mcp-server.mjs) was detected: offer bundle mode, checked by
      // default, with everything prefilled from the repository itself so the admin
      // only has to confirm or adjust it.
      const engine = data.engine || {};
      setAsBundle(Boolean(engine.detected));
      if (engine.detected) {
        setBundleName((prev) => prev || data.repo.split("/").pop());
        setBundleDescription((engine.readme || "").trim().slice(0, 4000));
        setBundleEntrypoint(engine.installerEntrypoint || "install.mjs");
      }

      const notes = [];
      if (data.ignored) notes.push(`Bỏ qua ${data.ignored} file không phải skill.`);
      if (data.scoped) notes.push(`${data.scoped} file ngoài thư mục đã chọn không xét.`);
      if (data.failed) notes.push(`${data.failed} file không tải được.`);
      if (engine.detected) notes.push("Repo có engine (lib/mcp-server.mjs) — có thể nhập dạng bundle.");
      if (data.truncated) notes.push(`Chỉ lấy ${data.imported}/${data.matched} skill đầu tiên.`);
      if (data.incomplete) notes.push("Repo quá lớn, danh sách file có thể thiếu — dùng ô thư mục để thu hẹp.");
      setNotice(notes.join(" "));
    } catch {
      setError("Không đọc được repo. Kiểm tra kết nối rồi thử lại.");
    } finally {
      setLoading(false);
    }
  };

  const update = (key, patch) =>
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch, outcome: null } : row)));
  const remove = (key) => setRows((prev) => prev.filter((row) => row.key !== key));

  const locked = (row) => row.outcome?.action === "created" || row.outcome?.action === "updated";
  const slugOf = (row) => (row.slug || "").trim() || slugFromName(row.name);
  const chosen = rows.filter((row) => row.include && !locked(row) && !row.problem);
  const counts = new Map();
  for (const row of chosen) counts.set(slugOf(row), (counts.get(slugOf(row)) || 0) + 1);
  const duplicate = (row) => (counts.get(slugOf(row)) || 0) > 1;
  const exists = (row) => !locked(row) && existingSlugs.has(slugOf(row));
  const anyOutcome = rows.some((row) => row.outcome);

  const toggleAll = (checked) =>
    setRows((prev) =>
      prev.map((row) => (locked(row) || row.problem ? row : { ...row, include: checked })),
    );

  const allChosen = rows.length > 0 && rows.filter((r) => !locked(r) && !r.problem).every((r) => r.include);

  const submit = async () => {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      // Bundle mode creates the bundle first, then every imported skill from this
      // repository is linked to it in the same action. Declining bundle mode (even
      // on a detected-engine repo) imports exactly as before this feature existed.
      let bundleId;
      if (asBundle) {
        const slashIndex = meta.repo.lastIndexOf("/");
        const sourceOwner = meta.repo.slice(0, slashIndex);
        const sourceRepo = meta.repo.slice(slashIndex + 1);
        const bundleRes = await fetch("/api/skills/bundles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: bundleName.trim() || sourceRepo,
            description: bundleDescription,
            usageGuide: bundleUsageGuide,
            sourceHost: meta.host,
            sourceOwner,
            sourceRepo,
            sourceRef: meta.ref,
            installerEntrypoint: bundleEntrypoint,
            audience,
            isPublished,
            version: bundleVersion.trim(),
            importedSha: meta.sha || null,
          }),
        });
        const bundleData = await bundleRes.json().catch(() => ({}));
        if (!bundleRes.ok) {
          setError(bundleData.error || "Không tạo được bundle");
          return;
        }
        bundleId = bundleData.id;
      }

      const payload = chosen.slice(0, MAX_ITEMS).map((row) => ({
        name: row.name.trim() || slugOf(row),
        slug: slugOf(row),
        summary: row.summary,
        body: row.body,
        fileName: "SKILL.md",
        targets,
        category,
        audience,
        isPublished,
        ...(bundleId ? { bundleId } : {}),
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
      // Results come back in request order, so they map onto the chosen rows by
      // position: two rows sharing a slug each get their own outcome.
      const byKey = new Map(chosen.map((row, i) => [row.key, data.results?.[i] || null]));
      setRows((prev) =>
        prev.map((row) => {
          const outcome = byKey.get(row.key);
          if (!outcome) return row;
          const done = outcome.action === "created" || outcome.action === "updated";
          return { ...row, outcome, include: done ? false : row.include };
        }),
      );
      setNotice(
        `Thêm ${data.created || 0}, cập nhật ${data.updated || 0}, bỏ qua ${data.skipped || 0}, lỗi ${data.failed || 0}.`,
      );
      onDone();
    } catch {
      setError("Không thêm được skill. Kiểm tra kết nối rồi thử lại.");
    } finally {
      setSaving(false);
    }
  };

  const summaryLine = useMemo(() => {
    if (!meta) return null;
    const bits = [`${meta.repo}@${meta.ref}`, `${meta.imported} skill`];
    if (meta.path) bits.push(`thư mục ${meta.path}`);
    return bits.join(" · ");
  }, [meta]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        if (saving) return;
        reset();
        onClose();
      }}
      title="Nhập skill từ repo"
      size="full"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => { reset(); onClose(); }} disabled={saving}>
            {anyOutcome && chosen.length === 0 ? "Đóng" : "Huỷ"}
          </Button>
          {rows.length === 0 ? (
            <Button onClick={readRepo} loading={loading}>Đọc repo</Button>
          ) : (
            <Button onClick={submit} loading={saving} disabled={chosen.length === 0}>
              {chosen.length ? `Thêm ${chosen.length} skill` : "Thêm skill"}
            </Button>
          )}
        </div>
      }
    >
      <div className="flex max-h-[70vh] flex-col gap-5 overflow-y-auto pr-1">
        {error && (
          <p role="alert" className="border border-red-500/40 bg-red-500/5 px-3 py-2 text-sm text-red-700 dark:text-red-400">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="border border-border bg-surface-2 px-3 py-2 text-sm text-text-main">{notice}</p>
        )}

        <div className="flex flex-col gap-3 border border-border p-4">
          <label className="flex flex-col gap-1.5">
            <span className={LABEL}>Link repo</span>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !loading) readRepo(); }}
              className={INPUT}
              placeholder="https://github.com/owner/repo"
              aria-label="Link repo"
            />
          </label>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className={LABEL}>Chỉ lấy trong thư mục (tuỳ chọn)</span>
              <input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                className={`${INPUT} font-mono`}
                placeholder="skills/redteam"
                aria-label="Thư mục trong repo"
              />
            </label>
            <Button variant="secondary" onClick={readRepo} loading={loading}>
              {rows.length ? "Đọc lại" : "Đọc repo"}
            </Button>
          </div>
          <p className="text-xs leading-5 text-text-muted">
            Hỗ trợ GitHub, GitLab, Codeberg — repo phải <strong className="text-text-main">public</strong>. Mỗi{" "}
            <code>SKILL.md</code> trong repo là một skill; tên thư mục thành slug. Đọc repo chỉ tải về xem trước,
            chưa ghi gì.
          </p>
          {summaryLine && <p className="font-mono text-[11px] text-text-subtle">{summaryLine}</p>}
        </div>

        {meta && (
          <div className="flex flex-col gap-3 border border-border p-4">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={asBundle}
                disabled={!meta.engine?.detected}
                onChange={(e) => setAsBundle(e.target.checked)}
                className="size-4"
              />
              <span className="text-sm text-text-main">Nhập dạng bundle (kèm engine)</span>
            </label>
            <p className="text-xs leading-5 text-text-muted">
              {meta.engine?.detected
                ? "Repo này có engine (lib/mcp-server.mjs). Nhập dạng bundle để gộp các skill dưới đây với engine và (nếu có) installer riêng của repo thành một khối, khách thấy chung mô tả và hướng dẫn sử dụng."
                : "Không thấy lib/mcp-server.mjs trong repo này — nhập như skill rời như bình thường."}
            </p>
            {asBundle && (
              <div className="flex flex-col gap-3">
                <label className="flex flex-col gap-1.5">
                  <span className={LABEL}>Tên bundle</span>
                  <input
                    value={bundleName}
                    onChange={(e) => setBundleName(e.target.value)}
                    className={INPUT}
                    placeholder="rea-policy"
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className={LABEL}>Mô tả (khách thấy)</span>
                  <textarea
                    value={bundleDescription}
                    onChange={(e) => setBundleDescription(e.target.value)}
                    rows={4}
                    className="w-full border border-border bg-surface px-3 py-2 text-sm text-text-main focus:border-text-main focus:outline-none"
                    placeholder="Prefilled từ README của repo — sửa lại cho khách dễ hiểu"
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className={LABEL}>Hướng dẫn sử dụng (skill nào dùng khi nào)</span>
                  <textarea
                    value={bundleUsageGuide}
                    onChange={(e) => setBundleUsageGuide(e.target.value)}
                    rows={3}
                    className="w-full border border-border bg-surface px-3 py-2 text-sm text-text-main focus:border-text-main focus:outline-none"
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className={LABEL}>Phiên bản (tự đặt — repo này không có git tag/release để lấy tự động)</span>
                  <input
                    value={bundleVersion}
                    onChange={(e) => setBundleVersion(e.target.value)}
                    className={`${INPUT} font-mono`}
                    placeholder="v1.0.0"
                    maxLength={40}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className={LABEL}>Installer entrypoint (trong repo, chạy sau khi giải nén engine)</span>
                  <input
                    value={bundleEntrypoint}
                    onChange={(e) => setBundleEntrypoint(e.target.value)}
                    className={`${INPUT} font-mono`}
                    placeholder="install.mjs"
                  />
                </label>
              </div>
            )}
          </div>
        )}

        {rows.length > 0 && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-text-main">
                <input
                  type="checkbox"
                  checked={allChosen}
                  onChange={(e) => toggleAll(e.target.checked)}
                  className="size-4"
                  aria-label="Chọn tất cả"
                />
                Chọn tất cả
              </label>
              <span className={LABEL}>{rows.length} skill · sẽ thêm {chosen.length}</span>
            </div>

            {rows.map((row) => {
              const problem = row.problem || (duplicate(row) ? "Trùng slug với dòng khác" : "");
              const done = locked(row);
              return (
                <div key={row.key} className="flex flex-col gap-2 border border-border bg-surface p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="checkbox"
                      checked={row.include && !done && !row.problem}
                      disabled={done || Boolean(row.problem)}
                      onChange={(e) => update(row.key, { include: e.target.checked })}
                      aria-label={`Chọn ${row.name || row.slug}`}
                      className="size-4"
                    />
                    <span className="font-mono text-[11px] text-text-subtle" title={row.path}>
                      {row.path} · {(row.bytes / 1024).toFixed(1)} KB
                    </span>
                    {exists(row) && (
                      <span className="border border-border px-2 py-0.5 text-[11px] text-text-muted">Slug đã có</span>
                    )}
                    {problem && (
                      <span role="alert" className="border border-red-500/40 px-2 py-0.5 text-[11px] text-red-700 dark:text-red-400">
                        {problem}
                      </span>
                    )}
                    {row.outcome && (
                      <span className="border border-border px-2 py-0.5 text-[11px] text-text-main">
                        {OUTCOME[row.outcome.action]}{row.outcome.error ? `: ${row.outcome.error}` : ""}
                      </span>
                    )}
                    {!done && (
                      <button
                        type="button"
                        onClick={() => remove(row.key)}
                        aria-label={`Bỏ ${row.name || row.slug} khỏi danh sách`}
                        className="ml-auto flex size-7 items-center justify-center border border-border text-text-muted hover:bg-surface-2 hover:text-text-main"
                      >
                        <span className="material-symbols-outlined text-[16px]" aria-hidden="true">close</span>
                      </button>
                    )}
                  </div>
                  {!done && (
                    <div className="grid gap-2 sm:grid-cols-[1fr_1fr_2fr]">
                      <input
                        value={row.name}
                        onChange={(e) => update(row.key, {
                          name: e.target.value,
                          // Follow the name only while the slug is still the derived one.
                          slug: row.slug === slugFromName(row.name) ? slugFromName(e.target.value) : row.slug,
                        })}
                        className={INPUT}
                        placeholder="Tên skill"
                        aria-label={`Tên skill (${row.path})`}
                      />
                      <input
                        value={row.slug}
                        onChange={(e) => update(row.key, { slug: e.target.value })}
                        className={`${INPUT} font-mono`}
                        placeholder="slug"
                        aria-label={`Slug (${row.path})`}
                      />
                      <input
                        value={row.summary}
                        maxLength={200}
                        onChange={(e) => update(row.key, { summary: e.target.value })}
                        className={INPUT}
                        placeholder="Mô tả ngắn"
                        aria-label={`Mô tả ngắn (${row.path})`}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {rows.length > 0 && (
          <div className="flex flex-col gap-4 border border-border p-4">
            <span className={LABEL}>Áp dụng cho tất cả skill sẽ thêm</span>
            <RuntimePicker value={targets} onChange={setTargets} />
            <div className="grid gap-4 sm:grid-cols-3">
              <label className="flex flex-col gap-1.5">
                <span className={LABEL}>Nhóm</span>
                <input
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  list="skill-repo-categories"
                  className={INPUT}
                  placeholder="Red team"
                />
                <datalist id="skill-repo-categories">
                  {categories.map((c) => <option key={c.category} value={c.category} />)}
                </datalist>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className={LABEL}>Đối tượng</span>
                <select value={audience} onChange={(e) => setAudience(e.target.value)} className={INPUT}>
                  <option value="customer">Khách hàng</option>
                  <option value="internal">Nội bộ</option>
                </select>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className={LABEL}>Slug đã có</span>
                <select value={mode} onChange={(e) => setMode(e.target.value)} className={INPUT}>
                  <option value="skip">Bỏ qua</option>
                  <option value="update">Cập nhật nội dung</option>
                </select>
              </label>
            </div>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={isPublished}
                onChange={(e) => setIsPublished(e.target.checked)}
                className="size-4"
              />
              <span className="text-sm text-text-main">Phát hành ngay (khách thấy trong khu tài khoản)</span>
            </label>
          </div>
        )}
      </div>
    </Modal>
  );
}
