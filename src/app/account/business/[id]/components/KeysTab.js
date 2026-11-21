"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ActionButton, Empty, Panel, Section, Tag, fieldClass } from "@/app/account/components/ui";
import CopyBlock from "@/app/account/components/CopyBlock";
import { formatDateTime } from "../../components/format";

/**
 * "Key API" tab (spec business-bots "Bot keys"): create a key (the secret is shown
 * once, with copy), list prefixes, reveal or copy again through the secret
 * endpoint, delete, and a ready-to-paste request sample.
 */
export default function KeysTab({ bot, publicBaseUrl = "" }) {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [revealed, setRevealed] = useState({});

  const base = useMemo(() => {
    const configured = String(publicBaseUrl || "").trim().replace(/\/+$/, "");
    if (configured) return `${configured}/v1`;
    if (typeof window !== "undefined") return `${window.location.origin}/v1`;
    return "/v1";
  }, [publicBaseUrl]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/account/biz/bots/${bot.id}/keys`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Không tải được danh sách key");
      setKeys(Array.isArray(data.keys) ? data.keys : []);
    } catch (e) {
      setError(e.message || "Không tải được danh sách key");
    } finally {
      setLoading(false);
    }
  }, [bot.id]);

  useEffect(() => { load(); }, [load]);

  const create = async (event) => {
    event.preventDefault();
    setCreating(true);
    setError("");
    try {
      const res = await fetch(`/api/account/biz/bots/${bot.id}/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() || "Key chatbot" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Không tạo được key");
      setCreated(data);
      setName("");
      await load();
    } catch (e) {
      setError(e.message || "Không tạo được key");
    } finally {
      setCreating(false);
    }
  };

  const reveal = async (key) => {
    setBusyId(key.id);
    setError("");
    try {
      const res = await fetch(`/api/account/biz/bots/${bot.id}/keys/${key.id}/secret`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Không lấy được key");
      setRevealed((current) => ({ ...current, [key.id]: data.secret }));
    } catch (e) {
      setError(e.message || "Không lấy được key");
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (key) => {
    setBusyId(key.id);
    setError("");
    try {
      const res = await fetch(`/api/account/biz/bots/${bot.id}/keys/${key.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Không xóa được key");
      await load();
    } catch (e) {
      setError(e.message || "Không xóa được key");
    } finally {
      setBusyId(null);
    }
  };

  const snippet = `curl ${base}/chat/completions \\
  -H "Authorization: Bearer <KEY>" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${bot.modelId}","messages":[{"role":"user","content":"Xin chào"}]}'`;

  return (
    <div className="flex flex-col gap-10">
      <Section title="Tạo key mới" description="Mỗi bot tối đa 10 key. Key chỉ dùng được với /v1/chat/completions và model của bot.">
        <form onSubmit={create} className="flex flex-col gap-4 border border-border bg-surface p-6">
          <div className="flex flex-col gap-2">
            <label htmlFor="key-name" className="meta text-text-muted">Tên key</label>
            <input
              id="key-name"
              className={fieldClass}
              value={name}
              maxLength={80}
              placeholder="Ví dụ: Website"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div>
            <ActionButton type="submit" tone="solid" loading={creating} disabled={creating}>Tạo key</ActionButton>
          </div>
        </form>

        {created ? (
          <Panel className="mt-4 flex flex-col gap-3 p-6">
            <p className="flex items-center gap-2 text-sm font-medium text-text-main">
              <span className="material-symbols-outlined text-[18px] text-text-muted" aria-hidden="true">key</span>
              Key “{created.key.name}” đã tạo. Đây là lần duy nhất key hiện đầy đủ.
            </p>
            <CopyBlock value={created.secret} label="Sao chép key" />
            <ActionButton onClick={() => setCreated(null)}>Đã lưu, đóng</ActionButton>
          </Panel>
        ) : null}
      </Section>

      <Section title="Key của bot" description="Chỉ hiện phần đầu của key. Bấm Hiện để lấy key đầy đủ.">
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
            <ActionButton onClick={load}>Thử lại</ActionButton>
          </Panel>
        ) : keys.length === 0 ? (
          <Empty icon="key" title="Chưa có key nào" body="Tạo key để ứng dụng của bạn gọi bot qua API." />
        ) : (
          <ul className="flex flex-col gap-2">
            {keys.map((key) => {
              const busy = busyId === key.id;
              return (
                <li key={key.id} className="flex flex-col gap-3 border border-border bg-surface-2 px-5 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="font-mono text-sm text-text-main">{key.name}</span>
                      <Tag tone={key.isActive ? "success" : "neutral"} icon={key.isActive ? "check_circle" : "pause_circle"}>
                        {key.isActive ? "Đang bật" : "Đang tắt"}
                      </Tag>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <ActionButton size="sm" onClick={() => reveal(key)} loading={busy} disabled={busy}>
                        {revealed[key.id] ? "Ẩn" : "Hiện"}
                      </ActionButton>
                      <ActionButton size="sm" onClick={() => remove(key)} disabled={busy}>Xóa</ActionButton>
                    </div>
                  </div>
                  <p className="font-mono text-xs text-text-muted">
                    {key.keyPrefix}… · tạo {formatDateTime(key.createdAt)}
                  </p>
                  {revealed[key.id] ? <CopyBlock value={revealed[key.id]} label="Sao chép key" /> : null}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title="Gọi bot" description="Đổi model nếu bạn muốn dùng model doanh nghiệp khác mà quản trị viên đã mở.">
        <div className="flex flex-col gap-3 border border-border bg-surface p-6">
          <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">Request mẫu</p>
          <CopyBlock value={snippet} label="Sao chép request mẫu" />
          <p className="text-sm text-text-muted">
            Model: <span className="font-mono text-text-main">{bot.modelId}</span>. Base URL:{" "}
            <span className="font-mono text-text-main">{base}</span>.
          </p>
        </div>
      </Section>
    </div>
  );
}
