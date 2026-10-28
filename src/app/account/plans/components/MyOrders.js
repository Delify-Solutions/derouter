"use client";

const STATUS_TAG = {
  pending: "border-warning/30 bg-warning/10 text-warning",
  paid: "border-brand-500/30 bg-brand-500/10 text-brand-700 dark:text-brand-400",
  cancelled: "border-border bg-surface-2 text-text-muted",
  refunded: "border-info/30 bg-info/10 text-info",
};

function fmtDate(value) {
  if (!value) return "—";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "2-digit",
  });
}

/**
 * The customer's own orders. Pending rows can be cancelled here; that is the
 * only mutation a customer has over an order.
 */
export default function MyOrders({ orders, loading, cancellingId, onCancel }) {
  if (loading) {
    return (
      <section className="flex flex-col gap-3">
        <span className="meta text-text-muted">Your orders</span>
        <div className="h-[120px] border border-border bg-surface-2/50" aria-hidden="true" />
      </section>
    );
  }

  if (!orders.length) {
    return (
      <section className="flex flex-col gap-3">
        <span className="meta text-text-muted">Your orders</span>
        <div className="border border-border px-6 py-8 flex flex-col items-center text-center gap-1.5">
          <span className="material-symbols-outlined text-[24px] text-text-subtle">receipt_long</span>
          <p className="text-sm text-text-main font-medium">No orders</p>
          <p className="text-sm text-text-muted">Buying a plan creates one here, awaiting approval.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <span className="meta text-text-muted">Your orders</span>
      <div className="overflow-x-auto border border-border">
        <table className="w-full min-w-[640px] border-collapse">
          <thead>
            <tr className="border-b border-border bg-surface-2">
              {["Plan", "Amount", "Credit", "Status", "Created", ""].map((h) => (
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
                  {order.amountUsd}
                </td>
                <td className="px-4 py-3 font-mono text-[12px] text-text-muted whitespace-nowrap">
                  {order.creditUsd}
                </td>
                <td className="px-4 py-3 whitespace-nowrap">
                  <span
                    className={`inline-flex items-center border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                      STATUS_TAG[order.status] || STATUS_TAG.cancelled
                    }`}
                  >
                    {order.status}
                  </span>
                </td>
                <td className="px-4 py-3 font-mono text-[11px] text-text-muted whitespace-nowrap">
                  {fmtDate(order.createdAt)}
                </td>
                <td className="px-4 py-3 text-right">
                  {order.status === "pending" && (
                    <button
                      type="button"
                      onClick={() => onCancel(order)}
                      disabled={cancellingId === order.id}
                      className="h-8 px-3 border border-border font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted transition-colors hover:border-danger hover:text-danger disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {cancellingId === order.id ? "Cancelling…" : "Cancel"}
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
