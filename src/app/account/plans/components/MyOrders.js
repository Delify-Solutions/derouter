"use client";

import { ActionButton, ButtonLink, Empty, ListRow, Section, Tag } from "@/app/account/components/ui";

// Vietnamese label and tone: a customer should never see the raw status word.
const STATUS_TAG = {
  pending: { tone: "warning", icon: "schedule", label: "Chờ duyệt" },
  paid: { tone: "success", icon: "check_circle", label: "Đã thanh toán" },
  cancelled: { tone: "neutral", icon: "block", label: "Đã hủy" },
  // A gateway order whose payment window closed unpaid. Separate from "Đã hủy"
  // because the customer did not cancel it — the code simply stopped being valid.
  expired: { tone: "warning", icon: "timer_off", label: "Hết hạn" },
  refunded: { tone: "neutral", icon: "undo", label: "Đã hoàn tiền" },
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
  const title = "Đơn hàng";
  const hint = "Đơn đang chờ có thể hủy. Đơn chuyển khoản và Binance có trang riêng với mã QR và mã thanh toán.";

  if (loading) {
    return (
      <Section title={title} description={hint}>
        <div className="h-[120px] border border-border bg-surface-2" aria-hidden="true" />
      </Section>
    );
  }

  if (!orders.length) {
    return (
      <Section title={title} description={hint}>
        <Empty icon="receipt_long" title="Chưa có đơn hàng" body="Mua một gói sẽ tạo đơn ở đây." />
      </Section>
    );
  }

  return (
    <Section title={title} description={hint}>
      <ul className="flex flex-col gap-2">
        {orders.map((order) => {
          const tag = STATUS_TAG[order.status] || STATUS_TAG.cancelled;
          return (
            <ListRow
              key={order.id}
              title={order.planName || order.planCode || "—"}
              tags={<Tag tone={tag.tone} icon={tag.icon}>{tag.label}</Tag>}
              // What the customer actually has to pay, in the currency they chose.
              // A gateway order is not "$10" — it may be 250.000đ.
              detail={`${payAmountLabel(order) || order.amountUsd} · nhận ${order.creditUsd} · ${fmtDate(order.createdAt)}`}
              actions={
                <>
                  {/* A gateway order has a page with the QR and the code; without
                      this link the customer has no way back to it. */}
                  {order.paymentCode && order.method !== "manual" && (
                    <ButtonLink
                      href={`/account/orders/${order.id}`}
                      size="sm"
                      tone={order.status === "pending" ? "solid" : "outline"}
                    >
                      {order.status === "pending" ? "Thanh toán" : "Xem đơn"}
                    </ButtonLink>
                  )}
                  {order.status === "pending" && (
                    <ActionButton
                      size="sm"
                      onClick={() => onCancel(order)}
                      loading={cancellingId === order.id}
                    >
                      Hủy đơn
                    </ActionButton>
                  )}
                </>
              }
            />
          );
        })}
      </ul>
    </Section>
  );
}
