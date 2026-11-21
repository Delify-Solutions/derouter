"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Heading, Eyebrow, Panel, Tag, buttonClass } from "../components/ui";
import { Modal } from "@/shared/components";
import { cn } from "@/shared/utils/cn";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

const TARGET_LABELS = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  generic: "Khác",
};

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

/** The install line for a skill, derived from the row when the admin left it blank. */
function installLine(skill) {
  if (skill.installPath) return skill.installPath;
  if (skill.target === "claude") return `~/.claude/skills/${skill.slug}/`;
  if (skill.target === "codex") return `~/.codex/skills/${skill.slug}/`;
  if (skill.target === "cursor") return `~/.cursor/skills/${skill.slug}/`;
  return `skills/${skill.slug}/`;
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

function SkillCard({ skill, onOpen, origin }) {
  return (
    <li className="flex flex-col gap-4 border border-border bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-mono text-sm font-semibold text-text-main">{skill.name}</h3>
            <Tag tone="neutral">{TARGET_LABELS[skill.target] || skill.target}</Tag>
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

      <div className="flex flex-col gap-1.5">
        <Eyebrow>Đặt file vào</Eyebrow>
        <CopyLine value={installLine(skill)} label="đường dẫn cài đặt" />
      </div>

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

  const visible = useMemo(
    () => (category ? skills.filter((s) => s.category === category) : skills),
    [skills, category]
  );

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
          Skill markdown cài vào agent của bạn (Claude Code, Codex, Cursor…) để agent biết
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
            </Panel>
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
                <SkillCard key={skill.id} skill={skill} onOpen={openDetail} origin={origin} />
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
              Key được đọc từ biến môi trường <code>DEROUTER_KEY</code>, không lưu vào máy.
            </p>
            {origin && (
              <div className="mt-3 flex flex-col gap-2">
                <CopyLine value={installCommand(origin, "--list")} label="lệnh xem danh sách" wrap />
                <CopyLine value={installCommand(origin, "--all")} label="lệnh cài tất cả" wrap />
                <CopyLine value={installCommand(origin, "<slug> <slug>")} label="lệnh cài một số skill" wrap />
              </div>
            )}
            <p className="mt-3 text-sm leading-6 text-text-muted">
              Mặc định mỗi skill vào thư mục của runtime nó dành cho. Thêm{" "}
              <code>--target codex</code> hoặc <code>--target cursor</code> để cài sang runtime khác, hoặc{" "}
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
                  Với Codex dùng <code>~/.codex/skills/&lt;slug&gt;/SKILL.md</code>; Cursor dùng{" "}
                  <code>~/.cursor/skills/&lt;slug&gt;/SKILL.md</code>. Mỗi skill là một thư mục,
                  mỗi thư mục đúng một <code>SKILL.md</code>.
                </p>
              </Step>

              <Step index="4" title="Mở lại phiên agent">
                <p className="text-sm leading-6 text-text-muted">
                  Skill chỉ được nạp lúc phiên khởi động. Thoát hẳn Claude Code (hoặc Codex,
                  Cursor) rồi mở lại — không cần khởi động lại máy.
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
