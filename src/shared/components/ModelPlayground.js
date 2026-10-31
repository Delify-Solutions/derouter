"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ActionButton, Empty, SelectField, Tag, fieldClass } from "@/app/account/components/ui";

const MODES = [
  { id: "chat", label: "Chat" },
  { id: "image", label: "Tạo ảnh" },
];

const SIZES = ["512x512", "1024x1024", "1024x1792", "1792x1024"].map((value) => ({ value, label: value }));
const COUNTS = [1, 2, 3, 4].map((value) => ({ value: String(value), label: `${value} ảnh` }));

function errorMessage(data, fallback) {
  if (!data) return fallback;
  if (typeof data.error === "string") return data.error;
  if (typeof data.error?.message === "string") return data.error.message;
  if (typeof data.message === "string") return data.message;
  return fallback;
}

/**
 * One generated image. A page's CSP may refuse an http:// upstream URL, which would
 * leave a broken-image icon; on any load failure show a link to open it instead.
 */
function ResultImage({ src, alt }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <a href={src} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 border border-border bg-surface-2 px-3 py-3 text-sm text-text-main hover:underline">
        <span className="material-symbols-outlined text-[18px]" aria-hidden="true">open_in_new</span>
        Mở ảnh
      </a>
    );
  }
  return (
    <a href={src} target="_blank" rel="noopener noreferrer" className="block border border-border bg-surface-2">
      {/* Generated images come from the upstream host, so next/image cannot optimise them. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} className="h-auto w-full" loading="lazy" onError={() => setFailed(true)} />
    </a>
  );
}

function imageSource(item) {
  if (item?.url) return item.url;
  if (item?.b64_json) return `data:image/png;base64,${item.b64_json}`;
  return null;
}

/**
 * Try-it panel: streamed text chat and image generation against the models a caller
 * may use. It owns the conversation and the form; HOW a call reaches the server is
 * the `transport`'s business, which is what lets the signed-in `/account/chat` page
 * (session route) and the public `/usage` page (the visitor's own API key on /v1)
 * share one screen.
 *
 * transport (must be referentially stable — it keys the model load):
 *   loadModels()                  -> { text: [{id,name}], image: [{id,name}] }, throws Error
 *   chat({ model, messages, signal })  -> fetch Response (JSON or text/event-stream)
 *   image({ body, signal })            -> fetch Response (JSON)  body: OpenAI images fields
 *
 * Conversations live in memory only: closing the tab clears them.
 *
 * @param {{ transport: object, storageKey?: string, notice?: string, onUsed?: () => void,
 *           request?: { id: number, model: string, kind: "text"|"image" } }} props
 *   `onUsed` fires after a call finished, so a page can refresh its own usage figures.
 *   `request` selects a model from outside (a "try" button on a model list): each new
 *   `id` switches to that model's tab and picks it, once the model list has loaded.
 */
export default function ModelPlayground({ transport, storageKey = "playground.mode", notice = "", onUsed = null, request = null }) {
  const [models, setModels] = useState({ text: [], image: [] });
  const [loadingModels, setLoadingModels] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [mode, setMode] = useState("chat");

  const [chatModel, setChatModel] = useState("");
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");

  const [imageModel, setImageModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState("1024x1024");
  const [count, setCount] = useState("1");
  const [seed, setSeed] = useState("");
  const [steps, setSteps] = useState("");
  const [reference, setReference] = useState("");
  const [images, setImages] = useState([]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const abortRef = useRef(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved === "chat" || saved === "image") setMode(saved);
    } catch { /* storage can be blocked */ }
  }, [storageKey]);

  const loadModels = useCallback(async () => {
    setLoadError("");
    try {
      const data = await transport.loadModels();
      const next = { text: data?.text || [], image: data?.image || [] };
      setModels(next);
      setChatModel((current) => current || next.text[0]?.id || "");
      setImageModel((current) => current || next.image[0]?.id || "");
    } catch (e) {
      setLoadError(e.message || "Không tải được danh sách model");
    } finally {
      setLoadingModels(false);
    }
  }, [transport]);

  useEffect(() => { loadModels(); }, [loadModels]);

  // Apply an outside model request once per id, after the list is there to pick from.
  const appliedRequestRef = useRef(null);
  useEffect(() => {
    if (!request || loadingModels || appliedRequestRef.current === request.id) return;
    appliedRequestRef.current = request.id;
    const kind = request.kind === "image" ? "image" : "chat";
    const list = kind === "image" ? models.image : models.text;
    if (!list.some((model) => model.id === request.model)) return;
    setMode(kind);
    setError("");
    (kind === "image" ? setImageModel : setChatModel)(request.model);
  }, [request, loadingModels, models]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, images, mode]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const switchMode = (next) => {
    setMode(next);
    setError("");
    try { window.localStorage.setItem(storageKey, next); } catch { /* ignore */ }
  };

  const stop = () => abortRef.current?.abort();

  const sendChat = async () => {
    const text = draft.trim();
    if (!text || !chatModel || busy) return;

    const history = [...messages, { role: "user", content: text }];
    setMessages([...history, { role: "assistant", content: "" }]);
    setDraft("");
    setError("");
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;

    const patchAnswer = (content) => setMessages((current) => {
      const copy = current.slice();
      copy[copy.length - 1] = { role: "assistant", content };
      return copy;
    });

    try {
      const res = await transport.chat({ model: chatModel, messages: history, signal: controller.signal });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(errorMessage(data, `Lỗi ${res.status}`));
      }

      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("text/event-stream")) {
        const data = await res.json().catch(() => ({}));
        patchAnswer(data?.choices?.[0]?.message?.content || "");
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let answer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta) {
              answer += delta;
              patchAnswer(answer);
            }
          } catch { /* a partial or non-JSON line */ }
        }
      }
      if (!answer) patchAnswer("(Model không trả nội dung)");
    } catch (e) {
      if (e?.name === "AbortError") return;
      // Drop the empty assistant bubble and keep the question so it can be resent.
      setMessages((current) => (current[current.length - 1]?.content === "" ? current.slice(0, -1) : current));
      setError(e.message || "Không gửi được tin nhắn");
    } finally {
      setBusy(false);
      abortRef.current = null;
      onUsed?.();
    }
  };

  const generate = async () => {
    const text = prompt.trim();
    if (!text || !imageModel || busy) return;

    setError("");
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;

    const body = { model: imageModel, prompt: text, size, n: Number(count) };
    if (seed.trim() !== "" && Number.isInteger(Number(seed))) body.seed = Number(seed);
    if (steps.trim() !== "" && Number.isInteger(Number(steps))) body.num_inference_steps = Number(steps);
    if (reference.trim()) body.condition_images = [reference.trim()];

    try {
      const res = await transport.image({ body, signal: controller.signal });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(errorMessage(data, `Lỗi ${res.status}`));
      const results = (Array.isArray(data.data) ? data.data : []).map(imageSource).filter(Boolean);
      if (!results.length) throw new Error("Model không trả ảnh nào");
      setImages((current) => [...current, { id: `${Date.now()}`, prompt: text, model: imageModel, sources: results }]);
      setPrompt("");
    } catch (e) {
      if (e?.name === "AbortError") return;
      setError(e.message || "Không tạo được ảnh");
    } finally {
      setBusy(false);
      abortRef.current = null;
      onUsed?.();
    }
  };

  const onKeyDown = (event, submit) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const list = mode === "chat" ? models.text : models.image;
  const noModels = !loadingModels && !loadError && list.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" aria-label="Chế độ" className="flex border-b border-border">
        {MODES.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={mode === item.id}
            onClick={() => switchMode(item.id)}
            className={`-mb-px flex h-11 items-center border-b-2 px-4 font-mono text-[13px] font-medium transition-colors duration-150 ${
              mode === item.id ? "border-text-main text-text-main" : "border-transparent text-text-muted hover:text-text-main"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {notice && <p className="text-xs text-text-muted">{notice}</p>}

      {loadError && (
        <div role="alert" className="flex items-start justify-between gap-4 border border-red-600/30 bg-red-500/10 px-5 py-4">
          <span className="text-sm text-red-600 dark:text-red-400">{loadError}</span>
          <ActionButton size="sm" onClick={() => { setLoadingModels(true); loadModels(); }}>Thử lại</ActionButton>
        </div>
      )}

      {noModels ? (
        <Empty
          icon={mode === "chat" ? "chat" : "image"}
          title={mode === "chat" ? "Chưa có model chat nào" : "Chưa có model tạo ảnh nào"}
          body="Key hoặc nhóm này chưa được mở model thuộc loại này. Liên hệ quản trị viên nếu bạn cần dùng."
        />
      ) : (
        <div className="flex flex-col border border-border bg-surface">
          <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border px-4 py-3">
            <SelectField
              id="playground-model"
              label="Model"
              className="min-w-[220px]"
              value={mode === "chat" ? chatModel : imageModel}
              onChange={(event) => (mode === "chat" ? setChatModel : setImageModel)(event.target.value)}
              options={list.map((model) => ({ value: model.id, label: model.name }))}
              disabled={loadingModels || busy}
            />
            {mode === "chat" && messages.length > 0 && (
              <ActionButton size="sm" onClick={() => { setMessages([]); setError(""); }} disabled={busy}>
                Cuộc trò chuyện mới
              </ActionButton>
            )}
          </div>

          <div ref={scrollRef} className="flex h-[52vh] min-h-[320px] flex-col gap-4 overflow-y-auto px-4 py-5" aria-live="polite">
            {mode === "chat" ? (
              messages.length === 0 ? (
                <p className="m-auto text-sm text-text-muted">Nhập tin nhắn bên dưới để bắt đầu.</p>
              ) : (
                messages.map((message, index) => (
                  <div key={index} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[85%] whitespace-pre-wrap break-words border px-4 py-3 text-sm leading-6 ${
                        message.role === "user"
                          ? "border-text-main bg-text-main text-bg"
                          : "border-border bg-surface-2 text-text-main"
                      }`}
                    >
                      {message.content || (busy && index === messages.length - 1 ? "…" : "")}
                    </div>
                  </div>
                ))
              )
            ) : images.length === 0 ? (
              <p className="m-auto text-sm text-text-muted">Mô tả ảnh bạn muốn tạo ở bên dưới.</p>
            ) : (
              images.map((entry) => (
                <div key={entry.id} className="flex flex-col gap-2">
                  <p className="flex flex-wrap items-center gap-2 text-sm text-text-muted">
                    <Tag icon="image">{entry.model}</Tag>
                    <span className="break-words">{entry.prompt}</span>
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {entry.sources.map((src, i) => (
                      <ResultImage key={i} src={src} alt={entry.prompt} />
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>

          {error && (
            <div role="alert" className="flex items-start gap-2 border-t border-red-600/30 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">error</span>
              <span className="min-w-0 break-words">{error}</span>
            </div>
          )}

          <div className="border-t border-border p-4">
            {mode === "chat" ? (
              <div className="flex items-end gap-3">
                <textarea
                  aria-label="Tin nhắn"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => onKeyDown(event, sendChat)}
                  rows={2}
                  maxLength={20000}
                  placeholder="Nhập tin nhắn — Enter để gửi, Shift+Enter xuống dòng"
                  className={`${fieldClass} h-auto min-h-[64px] resize-y py-2`}
                />
                {busy ? (
                  <ActionButton onClick={stop}>Dừng</ActionButton>
                ) : (
                  <ActionButton tone="solid" onClick={sendChat} disabled={!draft.trim() || !chatModel}>Gửi</ActionButton>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <textarea
                  aria-label="Mô tả ảnh"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => onKeyDown(event, generate)}
                  rows={2}
                  maxLength={4000}
                  placeholder="Ví dụ: một chú cáo đỏ trong rừng tuyết, tranh màu nước"
                  className={`${fieldClass} h-auto min-h-[64px] resize-y py-2`}
                />
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <SelectField id="playground-size" label="Kích thước" value={size} onChange={(event) => setSize(event.target.value)} options={SIZES} disabled={busy} />
                  <SelectField id="playground-count" label="Số ảnh" value={count} onChange={(event) => setCount(event.target.value)} options={COUNTS} disabled={busy} />
                  <label className="flex flex-col gap-2">
                    <span className="meta text-text-muted">Seed (tuỳ chọn)</span>
                    <input className={fieldClass} inputMode="numeric" value={seed} onChange={(event) => setSeed(event.target.value)} placeholder="42" disabled={busy} />
                  </label>
                  <label className="flex flex-col gap-2">
                    <span className="meta text-text-muted">Số bước (tuỳ chọn)</span>
                    <input className={fieldClass} inputMode="numeric" value={steps} onChange={(event) => setSteps(event.target.value)} placeholder="20" disabled={busy} />
                  </label>
                </div>
                <label className="flex flex-col gap-2">
                  <span className="meta text-text-muted">Ảnh tham chiếu (URL, tuỳ chọn)</span>
                  <input className={fieldClass} value={reference} onChange={(event) => setReference(event.target.value)} placeholder="https://…" disabled={busy} />
                </label>
                <div className="flex justify-end gap-2">
                  {busy && <ActionButton onClick={stop}>Dừng</ActionButton>}
                  <ActionButton tone="solid" onClick={generate} loading={busy} disabled={!prompt.trim() || !imageModel}>Tạo ảnh</ActionButton>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
