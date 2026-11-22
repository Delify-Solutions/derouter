"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Heading, Eyebrow, Panel, Tag, buttonClass } from "../components/ui";
import { Modal } from "@/shared/components";
import { runtimeInstallDir, runtimeLabel } from "@/lib/skills/runtimes.js";
import { cn } from "@/shared/utils/cn";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

const noopSubscribe = () => () => {};

/** This page's own origin, "" during server render so the markup matches on hydration. */
function useOrigin() {
  return useSyncExternalStore(
    noopSubscribe,
    () => window.location.origin,
    () => ""
  );
}

/** The one-line installer for these arguments; the key stays a placeholder the customer fills in. */
function installCommand(origin, args) {
  return `curl -fsSL ${origin}/api/public/skills/install.sh | DEROUTER_KEY=<API_KEY> sh -s -- ${args}`;
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

function SkillCard({ skill, onOpen, origin, checked, onToggle }) {
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

      <InstallPath skill={skill} />

      {origin && (
        <div className="flex flex-col gap-1.5">
          <Eyebrow>Cài nhanh bằng một lệnh</Eyebrow>
          <CopyLine value={installCommand(origin, skill.slug)} label="lệnh cài nhanh" wrap />
        </div>
      )}

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
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [category, setCategory] = useState("");
  const [opening, setOpening] = useState(null);
  const [detail, setDetail] = useState(null);
  const [picked, setPicked] = useState(() => new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/account/skills", { cache: "no-store" });
      if (!res.ok) throw new Error("fetch failed");
      const data = await res.json();
      setSkills(data.skills || []);
      setCategories(data.categories || []);
    } catch {
      setError("Không tải được danh sách skill. Tải lại trang để thử lại.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const togglePicked = (slug) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });

  const visible = useMemo(
    () => (category ? skills.filter((s) => s.category === category) : skills),
    [skills, category]
  );

  // What the zip and the one-line command act on: picked skills that still exist.
  const pickedSlugs = skills.filter((skill) => picked.has(skill.slug)).map((skill) => skill.slug);
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
    { id: "catalogue", label: "Danh sách", count: skills.length },
    { id: "guide", label: "Hướng dẫn cài", count: null },
  ];

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Heading>Skill</Heading>
        <p className="max-w-2xl text-sm leading-6 text-text-muted">
          Skill markdown cài vào agent của bạn (Claude Code, Codex, Cursor, omp, dsh…) để agent biết
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
              <CopyLine value={installCommand(origin, "--all")} label="lệnh cài tất cả skill" wrap />
              {pickedSlugs.length > 0 && (
                <>
                  <p className="text-sm leading-6 text-text-muted">Chỉ {pickedSlugs.length} skill bạn đã chọn:</p>
                  <CopyLine value={installCommand(origin, pickedSlugs.join(" "))} label="lệnh cài các skill đã chọn" wrap />
                </>
              )}
            </Panel>
          )}

          {skills.length > 0 && (
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

          {categories.length > 0 && (
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
              {categories.map((c) => (
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
          ) : visible.length === 0 ? (
            <p className="border border-dashed border-border px-6 py-12 text-center text-sm text-text-muted">
              {skills.length === 0
                ? "Chưa có skill nào được phát hành. Quay lại sau nhé."
                : "Nhóm này chưa có skill."}
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {visible.map((skill) => (
                <SkillCard key={skill.id} skill={skill} onOpen={openDetail} origin={origin} checked={picked.has(skill.slug)} onToggle={togglePicked} />
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
                <CopyLine value={installCommand(origin, "--list")} label="lệnh xem danh sách" wrap />
                <CopyLine value={installCommand(origin, "--all")} label="lệnh cài tất cả" wrap />
                <CopyLine value={installCommand(origin, "<slug> <slug>")} label="lệnh cài một số skill" wrap />
              </div>
            )}
            <div className="mt-4 border-t border-border pt-4">
              <Eyebrow>Cần tool, không chỉ tài liệu?</Eyebrow>
              <p className="mt-2 text-sm leading-6 text-text-muted">
                Skill là <strong className="text-text-main">hướng dẫn</strong>: nó mô tả quy trình và gọi
                các tool như <code>redteam_asset_add</code>. Những tool đó nằm trong engine (MCP server,
                67 tool) — không có engine thì skill vẫn mở được nhưng tới bước gọi tool là dừng. Thêm{" "}
                <code>--engine</code> để cài luôn engine:
              </p>
              {origin && (
                <div className="mt-2 flex flex-col gap-2">
                  <CopyLine value={installCommand(origin, "--all --engine")} label="lệnh cài skill + engine" wrap />
                  <CopyLine value={installCommand(origin, "--engine-only")} label="lệnh chỉ cài engine" wrap />
                </div>
              )}
              <p className="mt-2 text-sm leading-6 text-text-muted">
                Engine cần <strong className="text-text-main">Node &gt;= 22.5</strong> (dùng{" "}
                <code>node:sqlite</code>) và được đăng ký tự động cho Claude Code, Codex, Cursor,
                Windsurf, Amp, Cline. <strong className="text-text-main">omp</strong> không có MCP client
                nên installer cài một bridge extension thay thế. <strong className="text-text-main">dsh</strong>{" "}
                tự quản engine riêng nên được bỏ qua. Engine nằm ở <code>~/rt-claude</code>;{" "}
                <code>--engine-update</code> để làm mới.
              </p>
            </div>
            <p className="mt-3 text-sm leading-6 text-text-muted">
              Mỗi skill được cài vào mọi agent mà nó hỗ trợ và máy bạn đang có (Claude Code, Codex,
              Cursor, omp, dsh và nhiều agent khác); máy chưa có agent nào thì cài cho agent đầu tiên.
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
                  <code>~/.codex/skills/&lt;slug&gt;/SKILL.md</code>, Cursor dùng{" "}
                  <code>~/.cursor/skills/&lt;slug&gt;/SKILL.md</code>, omp dùng{" "}
                  <code>~/.omp/agent/skills/&lt;slug&gt;/SKILL.md</code>, dsh dùng{" "}
                  <code>~/.dsh/skills/&lt;slug&gt;/SKILL.md</code>. Ở tab &quot;Danh sách&quot; mỗi skill
                  có ô chọn agent để hiện đúng đường dẫn. Mỗi skill là một thư mục, mỗi thư mục đúng
                  một <code>SKILL.md</code>.
                </p>
              </Step>

              <Step index="4" title="Mở lại phiên agent">
                <p className="text-sm leading-6 text-text-muted">
                  Skill chỉ được nạp lúc phiên khởi động. Thoát hẳn agent (Claude Code, Codex,
                  Cursor, omp, dsh…) rồi mở lại — không cần khởi động lại máy.
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
                <li>Cập nhật skill = tải bản mới rồi ghi đè <code>SKILL.md</code> cũ.</li>
                <li>Xoá skill = xoá cả thư mục của nó.</li>
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
