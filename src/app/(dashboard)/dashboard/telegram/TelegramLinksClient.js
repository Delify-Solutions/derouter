"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Badge, Button, CardSkeleton, Input, Pagination, Table } from "@/shared/components";
import ReasonModal from "../users/[id]/components/ReasonModal";

const PAGE_SIZE = 25;
const DATE = new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short" });

function fmt(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : DATE.format(d);
}

/**
 * "Tài khoản đã liên kết" on the Telegram admin page (change telegram-admin):
 * every account with a linked Telegram user, searchable, each with "Gỡ liên kết"
 * (reason required, audited, the Telegram user is told).
 */
export default function TelegramLinksClient() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  // The query actually sent, 300 ms after the last keystroke.
  const [query, setQuery] = useState("");
  const seq = useRef(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [unlinking, setUnlinking] = useState(null);

  useEffect(() => {
    const timer = setTimeout(() => { setQuery(q.trim()); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [q]);

  const load = useCallback(async () => {
    // Only the latest request may write, so a slow answer for an older search
    // never replaces the current one.
    const mine = ++seq.current;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) });
      if (query) params.set("q", query);
      const res = await fetch(`/api/telegram-links?${params.toString()}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (mine !== seq.current) return;
      if (!res.ok) throw new Error(body.error || "Không tải được danh sách");
      const nextTotal = Number(body.total) || 0;
      const lastPage = Math.max(1, Math.ceil(nextTotal / PAGE_SIZE));
      // The last row of the last page was unlinked: step back a page.
      if (page > lastPage) {
        setPage(lastPage);
        return;
      }
      setRows(Array.isArray(body.links) ? body.links : []);
      setTotal(nextTotal);
    } catch (e) {
      if (mine !== seq.current) return;
      setError(e.message || "Không tải được danh sách");
      setRows([]);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [page, query]);

  useEffect(() => { load(); }, [load]);

  const unlink = async ({ reason }) => {
    const row = unlinking;
    const res = await fetch(`/api/users/${row.userId}/telegram`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body.error || "Không gỡ được liên kết" };
    setNotice(`Đã gỡ liên kết Telegram của ${row.email}.`);
    load();
    return { ok: true };
  };

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-text-main">Tài khoản đã liên kết</h2>
        <p className="max-w-2xl text-sm text-text-muted">
          Gỡ liên kết khi Telegram bị dùng sai (liên kết nhầm, tài khoản Telegram của người khác). Khách có thể liên kết lại;
          mã quà người mới đã nhận vẫn ghi nhận Telegram cũ nên không nhận lại được.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Input
          label="Tìm"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="email, @username, ID"
        />
        <Button variant="secondary" icon="refresh" onClick={load}>Tải lại</Button>
      </div>

      {notice ? (
        <p role="status" className="border border-brand-500/40 bg-brand-500/5 px-4 py-2 text-sm text-brand-700 dark:text-brand-400">{notice}</p>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>
      ) : loading ? (
        <CardSkeleton />
      ) : rows.length === 0 ? (
        <p className="border border-dashed border-border px-6 py-10 text-center text-sm text-text-muted">
          {query ? "Không có tài khoản nào khớp." : "Chưa có tài khoản nào liên kết Telegram."}
        </p>
      ) : (
        <Table className="min-w-[760px]">
          <Table.Head>
            <Table.Row>
              {["Tài khoản", "Telegram", "Liên kết lúc", "Trạng thái", ""].map((label) => (
                <Table.HeaderCell key={label}>{label}</Table.HeaderCell>
              ))}
            </Table.Row>
          </Table.Head>
          <Table.Body>
            {rows.map((row) => (
              <Table.Row key={row.userId}>
                <Table.Cell>
                  <Link href={`/dashboard/users/${row.userId}`} className="font-mono text-[12px] text-text-main underline-offset-4 hover:underline">
                    {row.email}
                  </Link>
                  {row.displayName ? <p className="text-xs text-text-muted">{row.displayName}</p> : null}
                </Table.Cell>
                <Table.Cell className="font-mono text-[12px] text-text-main">
                  {row.telegramUsername ? `@${row.telegramUsername}` : "—"}
                  <p className="text-xs text-text-muted">ID {row.telegramUserId}</p>
                </Table.Cell>
                <Table.Cell className="font-mono text-[12px] text-text-muted whitespace-nowrap">{fmt(row.linkedAt)}</Table.Cell>
                <Table.Cell>
                  {row.dmBlockedAt
                    ? <Badge variant="warning" dot>Bot bị chặn</Badge>
                    : <Badge dot>Chưa ghi nhận lỗi</Badge>}
                </Table.Cell>
                <Table.Cell className="text-right">
                  <Button size="sm" variant="secondary" onClick={() => { setNotice(""); setUnlinking(row); }}>Gỡ liên kết</Button>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}

      {total > PAGE_SIZE ? (
        <Pagination currentPage={page} pageSize={PAGE_SIZE} totalItems={total} onPageChange={setPage} />
      ) : null}

      <ReasonModal
        isOpen={Boolean(unlinking)}
        title={`Gỡ liên kết Telegram · ${unlinking?.email || ""}`}
        description={unlinking
          ? `Tài khoản Telegram ${unlinking.telegramUsername ? `@${unlinking.telegramUsername}` : unlinking.telegramUserId} sẽ thôi nhận thông báo và được báo về việc gỡ. Khách có thể liên kết lại.`
          : ""}
        confirmLabel="Gỡ liên kết"
        onClose={() => setUnlinking(null)}
        onConfirm={unlink}
      />
    </section>
  );
}
