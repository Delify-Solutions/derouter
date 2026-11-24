"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Heading, Eyebrow, Panel, Tag, buttonClass } from "../components/ui";
import { cn } from "@/shared/utils/cn";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { renderBundleMarkdown } from "../skills/renderBundleMarkdown";

const noopSubscribe = () => () => {};

function useOrigin() {
  return useSyncExternalStore(
    noopSubscribe,
    () => window.location.origin,
    () => "",
  );
}

/**
 * The command a customer runs to add a plugin to their harness.
 *
 * A DSH plugin is an npm package, not a file to download, so there is nothing for
 * this page to stream: the customer adds it to their own profile and their package
 * manager resolves it. `--profile` is explicit because a machine can hold several
 * profiles (tui, web, desktop) and adding the plugin to the wrong one looks
 * identical to the install failing.
 */
function pluginCommand(plugin, profile) {
  const pkg = plugin.packageName;
  return `dsh plugin --profile ${profile || "<profile>"} add ${pkg}`;
}

/** A copyable line: a monospace value and a square copy button. */
function CopyLine({ value, label, wrap = false }) {
  const { copied, copy } = useCopyToClipboard(2000);
  return (
    <div className="flex min-w-0 items-stretch border border-border bg-surface-2">
      <code
        className={cn(
          "min-w-0 flex-1 px-3 py-2 font-mono text-[12px] leading-5 text-text-main",
          wrap ? "break-all whitespace-pre-wrap" : "truncate",
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

/** One numbered step in a guide. */
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

function fmtDate(value) {
  const ms = Date.parse(value || "");
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleDateString("vi-VN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function PluginCard({ plugin, onOpen }) {
  return (
    <li className="flex flex-col gap-4 border border-border bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-mono text-sm font-semibold text-text-main">{plugin.name}</h3>
            {plugin.version && <Tag tone="neutral">v{plugin.version}</Tag>}
            {plugin.dshTarget && <Tag tone="neutral">DSH {plugin.dshTarget}</Tag>}
            {plugin.installCount > 0 && (
              <span className="font-mono text-[11px] text-text-subtle">{plugin.installCount} lượt cài</span>
            )}
          </div>
          {plugin.description && (
            <p className="mt-1 text-sm leading-6 text-text-muted">{plugin.description}</p>
          )}
        </div>
        <button
          type="button"
          onClick={() => onOpen(plugin)}
          className={buttonClass({ tone: "outline", size: "sm" })}
        >
          <span className="material-symbols-outlined text-[16px]" aria-hidden="true">menu_book</span>
          Hướng dẫn
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        <Eyebrow>Package</Eyebrow>
        <CopyLine value={plugin.packageName} label="tên package" />
      </div>

      {(plugin.repoUrl || plugin.docsUrl) && (
        <div className="flex flex-wrap gap-3 text-xs">
          {plugin.repoUrl && (
            <a href={plugin.repoUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-text-muted hover:text-text-main">
              <span className="material-symbols-outlined text-[14px]" aria-hidden="true">code</span>
              Mã nguồn
            </a>
          )}
          {plugin.docsUrl && (
            <a href={plugin.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-text-muted hover:text-text-main">
              <span className="material-symbols-outlined text-[14px]" aria-hidden="true">description</span>
              Tài liệu
            </a>
          )}
        </div>
      )}
    </li>
  );
}

/** A plugin's full detail, in a modal: guide, install command, source links. */
function PluginDetailModal({ plugin, onClose }) {
  const [profile, setProfile] = useState("desktop");
  const guideHtml = useMemo(() => (plugin ? renderBundleMarkdown(plugin.usageGuide) : ""), [plugin]);
  const descHtml = useMemo(() => (plugin ? renderBundleMarkdown(plugin.description) : ""), [plugin]);

  useEffect(() => {
    if (!plugin) return undefined;
    const onKey = (event) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [plugin, onClose]);

  if (!plugin) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Hướng dẫn ${plugin.name}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-3xl flex-col border border-border bg-surface"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-3">
          <div className="min-w-0">
            <p className="truncate font-mono text-sm font-semibold text-text-main">{plugin.name}</p>
            <p className="font-mono text-[11px] text-text-subtle">
              {plugin.packageName}
              {plugin.version ? ` · v${plugin.version}` : ""}
              {plugin.dshTarget ? ` · DSH ${plugin.dshTarget}` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng"
            className="flex size-8 shrink-0 items-center justify-center border border-border text-text-muted hover:bg-surface-2 hover:text-text-main"
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">close</span>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="flex flex-col gap-5">
            {descHtml && (
              <div className="docs-body text-sm text-text-main" dangerouslySetInnerHTML={{ __html: descHtml }} />
            )}

            <div className="flex flex-col gap-2 border-t border-border pt-4">
              <Eyebrow>Cài đặt</Eyebrow>
              <label className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-text-muted">Profile DSH</span>
                <select
                  value={profile}
                  onChange={(event) => setProfile(event.target.value)}
                  className="h-8 border border-border bg-surface px-2 font-mono text-sm text-text-main focus:border-text-main focus:outline-none"
                >
                  <option value="desktop">desktop</option>
                  <option value="web">web</option>
                  <option value="tui">tui</option>
                </select>
              </label>
              <CopyLine value={pluginCommand(plugin, profile)} label="lệnh cài plugin" wrap />
              <p className="text-xs leading-5 text-text-muted">
                Thêm package vào profile rồi mở lại DSH. Plugin chạy trong harness nên cần
                đúng profile bạn đang dùng — cài vào profile khác thì mở lên sẽ không thấy gì.
              </p>
            </div>

            {guideHtml && (
              <div className="border-l-2 border-border pl-3">
                <Eyebrow>Hướng dẫn sử dụng</Eyebrow>
                <div className="docs-body mt-1 text-sm text-text-main" dangerouslySetInnerHTML={{ __html: guideHtml }} />
              </div>
            )}

            {(plugin.repoUrl || plugin.docsUrl) && (
              <div className="flex flex-wrap gap-3 border-t border-border pt-3 text-xs">
                {plugin.repoUrl && (
                  <a href={plugin.repoUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-text-muted hover:text-text-main">
                    <span className="material-symbols-outlined text-[14px]" aria-hidden="true">code</span>
                    {plugin.repoUrl.replace(/^https?:\/\//, "")}
                  </a>
                )}
                {plugin.docsUrl && (
                  <a href={plugin.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-text-muted hover:text-text-main">
                    <span className="material-symbols-outlined text-[14px]" aria-hidden="true">description</span>
                    Tài liệu
                  </a>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * `/account/plugins` — DSH plugins the operator publishes.
 *
 * Two tabs: the catalogue, and a guide that explains what a plugin is and how it
 * differs from a skill. The distinction matters: a customer who expects a file to
 * download will look for a download button that is not here, because a plugin is an
 * npm package added to the harness profile.
 */
export default function PluginsPageClient() {
  const [tab, setTab] = useState("catalogue");
  const [plugins, setPlugins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState(null);
  const origin = useOrigin();

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/account/dsh-plugins", { cache: "no-store" });
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

  const openDetail = (plugin) => {
    setDetail(plugin);
    // Count the open, best-effort: analytics must never block the panel.
    fetch("/api/account/dsh-plugins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: plugin.slug }),
    }).catch(() => {});
  };

  const tabs = [
    { id: "catalogue", label: "Danh sách", count: plugins.length },
    { id: "guide", label: "Plugin là gì" },
  ];

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Heading>Plugin DSH</Heading>
        <p className="max-w-2xl text-sm leading-6 text-text-muted">
          Plugin cài thẳng vào DeepSeek Harness trên máy bạn — khác với skill (skill là
          tài liệu agent đọc, plugin là code harness nạp). Cài bằng một lệnh, không có file
          để tải về.
        </p>
      </div>

      <div role="tablist" aria-label="Plugin DSH" className="flex border-b border-border">
        {tabs.map((item) => {
          const selected = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`plugins-panel-${item.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setTab(item.id)}
              className={cn(
                "-mb-px flex h-11 items-center gap-2 border-b-2 px-4 font-mono text-[13px] font-medium transition-colors duration-150",
                selected ? "border-text-main text-text-main" : "border-transparent text-text-muted hover:text-text-main",
              )}
            >
              {item.label}
              {item.count !== undefined && (
                <span className="border border-border px-1.5 font-mono text-[11px] text-text-muted">{item.count}</span>
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
        <section id="plugins-panel-catalogue" role="tabpanel" aria-label="Danh sách plugin">
          {loading ? (
            <p className="border border-dashed border-border px-6 py-12 text-center text-sm text-text-muted">Đang tải…</p>
          ) : plugins.length === 0 ? (
            <p className="border border-dashed border-border px-6 py-12 text-center text-sm text-text-muted">
              Chưa có plugin nào được phát hành. Quay lại sau nhé.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {plugins.map((plugin) => (
                <PluginCard key={plugin.id} plugin={plugin} onOpen={openDetail} />
              ))}
            </ul>
          )}
        </section>
      ) : (
        <section
          id="plugins-panel-guide"
          role="tabpanel"
          aria-label="Plugin là gì"
          className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,320px)]"
        >
          <Panel className="p-6">
            <ol className="flex flex-col">
              <Step index="1" title="Plugin không phải skill">
                <p className="text-sm leading-6 text-text-muted">
                  Skill là file markdown agent đọc khi cần. Plugin là package code harness
                  nạp lúc khởi động — nó thêm tool, panel, hoặc đổi cách harness xử lý.
                  Cài plugin khác hoàn toàn cài skill.
                </p>
              </Step>

              <Step index="2" title="Kiểm tra DSH và Node trước">
                <CopyLine value="dsh --version && node -v" label="kiểm tra phiên bản" />
                <p className="text-sm leading-6 text-text-muted">
                  Mỗi plugin ghi rõ nó nhắm DSH bản nào. Lệch phiên bản thì plugin có thể
                  không mount được — xem nhãn <code>DSH …</code> trên thẻ plugin.
                </p>
              </Step>

              <Step index="3" title="Chọn đúng profile">
                <p className="text-sm leading-6 text-text-muted">
                  Một máy có thể có nhiều profile (<code>desktop</code>, <code>web</code>,
                  <code>tui</code>). Plugin cài vào profile nào thì chỉ profile đó thấy.
                  Xem bạn đang chạy profile nào rồi chọn đúng.
                </p>
              </Step>

              <Step index="4" title="Cài bằng một lệnh">
                <p className="text-sm leading-6 text-text-muted">
                  Mở hướng dẫn của plugin, chọn profile, sao chép lệnh. Dạng lệnh:
                </p>
                <CopyLine value="dsh plugin --profile <profile> add <package>" label="mẫu lệnh" />
              </Step>

              <Step index="5" title="Mở lại DSH">
                <p className="text-sm leading-6 text-text-muted">
                  Plugin chỉ được nạp lúc khởi động. Thoát hẳn rồi mở lại — không cần
                  khởi động lại máy.
                </p>
              </Step>

              <Step index="6" title="Gỡ khi không dùng">
                <CopyLine value="dsh plugin --profile <profile> remove <package>" label="lệnh gỡ" />
              </Step>
            </ol>
          </Panel>

          <div className="flex flex-col gap-4">
            <Panel className="p-5">
              <Eyebrow>Kiểm tra đã cài</Eyebrow>
              <p className="mt-2 text-sm leading-6 text-text-muted">
                Mở DSH, xem danh sách plugin trong profile. Không thấy thì kiểm tra ba điểm:
                đúng profile, đúng tên package, đã mở lại DSH.
              </p>
              <div className="mt-3">
                <CopyLine value="dsh plugin --profile <profile> list" label="lệnh liệt kê" />
              </div>
            </Panel>

            <Panel className="p-5">
              <Eyebrow>Lưu ý</Eyebrow>
              <ul className="mt-2 flex flex-col gap-2 text-sm leading-6 text-text-muted">
                <li>Plugin chạy trong harness — chỉ cài từ nguồn bạn tin.</li>
                <li>Đọc mã nguồn trước nếu có link repo; trang này luôn hiện link đó.</li>
                <li>Gỡ plugin = gỡ package khỏi profile, không ảnh hưởng skill đã cài.</li>
              </ul>
            </Panel>

            <Panel className="p-5">
              <Eyebrow>Cần trợ giúp</Eyebrow>
              <p className="mt-2 text-sm leading-6 text-text-muted">
                Plugin không hiện sau khi mở lại, hoặc báo lỗi mount? Gửi tên plugin, bản
                DSH của bạn và thông báo lỗi cho quản trị viên.
              </p>
              {origin && (
                <p className="mt-2 font-mono text-[11px] text-text-subtle">{origin}/account/plugins</p>
              )}
            </Panel>
          </div>
        </section>
      )}

      {detail && (
        <PluginDetailModal
          plugin={detail}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  );
}
