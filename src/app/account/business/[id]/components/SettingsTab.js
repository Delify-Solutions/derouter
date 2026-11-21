"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ActionButton, Panel, Section, Tag, fieldClass } from "@/app/account/components/ui";

/**
 * "Cài đặt" tab: every bot field, save, and delete with a typed confirmation
 * (deleting a bot also deletes its keys, documents and history, so it must not be
 * one stray click away).
 */
export default function SettingsTab({ bot, onSaved }) {
  const router = useRouter();
  const [draft, setDraft] = useState(bot);
  const [models, setModels] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [deleting, setDeleting] = useState(false);

  // The business model list is admin-owned; the form offers exactly it.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/account/biz/models", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && Array.isArray(data?.models)) setModels(data.models);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const setField = (field, value) => {
    setSaved(false);
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const modelOptions = models.length
    ? models
    : [{ id: bot.modelId, label: bot.modelId }];

  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/account/biz/bots/${bot.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          companyName: draft.companyName,
          domainDescription: draft.domainDescription,
          mode: draft.mode,
          refusalMessage: draft.refusalMessage,
          extraInstructions: draft.extraInstructions,
          modelId: draft.modelId,
          isActive: draft.isActive,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Không lưu được bot");
        return;
      }
      setSaved(true);
      onSaved(data.bot);
    } catch (e) {
      setError(e.message || "Không lưu được bot");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    setError("");
    try {
      const res = await fetch(`/api/account/biz/bots/${bot.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Không xóa được bot");
        return;
      }
      router.push("/account/business");
      router.refresh();
    } catch (e) {
      setError(e.message || "Không xóa được bot");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-10">
      <Section title="Thông tin bot" description="Những gì khách nhìn thấy và phạm vi bot được trả lời.">
        <form onSubmit={save} className="flex flex-col gap-4 border border-border bg-surface p-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <label htmlFor="s-name" className="meta text-text-muted">Tên bot</label>
              <input id="s-name" className={fieldClass} value={draft.name} maxLength={80} required
                onChange={(event) => setField("name", event.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor="s-company" className="meta text-text-muted">Tên doanh nghiệp</label>
              <input id="s-company" className={fieldClass} value={draft.companyName} maxLength={120} required
                onChange={(event) => setField("companyName", event.target.value)} />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="s-domain" className="meta text-text-muted">Mô tả lĩnh vực</label>
            <textarea id="s-domain" className={`${fieldClass} h-28 py-2`} value={draft.domainDescription}
              minLength={10} maxLength={2000} required
              onChange={(event) => setField("domainDescription", event.target.value)} />
            <p className="text-xs text-text-muted">Từ 10 đến 2.000 ký tự. Bot chỉ trả lời trong phạm vi này.</p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <span className="meta text-text-muted">Chế độ</span>
              <div className="flex flex-col gap-2">
                {[
                  { id: "strict", label: "Nghiêm ngặt — chỉ trả lời từ tài liệu" },
                  { id: "flexible", label: "Linh hoạt — cho phép chào hỏi và kiến thức chung" },
                ].map((option) => (
                  <label key={option.id} className="flex items-center gap-2 text-sm text-text-main">
                    <input type="radio" name="s-mode" value={option.id} checked={draft.mode === option.id}
                      onChange={() => setField("mode", option.id)} className="size-4" />
                    {option.label}
                  </label>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor="s-model" className="meta text-text-muted">Model doanh nghiệp</label>
              <select id="s-model" className={fieldClass} value={draft.modelId}
                onChange={(event) => setField("modelId", event.target.value)}>
                {modelOptions.map((model) => (
                  <option key={model.id} value={model.id}>{model.label ? `${model.label} (${model.id})` : model.id}</option>
                ))}
              </select>
              <label className="mt-2 flex items-center gap-2 text-sm text-text-main">
                <input type="checkbox" checked={draft.isActive} onChange={(event) => setField("isActive", event.target.checked)} className="size-4" />
                Bot đang bật (tắt thì mọi request trả lỗi 403)
              </label>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="s-refusal" className="meta text-text-muted">Câu từ chối</label>
            <input id="s-refusal" className={fieldClass} value={draft.refusalMessage} maxLength={500}
              onChange={(event) => setField("refusalMessage", event.target.value)} />
            <p className="text-xs text-text-muted">Dùng khi câu hỏi ngoài phạm vi, hoặc khi chế độ nghiêm ngặt không tìm thấy tài liệu.</p>
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="s-extra" className="meta text-text-muted">Chỉ dẫn thêm</label>
            <textarea id="s-extra" className={`${fieldClass} h-24 py-2`} value={draft.extraInstructions ?? ""}
              maxLength={2000} onChange={(event) => setField("extraInstructions", event.target.value)} />
            <p className="text-xs text-text-muted">Không được trái với quy tắc an toàn của hệ thống.</p>
          </div>

          {error ? (
            <p role="alert" className="flex items-center gap-2 text-sm text-danger">
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">error</span>
              {error}
            </p>
          ) : null}
          {saved ? (
            <p role="status" className="flex items-center gap-2 text-sm text-text-main">
              <span className="material-symbols-outlined text-[16px] text-text-muted" aria-hidden="true">check_circle</span>
              Đã lưu.
            </p>
          ) : null}

          <div>
            <ActionButton type="submit" tone="solid" loading={saving} disabled={saving}>Lưu thay đổi</ActionButton>
          </div>
        </form>
      </Section>

      <Section title="Xóa bot" description="Xóa bot sẽ xóa luôn key, tài liệu, các đoạn đã tách và lịch sử câu hỏi bị chặn.">
        <Panel className="flex flex-col gap-3 p-6">
          {!confirming ? (
            <ActionButton tone="outline" onClick={() => setConfirming(true)}>Xóa bot này</ActionButton>
          ) : (
            <>
              <label htmlFor="s-confirm" className="meta text-text-muted">
                Nhập đúng tên bot “{bot.name}” để xác nhận
              </label>
              <input id="s-confirm" className={fieldClass} value={confirmName}
                onChange={(event) => setConfirmName(event.target.value)} />
              <div className="flex flex-wrap items-center gap-2">
                <ActionButton
                  tone="solid"
                  loading={deleting}
                  disabled={deleting || confirmName.trim() !== bot.name}
                  onClick={remove}
                >
                  Xóa vĩnh viễn
                </ActionButton>
                <ActionButton onClick={() => { setConfirming(false); setConfirmName(""); }} disabled={deleting}>
                  Hủy
                </ActionButton>
                <Tag tone="danger" icon="warning">Không khôi phục được</Tag>
              </div>
            </>
          )}
        </Panel>
      </Section>
    </div>
  );
}
