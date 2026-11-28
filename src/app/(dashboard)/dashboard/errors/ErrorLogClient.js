"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Button, ConfirmModal, Select, Toggle, Input, Table, Badge, Card } from "@/shared/components";
import Drawer from "@/shared/components/Drawer";
import { errorFileName, errorReportMarkdown, replayCurl } from "@/lib/errorLog/report.js";

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

// Toggle buttons for the status filter — chosen together, not one at a time, so
// "loại trừ 503 và 429" is a single click each rather than needing free text.
const STATUS_TOKENS = [
  { value: "4", label: "4xx" },
  { value: "5", label: "5xx" },
  { value: "2", label: "200 (đứt)" },
  { value: "429", label: "429" },
  { value: "500", label: "500" },
  { value: "502", label: "502" },
  { value: "503", label: "503" },
  { value: "504", label: "504" },
];

const RANGES = [
  { value: "1h", label: "1 giờ qua" },
  { value: "24h", label: "24 giờ qua" },
  { value: "7d", label: "7 ngày qua" },
  { value: "", label: "Toàn bộ" },
];

const SOURCE_VARIANT = {
  upstream: "error",
  stream: "error",
  router: "warning",
  request: "info",
  platform: "default",
};

function StatusTag({ status }) {
  const variant = status >= 500 ? "error" : status >= 400 ? "warning" : "info";
  const icon = status >= 500 ? "error" : status >= 400 ? "warning" : "info";
  return (
    <Badge variant={variant} icon={icon} size="sm">
      {status || "—"}
    </Badge>
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

/** Save `text` as a file in the browser (no server round trip). */
function downloadText(text, fileName, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const origin = () => (typeof window !== "undefined" ? window.location.origin : "");

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
  const curl = replayCurl(detail, origin());

  return (
    <div className="flex flex-col gap-6">
      {/* Hand the whole failure over for a fix: the file, a pasteable report, or a
          command that sends the same request again. */}
      <div className="flex flex-col gap-2 border border-border bg-surface-2 p-3">
        <p className="meta text-text-subtle">Xuất lỗi để sửa</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" icon="download" onClick={() => downloadText(JSON.stringify(detail, null, 2), errorFileName(detail))}>
            Tải JSON
          </Button>
          <Button size="sm" variant="secondary" icon="description" onClick={() => downloadText(errorReportMarkdown(detail, { baseUrl: origin() }), errorFileName(detail, "md"), "text/markdown")}>
            Tải báo cáo .md
          </Button>
          <Button size="sm" variant="secondary" icon="content_copy" onClick={() => doCopy(errorReportMarkdown(detail, { baseUrl: origin() }))}>
            Sao chép báo cáo
          </Button>
          {curl && (
            <Button size="sm" variant="ghost" icon="terminal" onClick={() => doCopy(curl)}>
              Sao chép lệnh curl
            </Button>
          )}
        </div>
        <p className="text-xs text-text-muted">
          Gồm báo lỗi, các lần gọi upstream, phản hồi lỗi gốc, request khách gửi và body đã gửi upstream (khóa bí mật đã được che).
          {curl ? " Lệnh curl gửi lại đúng request này; đặt biến DEROUTER_KEY trước khi chạy." : ""}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <StatusTag status={detail.status} />
        <Badge variant={SOURCE_VARIANT[detail.source] || "default"} size="sm">{detail.source}</Badge>
        {detail.stream && <Badge variant="default" size="sm">yêu cầu stream</Badge>}
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
        {data.rawResponse && (
          <details className="border border-border" open>
            <summary className="cursor-pointer px-3 py-2 meta text-text-subtle">Phản hồi lỗi từ upstream (nguyên bản)</summary>
            <Pre>{pretty(data.rawResponse)}</Pre>
          </details>
        )}
        {data.response && pretty(data.response) !== detail.message && (
          <details className="border border-border">
            <summary className="cursor-pointer px-3 py-2 meta text-text-subtle">
              Nội dung khách đã nhận{data.rawResponse ? " (đã ẩn danh cho khách)" : ""}
            </summary>
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
          <Table className="min-w-[560px] text-left">
            <Table.Head>
              <Table.Row>
                {["#", "Mã", "Provider / model", "Kết nối", "Sau", "Lỗi"].map((h) => (
                  <Table.HeaderCell key={h} className="whitespace-nowrap">{h}</Table.HeaderCell>
                ))}
              </Table.Row>
            </Table.Head>
            <Table.Body>
              {data.attempts.map((a, i) => (
                <Table.Row key={i} className="align-top">
                  <Table.Cell className="font-mono text-[12px] text-text-muted">{i + 1}</Table.Cell>
                  <Table.Cell><StatusTag status={a.status} /></Table.Cell>
                  <Table.Cell className="font-mono text-[12px] break-all" title={a.provider || ""}>{shortProvider(a.provider) || "—"} / {a.model || "—"}</Table.Cell>
                  <Table.Cell className="font-mono text-[12px] text-text-muted">{a.connectionName || String(a.connectionId || "—").slice(0, 8)}</Table.Cell>
                  <Table.Cell className="font-mono text-[12px] text-text-muted whitespace-nowrap">{a.afterMs != null ? `${a.afterMs} ms` : "—"}</Table.Cell>
                  <Table.Cell className="font-mono text-[11px] text-text-main break-words">{a.error || "—"}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
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
    <Input
      type="number" min={min} max={max} value={form[key]} onChange={num(key)}
      label={label} hint={hint}
    />
  );

  return (
    <Card className="flex flex-col gap-5">
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
    </Card>
  );
}

export default function ErrorLogClient() {
  const [filters, setFilters] = useState({ source: "", status: "", statusMode: "", owner: "", range: "24h", model: "", q: "" });
  const [search, setSearch] = useState({ model: "", q: "", owner: "" });
  const [items, setItems] = useState([]);
  const [nextBefore, setNextBefore] = useState(null);
  const [count, setCount] = useState(0);
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
  const [confirmFilterDelete, setConfirmFilterDelete] = useState(false);
  const [filterDeleting, setFilterDeleting] = useState(false);
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
      setCount(Number(data.count) || 0);
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

  // Row shortcuts: fetch the full entry, then download it or copy its report.
  const [rowBusy, setRowBusy] = useState("");
  const [rowNote, setRowNote] = useState("");
  const exportRow = async (id, kind) => {
    setRowBusy(`${id}:${kind}`);
    try {
      const res = await fetch(`/api/error-logs/${encodeURIComponent(id)}`, { cache: "no-store" });
      const entry = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(entry.error || "Không mở được mục này");
      if (kind === "json") {
        downloadText(JSON.stringify(entry, null, 2), errorFileName(entry));
      } else {
        const ok = await copy(errorReportMarkdown(entry, { baseUrl: origin() }));
        setRowNote(ok ? "Đã sao chép báo cáo lỗi." : "Không sao chép được: trình duyệt từ chối.");
        setTimeout(() => setRowNote(""), 2500);
      }
    } catch (e) {
      setError(e.message || "Không xuất được mục này");
    } finally {
      setRowBusy("");
    }
  };

  // Everything the current filters match, as one file (at most 500 entries).
  const exportHref = () => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
    p.set("limit", "500");
    return `/api/error-logs/export?${p.toString()}`;
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

  // Deletes exactly what the current filters match (source/status(-mode)/owner/model/q/range)
  // — the API refuses an empty filter, so this is never reachable with nothing selected.
  const deleteByFilter = async () => {
    setFilterDeleting(true);
    try {
      const res = await fetch(`/api/error-logs?${query(filters)}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Không xóa được các mục khớp bộ lọc");
      setConfirmFilterDelete(false);
      load(filters);
    } catch (e) {
      setError(e.message || "Không xóa được các mục khớp bộ lọc");
      setConfirmFilterDelete(false);
    } finally {
      setFilterDeleting(false);
    }
  };

  const applySearch = (e) => {
    e.preventDefault();
    setFilters((f) => ({ ...f, model: search.model.trim(), q: search.q.trim(), owner: search.owner.trim() }));
  };

  const setFilter = (key) => (e) => setFilters((f) => ({ ...f, [key]: e.target.value }));
  const statusTokens = filters.status ? filters.status.split(",").filter(Boolean) : [];
  const toggleStatusToken = (token) => {
    setFilters((f) => {
      const current = f.status ? f.status.split(",").filter(Boolean) : [];
      const next = current.includes(token) ? current.filter((t) => t !== token) : [...current, token];
      return { ...f, status: next.join(",") };
    });
  };
  const empty = !loading && items.length === 0 && !error;
  const filtered = !!(filters.source || filters.status || filters.owner || filters.model || filters.q);

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
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Nguồn lỗi" options={SOURCES} value={filters.source} onChange={setFilter("source")} />
          <Select label="Khoảng thời gian" options={RANGES} value={filters.range} onChange={setFilter("range")} />
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">
              Mã trạng thái {statusTokens.length > 0 && `(${statusTokens.length} đã chọn)`}
            </span>
            <div className="flex shrink-0 gap-1.5" role="group" aria-label="Bao gồm hay loại trừ các mã đã chọn">
              {[["", "Bao gồm"], ["exclude", "Loại trừ"]].map(([v, label]) => (
                <Button
                  key={v || "include"}
                  type="button"
                  size="sm"
                  variant={filters.statusMode === v ? "primary" : "secondary"}
                  onClick={() => setFilters((f) => ({ ...f, statusMode: v }))}
                  aria-pressed={filters.statusMode === v}
                  title={v ? "Hiện mọi lỗi KHÔNG thuộc các mã đã chọn" : "Hiện lỗi thuộc các mã đã chọn"}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {STATUS_TOKENS.map((t) => {
              const active = statusTokens.includes(t.value);
              return (
                <Button
                  key={t.value}
                  type="button"
                  size="sm"
                  variant={active ? "primary" : "secondary"}
                  onClick={() => toggleStatusToken(t.value)}
                  aria-pressed={active}
                >
                  {t.label}
                </Button>
              );
            })}
            {statusTokens.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setFilters((f) => ({ ...f, status: "" }))}
              >
                Bỏ chọn mã
              </Button>
            )}
          </div>
        </div>
        <form onSubmit={applySearch} className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
          <Input
            className="sm:w-56"
            label="Model"
            value={search.model}
            onChange={(e) => setSearch((s) => ({ ...s, model: e.target.value }))}
            placeholder="vd. GLM-5.3"
          />
          <Input
            className="sm:w-56"
            label="Người dùng"
            value={search.owner}
            onChange={(e) => setSearch((s) => ({ ...s, owner: e.target.value }))}
            placeholder="email hoặc tên key"
          />
          <Input
            className="flex-1"
            label="Tìm kiếm"
            value={search.q}
            onChange={(e) => setSearch((s) => ({ ...s, q: e.target.value }))}
            placeholder="báo lỗi, chủ key hoặc mã lỗi, vd. context_length"
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="secondary" icon="search">Tìm</Button>
            <Button type="button" variant="ghost" icon="refresh" onClick={() => load(filters)}>Làm mới</Button>
            <a
              href={exportHref()}
              download
              aria-disabled={items.length === 0}
              title="Tải mọi lỗi khớp bộ lọc hiện tại (tối đa 500), kèm request và body đã gửi"
              className={`inline-flex h-10 items-center gap-1.5 px-4 text-sm text-text-muted hover:bg-surface-2 hover:text-text-main ${items.length === 0 ? "pointer-events-none opacity-50" : ""}`}
            >
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">download</span>
              Tải lỗi đang lọc
            </a>
            <Button type="button" variant="ghost" icon="tune" onClick={() => setShowSettings((v) => !v)}>Cài đặt</Button>
            {filtered && (
              <Button
                type="button"
                variant="ghost"
                icon="delete_sweep"
                className="text-danger"
                onClick={() => setConfirmFilterDelete(true)}
                disabled={!count}
                title="Xoá mọi mục khớp bộ lọc hiện tại (nguồn, mã trạng thái, người dùng, model, tìm kiếm, khoảng thời gian)"
              >
                Xóa theo bộ lọc ({count})
              </Button>
            )}
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
            <Button size="sm" variant="secondary" onClick={() => { setSearch({ model: "", q: "", owner: "" }); setFilters({ source: "", status: "", statusMode: "", owner: "", range: "", model: "", q: "" }); }}>
              Bỏ bộ lọc
            </Button>
          )}
        </div>
      ) : (
        <Table className="min-w-[980px]">
          <Table.Head>
            <Table.Row>
              {["Thời gian", "Mã", "Nguồn", "Model", "Chủ key", "Báo lỗi", "Kích thước", "Độ trễ", ""].map((h) => (
                <Table.HeaderCell key={h || "open"} align={h ? "left" : "right"} className="whitespace-nowrap">{h}</Table.HeaderCell>
              ))}
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {items.map((r) => (
              <Table.Row key={r.id}>
                <Table.Cell className="font-mono text-[12px] text-text-muted whitespace-nowrap">{formatTime(r.timestamp)}</Table.Cell>
                <Table.Cell><StatusTag status={r.status} /></Table.Cell>
                <Table.Cell><Badge variant={SOURCE_VARIANT[r.source] || "default"} size="sm">{r.source}</Badge></Table.Cell>
                <Table.Cell className="font-mono text-[12px] text-text-main whitespace-nowrap">
                  {r.requestedModel || "—"}
                  {r.model && r.model !== r.requestedModel && <span className="text-text-subtle"> → {r.model}</span>}
                </Table.Cell>
                <Table.Cell className="text-[12px] text-text-muted max-w-[180px] truncate" title={r.owner || ""}>{r.owner || "—"}</Table.Cell>
                <Table.Cell className="text-sm text-text-main max-w-[360px] truncate" title={r.message || ""}>{r.message || "—"}</Table.Cell>
                <Table.Cell className="font-mono text-[12px] text-text-muted whitespace-nowrap">{kb(r.bodyBytes)} · ~{(r.estTokens || 0).toLocaleString("vi-VN")} tk</Table.Cell>
                <Table.Cell className="font-mono text-[12px] text-text-muted whitespace-nowrap">{(r.latencyMs || 0).toLocaleString("vi-VN")} ms</Table.Cell>
                <Table.Cell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="content_copy"
                      className="size-8 px-0"
                      onClick={() => exportRow(r.id, "report")}
                      disabled={rowBusy === `${r.id}:report`}
                      title="Sao chép báo cáo lỗi (Markdown)"
                      aria-label={`Sao chép báo cáo lỗi ${r.id}`}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="download"
                      className="size-8 px-0"
                      onClick={() => exportRow(r.id, "json")}
                      disabled={rowBusy === `${r.id}:json`}
                      title="Tải lỗi kèm request (JSON)"
                      aria-label={`Tải lỗi ${r.id}`}
                    />
                    <Button size="sm" variant="secondary" onClick={() => openDetail(r.id)} aria-label={`Xem chi tiết lỗi ${r.id}`}>Chi tiết</Button>
                  </div>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}

      <p role="status" aria-live="polite" className="-mt-3 min-h-4 text-xs text-text-muted">{rowNote}</p>

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

      <ConfirmModal
        isOpen={confirmFilterDelete}
        onClose={() => setConfirmFilterDelete(false)}
        onConfirm={deleteByFilter}
        loading={filterDeleting}
        title="Xóa các mục khớp bộ lọc"
        message={`Xóa ${count.toLocaleString("vi-VN")} mục đang khớp bộ lọc hiện tại (nguồn, mã trạng thái, người dùng, model, tìm kiếm, khoảng thời gian)? Không hoàn tác được.`}
        confirmText="Xóa"
        cancelText="Hủy"
      />
    </div>
  );
}
