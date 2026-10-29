"use client";

import Link from "next/link";

// Vietnamese label AND styling: a customer should never see the raw status word.
const STATUS_TAG = {
  pending: { cls: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400", label: "Chờ duyệt" },
  paid: { cls: "border-brand-500/30 bg-brand-500/10 text-brand-700 dark:text-brand-400", label: "Đã thanh toán" },
  cancelled: { cls: "border-border bg-surface-2 text-text-muted", label: "Đã huỷ" },
  // A gateway order whose payment window closed unpaid. Separate from "Đã huỷ"
  // because the customer did not cancel it — the code simply stopped being valid.
  expired: { cls: "border-warning/40 bg-warning/10 text-warning", label: "Hết hạn" },
  refunded: { cls: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400", label: "Đã hoàn tiền" },
};

function fmtDate(value) {
  if (!value) return "—";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleDateString("vi-VN", {
    year: "numeric", month: "2-digit", day: "2-digit",
  });
}

/** "250.000đ" / "10.5 USDT" / "$10" — the amount in the order's own currency. */
function payAmountLabel(order) {
  const amount = Number(order.payAmount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (order.payCurrency === "VND") {
    const digits = String(Math.round(amount));
    let out = "";
    for (let i = 0; i < digits.length; i += 1) {
      if (i > 0 && (digits.length - i) % 3 === 0) out += ".";
      out += digits[i];
    }
    return `${out}đ`;
  }
  if (order.payCurrency === "USDT") {
    const whole = Math.floor(amount / 1e9);
    const frac = String(amount % 1e9).padStart(9, "0").replace(/0+$/, "");
    return `${whole}${frac ? `.${frac}` : ""} USDT`;
  }
  return null;
}

/**
 * The customer's own orders. Pending rows can be cancelled here; that is the only
 * mutation a customer has over an order.
 */
export default function MyOrders({ orders, loading, cancellingId, onCancel }) {
  if (loading) {
    return (
      <section className="flex flex-col gap-3">
        <span className="meta text-text-muted">Đơn hàng</span>
        <div className="h-[120px] border border-border bg-surface-2/50" aria-hidden="true" />
      </section>
    );
  }

  if (!orders.length) {
    return (
      <section className="flex flex-col gap-3">
        <span className="meta text-text-muted">Đơn hàng</span>
        <div className="border border-border px-6 py-8 flex flex-col items-center text-center gap-1.5">
          <span className="material-symbols-outlined text-[24px] text-text-subtle">receipt_long</span>
          <p className="text-sm text-text-main font-medium">Chưa có đơn hàng</p>
          <p className="text-sm text-text-muted">Mua một gói sẽ tạo đơn ở đây và chờ admin duyệt.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <span className="meta text-text-muted">Đơn hàng</span>
      <div className="overflow-x-auto border border-border">
        <table className="w-full min-w-[640px] border-collapse">
          <thead>
            <tr className="border-b border-border bg-surface-2">
              {["Gói", "Số tiền", "Credit", "Trạng thái", "Tạo lúc", ""].map((h) => (
                <th key={h || "action"} className="meta text-text-subtle text-left font-medium px-4 py-2.5 whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.id} className="border-b border-border last:border-b-0">
                <td className="px-4 py-3 text-sm text-text-main whitespace-nowrap">
                  <span className="block">{order.planName || "—"}</span>
                  {order.planCode && (
                    <span className="block font-mono text-[10px] uppercase tracking-wider text-text-subtle">
                      {order.planCode}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 font-mono text-[12px] text-text-main whitespace-nowrap">
                  {/* What the customer actually has to pay, in the currency they
                      chose. A gateway order is not "$10" — it may be 250.000đ. */}
                  {payAmountLabel(order) || order.amountUsd}
                </td>
                <td className="px-4 py-3 font-mono text-[12px] text-text-muted whitespace-nowrap">
                  {order.creditUsd}
                </td>
                <td className="px-4 py-3 whitespace-nowrap">
                  <span
                    className={`inline-flex items-center border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                      (STATUS_TAG[order.status] || STATUS_TAG.cancelled).cls
                    }`}
                  >
                    {(STATUS_TAG[order.status] || STATUS_TAG.cancelled).label}
                  </span>
                </td>
                <td className="px-4 py-3 font-mono text-[11px] text-text-muted whitespace-nowrap">
                  {fmtDate(order.createdAt)}
                </td>
                <td className="px-4 py-3 text-right">
                  {/* A gateway order has a page with the QR and the code; without
                      this link the customer has no way back to it. */}
                  {order.paymentCode && order.method !== "manual" && (
                    <Link
                      href={`/account/orders/${order.id}`}
                      className="mr-2 inline-flex h-8 items-center border border-border px-3 font-mono text-[10px] uppercase tracking-[0.12em] text-text-main transition-colors hover:bg-surface-2"
                    >
                      {order.status === "pending" ? "Thanh toán" : "Xem đơn"}
                    </Link>
                  )}
                  {order.status === "pending" && (
                    <button
                      type="button"
                      onClick={() => onCancel(order)}
                      disabled={cancellingId === order.id}
                      className="h-8 px-3 border border-border font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted transition-colors hover:border-danger hover:text-danger disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {cancellingId === order.id ? "Đang huỷ…" : "Huỷ đơn"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
