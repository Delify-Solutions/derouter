"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { ActionButton, Heading, Panel, Tag } from "@/app/account/components/ui";
import SettingsTab from "./SettingsTab";
import DocumentsTab from "./DocumentsTab";
import KeysTab from "./KeysTab";
import GuardEventsTab from "./GuardEventsTab";
import PlaygroundTab from "./PlaygroundTab";

// Order follows the work: define the bot, feed it, hand out keys, review what was
// blocked, then try it (spec business-bots "Customer portal business area").
const TABS = [
  { id: "settings", label: "Cài đặt" },
  { id: "documents", label: "Tài liệu" },
  { id: "keys", label: "Key API" },
  { id: "events", label: "Câu hỏi bị chặn" },
  { id: "playground", label: "Chat thử" },
];

export default function BotDetailClient({ publicBaseUrl = "" }) {
  // `params` is a Promise in Next 16; `useParams()` hands the resolved values to a
  // client component.
  const params = useParams();
  const botId = Array.isArray(params?.id) ? params.id[0] : params?.id;

  const [bot, setBot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("settings");

  const load = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`/api/account/biz/bots/${botId}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Không tải được bot");
      setBot(data.bot);
    } catch (e) {
      setError(e.message || "Không tải được bot");
    } finally {
      setLoading(false);
    }
  }, [botId]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="flex flex-col gap-4" aria-hidden="true">
        <div className="h-10 w-64 border border-border bg-surface-2" />
        <div className="h-40 border border-border bg-surface-2" />
      </div>
    );
  }

  if (error || !bot) {
    return (
      <Panel className="flex flex-col items-start gap-3 p-6">
        <p role="alert" className="flex items-center gap-2 text-sm text-danger">
          <span className="material-symbols-outlined text-[18px]" aria-hidden="true">error</span>
          {error || "Không tìm thấy bot"}
        </p>
        <ActionButton onClick={load}>Thử lại</ActionButton>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Heading>{bot.name}</Heading>
          <p className="text-sm text-text-muted">
            {bot.companyName} · model <span className="font-mono">{bot.modelId}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Tag tone={bot.isActive ? "success" : "neutral"} icon={bot.isActive ? "check_circle" : "pause_circle"}>
            {bot.isActive ? "Đang bật" : "Đang tắt"}
          </Tag>
          <Tag>{bot.mode === "flexible" ? "Linh hoạt" : "Nghiêm ngặt"}</Tag>
        </div>
      </header>

      <div role="tablist" aria-label="Khu vực của bot" className="flex flex-wrap gap-px border border-border bg-border">
        {TABS.map((item) => {
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`bot-tab-${item.id}`}
              aria-selected={active}
              aria-controls={`bot-panel-${item.id}`}
              tabIndex={active ? 0 : -1}
              onClick={() => setTab(item.id)}
              onKeyDown={(event) => {
                // Arrow keys move between tabs, as the ARIA tab pattern expects.
                const index = TABS.findIndex((entry) => entry.id === tab);
                if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
                event.preventDefault();
                const next = event.key === "ArrowRight"
                  ? TABS[(index + 1) % TABS.length]
                  : TABS[(index - 1 + TABS.length) % TABS.length];
                setTab(next.id);
                document.getElementById(`bot-tab-${next.id}`)?.focus();
              }}
              className={`h-10 flex-1 px-4 font-mono text-[13px] transition-colors duration-150 ${
                active ? "bg-surface text-text-main" : "bg-surface-2 text-text-muted hover:text-text-main"
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" id={`bot-panel-${tab}`} aria-labelledby={`bot-tab-${tab}`}>
        {tab === "settings" ? <SettingsTab bot={bot} onSaved={setBot} /> : null}
        {tab === "documents" ? <DocumentsTab botId={bot.id} /> : null}
        {tab === "keys" ? <KeysTab bot={bot} publicBaseUrl={publicBaseUrl} /> : null}
        {tab === "events" ? <GuardEventsTab botId={bot.id} /> : null}
        {tab === "playground" ? <PlaygroundTab bot={bot} /> : null}
      </div>
    </div>
  );
}
