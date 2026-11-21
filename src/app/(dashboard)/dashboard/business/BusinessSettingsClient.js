"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, CardSkeleton, Input } from "@/shared/components";


const fieldClass =
  "h-10 w-full border border-border bg-surface px-3 font-mono text-sm text-text-main placeholder:text-text-subtle " +
  "transition-colors duration-150 focus:border-brand-500 focus:outline-none";

/**
 * "AI doanh nghiệp" settings (spec business-guard "Business settings").
 *
 * Until BOTH the guard model and the embedding model are set, every business
 * request answers 503 — the page says so at the top rather than letting the
 * operator discover it from a customer complaint.
 *
 * Changing the embedding model invalidates every existing knowledge base (the
 * documents go stale), so saving a different model asks for confirmation first.
 */
export default function BusinessSettingsClient() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [combos, setCombos] = useState([]);
  const [business, setBusiness] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [saved, setSaved] = useState(false);
  const [bots, setBots] = useState([]);
  const [botsError, setBotsError] = useState("");
  const [confirmEmbedding, setConfirmEmbedding] = useState(false);

  const load = useCallback(async () => {
    setLoadError("");
    setLoading(true);
    try {
      const [settingsRes, botsRes] = await Promise.all([
        fetch("/api/biz-settings", { cache: "no-store" }),
        fetch("/api/biz-settings/bots", { cache: "no-store" }),
      ]);
      const settingsData = await settingsRes.json().catch(() => ({}));
      if (!settingsRes.ok) throw new Error(settingsData.error || "Failed to load settings");
      setBusiness(settingsData.business);
      setDraft(settingsData.business);
      setCombos(Array.isArray(settingsData.combos) ? settingsData.combos : []);

      const botsData = await botsRes.json().catch(() => ({}));
      if (botsRes.ok) {
        setBots(Array.isArray(botsData.bots) ? botsData.bots : []);
        setBotsError("");
      } else {
        setBotsError(botsData.error || "Failed to load bots");
      }
    } catch (e) {
      setLoadError(e.message || "Failed to load settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const setField = (field, value) => {
    setSaved(false);
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const setModelRow = (index, field, value) => {
    setSaved(false);
    setDraft((current) => ({
      ...current,
      businessModels: current.businessModels.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    }));
  };

  const addModelRow = () => {
    setSaved(false);
    setDraft((current) => {
      const used = new Set(current.businessModels.map((row) => row.id));
      const next = combos.find((combo) => !used.has(combo.name));
      return {
        ...current,
        businessModels: [...current.businessModels, { id: next?.name ?? "", label: "" }],
      };
    });
  };

  const removeModelRow = (index) => {
    setSaved(false);
    setDraft((current) => ({
      ...current,
      businessModels: current.businessModels.filter((_, i) => i !== index),
    }));
  };

  const embeddingChanged = Boolean(
    business && draft && String(draft.embeddingModel || "") !== String(business.embeddingModel || "")
  );

  const persist = async () => {
    setSaving(true);
    setFormError("");
    try {
      const res = await fetch("/api/biz-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessModels: draft.businessModels.map((row) => ({ id: row.id.trim(), label: row.label.trim() })),
          guardModel: draft.guardModel.trim(),
          embeddingModel: draft.embeddingModel.trim(),
          sovereigntyAnswer: draft.sovereigntyAnswer,
          politicalRefusal: draft.politicalRefusal,
          relevanceThreshold: Number(draft.relevanceThreshold),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError(data.error || "Failed to save settings");
        return;
      }
      setBusiness(data.business);
      setDraft(data.business);
      setSaved(true);
      setConfirmEmbedding(false);
    } catch (e) {
      setFormError(e.message || "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const save = async (event) => {
    event.preventDefault();
    if (embeddingChanged && !confirmEmbedding) {
      setConfirmEmbedding(true);
      return;
    }
    await persist();
  };

  if (loading) {
    return (
      <div className="flex max-w-5xl flex-col gap-6">
        <CardSkeleton />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex max-w-5xl flex-col gap-6">
        <div className="flex items-start gap-2 border border-danger/40 bg-danger/5 px-4 py-3">
          <span className="material-symbols-outlined text-[18px] text-danger">error</span>
          <p className="flex-1 text-sm text-danger">{loadError}</p>
          <Button size="sm" variant="ghost" onClick={load}>Retry</Button>
        </div>
      </div>
    );
  }

  const ready = Boolean(draft.guardModel && draft.embeddingModel);

  return (
    <div className="flex max-w-5xl flex-col gap-10">
      <header className="flex flex-col gap-1.5 border-b border-border pb-6">
        <span className="meta text-text-subtle">Product line</span>
        <h1 className="text-2xl font-semibold text-text-main">AI doanh nghiệp</h1>
        <p className="max-w-2xl text-sm text-text-muted">
          Model doanh nghiệp, model kiểm duyệt và nội dung quan điểm chính thức. Cấu hình này áp dụng cho mọi bot.
        </p>
      </header>

      {!ready ? (
        <div className="flex items-start gap-2 border border-warning/40 bg-warning/5 px-4 py-3">
          <span className="material-symbols-outlined text-[18px] text-warning" aria-hidden="true">warning</span>
          <p className="text-sm text-text-main">
            Chưa đặt <span className="font-mono">guardModel</span> và/hoặc <span className="font-mono">embeddingModel</span>: mọi
            request tới model doanh nghiệp trả lỗi 503 cho tới khi cả hai được đặt.
          </p>
        </div>
      ) : null}

      <form onSubmit={save} className="flex flex-col gap-8">
        <section className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col">
              <h2 className="meta text-text-subtle">Model doanh nghiệp</h2>
              <p className="text-sm text-text-muted">
                Mỗi dòng là một combo đã có. Bot key chỉ gọi được các model này; mọi khách khác bị chặn.
              </p>
            </div>
            <Button type="button" variant="outline" icon="add" onClick={addModelRow}>Add model</Button>
          </div>

          {draft.businessModels.length === 0 ? (
            <p className="border border-dashed border-border px-4 py-6 text-sm text-text-muted">
              Chưa có model doanh nghiệp. Tạo combo ở mục Combo & Vision Adapter, đặt giá combo, rồi thêm vào đây.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {draft.businessModels.map((row, index) => (
                <li key={`${row.id}-${index}`} className="flex flex-col gap-2 border border-border p-3 sm:flex-row sm:items-end">
                  <label className="flex flex-1 flex-col gap-1">
                    <span className="meta text-text-subtle">Combo</span>
                    <input
                      list="biz-combos"
                      className={fieldClass}
                      value={row.id}
                      onChange={(event) => setModelRow(index, "id", event.target.value)}
                      placeholder="delify-biz"
                    />
                  </label>
                  <label className="flex flex-1 flex-col gap-1">
                    <span className="meta text-text-subtle">Nhãn</span>
                    <input
                      className={fieldClass}
                      value={row.label}
                      onChange={(event) => setModelRow(index, "label", event.target.value)}
                      placeholder="Delify Biz"
                    />
                  </label>
                  <Button type="button" variant="ghost" icon="delete" onClick={() => removeModelRow(index)}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <datalist id="biz-combos">
            {combos.map((combo) => <option key={combo.name} value={combo.name} />)}
          </datalist>
        </section>

        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="Guard model"
            value={draft.guardModel}
            onChange={(event) => setField("guardModel", event.target.value)}
            placeholder="guard-model hoặc combo"
            hint="Model phân loại và kiểm duyệt câu trả lời. Chạy bằng key admin, không tính phí khách."
          />
          <Input
            label="Embedding model"
            value={draft.embeddingModel}
            onChange={(event) => setField("embeddingModel", event.target.value)}
            placeholder="openai/text-embedding-3-small"
            hint="Đổi model này làm toàn bộ tài liệu cũ thành “Cần xử lý lại”."
          />
          <Input
            label="Ngưỡng liên quan"
            type="number"
            step="0.01"
            min="0"
            max="1"
            value={String(draft.relevanceThreshold)}
            onChange={(event) => setField("relevanceThreshold", event.target.value)}
            hint="Từ 0 đến 1. Đoạn tài liệu dưới ngưỡng này không được đưa vào câu trả lời."
          />
        </section>

        <section className="flex flex-col gap-4">
          <label className="flex flex-col gap-1">
            <span className="meta text-text-subtle">Nội dung chủ quyền</span>
            <textarea
              className={`${fieldClass} h-28 py-2`}
              value={draft.sovereigntyAnswer}
              maxLength={1000}
              onChange={(event) => setField("sovereigntyAnswer", event.target.value)}
            />
            <span className="text-xs text-text-muted">1–1.000 ký tự. Trả lời trước, sau đó hướng khách về doanh nghiệp.</span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="meta text-text-subtle">Câu từ chối chính trị</span>
            <textarea
              className={`${fieldClass} h-20 py-2`}
              value={draft.politicalRefusal}
              maxLength={500}
              onChange={(event) => setField("politicalRefusal", event.target.value)}
            />
            <span className="text-xs text-text-muted">1–500 ký tự. Dùng cho nội dung chính trị và yêu cầu đổi chỉ dẫn.</span>
          </label>
        </section>

        {embeddingChanged ? (
          <div className="flex items-start gap-2 border border-warning/40 bg-warning/5 px-4 py-3">
            <span className="material-symbols-outlined text-[18px] text-warning" aria-hidden="true">warning</span>
            <p className="text-sm text-text-main">
              Đổi embedding model sẽ khiến mọi tài liệu hiện có thành “Cần xử lý lại” và không được dùng để trả lời cho tới khi
              khách bấm xử lý lại.
              {confirmEmbedding ? " Bấm Lưu lần nữa để xác nhận." : ""}
            </p>
          </div>
        ) : null}

        {formError ? (
          <p role="alert" className="flex items-center gap-1.5 text-[12px] text-danger">
            <span className="material-symbols-outlined text-[14px]" aria-hidden="true">error</span>
            {formError}
          </p>
        ) : null}
        {saved ? (
          <p role="status" className="flex items-center gap-1.5 text-[12px] text-text-main">
            <span className="material-symbols-outlined text-[14px] text-text-muted" aria-hidden="true">check_circle</span>
            Đã lưu.
          </p>
        ) : null}

        <div>
          <Button type="submit" loading={saving} disabled={saving}>
            {confirmEmbedding ? "Xác nhận đổi embedding model" : "Lưu cấu hình"}
          </Button>
        </div>
      </form>

      <section className="flex flex-col gap-4 border-t border-border pt-8">
        <div className="flex flex-col">
          <h2 className="meta text-text-subtle">Bot của khách hàng</h2>
          <p className="text-sm text-text-muted">
            {bots.length} bot. Số tài liệu theo trạng thái và số câu bị chặn trong 7 ngày gần nhất.
          </p>
        </div>

        {botsError ? (
          <div className="flex items-start gap-2 border border-danger/40 bg-danger/5 px-4 py-3">
            <span className="material-symbols-outlined text-[18px] text-danger">error</span>
            <p className="flex-1 text-sm text-danger">{botsError}</p>
            <Button size="sm" variant="ghost" onClick={load}>Retry</Button>
          </div>
        ) : bots.length === 0 ? (
          <p className="border border-dashed border-border px-4 py-6 text-sm text-text-muted">Chưa có bot nào.</p>
        ) : (
          <div className="overflow-x-auto border border-border">
            <table className="w-full min-w-[52rem] border-collapse text-sm">
              <thead>
                <tr className="bg-surface-2 text-left">
                  {["Chủ sở hữu", "Bot", "Model", "Trạng thái", "Tài liệu", "Bị chặn 7 ngày"].map((label) => (
                    <th key={label} className="whitespace-nowrap px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-text-muted">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {bots.map((bot) => (
                  <tr key={bot.id} className="border-t border-border">
                    <td className="px-4 py-2 font-mono text-[12px] text-text-muted [overflow-wrap:anywhere]">{bot.ownerEmail ?? "—"}</td>
                    <td className="px-4 py-2 text-text-main">
                      {bot.name}
                      <span className="block text-xs text-text-muted">{bot.companyName}</span>
                    </td>
                    <td className="px-4 py-2 font-mono text-[12px] text-text-main [overflow-wrap:anywhere]">{bot.modelId}</td>
                    {/* Active state as TEXT, never a coloured dot alone. */}
                    <td className="px-4 py-2 font-mono text-[12px] text-text-main">{bot.isActive ? "Đang bật" : "Đang tắt"}</td>
                    <td className="px-4 py-2 font-mono text-[12px] text-text-muted">
                      {`Sẵn sàng ${bot.documents.ready} · Đang xử lý ${bot.documents.processing} · Lỗi ${bot.documents.failed} · Cần xử lý lại ${bot.documents.stale}`}
                    </td>
                    <td className="px-4 py-2 font-mono text-[12px] text-text-main tabular-nums">{bot.blocked7d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
