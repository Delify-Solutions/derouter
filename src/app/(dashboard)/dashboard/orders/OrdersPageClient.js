"use client";

import { useState, useEffect, useCallback } from "react";
import { Badge, Button, Card, CardSkeleton, ConfirmModal, Table, Toast } from "@/shared/components";
import Drawer from "@/shared/components/Drawer";
import { fmtUsdNano, fmtCreditNano } from "@/shared/utils/money";

const FILTERS = [
  { value: "", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "paid", label: "Paid" },
  { value: "cancelled", label: "Cancelled" },
  { value: "expired", label: "Expired" },
  { value: "refunded", label: "Refunded" },
];

const STATUS_VARIANT = {
  pending: "warning",
  paid: "success",
  cancelled: "default",
  expired: "warning",
  refunded: "info",
};

function StatusTag({ status }) {
  const variant = STATUS_VARIANT[status] || "default";
  return (
    <Badge variant={variant} size="sm" className="capitalize">
      {status}
    </Badge>
  );
}

function shortId(id) {
  return id ? String(id).slice(0, 8) : "—";
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

export default function OrdersPageClient() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [status, setStatus] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [actionError, setActionError] = useState("");
  const [confirmState, setConfirmState] = useState(null);
  const [adminNote, setAdminNote] = useState("");

  const loadOrders = useCallback(async (filter) => {
    setLoadError("");
    try {
      const qs = filter ? `?status=${encodeURIComponent(filter)}` : "";
      const res = await fetch(`/api/orders${qs}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to load orders");
      setOrders(Array.isArray(data.orders) ? data.orders : []);
    } catch (e) {
      setLoadError(e.message || "Failed to load orders");
      setOrders([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { loadOrders(status); }, [loadOrders, status]);

  // Switching a filter re-queries but must not unmount the page: the filter row
  // is the control the user just touched, and flashing a skeleton would take it
  // away mid-interaction.
  const changeFilter = (value) => {
    if (value === status) return;
    setRefreshing(true);
    setStatus(value);
  };

  const runAction = async (order, action, note) => {
    setBusyId(order.id);
    setActionError("");
    try {
      const res = await fetch(`/api/orders/${order.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, adminNote: note || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Failed to ${action} order`);
      setSelected(null);
      setAdminNote("");
      await loadOrders(status);
    } catch (e) {
      setActionError(e.message || `Failed to ${action} order`);
    } finally {
      setBusyId(null);
    }
  };

  const confirmAction = (order, action) => {
    const copy = {
      approve: {
        title: "Approve order",
        message: `Mark payment received for ${order.userEmail || "this customer"}? Their plan and ${order.unlimitedCredit ? "unlimited credit" : `${fmtUsdNano(order.creditNanoUsd)} of credit`}${order.periods > 1 ? ` per period × ${order.periods} periods` : ""} are granted immediately.`,
        confirmText: "Approve",
        variant: "success",
      },
      cancel: {
        title: "Cancel order",
        message: "Cancel this pending order? The customer can place a new one.",
        confirmText: "Cancel order",
        variant: "danger",
      },
      refund: {
        title: "Refund order",
        message: `Refund ${fmtUsdNano(order.amountNanoUsd)}? The order becomes refunded and the unspent credit from this order is taken back from the customer.`,
        confirmText: "Refund",
        variant: "danger",
      },
    }[action];

    setConfirmState({
      ...copy,
      onConfirm: async () => {
        setConfirmState(null);
        await runAction(order, action, adminNote);
      },
    });
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-6 max-w-7xl">
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8 max-w-7xl">
      <header className="flex flex-wrap items-end justify-between gap-4 pb-6 border-b border-vx-border">
        <div className="flex flex-col gap-1.5">
          <span className="meta text-vx-text-subtle">Billing</span>
          <h1 className="text-2xl font-semibold text-vx-heading">Orders</h1>
          <p className="text-sm text-vx-text-muted max-w-xl">
            Manual transfers. Approving an order grants its snapshotted credit; refunding takes that credit back.
          </p>
        </div>
        <Button
          variant="secondary"
          icon="refresh"
          size="sm"
          onClick={() => loadOrders(status)}
        >
          Refresh
        </Button>
      </header>

      {/* Status filter. The list is filtered server-side, so a per-status count
          would only describe the rows already on screen — it is deliberately not
          shown. `refreshing` marks the re-query without unmounting the control. */}
      <div className="flex flex-wrap items-center gap-3">
        <div
          className={`flex flex-wrap items-center gap-1 rounded-vx-md bg-vx-surface-2 p-1 w-fit transition-opacity ${
            refreshing ? "opacity-60" : ""
          }`}
        >
          {FILTERS.map((f) => {
            const active = status === f.value;
            return (
              <button
                key={f.value || "all"}
                type="button"
                onClick={() => changeFilter(f.value)}
                aria-pressed={active}
                className={`px-4 h-8 rounded-vx-sm text-xs font-medium transition-colors ${
                  active
                    ? "bg-vx-primary text-white"
                    : "text-vx-text-muted hover:text-vx-text hover:bg-vx-surface-3"
                }`}
              >
                {f.label}
              </button>
            );
          })}
        </div>
        {refreshing && (
          <span className="text-xs font-medium uppercase tracking-wide text-vx-text-subtle">
            Loading…
          </span>
        )}
      </div>

      {loadError && (
        <div className="flex items-start gap-3">
          <Toast type="error" message={loadError} dismissible={false} className="flex-1" />
          <Button size="sm" variant="ghost" onClick={() => loadOrders(status)}>Retry</Button>
        </div>
      )}

      {actionError && (
        <Toast type="error" message={actionError} onDismiss={() => setActionError("")} />
      )}

      {orders.length === 0 ? (
        <Card padding="none" className="flex flex-col items-center text-center gap-3 px-6 py-16">
          <span className="material-symbols-outlined text-[32px] text-vx-text-subtle">receipt_long</span>
          <p className="text-vx-heading font-medium">
            {status ? `No ${status} orders` : "No orders yet"}
          </p>
          <p className="text-sm text-vx-text-muted max-w-sm">
            {status
              ? "Try another status, or check All."
              : "Orders appear here when a customer asks to buy a plan. Approving one grants the credit."}
          </p>
          {status && (
            <Button size="sm" variant="secondary" onClick={() => changeFilter("")}>
              Show all
            </Button>
          )}
        </Card>
      ) : (
        <Table className="min-w-[860px]">
          <Table.Head>
            <tr>
              {["Order", "Customer", "Plan", "Amount", "Credit", "Status", "Created", ""].map((h) => (
                <Table.HeaderCell key={h || "actions"} className="whitespace-nowrap">
                  {h}
                </Table.HeaderCell>
              ))}
            </tr>
          </Table.Head>
          <Table.Body>
            {orders.map((order) => (
              <Table.Row key={order.id}>
                <Table.Cell className="font-mono text-[12px] text-vx-text-muted whitespace-nowrap">
                  {shortId(order.id)}
                </Table.Cell>
                <Table.Cell className="text-sm">
                  <span className="block truncate max-w-[220px]">{order.userEmail || order.userId}</span>
                  {order.userDisplayName && (
                    <span className="block text-[11px] text-vx-text-subtle truncate max-w-[220px]">
                      {order.userDisplayName}
                    </span>
                  )}
                </Table.Cell>
                <Table.Cell className="text-sm whitespace-nowrap">
                  <span className="block">{order.planName || "—"}</span>
                  {order.planCode && (
                    <span className="block font-mono text-[10px] uppercase tracking-wider text-vx-text-subtle">
                      {order.planCode}
                    </span>
                  )}
                </Table.Cell>
                <Table.Cell className="font-mono text-[12px] whitespace-nowrap">
                  {fmtUsdNano(order.amountNanoUsd)}
                </Table.Cell>
                <Table.Cell className="font-mono text-[12px] text-vx-text-muted whitespace-nowrap">
                  {fmtCreditNano(order.creditNanoUsd, order.unlimitedCredit)}
                  {order.periods > 1 ? ` × ${order.periods}` : ""}
                </Table.Cell>
                <Table.Cell className="whitespace-nowrap">
                  <StatusTag status={order.status} />
                </Table.Cell>
                <Table.Cell className="font-mono text-[11px] text-vx-text-muted whitespace-nowrap">
                  {formatDate(order.createdAt)}
                </Table.Cell>
                <Table.Cell>
                  <div className="flex items-center justify-end gap-1">
                    {order.status === "pending" && (
                      <>
                        <Button
                          size="sm"
                          variant="success"
                          onClick={() => confirmAction(order, "approve")}
                          disabled={busyId === order.id}
                          loading={busyId === order.id}
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => confirmAction(order, "cancel")}
                          disabled={busyId === order.id}
                        >
                          Cancel
                        </Button>
                      </>
                    )}
                    {order.status === "paid" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => confirmAction(order, "refund")}
                        disabled={busyId === order.id}
                      >
                        Refund
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="w-9 px-0"
                      icon="open_in_full"
                      aria-label={`Open order ${shortId(order.id)}`}
                      onClick={() => { setSelected(order); setAdminNote(order.adminNote || ""); setActionError(""); }}
                    />
                  </div>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}

      <Drawer
        isOpen={!!selected}
        onClose={() => { setSelected(null); setAdminNote(""); }}
        title="Order detail"
        width="lg"
      >
        {selected && (
          <div className="flex flex-col gap-6">
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-col gap-1">
                <span className="meta text-text-subtle">Status</span>
                <StatusTag status={selected.status} />
              </div>
              <span className="font-mono text-[12px] text-text-muted">{selected.id}</span>
            </div>

            <dl className="border border-border divide-y divide-border">
              <div className="flex items-center justify-between px-4 py-3">
                <dt className="meta text-text-subtle">Customer</dt>
                <dd className="text-sm text-text-main text-right truncate max-w-[60%]">
                  {selected.userEmail || selected.userId}
                </dd>
              </div>
              <div className="flex items-center justify-between px-4 py-3">
                <dt className="meta text-text-subtle">Plan</dt>
                <dd className="text-sm text-text-main text-right">
                  {selected.planName || "—"}
                  {selected.planCode && (
                    <span className="ml-2 font-mono text-[10px] uppercase tracking-wider text-text-subtle">
                      {selected.planCode}
                    </span>
                  )}
                </dd>
              </div>
              <div className="flex items-center justify-between px-4 py-3">
                <dt className="meta text-text-subtle">Method</dt>
                <dd className="font-mono text-[12px] text-text-main">{selected.method}</dd>
              </div>
              <div className="flex items-center justify-between px-4 py-3">
                <dt className="meta text-text-subtle">Created</dt>
                <dd className="font-mono text-[12px] text-text-main">{formatDate(selected.createdAt)}</dd>
              </div>
              <div className="flex items-center justify-between px-4 py-3">
                <dt className="meta text-text-subtle">Paid</dt>
                <dd className="font-mono text-[12px] text-text-main">{formatDate(selected.paidAt)}</dd>
              </div>
              <div className="flex items-center justify-between px-4 py-3">
                <dt className="meta text-text-subtle">Approved by</dt>
                <dd className="font-mono text-[12px] text-text-main">{selected.approvedBy || "—"}</dd>
              </div>
            </dl>

            {/* Computed grant — the numbers this approval will apply. */}
            <section className="flex flex-col gap-3">
              <h3 className="meta text-text-subtle">Grant on approval</h3>
              <dl className="grid grid-cols-2 gap-px bg-border border border-border">
                <div className="bg-surface px-4 py-3">
                  <dt className="meta text-text-subtle">Amount</dt>
                  <dd className="font-mono text-sm text-text-main mt-1">{fmtUsdNano(selected.amountNanoUsd)}</dd>
                </div>
                <div className="bg-surface px-4 py-3">
                  <dt className="meta text-text-subtle">Credit</dt>
                  <dd className="font-mono text-sm text-text-main mt-1">{fmtCreditNano(selected.creditNanoUsd, selected.unlimitedCredit)}</dd>
                </div>
                <div className="bg-surface px-4 py-3">
                  <dt className="meta text-text-subtle">Window</dt>
                  <dd className="font-mono text-sm text-text-main mt-1">
                    {selected.periods > 1 ? `${selected.periods} × ` : ""}
                    {selected.durationDays} {selected.durationDays === 1 ? "day" : "days"}
                    {selected.discountPercent > 0 ? ` (−${selected.discountPercent}%)` : ""}
                  </dd>
                </div>
                <div className="bg-surface px-4 py-3">
                  <dt className="meta text-text-subtle">Expires</dt>
                  <dd className="font-mono text-sm text-text-main mt-1">
                    {selected.status === "paid" && selected.paidAt
                      // The last period's end; an unlimited plan queued behind
                      // another of the same plan ends later still (see the user's queue).
                      ? formatDate(new Date(new Date(selected.paidAt).getTime() + selected.durationDays * (selected.periods || 1) * 86400000).toISOString())
                      : "on approval"}
                  </dd>
                </div>
              </dl>
              <p className="text-[11px] text-text-muted">
                Credit first repays any overdraft; the remainder starts a new plan window.
              </p>
            </section>

            <section className="flex flex-col gap-3">
              <h3 className="meta text-text-subtle">Payer note</h3>
              <p className="border border-border bg-surface-2 px-4 py-3 text-sm text-text-main whitespace-pre-wrap min-h-[64px]">
                {selected.payerNote || "No note provided."}
              </p>
            </section>

            <section className="flex flex-col gap-3">
              <h3 className="meta text-text-subtle">Admin note</h3>
              <textarea
                value={adminNote}
                onChange={(e) => setAdminNote(e.target.value)}
                rows={3}
                placeholder="Reference the transfer, or explain an exception."
                className="w-full border border-border bg-surface px-3 py-2.5 text-sm text-text-main placeholder-text-muted/70 focus:border-brand-500 focus:outline-none transition-colors"
              />
            </section>

            <div className="flex flex-wrap justify-end gap-2 pt-4 border-t border-border">
              {selected.status === "pending" && (
                <>
                  <Button variant="ghost" onClick={() => confirmAction(selected, "cancel")} disabled={busyId === selected.id}>
                    Cancel order
                  </Button>
                  <Button variant="success" onClick={() => confirmAction(selected, "approve")} loading={busyId === selected.id}>
                    Approve
                  </Button>
                </>
              )}
              {selected.status === "paid" && (
                <Button variant="danger" onClick={() => confirmAction(selected, "refund")} loading={busyId === selected.id}>
                  Refund
                </Button>
              )}
              {selected.status !== "pending" && selected.status !== "paid" && (
                <Button variant="secondary" onClick={() => { setSelected(null); setAdminNote(""); }}>
                  Close
                </Button>
              )}
            </div>
          </div>
        )}
      </Drawer>

      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        confirmText={confirmState?.confirmText || "Confirm"}
        variant={confirmState?.variant || "danger"}
      />
    </div>
  );
}
