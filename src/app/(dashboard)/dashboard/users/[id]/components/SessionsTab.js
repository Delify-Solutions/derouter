"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/shared/components";
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
        <div className="border border-border bg-surface px-6 py-10">
          <p className="font-medium text-text-main">Không có phiên nào đang mở</p>
        </div>
      ) : (
        <div className="overflow-x-auto border border-border bg-surface">
          <table className="w-full min-w-[720px] border-collapse text-left">
            <thead>
              <tr className="border-b border-border bg-surface-2">
                <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Tạo</th>
                <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Hết hạn</th>
                <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">IP</th>
                <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Thiết bị</th>
                <th scope="col" className="meta px-4 py-2 text-right font-medium text-text-muted">Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.id} className="border-b border-border last:border-b-0">
                  <td className="px-4 py-2 font-mono text-[12px] whitespace-nowrap text-text-muted">
                    {dateOf(session.createdAt)} {timeOf(session.createdAt)}
                  </td>
                  <td className="px-4 py-2 font-mono text-[12px] whitespace-nowrap text-text-muted">{dateOf(session.expiresAt)}</td>
                  <td className="px-4 py-2 font-mono text-[12px] text-text-muted">{session.ip || "—"}</td>
                  <td className="max-w-[320px] truncate px-4 py-2 font-mono text-[11px] text-text-muted" title={session.userAgent || ""}>
                    {session.userAgent || "—"}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Button size="sm" variant="ghost" className="text-danger hover:bg-red-500/10" onClick={() => setAction({ type: "one", session })}>
                      Thu hồi
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
