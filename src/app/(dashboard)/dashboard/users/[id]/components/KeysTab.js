"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/shared/components";
import { dateOf } from "@/shared/components/billing";
import ReasonModal from "./ReasonModal";

/**
 * `API key` — name, prefix, creation date, last use and status.
 *
 * Enable/disable and delete both require a reason and write an audit entry; the
 * secret itself is never returned by any admin endpoint (only the 8-character
 * prefix the row already carries).
 */
export default function KeysTab({ userId }) {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [action, setAction] = useState(null); // { type: "toggle" | "delete", key }
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/users/${userId}/keys`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Không tải được API key");
      setKeys(Array.isArray(body.keys) ? body.keys : []);
    } catch (e) {
      setError(e.message || "Không tải được API key");
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  const submit = async ({ reason }) => {
    const { type, key } = action;
    const res = type === "delete"
      ? await fetch(`/api/users/${userId}/keys/${key.id}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        })
      : await fetch(`/api/users/${userId}/keys/${key.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive: !key.isActive, reason }),
        });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body.error || "Không thực hiện được" };
    await load();
    setNotice(type === "delete" ? "Đã xóa key" : key.isActive ? "Đã tắt key" : "Đã bật key");
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

      {keys.length === 0 ? (
        <div className="border border-border bg-surface px-6 py-10">
          <p className="font-medium text-text-main">Khách chưa tạo API key nào</p>
          <p className="mt-1 text-sm text-text-muted">Khách tự tạo key ở trang API key của họ.</p>
        </div>
      ) : (
        <div className="overflow-x-auto border border-border bg-surface">
          <table className="w-full min-w-[680px] border-collapse text-left">
            <thead>
              <tr className="border-b border-border bg-surface-2">
                <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Tên</th>
                <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Prefix</th>
                <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Tạo</th>
                <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Dùng gần nhất</th>
                <th scope="col" className="meta px-4 py-2 font-medium text-text-muted">Trạng thái</th>
                <th scope="col" className="meta px-4 py-2 text-right font-medium text-text-muted">Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id} className="border-b border-border last:border-b-0">
                  <td className="max-w-[200px] truncate px-4 py-2 text-sm text-text-main" title={key.name || ""}>
                    {key.name || "—"}
                  </td>
                  <td className="px-4 py-2 font-mono text-[12px] text-text-muted">{key.keyPrefix ? `${key.keyPrefix}…` : "—"}</td>
                  <td className="px-4 py-2 font-mono text-[12px] text-text-muted">{dateOf(key.createdAt)}</td>
                  <td className="px-4 py-2 font-mono text-[12px] text-text-muted">{dateOf(key.lastUsedAt)}</td>
                  <td className="px-4 py-2 font-mono text-[12px]">
                    <span className={key.isActive ? "text-brand-700 dark:text-brand-400" : "text-text-muted"}>
                      {key.isActive ? "Đang dùng" : "Đã tắt"}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center justify-end gap-1">
                      <Button size="sm" variant="secondary" onClick={() => setAction({ type: "toggle", key })}>
                        {key.isActive ? "Tắt" : "Bật"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-danger hover:bg-red-500/10"
                        onClick={() => setAction({ type: "delete", key })}
                      >
                        Xóa
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ReasonModal
        isOpen={!!action}
        title={action?.type === "delete" ? "Xóa API key" : action?.key?.isActive ? "Tắt API key" : "Bật API key"}
        description={
          action?.type === "delete"
            ? `Key ${action?.key?.name || action?.key?.keyPrefix || ""} sẽ ngừng hoạt động ngay và không thể khôi phục.`
            : `Key ${action?.key?.name || action?.key?.keyPrefix || ""} — hiệu lực từ request kế tiếp.`
        }
        confirmLabel={action?.type === "delete" ? "Xóa key" : "Xác nhận"}
        onClose={() => setAction(null)}
        onConfirm={submit}
      />
    </div>
  );
}
