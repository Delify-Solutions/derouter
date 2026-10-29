"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Pagination } from "@/shared/components";
import { dateOf, timeOf } from "@/shared/components/billing";

const ACTION_LABEL = {
  group_auto_assigned: "Tự gán nhóm",
  group_changed: "Đổi nhóm",
  status_changed: "Đổi trạng thái",
  profile_changed: "Sửa hồ sơ",
  note_changed: "Sửa ghi chú",
  password_reset: "Đặt lại mật khẩu",
  sessions_revoked: "Thu hồi tất cả phiên",
  session_revoked: "Thu hồi một phiên",
  key_disabled: "Tắt API key",
  key_enabled: "Bật API key",
  key_deleted: "Xoá API key",
  plan_granted: "Cấp gói",
  credit_granted: "Cấp credit",
  plan_extended: "Gia hạn gói",
  credit_adjusted: "Điều chỉnh credit",
  plan_limits_changed: "Sửa hạn mức gói",
  plan_revoked: "Thu hồi gói",
  queue_reordered: "Đổi thứ tự gói",
  user_deleted: "Xoá tài khoản",
};

/**
 * `Nhật ký` — audit entries newest first: time, actor, action, reason, and the
 * before/after details the page can show without a second lookup.
 */
export default function AuditTab({ userId }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [data, setData] = useState({ entries: [], total: 0 });
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/users/${userId}/audit?page=${page}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Không tải được nhật ký");
      setData({ entries: Array.isArray(body.entries) ? body.entries : [], total: Number(body.total) || 0 });
    } catch (e) {
      setError(e.message || "Không tải được nhật ký");
    } finally {
      setLoading(false);
    }
  }, [userId, page]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="h-40 border border-border bg-surface" aria-hidden="true" />;

  return (
    <div className="flex flex-col gap-4">
      {error && <p role="alert" className="border border-danger/40 bg-danger/5 px-4 py-2 text-sm text-danger">{error}</p>}

      {data.entries.length === 0 ? (
        <div className="border border-border bg-surface px-6 py-10">
          <p className="font-medium text-text-main">Chưa có ghi chép nào</p>
          <p className="mt-1 text-sm text-text-muted">Mọi thao tác của admin lên tài khoản này sẽ hiện ở đây.</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-px border border-border bg-border">
          {data.entries.map((entry) => (
            <li key={entry.id} className="bg-surface px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-mono text-[12px] text-text-main">
                    {ACTION_LABEL[entry.action] || entry.action}
                  </span>
                  <span className="font-mono text-[11px] text-text-subtle">{entry.actor}</span>
                </div>
                <span className="font-mono text-[11px] text-text-muted">
                  {dateOf(entry.createdAt)} {timeOf(entry.createdAt)}
                </span>
              </div>
              {entry.reason && <p className="mt-1 text-sm text-text-muted">Lý do: {entry.reason}</p>}
              {entry.details && (
                <>
                  <button
                    type="button"
                    onClick={() => setOpenId(openId === entry.id ? null : entry.id)}
                    className="mt-1 font-mono text-[10px] uppercase tracking-wider text-text-subtle hover:text-text-main"
                  >
                    {openId === entry.id ? "Ẩn chi tiết" : "Xem chi tiết"}
                  </button>
                  {openId === entry.id && (
                    <pre className="mt-2 overflow-x-auto border border-border bg-surface-2 p-2 font-mono text-[11px] text-text-muted">
{JSON.stringify(entry.details, null, 2)}
                    </pre>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center justify-between gap-3">
        <Button variant="secondary" size="sm" icon="refresh" onClick={load}>Tải lại</Button>
        {data.total > 50 && (
          <Pagination currentPage={page} pageSize={50} totalItems={data.total} onPageChange={setPage} />
        )}
      </div>
    </div>
  );
}
