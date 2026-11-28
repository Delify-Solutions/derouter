"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, Table } from "@/shared/components";
import { dateOf, timeOf } from "@/shared/components/billing";
import ReasonModal from "./ReasonModal";

/** `Phiên đăng nhập` — creation, expiry, IP and user agent of each open session. */
export default function SessionsTab({ userId }) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [action, setAction] = useState(null); // { type: "one" | "all", session }
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/users/${userId}/sessions`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Không tải được phiên đăng nhập");
      setSessions(Array.isArray(body.sessions) ? body.sessions : []);
    } catch (e) {
      setError(e.message || "Không tải được phiên đăng nhập");
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  const submit = async ({ reason }) => {
    const { type, session } = action;
    const res = type === "all"
      ? await fetch(`/api/users/${userId}/sessions`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        })
      : await fetch(`/api/users/${userId}/sessions/${session.id}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body.error || "Không thu hồi được" };
    await load();
    setNotice(type === "all" ? `Đã thu hồi ${body.revokedSessions ?? 0} phiên` : "Đã thu hồi phiên");
    return { ok: true };
  };

  if (loading) return <div className="h-40 border border-border bg-surface" aria-hidden="true" />;

  return (
    <div className="flex flex-col gap-4">
      {error && <p role="alert" className="border border-danger/40 bg-danger/5 px-4 py-2 text-sm text-danger">{error}</p>}
      {notice && (
        <p role="status" className="border border-brand-500/40 bg-brand-500/5 px-4 py-2 text-sm text-brand-700 dark:text-brand-400">
          {notice}
        </p>
      )}

      {sessions.length > 0 && (
        <div>
          <Button size="sm" variant="secondary" icon="logout" onClick={() => setAction({ type: "all" })}>
            Thu hồi tất cả phiên
          </Button>
        </div>
      )}

      {sessions.length === 0 ? (
        <Card padding="lg">
          <p className="font-medium text-text-main">Không có phiên nào đang mở</p>
        </Card>
      ) : (
        <Table className="min-w-[720px] text-left">
          <Table.Head>
            <tr>
              <Table.HeaderCell>Tạo</Table.HeaderCell>
              <Table.HeaderCell>Hết hạn</Table.HeaderCell>
              <Table.HeaderCell>IP</Table.HeaderCell>
              <Table.HeaderCell>Thiết bị</Table.HeaderCell>
              <Table.HeaderCell className="text-right">Thao tác</Table.HeaderCell>
            </tr>
          </Table.Head>
          <Table.Body>
            {sessions.map((session) => (
              <Table.Row key={session.id}>
                <Table.Cell className="font-mono text-[12px] whitespace-nowrap text-text-muted">
                  {dateOf(session.createdAt)} {timeOf(session.createdAt)}
                </Table.Cell>
                <Table.Cell className="font-mono text-[12px] whitespace-nowrap text-text-muted">{dateOf(session.expiresAt)}</Table.Cell>
                <Table.Cell className="font-mono text-[12px] text-text-muted">{session.ip || "—"}</Table.Cell>
                <Table.Cell className="max-w-[320px] truncate font-mono text-[11px] text-text-muted" title={session.userAgent || ""}>
                  {session.userAgent || "—"}
                </Table.Cell>
                <Table.Cell className="text-right">
                  <Button size="sm" variant="ghost" className="text-danger hover:bg-red-500/10" onClick={() => setAction({ type: "one", session })}>
                    Thu hồi
                  </Button>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}

      <ReasonModal
        isOpen={!!action}
        title={action?.type === "all" ? "Thu hồi tất cả phiên" : "Thu hồi một phiên"}
        description={
          action?.type === "all"
            ? "Mọi thiết bị của khách sẽ bị đăng xuất ngay."
            : "Thiết bị này sẽ bị đăng xuất ngay."
        }
        confirmLabel="Thu hồi"
        onClose={() => setAction(null)}
        onConfirm={submit}
      />
    </div>
  );
}
