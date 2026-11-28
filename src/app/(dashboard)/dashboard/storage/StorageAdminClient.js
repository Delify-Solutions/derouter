"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Badge, Button, Card, CardSkeleton, Table, Toast } from "@/shared/components";
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

      <Card padding="sm" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex max-w-2xl flex-col gap-1">
            <h2 className="meta text-vx-text-muted">Lưu trên máy chủ</h2>
            <p className="text-sm text-vx-text-muted">
              Khách được chọn có ảnh lưu trên ổ đĩa máy chủ (thư mục dữ liệu) và nhận link của hệ thống, bỏ qua mọi CDN.
              Bật hoặc tắt ở tab CDN ảnh của từng khách. Link dùng địa chỉ công khai trong Cài đặt (publicBaseUrl).
              Ảnh không tự xoá; khi ổ còn dưới 2 GB trống, hệ thống ngừng ghi ảnh và khách không bị tính phí lượt đó.
            </p>
          </div>
          {data ? (
            <span className="font-mono text-[12px] text-vx-text-muted">
              <span title={`${data.localUsage?.bytes ?? 0} byte`}>
                {data.localUsage?.files ?? 0} ảnh · {formatBytes(data.localUsage?.bytes ?? 0)}
              </span>
              {data.localUsage?.freeBytes != null ? (
                <span
                  title={`${data.localUsage.freeBytes} byte`}
                  className={data.localUsage.freeBytes < data.localUsage.minFreeBytes ? " text-vx-danger" : ""}
                >
                  {" "}· còn trống {formatBytes(data.localUsage.freeBytes)}
                  {data.localUsage.freeBytes < data.localUsage.minFreeBytes ? " (dưới mức tối thiểu, đã ngừng ghi ảnh)" : ""}
                </span>
              ) : null}
            </span>
          ) : null}
        </div>
        {data?.localUsers?.length ? (
          <ul className="flex flex-col divide-y divide-vx-border rounded-vx-md border border-vx-border">
            {data.localUsers.map((u) => (
              <li key={u.userId} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                <Link href={`/dashboard/users/${encodeURIComponent(u.userId)}?tab=storage`} className="text-vx-text underline-offset-2 hover:underline">
                  {u.email}
                </Link>
                {u.name ? <span className="text-xs text-vx-text-muted">{u.name}</span> : null}
              </li>
            ))}
          </ul>
        ) : data ? (
          <p className="text-sm text-vx-text-muted">Chưa chọn khách nào.</p>
        ) : null}
      </Card>

      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="meta text-vx-text-muted">CDN của khách</h2>
          {data ? (
            <p className="text-sm text-vx-text-muted">
              <span className="font-mono text-vx-text">{data.storages.length}</span> khách đã cấu hình,{" "}
              <span className="font-mono text-vx-text">{Math.max(0, data.customers - (counts.ok ?? 0) - (data.localUsers?.length ?? 0))}</span> khách chưa có CDN riêng
              hoạt động (chưa kết nối, lỗi, chưa kiểm tra hoặc đang tắt)
              {data.systemActive ? ": đang dùng CDN hệ thống." : ": không dùng được model ảnh."}
            </p>
          ) : null}
        </div>

        <div
          role="group"
          aria-label="Lọc theo trạng thái"
          className="flex flex-wrap items-center gap-1 rounded-vx-md bg-vx-surface-2 p-1 w-fit"
        >
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
                  "flex h-8 items-center gap-2 rounded-vx-sm px-3 text-xs font-medium transition-colors",
                  active ? "bg-vx-primary text-white" : "text-vx-text-muted hover:text-vx-text hover:bg-vx-surface-3"
                )}
              >
                {f.label}
                <span className="font-mono text-[12px]">{n ?? 0}</span>
              </button>
            );
          })}
        </div>

        {error ? <Toast type="error" message={error} dismissible={false} /> : null}
        {rowNotice ? (
          <Toast
            type={rowNotice.ok ? "success" : "error"}
            message={rowNotice.text}
            onDismiss={() => setRowNotice(null)}
          />
        ) : null}

        {!data && !error ? <CardSkeleton /> : null}

        {data && !rows.length ? (
          <Card padding="none" className="flex flex-col items-center text-center gap-3 px-6 py-16">
            <span className="material-symbols-outlined text-[32px] text-vx-text-subtle">cloud_off</span>
            <p className="text-sm text-vx-text-muted">
              {filter === "all" ? "Chưa khách nào kết nối CDN." : "Không có khách nào ở trạng thái này."}
            </p>
          </Card>
        ) : null}

        {rows.length ? (
          <Table className="min-w-[900px]">
            <Table.Head>
              <tr>
                <Table.HeaderCell>Khách</Table.HeaderCell>
                <Table.HeaderCell>Kho</Table.HeaderCell>
                <Table.HeaderCell>Trạng thái</Table.HeaderCell>
                <Table.HeaderCell>Kiểm tra gần nhất</Table.HeaderCell>
                <Table.HeaderCell>Lỗi</Table.HeaderCell>
                <Table.HeaderCell><span className="sr-only">Thao tác</span></Table.HeaderCell>
              </tr>
            </Table.Head>
            <Table.Body>
              {rows.map((row) => {
                const status = STATUS[row.status] || STATUS.untested;
                return (
                  <Table.Row key={row.userId} className="align-top">
                    <Table.Cell className="text-sm">
                      {row.email ? (
                        <Link href={`/dashboard/users/${encodeURIComponent(row.userId)}?tab=storage`} className="text-vx-text underline-offset-2 hover:underline">
                          {row.email}
                        </Link>
                      ) : (
                        <span className="font-mono text-[12px] text-vx-text-muted">{row.userId} (đã xoá)</span>
                      )}
                      {row.name ? <div className="text-xs text-vx-text-muted">{row.name}</div> : null}
                    </Table.Cell>
                    <Table.Cell className="font-mono text-[12px] text-vx-text [overflow-wrap:anywhere]">
                      {row.bucket}
                      <div className="text-vx-text-muted">{row.endpoint}</div>
                      <div className="text-vx-text-muted">{row.publicBaseUrl || "link ký sẵn 7 ngày"}</div>
                    </Table.Cell>
                    <Table.Cell><Badge variant={status.variant} dot>{status.label}</Badge></Table.Cell>
                    <Table.Cell className="font-mono text-[12px] text-vx-text-muted">
                      {row.lastTestAt ? DATE.format(new Date(row.lastTestAt)) : "—"}
                    </Table.Cell>
                    <Table.Cell className="max-w-[260px] text-xs text-vx-danger [overflow-wrap:anywhere]">
                      {row.lastError || <span className="text-vx-text-muted">—</span>}
                    </Table.Cell>
                    <Table.Cell className="text-right">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => retest(row)}
                        loading={testing === row.userId}
                        disabled={Boolean(testing)}
                      >
                        Kiểm tra lại
                      </Button>
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        ) : null}
      </section>
    </div>
  );
}
