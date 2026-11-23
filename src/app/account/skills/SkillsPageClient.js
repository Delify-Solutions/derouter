"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Heading, Eyebrow, Panel, Tag, buttonClass } from "../components/ui";
import { Modal } from "@/shared/components";
import { runtimeInstallDir, runtimeLabel, SKILL_RUNTIME_IDS } from "@/lib/skills/runtimes.js";
import { cn } from "@/shared/utils/cn";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { renderBundleMarkdown } from "./renderBundleMarkdown";

const noopSubscribe = () => () => {};

/** This page's own origin, "" during server render so the markup matches on hydration. */
function useOrigin() {
  return useSyncExternalStore(
    noopSubscribe,
    () => window.location.origin,
    () => ""
  );
}

/**
 * The one-line installer for these arguments.
 *
 * `opts.apiKey`, when the customer picked one, is the real secret inlined
 * straight into the command; otherwise the key stays a placeholder they fill in
 * by hand. `opts.target`, when the customer narrowed it to specific agents, is
 * appended as `--target <ids>`; left out (the default), the installer covers
 * every agent it finds on the machine — "all agents" needs no flag at all.
 *
 * `--uninstall` is a pure filesystem cleanup (installScript.js's own words: "no
 * server, no API key needed") — it never reads DEROUTER_KEY, so the command
 * leaves that part out entirely instead of showing a key/placeholder nothing
 * ever uses.
 */
function installCommand(origin, args, opts = {}) {
  const { apiKey, target } = opts;
  const targetArg = target && target.length > 0 ? ` --target ${target.join(",")}` : "";
  const base = `curl -fsSL ${origin}/api/public/skills/install.sh | `;
  const keyPrefix = /(^|\s)--uninstall(\s|$)/.test(args) ? "" : `DEROUTER_KEY=${apiKey || "<API_KEY>"} `;
  return `${base}${keyPrefix}sh -s -- ${args}${targetArg}`;
}

function fmtDate(value) {
  if (!value) return "—";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleDateString("vi-VN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

/**
 * Copy-able line: a monospace value with a square copy button. The button is the
 * only control, so the row does not need a caption.
 */
function CopyLine({ value, label, wrap = false }) {
  const { copied, copy } = useCopyToClipboard(2000);
  return (
    <div className="flex min-w-0 items-stretch border border-border bg-surface-2">
      <code
        className={cn(
          "min-w-0 flex-1 px-3 py-2 font-mono text-[12px] leading-5 text-text-main",
          wrap ? "break-all" : "truncate"
        )}
        title={value}
      >
        {value}
      </code>
      <button
        type="button"
        onClick={() => copy(value)}
        aria-label={copied ? "Đã sao chép" : `Sao chép ${label}`}
        className="flex w-10 shrink-0 items-center justify-center border-l border-border text-text-muted transition-colors duration-150 hover:bg-surface hover:text-text-main"
      >
        <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
          {copied ? "check" : "content_copy"}
        </span>
      </button>
    </div>
  );
}

/**
 * One download step: a numbered square, a verb, then the code.
 */
function Step({ index, title, children }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center border border-border bg-surface-2 font-mono text-[11px] text-text-muted">
        {index}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2 pb-5">
        <p className="text-sm font-medium text-text-main">{title}</p>
        {children}
      </div>
    </li>
  );
}

/**
 * Picks one of the customer's own API keys and reveals it (POST .../secret, same
 * action as the "Hiện key" button on /account/keys) so it can be inlined straight
 * into a copy-pasteable install command instead of a placeholder the customer has
 * to hand-edit.
 */
function ApiKeySelect({ id, keys, selectedId, loading, onSelect }) {
  if (keys.length === 0) return null;
  return (
    <label className="flex flex-wrap items-center gap-2 text-sm text-text-main">
      <span>Điền sẵn API key vào lệnh:</span>
      <select
        id={id}
        value={selectedId}
        onChange={(e) => onSelect(e.target.value)}
        className="h-8 border border-border bg-surface px-2 text-sm text-text-main focus:border-text-main focus:outline-none"
      >
        <option value="">— không, giữ &lt;API_KEY&gt; —</option>
        {keys.map((k) => (
          <option key={k.id} value={k.id}>{k.name || k.keyPrefix}</option>
        ))}
      </select>
      {loading && <span className="text-xs text-text-muted">Đang lấy key…</span>}
    </label>
  );
}

/**
 * Which agents the command installs into: every agent on the machine (the
 * installer's own default — no flag needed), or a chosen few via `--target`.
 */
function AgentTargetSelect({ id, mode, onModeChange, picked, onTogglePicked }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-4 text-sm text-text-main">
        <span>Cài cho agent nào:</span>
        <label className="flex items-center gap-1.5">
          <input type="radio" name={id} checked={mode === "all"} onChange={() => onModeChange("all")} className="size-4" />
          Tất cả agent có trên máy
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" name={id} checked={mode === "pick"} onChange={() => onModeChange("pick")} className="size-4" />
          Chọn agent
        </label>
      </div>
      {mode === "pick" && (
        <div className="flex flex-wrap gap-1.5">
          {SKILL_RUNTIME_IDS.map((rid) => (
            <label
              key={rid}
              className="flex items-center gap-1 border border-border bg-surface px-2 py-1 font-mono text-[11px] text-text-main"
            >
              <input
                type="checkbox"
                checked={picked.has(rid)}
                onChange={() => onTogglePicked(rid)}
                className="size-3.5"
              />
              {runtimeLabel(rid)}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One bundle, as a row in the left-hand list: its name, version and skill count,
 * selected or not. Everything else — description, usage guide, the install
 * command — is the detail pane on the right (BundleDetailBody), not repeated here.
 */
function BundleListItem({ bundle, skillCount, selected, onSelect }) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(bundle)}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "flex w-full flex-col items-start gap-1 border px-3 py-2.5 text-left transition-colors duration-150",
          selected
            ? "border-text-main bg-surface-2"
            : "border-border bg-surface hover:bg-surface-2"
        )}
      >
        <div className="flex w-full min-w-0 items-center gap-1.5">
          <span className="material-symbols-outlined shrink-0 text-[16px] text-text-muted" aria-hidden="true">inventory_2</span>
          <span className="truncate font-mono text-sm font-semibold text-text-main">{bundle.name}</span>
          {bundle.hasUpdate && (
            <span className="ml-auto size-2 shrink-0 rounded-full bg-amber-500" title="Có bản cập nhật từ nguồn" aria-hidden="true" />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {bundle.version && <Tag tone="neutral">{bundle.version}</Tag>}
          <Tag tone="neutral">{skillCount} skill</Tag>
        </div>
      </button>
    </li>
  );
}

/**
 * Which action the "Cài đặt" card's command is for: install/update share one
 * command (re-running install is the update), uninstall is the other. A picker
 * instead of showing both commands at once — one bundle, one command to copy.
 */
function BundleActionSelect({ action, onChange }) {
  const options = [
    { id: "install", label: "Cài / cập nhật" },
    { id: "uninstall", label: "Gỡ cài" },
  ];
  return (
    <div className="flex gap-1.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          aria-pressed={action === o.id}
          className={cn(
            "h-8 border px-3 font-mono text-xs font-medium transition-colors duration-150",
            action === o.id
              ? "border-text-main bg-text-main text-bg"
              : "border-border bg-surface text-text-muted hover:text-text-main"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A bundle's full detail: its description and usage guide rendered as Markdown,
 * and a "Cài đặt" card of its own with an action picker (install/update vs
 * uninstall, install by default) so only one command shows at a time. When the
 * source has moved past what was imported (hasUpdate), a separate banner offers
 * the same install command with --engine-update to refresh the local engine.
 */
function BundleDetailBody({ bundle, skills, origin, apiKeyProps, targetProps, installOpts }) {
  const skillCount = skills.filter((s) => s.bundleId === bundle.id).length;
  const descriptionHtml = renderBundleMarkdown(bundle.description);
  const usageHtml = renderBundleMarkdown(bundle.usageGuide);
  const [action, setAction] = useState("install");
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-mono text-base font-semibold text-text-main">{bundle.name}</h2>
        {bundle.version && <Tag tone="neutral">{bundle.version}</Tag>}
      </div>

      {origin && skillCount > 0 && (
        <Panel className="flex flex-col gap-3 p-4">
          <Eyebrow>Cài đặt</Eyebrow>
          <BundleActionSelect action={action} onChange={setAction} />
          {action === "install" ? (
            <>
              <ApiKeySelect id="bundle-api-key" {...apiKeyProps} />
              <AgentTargetSelect id="bundle-target" {...targetProps} />
              <CopyLine
                value={installCommand(origin, `--bundle ${bundle.slug}`, installOpts)}
                label={`lệnh cài bundle ${bundle.name}`}
                wrap
              />
            </>
          ) : (
            <>
              <AgentTargetSelect id="bundle-target-uninstall" {...targetProps} />
              <CopyLine
                value={installCommand(origin, `--uninstall --bundle ${bundle.slug}`)}
                label={`lệnh gỡ engine bundle ${bundle.name}`}
                wrap
              />
            </>
          )}
        </Panel>
      )}

      {bundle.hasUpdate && (
        <div className="flex flex-col gap-1.5 border border-amber-500/40 bg-amber-500/5 p-3">
          <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-amber-700 dark:text-amber-400">
            Có bản cập nhật từ nguồn
          </p>
          <p className="text-xs leading-5 text-text-muted">
            Repo nguồn của bundle này đã có commit mới hơn lần nhập gần nhất. Chạy lại lệnh cài bên
            trên với <code>--engine-update</code> để lấy bản engine mới nhất.
          </p>
          {origin && (
            <CopyLine
              value={installCommand(origin, `--bundle ${bundle.slug} --engine-update`, installOpts)}
              label={`lệnh cập nhật bundle ${bundle.name}`}
              wrap
            />
          )}
        </div>
      )}

      {descriptionHtml && (
        <div
          className="docs-body text-sm text-text-main"
          dangerouslySetInnerHTML={{ __html: descriptionHtml }}
        />
      )}
      {usageHtml && (
        <div className="border-l-2 border-border pl-3">
          <Eyebrow>Hướng dẫn sử dụng</Eyebrow>
          <div
            className="docs-body mt-1 text-sm text-text-main"
            dangerouslySetInnerHTML={{ __html: usageHtml }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Where one skill's file goes, for one agent at a time: with two dozen agents a path
 * per agent would bury the card, so the customer picks theirs.
 */
function InstallPath({ skill }) {
  const agents = skill.targets || [];
  const [agent, setAgent] = useState(agents[0] || "claude");
  const current = agents.includes(agent) ? agent : agents[0];
  if (!current) return null;
  const id = `path-${skill.slug}`;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={id}><Eyebrow>Đặt file vào, cho agent</Eyebrow></label>
        <select
          id={id}
          value={current}
          onChange={(e) => setAgent(e.target.value)}
          className="h-8 border border-border bg-surface px-2 text-sm text-text-main focus:border-text-main focus:outline-none"
        >
          {agents.map((rid) => (
            <option key={rid} value={rid}>{runtimeLabel(rid)}</option>
          ))}
        </select>
      </div>
      <CopyLine value={runtimeInstallDir(current, skill.slug)} label={`đường dẫn ${runtimeLabel(current)}`} />
    </div>
  );
}

function SkillCard({ skill, onOpen, origin, checked, onToggle, installOpts }) {
  return (
    <li className="flex flex-col gap-4 border border-border bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="checkbox"
              checked={checked}
              onChange={() => onToggle(skill.slug)}
              aria-label={`Chọn ${skill.name} để tải`}
              className="size-4"
            />
            <h3 className="font-mono text-sm font-semibold text-text-main">{skill.name}</h3>
            {skill.allAgents ? (
              <Tag tone="neutral">Mọi agent</Tag>
            ) : (
              (skill.targets || []).map((id) => (
                <Tag key={id} tone="neutral">{runtimeLabel(id)}</Tag>
              ))
            )}
            {skill.version && <Tag tone="neutral">v{skill.version}</Tag>}
          </div>
          {skill.summary && (
            <p className="mt-1 text-sm leading-6 text-text-muted">{skill.summary}</p>
          )}
          {skill.description && skill.description !== skill.summary && (
            <p className="mt-1 text-sm leading-6 text-text-muted">{skill.description}</p>
          )}
        </div>
        <span className="shrink-0 font-mono text-[11px] text-text-subtle">
          {skill.downloadCount ?? 0} lượt tải
        </span>
      </div>

      {origin && (
        <div className="flex flex-col gap-1.5">
          <Eyebrow>Cài nhanh bằng một lệnh</Eyebrow>
          <CopyLine value={installCommand(origin, skill.slug, installOpts)} label="lệnh cài nhanh" wrap />
          <p className="text-xs leading-5 text-text-muted">
            Chạy lại đúng lệnh trên là cập nhật lên bản mới nhất.
          </p>
          <CopyLine value={installCommand(origin, `--uninstall ${skill.slug}`)} label="lệnh gỡ cài" wrap />
        </div>
      )}

      <InstallPath skill={skill} />

      {skill.usageNotes && (
        <p className="border-l-2 border-border pl-3 text-sm leading-6 text-text-muted">
          {skill.usageNotes}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <a
          href={`/api/account/skills/${skill.slug}/download`}
          className={buttonClass({ tone: "solid", size: "sm" })}
          download
        >
          <span className="material-symbols-outlined text-[16px]" aria-hidden="true">download</span>
          Tải {skill.fileName}
        </a>
        <button
          type="button"
          onClick={() => onOpen(skill)}
          className={buttonClass({ tone: "outline", size: "sm" })}
        >
          <span className="material-symbols-outlined text-[16px]" aria-hidden="true">visibility</span>
          Xem nội dung
        </button>
      </div>
    </li>
  );
}

/**
 * `/account/skills` — the skills this customer may install into their agent
 * runtime.
 *
 * Two tabs: the catalogue, and a fixed how-to that does not depend on any one
 * skill, so a customer who has never installed a skill has a path from "I
 * downloaded a file" to "my agent is using it".
 */
export default function SkillsPageClient() {
  const origin = useOrigin();
  const [tab, setTab] = useState("catalogue");
  const [skills, setSkills] = useState([]);
  const [bundles, setBundles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [category, setCategory] = useState("");
  const [opening, setOpening] = useState(null);
  const [detail, setDetail] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  // Which bundle is open in the right-hand detail pane; the first one loaded is
  // selected by default so the pane is never empty while any bundle exists.
  const [selectedBundleId, setSelectedBundleId] = useState(null);

  // The customer's own API keys, for inlining the real secret into a command
  // instead of a placeholder. Secrets are fetched one at a time, on an explicit
  // pick, and kept only in memory (same rule as /account/keys).
  const [keys, setKeys] = useState([]);
  const [keySecrets, setKeySecrets] = useState({});
  const [selectedKeyId, setSelectedKeyId] = useState("");
  const [keyLoading, setKeyLoading] = useState(false);

  // Which agents a command installs into: "all" (the installer's own default,
  // every agent machine has) needs no flag; "pick" adds --target for the chosen
  // ones.
  const [targetMode, setTargetMode] = useState("all");
  const [targetAgents, setTargetAgents] = useState(() => new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/account/skills", { cache: "no-store" });
      if (!res.ok) throw new Error("fetch failed");
      const data = await res.json();
      setSkills(data.skills || []);
      setBundles(data.bundles || []);
    } catch {
      setError("Không tải được danh sách skill. Tải lại trang để thử lại.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    fetch("/api/account/keys", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : { keys: [] }))
      .then((data) => setKeys(data.keys || []))
      .catch(() => {});
  }, []);

  const selectKey = async (id) => {
    setSelectedKeyId(id);
    if (!id || keySecrets[id]) return;
    setKeyLoading(true);
    try {
      const res = await fetch(`/api/account/keys/${encodeURIComponent(id)}/secret`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.secret) setKeySecrets((prev) => ({ ...prev, [id]: data.secret }));
    } catch {
      /* the command simply keeps the placeholder */
    } finally {
      setKeyLoading(false);
    }
  };

  const apiKey = selectedKeyId ? keySecrets[selectedKeyId] || null : null;
  const apiKeyProps = { keys, selectedId: selectedKeyId, loading: keyLoading, onSelect: selectKey, apiKey };

  const toggleTargetAgent = (id) =>
    setTargetAgents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const target = targetMode === "pick" ? [...targetAgents] : null;
  const targetProps = { mode: targetMode, onModeChange: setTargetMode, picked: targetAgents, onTogglePicked: toggleTargetAgent };
  const installOpts = { apiKey, target };
  // Falls back to the first bundle so the pane is never empty, without needing an
  // effect to keep the selection in sync as the list loads or changes.
  const selectedBundle = bundles.find((b) => b.id === selectedBundleId) || bundles[0] || null;

  const togglePicked = (slug) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });

  // A bundle's skills are browsed and installed as that one bundle (see the bundle
  // cards below), not listed individually here — the catalogue is the skills nobody
  // grouped.
  const standaloneSkills = useMemo(() => skills.filter((s) => !s.bundleId), [skills]);

  // Category pills are derived from the same standalone set, so a pill never leads
  // to an empty page because its only skills are now shown inside a bundle instead.
  const visibleCategories = useMemo(() => {
    const counts = new Map();
    for (const s of standaloneSkills) {
      if (!s.category) continue;
      counts.set(s.category, (counts.get(s.category) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([cat, count]) => ({ category: cat, count }))
      .sort((a, b) => a.category.localeCompare(b.category));
  }, [standaloneSkills]);

  const visible = useMemo(
    () => (category ? standaloneSkills.filter((s) => s.category === category) : standaloneSkills),
    [standaloneSkills, category]
  );

  // What the zip and the one-line command act on: picked skills that still exist.
  const pickedSlugs = standaloneSkills.filter((skill) => picked.has(skill.slug)).map((skill) => skill.slug);
  const selectable = visible.slice(0, 100).map((skill) => skill.slug); // one archive carries at most 100
  const allShownPicked = selectable.length > 0 && selectable.every((slug) => picked.has(slug));
  const togglePage = () =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (allShownPicked) selectable.forEach((slug) => next.delete(slug));
      else selectable.forEach((slug) => next.add(slug));
      return next;
    });

  const openDetail = async (skill) => {
    setOpening(skill.slug);
    setError("");
    try {
      const res = await fetch(`/api/account/skills/${skill.slug}`, { cache: "no-store" });
      if (!res.ok) throw new Error("fetch failed");
      const data = await res.json();
      setDetail(data.skill);
    } catch {
      setError("Không mở được nội dung skill.");
    } finally {
      setOpening(null);
    }
  };

  const tabs = [
    { id: "catalogue", label: "Danh sách", count: standaloneSkills.length + bundles.length },
    { id: "guide", label: "Hướng dẫn cài", count: null },
  ];

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Heading>Skill</Heading>
        <p className="max-w-2xl text-sm leading-6 text-text-muted">
          Skill markdown cài vào agent của bạn (Claude Code, Codex, OpenCode, omp, dsh) để agent biết
          cách dùng derouter và các quy trình kèm theo. Tải file, đặt đúng thư mục, rồi gọi
          skill trong phiên làm việc.
        </p>
      </div>

      <div role="tablist" aria-label="Skill" className="flex border-b border-border">
        {tabs.map((item) => {
          const selected = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`skills-panel-${item.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setTab(item.id)}
              className={cn(
                "-mb-px flex h-11 items-center gap-2 border-b-2 px-4 font-mono text-[13px] font-medium transition-colors duration-150",
                selected
                  ? "border-text-main text-text-main"
                  : "border-transparent text-text-muted hover:text-text-main"
              )}
            >
              {item.label}
              {item.count !== null && (
                <span className="border border-border px-1.5 font-mono text-[11px] text-text-muted">
                  {item.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {error && (
        <p role="alert" className="border border-red-500/40 bg-red-500/5 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}

      {tab === "catalogue" ? (
        <section
          id="skills-panel-catalogue"
          role="tabpanel"
          aria-label="Danh sách skill"
          className="flex flex-col gap-5"
        >
          {origin && (
            <Panel className="flex flex-col gap-3 p-5">
              <Eyebrow>Cài nhanh</Eyebrow>
              <p className="text-sm leading-6 text-text-muted">
                Một lệnh tải và đặt đúng thư mục cho tất cả skill bên dưới. Thay{" "}
                <code>&lt;API_KEY&gt;</code> bằng key của bạn ở trang{" "}
                <a href="/account/keys" className="underline">API key</a>.
              </p>
              <ApiKeySelect id="catalogue-api-key" {...apiKeyProps} />
              <AgentTargetSelect id="catalogue-target" {...targetProps} />
              <CopyLine value={installCommand(origin, "--all", installOpts)} label="lệnh cài tất cả skill" wrap />
              {pickedSlugs.length > 0 && (
                <>
                  <p className="text-sm leading-6 text-text-muted">Chỉ {pickedSlugs.length} skill bạn đã chọn:</p>
                  <CopyLine value={installCommand(origin, pickedSlugs.join(" "), installOpts)} label="lệnh cài các skill đã chọn" wrap />
                </>
              )}
            </Panel>
          )}

          {bundles.length > 0 && (
            <div className="flex flex-col gap-3">
              <Eyebrow>Bundle (skill + engine)</Eyebrow>
              <div className="grid gap-3 lg:grid-cols-[260px_minmax(0,1fr)]">
                <ul className="flex flex-col gap-2 lg:max-h-[640px] lg:overflow-y-auto">
                  {bundles.map((bundle) => (
                    <BundleListItem
                      key={bundle.id}
                      bundle={bundle}
                      skillCount={skills.filter((s) => s.bundleId === bundle.id).length}
                      selected={bundle.id === selectedBundleId}
                      onSelect={(b) => setSelectedBundleId(b.id)}
                    />
                  ))}
                </ul>
                <Panel className="min-w-0 p-5">
                  {selectedBundle ? (
                    <BundleDetailBody
                      bundle={selectedBundle}
                      skills={skills}
                      origin={origin}
                      apiKeyProps={apiKeyProps}
                      targetProps={targetProps}
                      installOpts={installOpts}
                    />
                  ) : (
                    <p className="text-sm text-text-muted">Chọn một bundle để xem hướng dẫn và cài.</p>
                  )}
                </Panel>
              </div>
            </div>
          )}

          {standaloneSkills.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 border border-border bg-surface px-4 py-3">
              <label className="flex items-center gap-2 text-sm text-text-main">
                <input type="checkbox" checked={allShownPicked} onChange={togglePage} className="size-4" />
                Chọn tất cả {selectable.length} skill đang hiện
              </label>
              <span className="font-mono text-xs text-text-muted" role="status">{pickedSlugs.length} đã chọn</span>
              <span className="ml-auto text-xs text-text-muted">
                {pickedSlugs.length > 0
                  ? "Lệnh cài riêng các skill đã chọn nằm ở khung \"Cài nhanh\" phía trên."
                  : "Tick skill để lấy lệnh cài riêng, hoặc dùng lệnh cài tất cả."}
              </span>
            </div>
          )}

          {visibleCategories.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setCategory("")}
                aria-pressed={category === ""}
                className={cn(
                  "h-8 border px-3 font-mono text-xs font-medium transition-colors duration-150",
                  category === ""
                    ? "border-text-main bg-text-main text-bg"
                    : "border-border bg-surface text-text-muted hover:text-text-main"
                )}
              >
                Tất cả
              </button>
              {visibleCategories.map((c) => (
                <button
                  key={c.category}
                  type="button"
                  onClick={() => setCategory(c.category)}
                  aria-pressed={category === c.category}
                  className={cn(
                    "h-8 border px-3 font-mono text-xs font-medium transition-colors duration-150",
                    category === c.category
                      ? "border-text-main bg-text-main text-bg"
                      : "border-border bg-surface text-text-muted hover:text-text-main"
                  )}
                >
                  {c.category}
                  <span className="ml-1.5 opacity-60">{c.count}</span>
                </button>
              ))}
            </div>
          )}

          {loading ? (
            <p className="border border-dashed border-border px-6 py-12 text-center text-sm text-text-muted">
              Đang tải…
            </p>
          ) : visible.length === 0 && standaloneSkills.length === 0 && bundles.length > 0 ? null : visible.length === 0 ? (
            <p className="border border-dashed border-border px-6 py-12 text-center text-sm text-text-muted">
              {standaloneSkills.length === 0
                ? "Chưa có skill nào được phát hành. Quay lại sau nhé."
                : "Nhóm này chưa có skill."}
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {visible.map((skill) => (
                <SkillCard key={skill.id} skill={skill} onOpen={openDetail} origin={origin} checked={picked.has(skill.slug)} onToggle={togglePicked} installOpts={installOpts} />
              ))}
            </ul>
          )}
        </section>
      ) : (
        <section
          id="skills-panel-guide"
          role="tabpanel"
          aria-label="Hướng dẫn cài skill"
          className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,320px)]"
        >
          <Panel className="p-6 xl:col-span-2">
            <Eyebrow>Cách nhanh (khuyên dùng)</Eyebrow>
            <p className="mt-2 text-sm leading-6 text-text-muted">
              Chạy lệnh dưới đây trong terminal (macOS, Linux, hoặc WSL / Git Bash trên Windows). Lệnh tải
              skill, tạo thư mục đúng tên và ghi <code>SKILL.md</code> cho bạn; chạy lại là cập nhật lên bản mới.
              Key được đọc từ biến môi trường <code>DEROUTER_KEY</code>, không lưu vào máy. Chạy lệnh
              không kèm tên skill trong terminal thì script hiện danh sách đánh số để bạn chọn từng cái
              hoặc nhập <code>a</code> để cài tất cả.
            </p>
            {origin && (
              <div className="mt-3 flex flex-col gap-2">
                <ApiKeySelect id="guide-api-key" {...apiKeyProps} />
                <AgentTargetSelect id="guide-target" {...targetProps} />
                <CopyLine value={installCommand(origin, "--list", installOpts)} label="lệnh xem danh sách" wrap />
                <CopyLine value={installCommand(origin, "--all", installOpts)} label="lệnh cài tất cả" wrap />
                <CopyLine value={installCommand(origin, "<slug> <slug>", installOpts)} label="lệnh cài một số skill" wrap />
                <CopyLine value={installCommand(origin, "--uninstall <slug> <slug>")} label="lệnh gỡ cài" wrap />
              </div>
            )}
            <p className="mt-2 text-sm leading-6 text-text-muted">
              <strong className="text-text-main">Cập nhật</strong>: chạy lại đúng lệnh cài ở trên.{" "}
              <strong className="text-text-main">Gỡ cài</strong> không cần key hay địa chỉ máy chủ — chỉ
              xoá file đã ghi trên máy này.
            </p>
            <div className="mt-4 border-t border-border pt-4">
              <Eyebrow>Cần tool, không chỉ tài liệu?</Eyebrow>
              <p className="mt-2 text-sm leading-6 text-text-muted">
                Một số skill là <strong className="text-text-main">hướng dẫn</strong>: chúng mô tả quy
                trình và gọi tool sống trong một engine (MCP server) riêng. Không có engine thì skill
                vẫn mở được nhưng tới bước gọi tool là dừng. Thêm <code>--engine</code> vào lệnh cài để
                cài luôn mọi engine mà tài khoản của bạn có skill đi kèm.
              </p>
              {bundles.length === 0 ? (
                <p className="mt-2 text-sm leading-6 text-text-muted">
                  Hiện chưa có skill nào của bạn cần engine riêng.
                </p>
              ) : (
                <p className="mt-2 text-sm leading-6 text-text-muted">
                  Bạn có {bundles.length} bundle đi kèm engine — xem mô tả, hướng dẫn dùng và lệnh cài
                  riêng của từng bundle ở tab{" "}
                  <button type="button" onClick={() => setTab("catalogue")} className="underline">
                    Danh sách
                  </button>.
                </p>
              )}
              <p className="mt-2 text-sm leading-6 text-text-muted">
                Engine cần <strong className="text-text-main">Node &gt;= 22.5</strong> (dùng{" "}
                <code>node:sqlite</code>) và được đăng ký tự động cho Claude Code, Codex, OpenCode.{" "}
                <strong className="text-text-main">omp</strong> không có MCP client
                nên installer cài một bridge extension thay thế. <strong className="text-text-main">dsh</strong>{" "}
                tự quản engine riêng nên được bỏ qua. Mỗi engine nằm riêng ở{" "}
                <code>~/.engines/&lt;tên-bundle&gt;</code>; <code>--engine-update</code> để làm mới.
                Cài engine xong thì installer riêng của bundle (nếu có) sẽ tự chạy cho mọi agent đã
                chọn để thêm agent preset và lệnh orchestrating của bundle đó.
              </p>
            </div>
            <p className="mt-3 text-sm leading-6 text-text-muted">
              Mỗi skill được cài vào mọi agent mà nó hỗ trợ và máy bạn đang có (Claude Code, Codex,
              OpenCode, omp, dsh); máy chưa có agent nào thì cài cho agent đầu tiên.
              Cài cho nhiều agent thì skill được ghi một bản ở <code>~/.agents/skills</code> rồi liên
              kết sang từng agent, cập nhật một chỗ là đủ — thêm <code>--copy</code> nếu muốn chép riêng.
              Thêm <code>--target claude,omp,dsh</code> để chỉ định agent, hoặc{" "}
              <code>--dir &lt;đường dẫn&gt;</code> để chọn thư mục. Sau khi cài, mở lại phiên agent.
            </p>
          </Panel>

          <Panel className="p-6">
            <Eyebrow>Cài thủ công</Eyebrow>
            <ol className="mt-3 flex flex-col">
              <Step index="1" title="Tải file markdown">
                <p className="text-sm leading-6 text-text-muted">
                  Ở tab &quot;Danh sách&quot;, bấm <strong className="text-text-main">Tải SKILL.md</strong>.
                  Trình duyệt lưu file về máy — đó chính là skill, không có gì khác cần cài.
                  Muốn cài nhiều skill một lúc, dùng lệnh ở mục &quot;Cách nhanh&quot; thay vì làm thủ công từng cái.
                </p>
              </Step>

              <Step index="2" title="Tạo thư mục đúng tên skill">
                <p className="text-sm leading-6 text-text-muted">
                  Tên thư mục phải trùng slug của skill. Ví dụ skill <code>rt-recon-pipeline</code>:
                </p>
                <CopyLine value="mkdir -p ~/.claude/skills/rt-recon-pipeline" label="lệnh tạo thư mục" />
              </Step>

              <Step index="3" title="Đổi tên file thành SKILL.md và chép vào thư mục">
                <CopyLine
                  value="mv ~/Downloads/SKILL.md ~/.claude/skills/rt-recon-pipeline/SKILL.md"
                  label="lệnh chép file"
                />
                <p className="text-sm leading-6 text-text-muted">
                  Mỗi agent đọc skill ở một thư mục riêng: Codex dùng{" "}
                  <code>~/.codex/skills/&lt;slug&gt;/SKILL.md</code>, OpenCode dùng{" "}
                  <code>~/.config/opencode/skills/&lt;slug&gt;/SKILL.md</code>, omp dùng{" "}
                  <code>~/.omp/agent/skills/&lt;slug&gt;/SKILL.md</code>, dsh dùng{" "}
                  <code>~/.dsh/skills/&lt;slug&gt;/SKILL.md</code>. Ở tab &quot;Danh sách&quot; mỗi skill
                  có ô chọn agent để hiện đúng đường dẫn. Mỗi skill là một thư mục, mỗi thư mục đúng
                  một <code>SKILL.md</code>.
                </p>
              </Step>

              <Step index="4" title="Mở lại phiên agent">
                <p className="text-sm leading-6 text-text-muted">
                  Skill chỉ được nạp lúc phiên khởi động. Thoát hẳn agent (Claude Code, Codex,
                  OpenCode, omp, dsh) rồi mở lại — không cần khởi động lại máy.
                </p>
              </Step>

              <Step index="5" title="Gọi skill trong phiên">
                <p className="text-sm leading-6 text-text-muted">
                  Trong Claude Code, gõ <code>/</code> rồi tên skill, hoặc nói thẳng tên skill
                  trong câu lệnh:
                </p>
                <CopyLine value="Dùng skill rt-recon-pipeline cho example.com" label="câu lệnh mẫu" />
              </Step>
            </ol>
          </Panel>

          <div className="flex flex-col gap-4">
            <Panel className="p-5">
              <Eyebrow>Kiểm tra đã cài đúng</Eyebrow>
              <p className="mt-2 text-sm leading-6 text-text-muted">
                Trong Claude Code gõ <code>/help</code> hoặc mở danh sách skill — skill vừa cài
                phải xuất hiện trong đó. Không thấy thì kiểm tra lại ba điểm: đúng thư mục,
                đúng tên <code>SKILL.md</code>, đã mở lại phiên.
              </p>
              <div className="mt-3">
                <CopyLine value="ls ~/.claude/skills/" label="lệnh liệt kê skill đã cài" />
              </div>
            </Panel>

            <Panel className="p-5">
              <Eyebrow>Quy tắc chung</Eyebrow>
              <ul className="mt-2 flex flex-col gap-2 text-sm leading-6 text-text-muted">
                <li>Mỗi skill là một thư mục riêng, không gộp nhiều skill vào một file.</li>
                <li>Phần đầu file (<code>---</code> … <code>---</code>) phải giữ nguyên: đó là phần agent đọc để biết khi nào dùng skill.</li>
                <li>Cập nhật skill = tải bản mới rồi ghi đè <code>SKILL.md</code> cũ, hoặc chạy lại đúng lệnh cài.</li>
                <li>
                  Xoá skill = xoá cả thư mục của nó, hoặc dùng lệnh{" "}
                  <code>--uninstall &lt;slug&gt;</code> ở mục &quot;Cách nhanh&quot; phía trên — tự tìm và gỡ
                  đúng chỗ, không cần key hay máy chủ.
                </li>
              </ul>
            </Panel>

            <Panel className="p-5">
              <Eyebrow>Cần trợ giúp</Eyebrow>
              <p className="mt-2 text-sm leading-6 text-text-muted">
                Skill không hiện sau khi mở lại phiên, hoặc file tải về không đúng định dạng?
                Gửi đường dẫn thư mục bạn đã tạo và ảnh chụp danh sách skill cho quản trị viên.
              </p>
            </Panel>
          </div>
        </section>
      )}

      <Modal
        isOpen={Boolean(detail)}
        onClose={() => setDetail(null)}
        title={detail ? `${detail.fileName} · ${detail.slug}` : ""}
        size="full"
        footer={
          detail ? (
            <>
              <span className="mr-auto font-mono text-[11px] text-text-subtle">
                cập nhật {fmtDate(detail.updatedAt)}
              </span>
              <a
                href={`/api/account/skills/${detail.slug}/download`}
                className={buttonClass({ tone: "solid", size: "sm" })}
                download
              >
                <span className="material-symbols-outlined text-[16px]" aria-hidden="true">download</span>
                Tải về
              </a>
            </>
          ) : null
        }
      >
        <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-text-main">
          {detail?.body}
        </pre>
      </Modal>

      {opening && (
        <p className="sr-only" role="status">Đang mở {opening}</p>
      )}
    </div>
  );
}
