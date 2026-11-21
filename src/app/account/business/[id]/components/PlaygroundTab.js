"use client";

import { useState } from "react";
import { ActionButton, Panel, Section, Tag, fieldClass } from "@/app/account/components/ui";
import { categoryLabel } from "../../components/format";

/**
 * "Chat thử" tab (spec business-bots "Playground").
 *
 * The request goes to `/api/account/biz/bots/[id]/chat`, which calls the SAME
 * pipeline as the public API with the per-bot "Chat thử" key — so charges,
 * admission, rate limits and every guard rule apply exactly as they do for a real
 * client. A reply the guard produced is labelled with its category.
 */
export default function PlaygroundTab({ bot }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const send = async (event) => {
    event.preventDefault();
    const question = input.trim();
    if (!question || sending) return;
    const history = [...messages, { role: "user", content: question }];
    setMessages(history);
    setInput("");
    setSending(true);
    setError("");
    try {
      const res = await fetch(`/api/account/biz/bots/${bot.id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history.map((message) => ({ role: message.role, content: message.content })),
        }),
      });
      const category = res.headers.get("X-Guard-Category");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Platform errors carry the customer-facing Vietnamese message.
        setError(data?.error?.message || data?.error || "Không nhận được phản hồi");
        return;
      }
      const content = data?.choices?.[0]?.message?.content ?? "";
      setMessages((current) => [...current, { role: "assistant", content, category }]);
    } catch (e) {
      setError(e.message || "Không nhận được phản hồi");
    } finally {
      setSending(false);
    }
  };

  return (
    <Section
      title="Chat thử"
      description="Hội thoại đi qua đúng pipeline như API thật: bị chặn thì không tính phí, trả lời từ model thì tính phí như request thường."
    >
      <div className="flex flex-col gap-4">
        <Panel className="flex min-h-64 flex-col gap-3 p-5">
          {messages.length === 0 ? (
            <p className="text-sm text-text-muted">
              Đặt câu hỏi như một khách hàng. Thử cả câu ngoài phạm vi và câu về chủ quyền để xem bot xử lý thế nào.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {messages.map((message, index) => (
                <li
                  key={index}
                  className={`flex flex-col gap-1.5 border p-3 ${
                    message.role === "user" ? "border-border bg-surface-2" : "border-border bg-surface"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="meta text-text-muted">{message.role === "user" ? "Khách" : "Bot"}</span>
                    {message.category ? (
                      <Tag tone="warning" icon="shield">
                        {`Đã chặn: ${categoryLabel(message.category)}`}
                      </Tag>
                    ) : null}
                  </div>
                  <p className="whitespace-pre-wrap text-sm text-text-main [overflow-wrap:anywhere]">{message.content}</p>
                </li>
              ))}
              {sending ? (
                <li className="flex items-center gap-2 text-sm text-text-muted">
                  <span className="material-symbols-outlined animate-spin text-[16px]" aria-hidden="true">progress_activity</span>
                  Đang trả lời…
                </li>
              ) : null}
            </ul>
          )}
        </Panel>

        {error ? (
          <p role="alert" className="flex items-center gap-2 text-sm text-danger">
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">error</span>
            {error}
          </p>
        ) : null}

        <form onSubmit={send} className="flex flex-col gap-3">
          <label htmlFor="playground-input" className="meta text-text-muted">Câu hỏi</label>
          <textarea
            id="playground-input"
            className={`${fieldClass} h-24 py-2`}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Ví dụ: Giá sofa da là bao nhiêu?"
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter breaks the line: the same habit as a chat box.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send(event);
              }
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <ActionButton type="submit" tone="solid" loading={sending} disabled={sending || !input.trim()}>
              Gửi câu hỏi
            </ActionButton>
            {messages.length > 0 ? (
              <ActionButton type="button" onClick={() => { setMessages([]); setError(""); }} disabled={sending}>
                Bắt đầu lại
              </ActionButton>
            ) : null}
          </div>
        </form>
      </div>
    </Section>
  );
}
