"use client";

import { useCallback, useEffect, useState } from "react";
import { ActionButton, Empty, Panel, Section, Tag } from "@/app/account/components/ui";
import { categoryLabel, formatDateTime } from "../../components/format";

/** Output violations get the danger tone; input categories are informational. */
function toneFor(category) {
  if (String(category).startsWith("output_")) return "danger";
  if (category === "guard_unavailable") return "warning";
  return "neutral";
}

/**
 * "Câu hỏi bị chặn" tab (spec business-guard "Guard event log"): the bot's latest
 * 100 guard events, newest first — the time, the category LABEL and the question
 * excerpt, so a business can see what its customers ask and tune the domain
 * description.
 */
export default function GuardEventsTab({ botId }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/account/biz/bots/${botId}/guard-events`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Không tải được câu hỏi bị chặn");
      setEvents(Array.isArray(data.events) ? data.events : []);
    } catch (e) {
      setError(e.message || "Không tải được câu hỏi bị chặn");
    } finally {
      setLoading(false);
    }
  }, [botId]);

  useEffect(() => { load(); }, [load]);

  return (
    <Section
      title="Câu hỏi bị chặn"
      description="100 câu gần nhất bị chặn hoặc bị thay câu trả lời. Xem để điều chỉnh mô tả lĩnh vực hoặc bổ sung tài liệu."
    >
      {loading ? (
        <div className="grid grid-cols-1 gap-2" aria-hidden="true">
          {[0, 1, 2].map((i) => <div key={i} className="h-14 border border-border bg-surface-2" />)}
        </div>
      ) : error ? (
        <Panel className="flex flex-col items-start gap-3 p-6">
          <p role="alert" className="flex items-center gap-2 text-sm text-danger">
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">error</span>
            {error}
          </p>
          <ActionButton onClick={load}>Thử lại</ActionButton>
        </Panel>
      ) : events.length === 0 ? (
        <Empty
          icon="shield"
          title="Chưa có câu hỏi nào bị chặn"
          body="Khi bot từ chối một câu hỏi hoặc thay một câu trả lời không đạt, sự kiện sẽ hiện ở đây."
        />
      ) : (
        <ul className="flex flex-col border border-border">
          {events.map((event, index) => (
            <li
              key={event.id}
              className={`flex flex-col gap-1.5 bg-surface px-5 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4 ${
                index > 0 ? "border-t border-border" : ""
              }`}
            >
              <div className="flex min-w-0 flex-col gap-1">
                <Tag tone={toneFor(event.category)}>{categoryLabel(event.category)}</Tag>
                <p className="text-sm text-text-main [overflow-wrap:anywhere]">{event.excerpt || "(không có nội dung)"}</p>
              </div>
              <span className="shrink-0 font-mono text-[11px] text-text-muted">{formatDateTime(event.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
