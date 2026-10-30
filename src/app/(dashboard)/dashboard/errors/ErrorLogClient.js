"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Button, ConfirmModal, Select, Toggle } from "@/shared/components";
import Drawer from "@/shared/components/Drawer";

const SOURCES = [
  { value: "", label: "Tất cả nguồn" },
  { value: "upstream", label: "Upstream" },
  { value: "stream", label: "Stream" },
  { value: "router", label: "Router" },
  { value: "request", label: "Request" },
  { value: "platform", label: "Nền tảng" },
];

const SOURCE_HINT = {
  upstream: "Nhà cung cấp trả lỗi hoặc không phản hồi",
  stream: "Phản hồi đã bắt đầu rồi mới đứt giữa chừng",
  router: "Router không gửi được tới upstream (hết credential, model đang khóa, lỗi nội bộ)",
  request: "Router từ chối request (JSON sai, model không tồn tại)",
  platform: "Router chặn theo key, nhóm hoặc gói (hết quota, vượt rate limit)",
};

const STATUSES = [
  { value: "", label: "Mọi mã" },
  { value: "4", label: "4xx" },
  { value: "5", label: "5xx" },
  { value: "2", label: "200 (stream đứt)" },
];

const RANGES = [
  { value: "1h", label: "1 giờ qua" },
  { value: "24h", label: "24 giờ qua" },
  { value: "7d", label: "7 ngày qua" },
  { value: "", label: "Toàn bộ" },
];

const SOURCE_STYLE = {
  upstream: "border-danger/30 bg-danger/10 text-danger",
  stream: "border-danger/30 bg-danger/10 text-danger",
  router: "border-warning/30 bg-warning/10 text-warning",
  request: "border-info/30 bg-info/10 text-info",
  platform: "border-border bg-surface-2 text-text-muted",
};

function Tag({ children, className = "" }) {
  return (
    <span className={`inline-flex items-center border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider whitespace-nowrap ${className}`}>
      {children}
    </span>
  );
}

function StatusTag({ status }) {
  const style = status >= 500 ? "border-danger/30 bg-danger/10 text-danger"
    : status >= 400 ? "border-warning/30 bg-warning/10 text-warning"
      : "border-info/30 bg-info/10 text-info";
  const icon = status >= 500 ? "error" : status >= 400 ? "warning" : "info";
  return (
    <Tag className={style}>
      <span className="material-symbols-outlined text-[12px] mr-1" aria-hidden="true">{icon}</span>
      {status || "—"}
    </Tag>
  );
}

function formatTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function kb(bytes) {
  return `${Math.max(0, Math.round((bytes || 0) / 102.4) / 10).toLocaleString("vi-VN")} KB`;
}

// Node ids of custom providers are long UUIDs; the full id stays in the cell's title.
function shortProvider(id) {
  const s = String(id || "");
  const m = s.match(/^(openai|anthropic)-compatible-(chat|images|responses|embeddings)?-?([0-9a-f]{8})/);
  return m ? `${m[1]}-compat · ${m[3]}` : s;
}

function pretty(text) {
  if (!text) return "";
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false; // clipboard unavailable or refused
  }
}

const TURN_KEYS = ["messages", "input", "contents"];

function turnsOf(request) {
  if (!request || typeof request !== "object") return [];
  for (const k of TURN_KEYS) if (Array.isArray(request[k])) return request[k];
  return [];
}

function textOfTurn(turn) {
  if (turn?._omitted) return `… ${turn._omitted} bị lược bỏ để vừa giới hạn lưu …`;
  const c = turn?.content ?? turn?.parts;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.map((p) => {
      if (typeof p === "string") return p;
      if (p?.text != null) return p.text;
      if (p?.type === "image_url") return `[ảnh] ${p.image_url?.url ?? ""}`;
      if (p?.type === "tool_use" || p?.functionCall) return `[gọi tool] ${JSON.stringify(p.input ?? p.functionCall ?? p)}`;
      return JSON.stringify(p);
    }).join("\n");
  }
  if (turn?.tool_calls) return `[gọi tool] ${JSON.stringify(turn.tool_calls)}`;
  return c == null ? "" : JSON.stringify(c);
}

function Block({ title, actions, children }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <h3 className="meta text-text-subtle">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

function Pre({ children }) {
  return (
    <pre className="border border-border bg-surface-2 p-3 font-mono text-[12px] leading-5 text-text-main whitespace-pre-wrap break-words max-h-80 overflow-auto">
      {children}
    </pre>
  );
}

function Detail({ detail, onDelete }) {
  const { data } = detail;
  const [note, setNote] = useState("");
  const doCopy = async (text) => {
    setNote((await copy(text)) ? "Đã sao chép." : "Không sao chép được: trình duyệt từ chối.");
    setTimeout(() => setNote(""), 2500);
  };
  const turns = turnsOf(data.request);
  const params = data.request && typeof data.request === "object"
    ? Object.fromEntries(Object.entries(data.request).filter(([k]) => !TURN_KEYS.includes(k)))
    : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <StatusTag status={detail.status} />
        <Tag className={SOURCE_STYLE[detail.source]}>{detail.source}</Tag>
        {detail.stream && <Tag className="border-border bg-surface-2 text-text-muted">yêu cầu stream</Tag>}
        <span className="font-mono text-[12px] text-text-muted ml-auto">{detail.id}</span>
      </div>
      <p className="text-sm text-text-muted">{SOURCE_HINT[detail.source]}</p>
      <p role="status" aria-live="polite" className="text-xs text-text-muted min-h-4">{note}</p>

      <dl className="border border-border divide-y divide-border text-sm">
        {[
          ["Thời gian", new Date(detail.timestamp).toLocaleString("vi-VN")],
          ["Endpoint", detail.endpoint || "—"],
          ["Model khách gọi", detail.requestedModel || "—"],
          ["Đi tới", detail.provider ? `${shortProvider(detail.provider)} / ${detail.model || "—"}` : "—"],
          ["Kết nối", detail.connectionName || detail.connectionId || "—"],
          ["Chủ key", detail.owner ? `${detail.owner}${detail.apiKeyId ? ` · ${String(detail.apiKeyId).slice(0, 8)}` : ""}` : "—"],
          ["Kích thước", `${kb(detail.bodyBytes)} · ~${(detail.estTokens || 0).toLocaleString("vi-VN")} token · ${detail.messageCount} lượt`],
          ["Độ trễ", `${(detail.latencyMs || 0).toLocaleString("vi-VN")} ms`],
          ["User-Agent", data.userAgent || "—"],
        ].map(([k, v]) => (
          <div key={k} className="flex items-start justify-between gap-4 px-4 py-2.5">
            <dt className="meta text-text-subtle shrink-0">{k}</dt>
            <dd className="font-mono text-[12px] text-text-main text-right break-all">{v}</dd>
          </div>
        ))}
      </dl>

      <Block
        title="Báo lỗi"
        actions={<Button size="sm" variant="ghost" icon="content_copy" onClick={() => doCopy(detail.message || "")}>Sao chép</Button>}
      >
        <Pre>{detail.message || "—"}</Pre>
        {data.response && pretty(data.response) !== detail.message && (
          <details className="border border-border">
            <summary className="cursor-pointer px-3 py-2 meta text-text-subtle">Nội dung phản hồi gốc</summary>
            <Pre>{pretty(data.response)}</Pre>
          </details>
        )}
        {detail.source === "stream" && (
          <p className="text-xs text-text-muted">
            Phản hồi đã bắt đầu (HTTP 200) rồi mới đứt, nên khách thấy câu trả lời bị cụt thay vì mã lỗi.
            {data.stream?.chunks != null && ` Nhận được ${data.stream.chunks} chunk, ${kb(data.stream.bytes)}.`}
          </p>
        )}
      </Block>

      {data.attempts?.length > 0 && (
        <Block title={`Các lần gọi upstream (${data.attempts.length})`}>
          <div className="overflow-x-auto border border-border">
            <table className="w-full min-w-[560px] border-collapse text-left">
              <thead>
                <tr className="border-b border-border bg-surface-2">
                  {["#", "Mã", "Provider / model", "Kết nối", "Sau", "Lỗi"].map((h) => (
                    <th key={h} className="meta text-text-subtle font-medium px-3 py-2 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.attempts.map((a, i) => (
                  <tr key={i} className="border-b border-border last:border-b-0 align-top">
                    <td className="px-3 py-2 font-mono text-[12px] text-text-muted">{i + 1}</td>
                    <td className="px-3 py-2"><StatusTag status={a.status} /></td>
                    <td className="px-3 py-2 font-mono text-[12px] break-all" title={a.provider || ""}>{shortProvider(a.provider) || "—"} / {a.model || "—"}</td>
                    <td className="px-3 py-2 font-mono text-[12px] text-text-muted">{a.connectionName || String(a.connectionId || "—").slice(0, 8)}</td>
                    <td className="px-3 py-2 font-mono text-[12px] text-text-muted whitespace-nowrap">{a.afterMs != null ? `${a.afterMs} ms` : "—"}</td>
                    <td className="px-3 py-2 font-mono text-[11px] text-text-main break-words">{a.error || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Block>
      )}

      <Block
        title="Prompt khách gửi lên"
        actions={data.request && (
          <Button size="sm" variant="ghost" icon="content_copy" onClick={() => doCopy(JSON.stringify(data.request, null, 2))}>Sao chép JSON</Button>
        )}
      >
        {!data.promptStored ? (
          <p className="border border-dashed border-border px-4 py-6 text-sm text-text-muted">
            Không lưu nội dung prompt cho mục này: lỗi nền tảng không giữ prompt, hoặc cài đặt đang tắt “Lưu prompt”.
            Kích thước và số lượt vẫn được ghi ở trên.
          </p>
        ) : (
          <>
            {data.requestTruncated && (
              <p className="text-xs text-warning font-mono">Đã rút gọn để vừa giới hạn lưu: chuỗi dài bị cắt giữa, ảnh nhúng được thay bằng mô tả.</p>
            )}
            {turns.length > 0 ? (
              <ol className="flex flex-col gap-2">
                {turns.map((t, i) => (
                  <li key={i} className="border border-border">
                    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-surface-2">
                      <span className="meta text-text-subtle">{t?._omitted ? "…" : t?.role || "turn"}</span>
                      <span className="font-mono text-[11px] text-text-subtle">#{i + 1}</span>
                    </div>
                    <pre className="p-3 font-mono text-[12px] leading-5 whitespace-pre-wrap break-words max-h-60 overflow-auto">{textOfTurn(t)}</pre>
                  </li>
                ))}
              </ol>
            ) : (
              <Pre>{JSON.stringify(data.request, null, 2)}</Pre>
            )}
            {params && Object.keys(params).length > 0 && (
              <details className="border border-border">
                <summary className="cursor-pointer px-3 py-2 meta text-text-subtle">Tham số (model, temperature, tools…)</summary>
                <Pre>{JSON.stringify(params, null, 2)}</Pre>
              </details>
            )}
          </>
        )}
      </Block>

      {data.upstreamRequest && (
        <Block
          title="Body thực sự gửi tới upstream"
          actions={<Button size="sm" variant="ghost" icon="content_copy" onClick={() => doCopy(JSON.stringify(data.upstreamRequest, null, 2))}>Sao chép JSON</Button>}
        >
          <p className="text-xs text-text-muted">
            Sau khi router dịch định dạng và áp các tính năng tiết kiệm token ({kb(data.upstreamBytes)} gốc).
            {data.upstreamTruncated && " Đã rút gọn để vừa giới hạn lưu."}
          </p>
          <details className="border border-border">
            <summary className="cursor-pointer px-3 py-2 meta text-text-subtle">Xem JSON</summary>
            <Pre>{JSON.stringify(data.upstreamRequest, null, 2)}</Pre>
          </details>
        </Block>
      )}

      <div className="flex justify-between gap-3 border-t border-border pt-4">
        <Button variant="secondary" icon="content_copy" onClick={() => doCopy(JSON.stringify(detail, null, 2))}>Sao chép toàn bộ mục</Button>
        <Button variant="danger" icon="delete" onClick={onDelete}>Xóa mục này</Button>
      </div>
    </div>
  );
}

function SettingsPanel({ config, onSaved }) {
  const [form, setForm] = useState(config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const num = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const save = async () => {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const res = await fetch("/api/error-logs/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: form.enabled,
          storePrompt: form.storePrompt,
          retentionDays: Number(form.retentionDays),
          maxRows: Number(form.maxRows),
          maxBodyKB: Number(form.maxBodyKB),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Không lưu được cài đặt");
      setForm(data);
      setSaved(true);
      onSaved(data);
    } catch (e) {
      setError(e.message || "Không lưu được cài đặt");
    } finally {
      setSaving(false);
    }
  };

  const field = (key, label, hint, min, max) => (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">{label}</span>
      <input
        type="number" min={min} max={max} value={form[key]} onChange={num(key)}
        className="h-10 w-full border border-border bg-surface px-3 font-mono text-sm text-text-main focus:border-brand-500 focus:outline-none"
      />
      <span className="text-[11px] text-text-subtle">{hint}</span>
    </label>
  );

  return (
    <div className="border border-border p-6 flex flex-col gap-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:gap-10">
        <Toggle checked={form.enabled} onChange={(v) => setForm((f) => ({ ...f, enabled: v }))} label="Ghi nhật ký lỗi" description="Tắt thì không lưu thêm mục nào." />
        <Toggle checked={form.storePrompt} onChange={(v) => setForm((f) => ({ ...f, storePrompt: v }))} label="Lưu nội dung prompt" description="Tắt thì chỉ lưu lỗi, model, kích thước và các lần gọi." />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {field("retentionDays", "Giữ tối đa (ngày)", "Mục cũ hơn bị xóa tự động. 1–365.", 1, 365)}
        {field("maxRows", "Số mục tối đa", "Vượt thì xóa mục cũ nhất. 100–20.000.", 100, 20000)}
        {field("maxBodyKB", "Dung lượng prompt mỗi mục (KB)", "Prompt dài hơn bị rút gọn. 4–1024.", 4, 1024)}
      </div>
      <p className="text-xs text-text-muted max-w-2xl">
        Prompt là dữ liệu của khách hàng: chỉ admin xem được trang này. API key không bao giờ được lưu (chỉ id và email chủ key),
        chuỗi trông giống key hoặc Bearer token trong nội dung được che. Lỗi nền tảng (hết quota, rate limit) không giữ prompt.
      </p>
      {error && <p role="alert" className="text-sm text-danger flex items-center gap-1.5"><span className="material-symbols-outlined text-[16px]" aria-hidden="true">error</span>{error}</p>}
      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving}>Lưu cài đặt</Button>
        {saved && <span className="text-sm text-text-muted" role="status">Đã lưu.</span>}
      </div>
    </div>
  );
}

export default function ErrorLogClient() {
  const [filters, setFilters] = useState({ source: "", status: "", range: "24h", model: "", q: "" });
  const [search, setSearch] = useState({ model: "", q: "" });
  const [items, setItems] = useState([]);
  const [nextBefore, setNextBefore] = useState(null);
  const [summary, setSummary] = useState(null);
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const requestSeq = useRef(0);

  const query = useCallback((f, before) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
    p.set("limit", "50");
    if (before) p.set("before", before);
    return p.toString();
  }, []);

  const load = useCallback(async (f) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/error-logs?${query(f)}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Không tải được nhật ký lỗi");
      if (seq !== requestSeq.current) return; // a newer filter already answered
      setItems(data.items || []);
      setNextBefore(data.nextBefore || null);
      setSummary(data.summary || null);
      setConfig(data.config || null);
    } catch (e) {
      if (seq === requestSeq.current) { setError(e.message || "Không tải được nhật ký lỗi"); setItems([]); }
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [query]);

  useEffect(() => { load(filters); }, [load, filters]);

  const loadMore = async () => {
    if (!nextBefore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/error-logs?${query(filters, nextBefore)}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Không tải thêm được");
      setItems((prev) => [...prev, ...(data.items || [])]);
      setNextBefore(data.nextBefore || null);
    } catch (e) {
      setError(e.message || "Không tải thêm được");
    } finally {
      setLoadingMore(false);
    }
  };

  const openDetail = async (id) => {
    setDetail({ id, loading: true });
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/error-logs/${encodeURIComponent(id)}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Không mở được mục này");
      setDetail(data);
    } catch (e) {
      setDetail(null);
      setError(e.message || "Không mở được mục này");
    } finally {
      setDetailLoading(false);
    }
  };

  const deleteOne = async () => {
    if (!detail?.id) return;
    const res = await fetch(`/api/error-logs/${encodeURIComponent(detail.id)}`, { method: "DELETE" });
    if (!res.ok) { setError("Không xóa được mục này"); return; }
    setDetail(null);
    load(filters);
  };

  const clearAll = async () => {
    setClearing(true);
    try {
      const res = await fetch("/api/error-logs", { method: "DELETE" });
      if (!res.ok) throw new Error("Không xóa được nhật ký");
      setConfirmClear(false);
      load(filters);
    } catch (e) {
      setError(e.message || "Không xóa được nhật ký");
      setConfirmClear(false);
    } finally {
      setClearing(false);
    }
  };

  const applySearch = (e) => {
    e.preventDefault();
    setFilters((f) => ({ ...f, model: search.model.trim(), q: search.q.trim() }));
  };

  const setFilter = (key) => (e) => setFilters((f) => ({ ...f, [key]: e.target.value }));
  const empty = !loading && items.length === 0 && !error;
  const filtered = !!(filters.source || filters.status || filters.model || filters.q);

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-text-muted max-w-3xl">
        Mỗi request lỗi được lưu riêng cùng báo lỗi, các lần gọi upstream và prompt đã gửi, để kiểm tra lại sau.
        Mục cũ tự xóa theo cài đặt.
      </p>

      {summary && (
        <div className="grid grid-cols-2 gap-px border border-border bg-border sm:grid-cols-3 lg:grid-cols-6">
          {[["Tổng đang lưu", summary.total], ...SOURCES.slice(1).map((s) => [s.label, summary.bySource?.[s.value] ?? 0])].map(([label, n]) => (
            <div key={label} className="bg-surface px-4 py-3 flex flex-col gap-1">
              <span className="meta text-text-subtle">{label}</span>
              <span className="font-mono text-2xl text-text-main">{Number(n).toLocaleString("vi-VN")}</span>
            </div>
          ))}
        </div>
      )}
      {summary && <p className="-mt-3 text-[11px] text-text-subtle">Các ô theo nguồn đếm trong khoảng thời gian đang chọn.</p>}

      <div className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <Select label="Nguồn lỗi" options={SOURCES} value={filters.source} onChange={setFilter("source")} />
          <Select label="Mã trạng thái" options={STATUSES} value={filters.status} onChange={setFilter("status")} />
          <Select label="Khoảng thời gian" options={RANGES} value={filters.range} onChange={setFilter("range")} />
        </div>
        <form onSubmit={applySearch} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex flex-col gap-1.5 sm:w-56">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">Model</span>
            <input value={search.model} onChange={(e) => setSearch((s) => ({ ...s, model: e.target.value }))} placeholder="vd. GLM-5.3"
              className="h-10 border border-border bg-surface px-3 text-sm text-text-main focus:border-brand-500 focus:outline-none" />
          </label>
          <label className="flex flex-col gap-1.5 flex-1">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">Tìm kiếm</span>
            <input value={search.q} onChange={(e) => setSearch((s) => ({ ...s, q: e.target.value }))} placeholder="báo lỗi, chủ key hoặc mã lỗi, vd. context_length"
              className="h-10 border border-border bg-surface px-3 text-sm text-text-main focus:border-brand-500 focus:outline-none" />
          </label>
          <div className="flex gap-2">
            <Button type="submit" variant="secondary" icon="search">Tìm</Button>
            <Button type="button" variant="ghost" icon="refresh" onClick={() => load(filters)}>Làm mới</Button>
            <Button type="button" variant="ghost" icon="tune" onClick={() => setShowSettings((v) => !v)}>Cài đặt</Button>
            <Button type="button" variant="ghost" icon="delete" onClick={() => setConfirmClear(true)} disabled={!summary?.total}>Xóa hết</Button>
          </div>
        </form>
      </div>

      {showSettings && config && <SettingsPanel config={config} onSaved={(c) => setConfig(c)} />}

      {config && !config.enabled && (
        <div role="status" className="flex items-start gap-2 border border-warning/40 bg-warning/5 px-4 py-3">
          <span className="material-symbols-outlined text-[18px] text-warning" aria-hidden="true">warning</span>
          <p className="text-sm text-text-main flex-1">Ghi nhật ký lỗi đang tắt: lỗi mới sẽ không được lưu.</p>
          <Button size="sm" variant="secondary" onClick={() => setShowSettings(true)}>Bật lại trong cài đặt</Button>
        </div>
      )}

      {error && (
        <div role="alert" className="flex items-start gap-2 border border-danger/40 bg-danger/5 px-4 py-3">
          <span className="material-symbols-outlined text-[18px] text-danger" aria-hidden="true">error</span>
          <p className="text-sm text-danger flex-1">{error}</p>
          <Button size="sm" variant="ghost" onClick={() => load(filters)}>Thử lại</Button>
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="border border-border px-6 py-16 text-center text-sm text-text-muted" role="status">Đang tải…</div>
      ) : empty ? (
        <div className="border border-dashed border-border px-6 py-16 flex flex-col items-center text-center gap-3">
          <span className="material-symbols-outlined text-[32px] text-text-subtle" aria-hidden="true">fact_check</span>
          <p className="text-text-main font-medium">{filtered ? "Không có lỗi nào khớp bộ lọc" : "Chưa có lỗi nào trong khoảng này"}</p>
          <p className="text-sm text-text-muted max-w-md">
            {filtered ? "Thử bỏ bớt bộ lọc hoặc mở rộng khoảng thời gian." : "Khi một request lỗi, nó sẽ hiện ở đây cùng báo lỗi và prompt đã gửi."}
          </p>
          {filtered && (
            <Button size="sm" variant="secondary" onClick={() => { setSearch({ model: "", q: "" }); setFilters({ source: "", status: "", range: "", model: "", q: "" }); }}>
              Bỏ bộ lọc
            </Button>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto border border-border">
          <table className="w-full min-w-[980px] border-collapse">
            <thead>
              <tr className="border-b border-border bg-surface-2">
                {["Thời gian", "Mã", "Nguồn", "Model", "Chủ key", "Báo lỗi", "Kích thước", "Độ trễ", ""].map((h) => (
                  <th key={h || "open"} className="meta text-text-subtle text-left font-medium px-4 py-2.5 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-b-0 hover:bg-surface-2/60 transition-colors">
                  <td className="px-4 py-3 font-mono text-[12px] text-text-muted whitespace-nowrap">{formatTime(r.timestamp)}</td>
                  <td className="px-4 py-3"><StatusTag status={r.status} /></td>
                  <td className="px-4 py-3"><Tag className={SOURCE_STYLE[r.source]}>{r.source}</Tag></td>
                  <td className="px-4 py-3 font-mono text-[12px] text-text-main whitespace-nowrap">
                    {r.requestedModel || "—"}
                    {r.model && r.model !== r.requestedModel && <span className="text-text-subtle"> → {r.model}</span>}
                  </td>
                  <td className="px-4 py-3 text-[12px] text-text-muted max-w-[180px] truncate" title={r.owner || ""}>{r.owner || "—"}</td>
                  <td className="px-4 py-3 text-sm text-text-main max-w-[360px] truncate" title={r.message || ""}>{r.message || "—"}</td>
                  <td className="px-4 py-3 font-mono text-[12px] text-text-muted whitespace-nowrap">{kb(r.bodyBytes)} · ~{(r.estTokens || 0).toLocaleString("vi-VN")} tk</td>
                  <td className="px-4 py-3 font-mono text-[12px] text-text-muted whitespace-nowrap">{(r.latencyMs || 0).toLocaleString("vi-VN")} ms</td>
                  <td className="px-4 py-3 text-right">
                    <Button size="sm" variant="secondary" onClick={() => openDetail(r.id)} aria-label={`Xem chi tiết lỗi ${r.id}`}>Chi tiết</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {nextBefore && (
        <div className="flex justify-center">
          <Button variant="secondary" onClick={loadMore} loading={loadingMore}>Tải thêm</Button>
        </div>
      )}

      <Drawer isOpen={!!detail} onClose={() => setDetail(null)} title="Chi tiết lỗi" width="xl">
        {detailLoading || detail?.loading ? (
          <p className="text-sm text-text-muted" role="status">Đang tải…</p>
        ) : detail ? (
          <Detail detail={detail} onDelete={deleteOne} />
        ) : null}
      </Drawer>

      <ConfirmModal
        isOpen={confirmClear}
        onClose={() => setConfirmClear(false)}
        onConfirm={clearAll}
        loading={clearing}
        title="Xóa toàn bộ nhật ký lỗi"
        message={`Xóa ${(summary?.total ?? 0).toLocaleString("vi-VN")} mục đang lưu, gồm cả prompt đã ghi? Không hoàn tác được.`}
        confirmText="Xóa hết"
        cancelText="Hủy"
      />
    </div>
  );
}
