"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, Table } from "@/shared/components";
import { fmtUsdNano, fmtCreditNano } from "@/shared/utils/money";

const STATUS_LABEL = {
  pending: "Chờ duyệt",
  paid: "Đã thanh toán",
  cancelled: "Đã hủy",
  expired: "Hết hạn",
  refunded: "Đã hoàn tiền",
};

const ACTIONS = {
  pending: [
    { action: "approve", label: "Duyệt", variant: "primary" },
    { action: "cancel", label: "Hủy", variant: "secondary" },
  ],
  paid: [{ action: "refund", label: "Hoàn tiền", variant: "secondary" }],
};

/**
 * `Đơn hàng` — the customer's orders with the same admin actions as the orders
 * page (approve / cancel / refund), scoped to this user.
 *
 * `GET /api/orders?userId=` already exists, so this tab adds no new endpoint; it
 * only presents the result in the context of the account being looked at.
 */
export default function OrdersTab({ userId }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/orders?userId=${encodeURIComponent(userId)}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Không tải được đơn hàng");
      setOrders(Array.isArray(body.orders) ? body.orders : []);
    } catch (e) {
      setError(e.message || "Không tải được đơn hàng");
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  const act = async (order, action) => {
    setBusyId(order.id);
    setError("");
    try {
      const res = await fetch(`/api/orders/${order.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Không thực hiện được");
      await load();
    } catch (e) {
      setError(e.message || "Không thực hiện được");
    } finally {
      setBusyId(null);
    }
  };

  if (loading) return <div className="h-40 border border-border bg-surface" aria-hidden="true" />;

  return (
    <div className="flex flex-col gap-4">
      {error && <p role="alert" className="border border-danger/40 bg-danger/5 px-4 py-2 text-sm text-danger">{error}</p>}

      {orders.length === 0 ? (
        <Card padding="lg">
          <p className="font-medium text-text-main">Chưa có đơn hàng</p>
          <p className="mt-1 text-sm text-text-muted">Đơn xuất hiện ở đây khi khách mua gói.</p>
        </Card>
      ) : (
        <Table className="min-w-[720px] text-left">
          <Table.Head>
            <tr>
              <Table.HeaderCell>Gói</Table.HeaderCell>
              <Table.HeaderCell>Số tiền</Table.HeaderCell>
              <Table.HeaderCell>Credit</Table.HeaderCell>
              <Table.HeaderCell>Trạng thái</Table.HeaderCell>
              <Table.HeaderCell>Tạo lúc</Table.HeaderCell>
              <Table.HeaderCell className="text-right">Thao tác</Table.HeaderCell>
            </tr>
          </Table.Head>
          <Table.Body>
            {orders.map((order) => (
              <Table.Row key={order.id}>
                <Table.Cell className="text-sm text-text-main">
                  {order.planName || order.planCode || "—"}
                  {order.emailSnapshot && !order.userEmail && (
                    <span className="block font-mono text-[10px] text-text-subtle">{order.emailSnapshot}</span>
                  )}
                </Table.Cell>
                <Table.Cell className="font-mono text-[12px] text-text-main">{fmtUsdNano(order.amountNanoUsd)}</Table.Cell>
                <Table.Cell className="font-mono text-[12px] text-text-muted">{fmtCreditNano(order.creditNanoUsd, order.unlimitedCredit)}</Table.Cell>
                <Table.Cell className="font-mono text-[12px] text-text-muted">{STATUS_LABEL[order.status] || order.status}</Table.Cell>
                <Table.Cell className="font-mono text-[12px] text-text-muted">
                  {order.createdAt ? new Date(order.createdAt).toLocaleDateString("vi-VN") : "—"}
                </Table.Cell>
                <Table.Cell>
                  <div className="flex items-center justify-end gap-1">
                    {(ACTIONS[order.status] || []).map((item) => (
                      <Button
                        key={item.action}
                        size="sm"
                        variant={item.variant}
                        disabled={busyId === order.id}
                        onClick={() => act(order, item.action)}
                      >
                        {item.label}
                      </Button>
                    ))}
                  </div>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}
    </div>
  );
}
