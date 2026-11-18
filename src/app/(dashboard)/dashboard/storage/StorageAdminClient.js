"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Badge from "@/shared/components/Badge";
import Button from "@/shared/components/Button";
import StorageConfigPanel from "@/shared/components/StorageConfigPanel";
import { cn } from "@/shared/utils/cn";

const DATE = new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short" });

const STATUS = {
  ok: { label: "Đã kết nối", variant: "success" },
  failing: { label: "Lỗi", variant: "error" },
  untested: { label: "Chưa kiểm tra", variant: "warning" },
  disabled: { label: "Đang tắt", variant: "default" },
};

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

const FILTERS = [
  { id: "all", label: "Tất cả" },
  { id: "failing", label: "Lỗi" },
  { id: "untested", label: "Chưa kiểm tra" },
  { id: "disabled", label: "Đang tắt" },
  { id: "ok", label: "Đã kết nối" },
];

/**
 * `/dashboard/storage`: the system storage form, then every customer storage
 * with its status. A row re-tests in place; the customer's tab edits it.
 */
export default function StorageAdminClient() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");
  const [testing, setTesting] = useState("");
  const [rowNotice, setRowNotice] = useState(null);

  const [version, setVersion] = useState(0);
  const load = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/storage", { cache: "no-store" })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || "Không tải được danh sách CDN");
        return body;
      })
      .then((body) => {
        if (cancelled) return;
        setData(body);
        setError("");
      })
      .catch((e) => {
        if (!cancelled) setError(e.message || "Không tải được danh sách CDN");
      });
    return () => { cancelled = true; };
  }, [version]);

  const rows = useMemo(() => {
    const all = data?.storages || [];
    return filter === "all" ? all : all.filter((row) => row.status === filter);
  }, [data, filter]);

  const retest = async (row) => {
    setTesting(row.userId);
    setRowNotice(null);
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(row.userId)}/storage/test`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      const who = row.email || row.userId;
      if (!res.ok) setRowNotice({ ok: false, text: `${who}: ${body.error || "Không kiểm tra được"}` });
      else if (body.test?.ok) setRowNotice({ ok: true, text: `${who}: kiểm tra thành công${body.test.warning ? `. Lưu ý: ${body.test.warning}` : ""}` });
      else setRowNotice({ ok: false, text: `${who}: kiểm tra thất bại: ${body.test?.error || "không rõ lỗi"}` });
      load();
    } catch {
      setRowNotice({ ok: false, text: "Không kết nối được máy chủ" });
    } finally {
      setTesting("");
    }
  };

  const counts = data?.counts || {};

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <div className="flex flex-col gap-1.5 border-b border-border pb-6">
        <span className="meta text-text-muted">Khách hàng</span>
        <h1 className="text-2xl font-semibold tracking-tight text-text-main">CDN ảnh</h1>
        <p className="max-w-2xl text-sm text-text-muted">
          Ảnh do model tạo ra được lưu lên CDN rồi trả link của CDN cho khách. Khách được chọn lưu trên máy chủ thì
          ảnh nằm trên ổ đĩa máy chủ. Các khách còn lại dùng CDN riêng nếu đã kết nối và
          kiểm tra thành công, không thì dùng CDN hệ thống bên dưới (nếu đang bật), không có cả hai thì model ảnh bị từ chối.
        </p>
      </div>

      <StorageConfigPanel apiBase="/api/storage/system" audience="system" onChange={load} />

      <section className="flex flex-col gap-4 border border-border bg-surface p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex max-w-2xl flex-col gap-1">
            <h2 className="meta text-text-muted">Lưu trên máy chủ</h2>
            <p className="text-sm text-text-muted">
              Khách được chọn có ảnh lưu trên ổ đĩa máy chủ (thư mục dữ liệu) và nhận link của hệ thống, bỏ qua mọi CDN.
              Bật hoặc tắt ở tab CDN ảnh của từng khách. Link dùng địa chỉ công khai trong Cài đặt (publicBaseUrl).
              Ảnh không tự xoá; khi ổ còn dưới 2 GB trống, hệ thống ngừng ghi ảnh và khách không bị tính phí lượt đó.
            </p>
          </div>
          {data ? (
            <span className="font-mono text-[12px] text-text-muted">
              <span title={`${data.localUsage?.bytes ?? 0} byte`}>
                {data.localUsage?.files ?? 0} ảnh · {formatBytes(data.localUsage?.bytes ?? 0)}
              </span>
              {data.localUsage?.freeBytes != null ? (
                <span
                  title={`${data.localUsage.freeBytes} byte`}
                  className={data.localUsage.freeBytes < data.localUsage.minFreeBytes ? " text-red-700 dark:text-red-400" : ""}
                >
                  {" "}· còn trống {formatBytes(data.localUsage.freeBytes)}
                  {data.localUsage.freeBytes < data.localUsage.minFreeBytes ? " (dưới mức tối thiểu, đã ngừng ghi ảnh)" : ""}
                </span>
              ) : null}
            </span>
          ) : null}
        </div>
        {data?.localUsers?.length ? (
          <ul className="flex flex-col divide-y divide-border border border-border">
            {data.localUsers.map((u) => (
              <li key={u.userId} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                <Link href={`/dashboard/users/${encodeURIComponent(u.userId)}?tab=storage`} className="text-text-main underline-offset-2 hover:underline">
                  {u.email}
                </Link>
                {u.name ? <span className="text-xs text-text-muted">{u.name}</span> : null}
              </li>
            ))}
          </ul>
        ) : data ? (
          <p className="text-sm text-text-muted">Chưa chọn khách nào.</p>
        ) : null}
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="meta text-text-muted">CDN của khách</h2>
          {data ? (
            <p className="text-sm text-text-muted">
              <span className="font-mono text-text-main">{data.storages.length}</span> khách đã cấu hình,{" "}
              <span className="font-mono text-text-main">{Math.max(0, data.customers - (counts.ok ?? 0) - (data.localUsers?.length ?? 0))}</span> khách chưa có CDN riêng
              hoạt động (chưa kết nối, lỗi, chưa kiểm tra hoặc đang tắt)
              {data.systemActive ? ": đang dùng CDN hệ thống." : ": không dùng được model ảnh."}
            </p>
          ) : null}
        </div>

        <div role="group" aria-label="Lọc theo trạng thái" className="flex flex-wrap gap-2">
          {FILTERS.map((f) => {
            const n = f.id === "all" ? data?.storages?.length : counts[f.id];
            const active = filter === f.id;
            return (
              <button
                key={f.id}
                type="button"
                aria-pressed={active}
                onClick={() => setFilter(f.id)}
                className={cn(
                  "flex h-8 items-center gap-2 border px-3 font-mono text-[12px]",
                  active ? "border-text-main bg-surface-2 text-text-main" : "border-border text-text-muted hover:text-text-main"
                )}
              >
                {f.label}
                <span className="font-mono text-[12px]">{n ?? 0}</span>
              </button>
            );
          })}
        </div>

        {error ? <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p> : null}
        {rowNotice ? (
          <p
            role="status"
            className={rowNotice.ok
              ? "border border-brand-500/40 bg-brand-500/5 px-4 py-2 text-sm text-brand-700 dark:text-brand-400"
              : "border border-red-500/40 bg-red-500/5 px-4 py-2 text-sm text-red-700 dark:text-red-400"}
          >
            {rowNotice.text}
          </p>
        ) : null}

        {!data && !error ? (
          <div className="h-40 animate-pulse bg-surface-2" aria-busy="true" aria-label="Đang tải" />
        ) : null}

        {data && !rows.length ? (
          <p className="border border-border px-4 py-6 text-center text-sm text-text-muted">
            {filter === "all" ? "Chưa khách nào kết nối CDN." : "Không có khách nào ở trạng thái này."}
          </p>
        ) : null}

        {rows.length ? (
          <div className="overflow-x-auto border border-border">
            <table className="w-full min-w-[900px] border-collapse text-left">
              <thead>
                <tr className="border-b border-border bg-surface-2">
                  <th scope="col" className="meta px-4 py-2.5 font-medium text-text-muted">Khách</th>
                  <th scope="col" className="meta px-4 py-2.5 font-medium text-text-muted">Kho</th>
                  <th scope="col" className="meta px-4 py-2.5 font-medium text-text-muted">Trạng thái</th>
                  <th scope="col" className="meta px-4 py-2.5 font-medium text-text-muted">Kiểm tra gần nhất</th>
                  <th scope="col" className="meta px-4 py-2.5 font-medium text-text-muted">Lỗi</th>
                  <th scope="col" className="px-4 py-2.5"><span className="sr-only">Thao tác</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const status = STATUS[row.status] || STATUS.untested;
                  return (
                    <tr key={row.userId} className="border-b border-border last:border-b-0 align-top">
                      <td className="px-4 py-3 text-sm">
                        {row.email ? (
                          <Link href={`/dashboard/users/${encodeURIComponent(row.userId)}?tab=storage`} className="text-text-main underline-offset-2 hover:underline">
                            {row.email}
                          </Link>
                        ) : (
                          <span className="font-mono text-[12px] text-text-muted">{row.userId} (đã xoá)</span>
                        )}
                        {row.name ? <div className="text-xs text-text-muted">{row.name}</div> : null}
                      </td>
                      <td className="px-4 py-3 font-mono text-[12px] text-text-main [overflow-wrap:anywhere]">
                        {row.bucket}
                        <div className="text-text-muted">{row.endpoint}</div>
                        <div className="text-text-muted">{row.publicBaseUrl || "link ký sẵn 7 ngày"}</div>
                      </td>
                      <td className="px-4 py-3"><Badge variant={status.variant} dot>{status.label}</Badge></td>
                      <td className="px-4 py-3 font-mono text-[12px] text-text-muted">
                        {row.lastTestAt ? DATE.format(new Date(row.lastTestAt)) : "—"}
                      </td>
                      <td className="max-w-[260px] px-4 py-3 text-xs text-red-700 dark:text-red-400 [overflow-wrap:anywhere]">
                        {row.lastError || <span className="text-text-muted">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => retest(row)}
                          loading={testing === row.userId}
                          disabled={Boolean(testing)}
                        >
                          Kiểm tra lại
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}
