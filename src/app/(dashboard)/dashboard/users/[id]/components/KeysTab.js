"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Table } from "@/shared/components";
import { dateOf } from "@/shared/components/billing";
import ReasonModal from "./ReasonModal";

/**
 * `API key` — name, prefix, creation date, last use and status.
 *
 * Enable/disable and delete both require a reason and write an audit entry.
 * "Sao chép" fetches the full key on that press only (so the admin can test with
 * it) and writes a `key_revealed` audit entry; the list itself carries the prefix.
 */
export default function KeysTab({ userId }) {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [action, setAction] = useState(null); // { type: "toggle" | "delete", key }
  const [notice, setNotice] = useState("");
  const [copyState, setCopyState] = useState({}); // keyId -> "loading" | "copied"

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

  const copyKey = async (key) => {
    setError("");
    setNotice("");
    setCopyState((prev) => ({ ...prev, [key.id]: "loading" }));
    const clear = () => setCopyState((prev) => {
      const next = { ...prev };
      delete next[key.id];
      return next;
    });
    let secret;
    try {
      const res = await fetch(`/api/users/${userId}/keys/${key.id}/secret`, { method: "POST", cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.secret) throw new Error(body.error || "Không lấy được key");
      secret = body.secret;
    } catch (e) {
      clear();
      setError(e.message || "Không lấy được key");
      return;
    }
    try {
      await navigator.clipboard.writeText(secret);
    } catch {
      clear();
      setError("Trình duyệt chặn sao chép vào clipboard");
      return;
    }
    setCopyState((prev) => ({ ...prev, [key.id]: "copied" }));
    setTimeout(clear, 2000);
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
        <Card padding="lg">
          <p className="font-medium text-text-main">Khách chưa tạo API key nào</p>
          <p className="mt-1 text-sm text-text-muted">Khách tự tạo key ở trang API key của họ.</p>
        </Card>
      ) : (
        <Table className="min-w-[680px] text-left">
          <Table.Head>
            <tr>
              <Table.HeaderCell>Tên</Table.HeaderCell>
              <Table.HeaderCell>Prefix</Table.HeaderCell>
              <Table.HeaderCell>Tạo</Table.HeaderCell>
              <Table.HeaderCell>Dùng gần nhất</Table.HeaderCell>
              <Table.HeaderCell>Trạng thái</Table.HeaderCell>
              <Table.HeaderCell className="text-right">Thao tác</Table.HeaderCell>
            </tr>
          </Table.Head>
          <Table.Body>
            {keys.map((key) => (
              <Table.Row key={key.id}>
                <Table.Cell className="max-w-[200px] truncate text-sm text-text-main" title={key.name || ""}>
                  {key.name || "—"}
                </Table.Cell>
                <Table.Cell className="font-mono text-[12px] text-text-muted">{key.keyPrefix ? `${key.keyPrefix}…` : "—"}</Table.Cell>
                <Table.Cell className="font-mono text-[12px] text-text-muted">{dateOf(key.createdAt)}</Table.Cell>
                <Table.Cell className="font-mono text-[12px] text-text-muted">{dateOf(key.lastUsedAt)}</Table.Cell>
                <Table.Cell>
                  <Badge variant={key.isActive ? "success" : "default"} dot>
                    {key.isActive ? "Đang dùng" : "Đã tắt"}
                  </Badge>
                </Table.Cell>
                <Table.Cell>
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => copyKey(key)}
                      disabled={copyState[key.id] === "loading"}
                      aria-busy={copyState[key.id] === "loading"}
                    >
                      {copyState[key.id] === "copied" ? "Đã sao chép" : copyState[key.id] === "loading" ? "Đang lấy…" : "Sao chép"}
                      <span className="sr-only"> key {key.name || key.keyPrefix || ""}</span>
                      <span className="sr-only" role="status">{copyState[key.id] === "copied" ? "Đã sao chép key" : ""}</span>
                    </Button>
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
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
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
