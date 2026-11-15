"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Badge, Button, Card, CardSkeleton } from "@/shared/components";

// Admin inbox for the two-way support chat (spec telegram-support).
//
// The primary way to answer is Telegram itself: a customer's message is relayed to
// the admin chat and the admin replies to that message. This page exists for when
// the operator is at a computer, and to see history the chat has scrolled past.

const POLL_MS = 15000;
const MAX_LENGTH = 4096;
const DATE = new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short" });

export default function SupportInbox() {
  const [threads, setThreads] = useState(null);
  const [error, setError] = useState("");
  const [openUserId, setOpenUserId] = useState(null);
  const [messages, setMessages] = useState(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");

  const loadThreads = useCallback(async () => {
    try {
      const res = await fetch("/api/support/messages", { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "load");
      setThreads(Array.isArray(body.threads) ? body.threads : []);
      setError("");
    } catch {
      setError("Không tải được hộp thư hỗ trợ.");
      setThreads([]);
    }
  }, []);

  /**
   * Load one conversation. `markRead` is true only when the admin OPENED it: the
   * panel polls this same call, and marking on every poll would hide a message that
   * arrived while the thread sat open on an unattended screen.
   */
  const loadThread = useCallback(async (userId, { markRead = false } = {}) => {
    try {
      const query = `userId=${encodeURIComponent(userId)}${markRead ? "&markRead=1" : ""}`;
      const res = await fetch(`/api/support/messages?${query}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "load");
      setMessages(Array.isArray(body.messages) ? body.messages : []);
      if (markRead) {
        setThreads((current) => (current || []).map((t) => (t.userId === userId ? { ...t, unread: 0 } : t)));
      }
    } catch {
      setMessages([]);
    }
  }, []);

  useEffect(() => {
    loadThreads();
  }, [loadThreads]);

  useEffect(() => {
    if (!openUserId) return undefined;
    // Opening the conversation is the read; the timer refreshes content only.
    loadThread(openUserId, { markRead: true });
    const timer = setInterval(() => {
      loadThread(openUserId);
      // New messages from other customers should surface without a reload.
      loadThreads();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [openUserId, loadThread, loadThreads]);

  const unreadTotal = (threads || []).reduce((sum, t) => sum + (t.unread || 0), 0);

  const send = async () => {
    const text = draft.trim();
    if (!text || !openUserId) return;
    setSendError("");
    setSending(true);
    try {
      const res = await fetch("/api/support/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: openUserId, text }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Gửi không được");
      setDraft("");
      await loadThread(openUserId);
      await loadThreads();
    } catch (e) {
      setSendError(e.message || "Gửi không được");
    } finally {
      setSending(false);
    }
  };

  if (threads === null) return <CardSkeleton />;

  const active = threads.find((t) => t.userId === openUserId) || null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold text-text-main">Hỗ trợ khách</h2>
          {unreadTotal > 0 && <Badge variant="info" size="sm">{unreadTotal} chưa đọc</Badge>}
        </div>
        <p className="max-w-2xl text-sm text-text-muted">
          Khách nhắn vào bot (gõ <span className="font-mono">/help</span>) thì tin chuyển tới chat admin. Trả lời bằng
          cách <b>Reply</b> tin đó trong Telegram, hoặc gõ ở đây — cả hai đều tới đúng khách.
        </p>
      </div>

      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}

      {threads.length === 0 ? (
        <Card>
          <p className="text-sm text-text-muted">Chưa có khách nào nhắn hỗ trợ.</p>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
          <Card className="p-0">
            <ul className="divide-y divide-border">
              {threads.map((thread) => (
                <li key={thread.userId}>
                  <button
                    type="button"
                    onClick={() => {
                      // Clicking the already-open conversation is still "I am reading
                      // this now", so it must mark read too. `setOpenUserId` with the
                      // same id changes nothing and would skip the effect.
                      if (thread.userId === openUserId) loadThread(thread.userId, { markRead: true });
                      else setOpenUserId(thread.userId);
                    }}
                    aria-current={thread.userId === openUserId ? "true" : undefined}
                    className={`flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors hover:bg-surface-2 ${
                      thread.userId === openUserId ? "bg-surface-2" : ""
                    }`}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-medium text-text-main">
                        {thread.displayName || thread.email || thread.userId}
                      </span>
                      {thread.unread > 0 && <Badge variant="info" size="sm">{thread.unread}</Badge>}
                    </span>
                    <span className="line-clamp-1 text-xs text-text-muted">
                      {thread.lastDirection === "out" ? "Bạn: " : ""}
                      {thread.lastBody}
                    </span>
                    <span className="font-mono text-[11px] text-text-subtle">{DATE.format(new Date(thread.lastAt))}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>

          <Card className="flex min-h-[24rem] flex-col p-0">
            {!active ? (
              <p className="p-5 text-sm text-text-muted">Chọn một hội thoại bên trái.</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium text-text-main">
                      {active.displayName || active.email || active.userId}
                    </span>
                    <span className="truncate font-mono text-[11px] text-text-subtle">
                      {active.email}
                      {active.telegramUsername ? ` · @${active.telegramUsername}` : ""}
                    </span>
                  </div>
                  <Link href={`/dashboard/users/${active.userId}`} className="text-xs text-text-muted underline">
                    Mở tài khoản
                  </Link>
                </div>

                <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-4 py-3">
                  {messages === null ? (
                    <p className="text-sm text-text-muted">Đang tải…</p>
                  ) : messages.length === 0 ? (
                    <p className="text-sm text-text-muted">Chưa có tin nào.</p>
                  ) : (
                    messages.map((message) => (
                      <div
                        key={message.id}
                        className={`max-w-[85%] border px-3 py-2 text-sm ${
                          message.direction === "out"
                            ? "self-end border-text-main/20 bg-surface-2 text-text-main"
                            : "self-start border-border bg-surface text-text-main"
                        }`}
                      >
                        <p className="whitespace-pre-line break-words">{message.body}</p>
                        <p className="mt-1 font-mono text-[10px] text-text-subtle">
                          {message.direction === "out" ? "Admin" : "Khách"} · {DATE.format(new Date(message.createdAt))}
                        </p>
                      </div>
                    ))
                  )}
                </div>

                <div className="flex flex-col gap-2 border-t border-border px-4 py-3">
                  <label htmlFor="support-reply" className="sr-only">Trả lời khách</label>
                  <textarea
                    id="support-reply"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={3}
                    maxLength={MAX_LENGTH}
                    placeholder="Trả lời khách qua Telegram…"
                    className="w-full border border-border bg-surface px-3 py-2 text-sm text-text-main"
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-[11px] text-text-muted">
                      {draft.trim().length} / {MAX_LENGTH}
                    </span>
                    <Button icon="send" onClick={send} disabled={sending || !draft.trim()}>
                      Gửi cho khách
                    </Button>
                  </div>
                  {sendError && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{sendError}</p>}
                </div>
              </>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
