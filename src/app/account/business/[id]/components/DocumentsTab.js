"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ActionButton, Empty, Panel, Section, Tag, fieldClass } from "@/app/account/components/ui";
import { fmtDocSize, formatDateTime, statusView } from "../../components/format";

const SOURCE_LABEL = { file: "Tệp", text: "Văn bản", qa: "Hỏi đáp" };

/**
 * "Tài liệu" tab (spec business-bots "Knowledge base ingestion"): upload a file,
 * paste text, or add Q&A pairs; then watch each document move through processing →
 * ready, or fail with a retryable error.
 *
 * Every document row states its status with an ICON AND TEXT — never colour alone
 * (openspec/ui-dna.md §4).
 */
export default function DocumentsTab({ botId }) {
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mode, setMode] = useState("file");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [pairs, setPairs] = useState([{ question: "", answer: "" }]);
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [busyId, setBusyId] = useState(null);
  const fileRef = useRef(null);

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/account/biz/bots/${botId}/documents`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Không tải được tài liệu");
      setDocuments(Array.isArray(data.documents) ? data.documents : []);
    } catch (e) {
      setError(e.message || "Không tải được tài liệu");
    } finally {
      setLoading(false);
    }
  }, [botId]);

  useEffect(() => { load(); }, [load]);

  // A document in `processing` becomes ready on the worker's schedule; polling
  // while one is pending is what turns the upload into a visible result without a
  // reload. It stops as soon as nothing is processing.
  const pending = documents.some((doc) => doc.status === "processing");
  useEffect(() => {
    if (!pending) return undefined;
    const timer = setInterval(() => { load({ quiet: true }); }, 4000);
    return () => clearInterval(timer);
  }, [pending, load]);

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setFormError("");
    try {
      let res;
      if (mode === "file") {
        if (!file) {
          setFormError("Chọn một tệp PDF, DOCX, TXT hoặc MD");
          return;
        }
        const form = new FormData();
        form.append("file", file);
        if (title.trim()) form.append("title", title.trim());
        res = await fetch(`/api/account/biz/bots/${botId}/documents`, { method: "POST", body: form });
      } else if (mode === "text") {
        res = await fetch(`/api/account/biz/bots/${botId}/documents`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "text", title: title.trim() || "Văn bản", text }),
        });
      } else {
        res = await fetch(`/api/account/biz/bots/${botId}/documents`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "qa", title: title.trim() || "Hỏi đáp", pairs }),
        });
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError(data.error || "Không thêm được tài liệu");
        return;
      }
      setTitle("");
      setText("");
      setPairs([{ question: "", answer: "" }]);
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      await load();
    } catch (e) {
      setFormError(e.message || "Không thêm được tài liệu");
    } finally {
      setSaving(false);
    }
  };

  const retry = async (doc) => {
    setBusyId(doc.id);
    setError("");
    try {
      const res = await fetch(`/api/account/biz/bots/${botId}/documents/${doc.id}/retry`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Không xử lý lại được tài liệu");
      await load();
    } catch (e) {
      setError(e.message || "Không xử lý lại được tài liệu");
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (doc) => {
    setBusyId(doc.id);
    setError("");
    try {
      const res = await fetch(`/api/account/biz/bots/${botId}/documents/${doc.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Không xóa được tài liệu");
      await load();
    } catch (e) {
      setError(e.message || "Không xóa được tài liệu");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex flex-col gap-10">
      <Section title="Thêm tài liệu" description="Tệp tối đa 10 MB. Chỉ phần văn bản được lưu, không lưu tệp gốc.">
        <form onSubmit={submit} className="flex flex-col gap-4 border border-border bg-surface p-6">
          <div role="tablist" aria-label="Cách thêm tài liệu" className="flex flex-wrap gap-px border border-border bg-border">
            {[
              { id: "file", label: "Tải tệp" },
              { id: "text", label: "Dán văn bản" },
              { id: "qa", label: "Cặp hỏi đáp" },
            ].map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={mode === item.id}
                onClick={() => setMode(item.id)}
                className={`h-9 flex-1 px-3 font-mono text-xs transition-colors duration-150 ${
                  mode === item.id ? "bg-surface text-text-main" : "bg-surface-2 text-text-muted hover:text-text-main"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="doc-title" className="meta text-text-muted">Tiêu đề</label>
            <input id="doc-title" className={fieldClass} value={title} maxLength={200}
              placeholder="Ví dụ: Bảng giá sofa 2026" onChange={(event) => setTitle(event.target.value)} />
          </div>

          {mode === "file" ? (
            <div className="flex flex-col gap-2">
              <label htmlFor="doc-file" className="meta text-text-muted">Tệp (PDF, DOCX, TXT, MD)</label>
              <input
                id="doc-file"
                ref={fileRef}
                type="file"
                accept=".pdf,.docx,.txt,.md,application/pdf,text/plain,text/markdown"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                className="block w-full border border-border bg-surface px-3 py-2 text-sm text-text-main file:mr-3 file:border-0 file:bg-surface-2 file:px-3 file:py-1 file:font-mono file:text-xs file:text-text-main"
              />
            </div>
          ) : mode === "text" ? (
            <div className="flex flex-col gap-2">
              <label htmlFor="doc-text" className="meta text-text-muted">Nội dung</label>
              <textarea id="doc-text" className={`${fieldClass} h-40 py-2`} value={text}
                onChange={(event) => setText(event.target.value)} />
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {pairs.map((pair, index) => (
                <div key={index} className="flex flex-col gap-2 border border-border p-3">
                  <label className="flex flex-col gap-1">
                    <span className="meta text-text-muted">Câu hỏi {index + 1}</span>
                    <input
                      className={fieldClass}
                      value={pair.question}
                      onChange={(event) => setPairs((current) =>
                        current.map((entry, i) => (i === index ? { ...entry, question: event.target.value } : entry)))}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="meta text-text-muted">Câu trả lời {index + 1}</span>
                    <textarea
                      className={`${fieldClass} h-20 py-2`}
                      value={pair.answer}
                      onChange={(event) => setPairs((current) =>
                        current.map((entry, i) => (i === index ? { ...entry, answer: event.target.value } : entry)))}
                    />
                  </label>
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                <ActionButton type="button" onClick={() => setPairs((current) => [...current, { question: "", answer: "" }])}>
                  Thêm cặp
                </ActionButton>
                {pairs.length > 1 ? (
                  <ActionButton type="button" onClick={() => setPairs((current) => current.slice(0, -1))}>
                    Bớt cặp cuối
                  </ActionButton>
                ) : null}
              </div>
            </div>
          )}

          {formError ? (
            <p role="alert" className="flex items-center gap-2 text-sm text-danger">
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">error</span>
              {formError}
            </p>
          ) : null}

          <div>
            <ActionButton type="submit" tone="solid" loading={saving} disabled={saving}>
              Thêm tài liệu
            </ActionButton>
          </div>
        </form>
      </Section>

      <Section title="Tài liệu của bot" description="Bot chỉ dùng những đoạn liên quan nhất trong các tài liệu sẵn sàng.">
        {loading ? (
          <div className="grid grid-cols-1 gap-2" aria-hidden="true">
            {[0, 1].map((i) => <div key={i} className="h-16 border border-border bg-surface-2" />)}
          </div>
        ) : error ? (
          <Panel className="flex flex-col items-start gap-3 p-6">
            <p role="alert" className="flex items-center gap-2 text-sm text-danger">
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">error</span>
              {error}
            </p>
            <ActionButton onClick={() => load()}>Thử lại</ActionButton>
          </Panel>
        ) : documents.length === 0 ? (
          <Empty
            icon="folder_open"
            title="Chưa có tài liệu nào"
            body="Thêm tài liệu để bot trả lời được câu hỏi về sản phẩm và dịch vụ của bạn."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {documents.map((doc) => {
              const view = statusView(doc.status);
              const busy = busyId === doc.id;
              return (
                <li key={doc.id} className="flex flex-col gap-3 border border-border bg-surface-2 px-5 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="min-w-0 max-w-full truncate font-mono text-sm text-text-main" title={doc.title}>
                        {doc.title}
                      </span>
                      <Tag tone={view.tone} icon={view.icon}>{view.label}</Tag>
                      <Tag>{SOURCE_LABEL[doc.sourceType] ?? doc.sourceType}</Tag>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      {doc.status === "failed" || doc.status === "stale" ? (
                        <ActionButton size="sm" onClick={() => retry(doc)} loading={busy} disabled={busy}>
                          Xử lý lại
                        </ActionButton>
                      ) : null}
                      <ActionButton size="sm" onClick={() => remove(doc)} disabled={busy}>
                        Xóa
                      </ActionButton>
                    </div>
                  </div>
                  <p className="font-mono text-xs text-text-muted">
                    {fmtDocSize(doc.bytes)} · {doc.chunkCount} đoạn · {formatDateTime(doc.createdAt)}
                  </p>
                  {doc.error ? (
                    <p className="flex items-center gap-2 text-sm text-danger">
                      <span className="material-symbols-outlined text-[16px]" aria-hidden="true">error</span>
                      {doc.error}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </div>
  );
}
