"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ActionButton,
  ButtonLink,
  Empty,
  ListRow,
  Page,
  Panel,
  Section,
  Stat,
  Tag,
  fieldClass,
} from "@/app/account/components/ui";
import { fmtDocSize } from "./format";

/**
 * `/account/business` — the bot list of the customer's business product (spec
 * business-bots "Customer portal business area").
 *
 * Three states are always distinct: loading, an error with a retry, and empty. A
 * customer with no live business plan still sees their bots (an expired plan keeps
 * them), but the create button is disabled with the reason spelled out and a link
 * to the sales page.
 */
export default function BusinessBotsPage() {
  const [quota, setQuota] = useState(null);
  const [bots, setBots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [draft, setDraft] = useState({
    name: "",
    companyName: "",
    domainDescription: "",
    mode: "strict",
    modelId: "",
  });
  // The admin owns the business model list; the create form offers exactly it.
  const [models, setModels] = useState([]);

  const load = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      const [quotaRes, botsRes] = await Promise.all([
        fetch("/api/account/biz/quota", { cache: "no-store" }),
        fetch("/api/account/biz/bots", { cache: "no-store" }),
      ]);
      const quotaData = await quotaRes.json().catch(() => ({}));
      const botsData = await botsRes.json().catch(() => ({}));
      if (!quotaRes.ok) throw new Error(quotaData.error || "Không tải được hạn mức gói");
      if (!botsRes.ok) throw new Error(botsData.error || "Không tải được danh sách bot");
      setQuota(quotaData);
      setBots(Array.isArray(botsData.bots) ? botsData.bots : []);
    } catch (e) {
      setError(e.message || "Không tải được dữ liệu AI doanh nghiệp");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/account/biz/models", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        const list = Array.isArray(data?.models) ? data.models : [];
        setModels(list);
        // Default to the first model so the form is valid without a choice the
        // customer has no reason to make for a single-model installation.
        setDraft((current) => (current.modelId || list.length === 0
          ? current
          : { ...current, modelId: list[0].id }));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const canCreate = Boolean(quota?.hasBusinessPlan) && (quota?.botCount ?? 0) < (quota?.maxBots ?? 0);
  const createBlockedReason = !quota?.hasBusinessPlan
    ? "Cần gói AI doanh nghiệp còn hạn để tạo bot."
    : (quota?.botCount ?? 0) >= (quota?.maxBots ?? 0)
      ? `Đã đạt số bot tối đa của gói (${quota?.maxBots ?? 0}).`
      : "";

  const create = async (event) => {
    event.preventDefault();
    setSaving(true);
    setFormError("");
    try {
      const res = await fetch("/api/account/biz/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError(data.error || "Không tạo được bot");
        return;
      }
      setDraft({ name: "", companyName: "", domainDescription: "", mode: "strict", modelId: models[0]?.id ?? "" });
      setFormOpen(false);
      await load();
    } catch (e) {
      setFormError(e.message || "Không tạo được bot");
    } finally {
      setSaving(false);
    }
  };

  const setField = (field, value) => setDraft((current) => ({ ...current, [field]: value }));

  return (
    <Page
      title="AI doanh nghiệp"
      description="Mỗi bot trả lời khách hàng bằng tài liệu của doanh nghiệp bạn, trong phạm vi bạn mô tả, và giữ đúng quan điểm chủ quyền."
      actions={
        <>
          {createBlockedReason ? (
            <span className="text-sm text-text-muted" id="create-blocked-reason">{createBlockedReason}</span>
          ) : null}
          <ActionButton
            tone="solid"
            disabled={!canCreate || models.length === 0}
            aria-describedby={createBlockedReason ? "create-blocked-reason" : undefined}
            onClick={() => setFormOpen((open) => !open)}
          >
            {formOpen ? "Đóng form" : "Tạo bot"}
          </ActionButton>
        </>
      }
    >
      {loading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3" aria-hidden="true">
          {[0, 1, 2].map((i) => <div key={i} className="h-24 border border-border bg-surface-2" />)}
        </div>
      ) : error ? (
        <Panel className="flex flex-col items-start gap-3 p-6">
          <p role="alert" className="flex items-center gap-2 text-sm text-danger">
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">error</span>
            {error}
          </p>
          <ActionButton onClick={load}>Thử lại</ActionButton>
        </Panel>
      ) : (
        <>
          {!quota?.hasBusinessPlan ? (
            <Panel className="flex flex-col items-start gap-3 p-6">
              <p className="flex items-center gap-2 text-sm text-text-main">
                <span className="material-symbols-outlined text-[18px] text-text-muted" aria-hidden="true">info</span>
                Tài khoản chưa có gói AI doanh nghiệp còn hạn.
              </p>
              <p className="text-sm text-text-muted">
                Mua gói để tạo bot và thêm tài liệu. Bot và tài liệu đã có vẫn được giữ nguyên.
              </p>
              <ButtonLink href="/doanh-nghiep" tone="solid">Xem gói AI doanh nghiệp</ButtonLink>
            </Panel>
          ) : null}

          <Panel className="grid grid-cols-1 gap-px bg-border sm:grid-cols-3">
            {[
              {
                label: "Bot",
                value: `${quota?.botCount ?? 0}/${quota?.maxBots ?? 0}`,
                hint: "Số bot đã tạo trên số bot của gói",
              },
              {
                label: "Tài liệu",
                value: `${fmtDocSize(quota?.kbBytesUsed)}/${fmtDocSize(quota?.maxKbBytes)}`,
                hint: "Dung lượng văn bản đã dùng trên dung lượng của gói",
              },
              {
                label: "Gói",
                value: quota?.hasBusinessPlan ? "Còn hạn" : "Hết hạn",
                hint: quota?.hasBusinessPlan ? "Được tạo bot và thêm tài liệu" : "Chỉ xem và sửa bot đã có",
              },
            ].map((item) => (
              <div key={item.label} className="bg-surface p-5">
                <Stat label={item.label} value={item.value} hint={item.hint} />
              </div>
            ))}
          </Panel>

          {formOpen ? (
            <Section title="Bot mới" description="Tên và mô tả lĩnh vực quyết định bot được trả lời những gì.">
              <form onSubmit={create} className="flex flex-col gap-4 border border-border bg-surface p-6">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="flex flex-col gap-2">
                    <label htmlFor="bot-name" className="meta text-text-muted">Tên bot</label>
                    <input
                      id="bot-name"
                      className={fieldClass}
                      value={draft.name}
                      onChange={(event) => setField("name", event.target.value)}
                      maxLength={80}
                      required
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <label htmlFor="bot-company" className="meta text-text-muted">Tên doanh nghiệp</label>
                    <input
                      id="bot-company"
                      className={fieldClass}
                      value={draft.companyName}
                      onChange={(event) => setField("companyName", event.target.value)}
                      maxLength={120}
                      required
                    />
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <label htmlFor="bot-domain" className="meta text-text-muted">Mô tả lĩnh vực</label>
                  <textarea
                    id="bot-domain"
                    className={`${fieldClass} h-28 py-2`}
                    value={draft.domainDescription}
                    onChange={(event) => setField("domainDescription", event.target.value)}
                    minLength={10}
                    maxLength={2000}
                    placeholder="Ví dụ: cửa hàng bán sofa, bàn ăn và đồ nội thất gỗ cho gia đình."
                    required
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <label htmlFor="bot-model" className="meta text-text-muted">Model doanh nghiệp</label>
                  <select
                    id="bot-model"
                    className={fieldClass}
                    value={draft.modelId}
                    onChange={(event) => setField("modelId", event.target.value)}
                    required
                  >
                    {models.length === 0 ? <option value="">Chưa có model doanh nghiệp</option> : null}
                    {models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.label ? `${model.label} (${model.id})` : model.id}
                      </option>
                    ))}
                  </select>
                  {models.length === 0 ? (
                    <p className="text-xs text-danger">
                      Quản trị viên chưa mở model doanh nghiệp nào, nên chưa tạo được bot.
                    </p>
                  ) : null}
                </div>

                <div className="flex flex-col gap-2">
                  <span className="meta text-text-muted">Chế độ</span>
                  <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
                    {[
                      { id: "strict", label: "Nghiêm ngặt", hint: "Chỉ trả lời từ tài liệu" },
                      { id: "flexible", label: "Linh hoạt", hint: "Cho phép chào hỏi và kiến thức chung trong lĩnh vực" },
                    ].map((option) => (
                      <label key={option.id} className="flex items-start gap-2 text-sm text-text-main">
                        <input
                          type="radio"
                          name="mode"
                          value={option.id}
                          checked={draft.mode === option.id}
                          onChange={() => setField("mode", option.id)}
                          className="mt-1 size-4"
                        />
                        <span>
                          {option.label}
                          <span className="block text-xs text-text-muted">{option.hint}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
                {formError ? (
                  <p role="alert" className="flex items-center gap-2 text-sm text-danger">
                    <span className="material-symbols-outlined text-[16px]" aria-hidden="true">error</span>
                    {formError}
                  </p>
                ) : null}
                <div className="flex items-center gap-2">
                  <ActionButton type="submit" tone="solid" loading={saving} disabled={saving}>
                    Tạo bot
                  </ActionButton>
                  <ActionButton type="button" onClick={() => setFormOpen(false)} disabled={saving}>
                    Hủy
                  </ActionButton>
                </div>
              </form>
            </Section>
          ) : null}

          <Section title="Bot của bạn" description="Mở một bot để quản lý cài đặt, tài liệu, key và câu hỏi bị chặn.">
            {bots.length === 0 ? (
              <Empty
                icon="smart_toy"
                title="Chưa có bot nào"
                body={
                  quota?.hasBusinessPlan
                    ? "Tạo bot đầu tiên, rồi thêm tài liệu để bot trả lời được khách hàng."
                    : "Mua gói AI doanh nghiệp để tạo bot đầu tiên."
                }
                action={
                  quota?.hasBusinessPlan ? (
                    <ActionButton tone="solid" onClick={() => setFormOpen(true)}>Tạo bot</ActionButton>
                  ) : (
                    <ButtonLink href="/doanh-nghiep">Xem gói</ButtonLink>
                  )
                }
              />
            ) : (
              <ul className="flex flex-col gap-2">
                {bots.map((bot) => (
                  <ListRow
                    key={bot.id}
                    title={bot.name}
                    tags={
                      <>
                        <Tag tone={bot.isActive ? "success" : "neutral"} icon={bot.isActive ? "check_circle" : "pause_circle"}>
                          {bot.isActive ? "Đang bật" : "Đang tắt"}
                        </Tag>
                        <Tag>{bot.mode === "flexible" ? "Linh hoạt" : "Nghiêm ngặt"}</Tag>
                      </>
                    }
                    detail={`${bot.companyName} · model ${bot.modelId}`}
                    actions={
                      <Link
                        href={`/account/business/${bot.id}`}
                        className="inline-flex min-h-8 items-center border border-border bg-surface px-3 font-mono text-xs text-text-main transition-colors duration-150 hover:bg-surface-2"
                      >
                        Mở bot
                      </Link>
                    }
                  />
                ))}
              </ul>
            )}
          </Section>
        </>
      )}
    </Page>
  );
}
