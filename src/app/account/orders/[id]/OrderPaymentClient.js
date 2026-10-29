"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

/**
 * The payment page for one gateway order (spec payment-checkout "Order page").
 *
 * What it must do, and why each piece exists:
 *   * show the QR and every field as COPYABLE text — a failed QR image must never
 *     be the reason a customer cannot pay;
 *   * count down to `expiresAt` and poll the status every 5 s, so the page reacts
 *     when the payment lands without the customer refreshing;
 *   * announce only STATUS CHANGES to a screen reader (`aria-live`), never the
 *     ticking clock — a per-second announcement makes the page unusable;
 *   * show "not found" for another customer's order, with no payment details.
 *
 * All styling follows `openspec/ui-dna.md`: square corners, hairline borders, mono
 * for data, status as a word plus a tint (never colour alone).
 */

const POLL_MS = 5000;

const STATUS_TAG = {
  pending: { label: "Chờ thanh toán", cls: "border-warning/30 bg-warning/10 text-warning" },
  paid: { label: "Đã thanh toán", cls: "border-brand-500/30 bg-brand-500/10 text-brand-700 dark:text-brand-400" },
  expired: { label: "Hết hạn", cls: "border-warning/30 bg-warning/10 text-warning" },
  cancelled: { label: "Đã huỷ", cls: "border-border bg-surface-2 text-text-muted" },
  refunded: { label: "Đã hoàn tiền", cls: "border-info/30 bg-info/10 text-info" },
};

function fmtCountdown(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0:00";
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function fmtDate(value) {
  if (!value) return "—";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString("vi-VN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

/** One labelled, copyable value. The copy button is the primary affordance. */
function CopyField({ label, value, size = "md" }) {
  const { copied, copy } = useCopyToClipboard(1500);
  if (!value) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="meta text-text-subtle">{label}</span>
      <div className="flex items-stretch border border-border">
        <code
          className={`flex-1 min-w-0 px-3 ${size === "lg" ? "py-3 text-base" : "py-2 text-[13px]"} font-mono break-all text-text-main`}
        >
          {value}
        </code>
        <button
          type="button"
          onClick={() => copy(value)}
          aria-label={`Sao chép ${label}`}
          className="shrink-0 border-l border-border px-3 font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted transition-colors hover:bg-surface-2 hover:text-text-main focus-visible:outline-2 focus-visible:outline-brand-500"
        >
          {copied ? "Đã chép" : "Chép"}
        </button>
      </div>
    </div>
  );
}

export default function OrderPaymentClient({ orderId }) {
  const [state, setState] = useState({ loading: true, notFound: false, error: "" });
  const [order, setOrder] = useState(null);
  const [payment, setPayment] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const [cancelling, setCancelling] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const lastStatus = useRef(null);

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setState((current) => ({ ...current, loading: true, error: "" }));
    try {
      const res = await fetch(`/api/account/orders/${encodeURIComponent(orderId)}`, { cache: "no-store" });
      if (res.status === 404) {
        setState({ loading: false, notFound: true, error: "" });
        return;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Không tải được đơn");

      setOrder(body.order ?? null);
      setPayment(body.payment ?? null);
      setState({ loading: false, notFound: false, error: "" });

      // Announce transitions only. The first load sets the baseline silently.
      const status = body.order?.status ?? null;
      if (lastStatus.current && status && status !== lastStatus.current) {
        if (status === "paid") setAnnouncement("Thanh toán thành công — gói đã vào hàng đợi");
        else if (status === "expired") setAnnouncement("Đơn đã hết hạn thanh toán");
        else if (status === "cancelled") setAnnouncement("Đơn đã được huỷ");
      }
      lastStatus.current = status;
    } catch (error) {
      setState({ loading: false, notFound: false, error: error.message || "Không tải được đơn" });
    }
  }, [orderId]);

  useEffect(() => { load(); }, [load]);

  // Status poll: only while there is something to wait for. A paid/expired/
  // cancelled order will not change again, so polling it would be pure noise.
  useEffect(() => {
    if (state.loading || state.notFound || !order) return;
    if (order.status !== "pending") return;
    const timer = setInterval(() => { load({ silent: true }); }, POLL_MS);
    return () => clearInterval(timer);
  }, [state.loading, state.notFound, order, load]);

  // Countdown tick: one second, display only. It never causes a network call and
  // never touches the live region.
  useEffect(() => {
    if (!order || order.status !== "pending" || !order.expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [order]);

  const cancel = async () => {
    setCancelling(true);
    try {
      const res = await fetch(`/api/account/orders/${encodeURIComponent(orderId)}`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Không huỷ được đơn");
      await load({ silent: true });
    } catch (error) {
      setState((current) => ({ ...current, error: error.message || "Không huỷ được đơn" }));
    } finally {
      setCancelling(false);
    }
  };

  if (state.loading) {
    return (
      <div className="flex flex-col gap-4">
        <div className="h-8 w-48 border border-border bg-surface-2/50" aria-hidden="true" />
        <div className="h-64 border border-border bg-surface-2/50" aria-hidden="true" />
      </div>
    );
  }

  if (state.notFound) {
    return (
      <div className="flex flex-col items-center gap-3 border border-border px-6 py-16 text-center">
        <span className="material-symbols-outlined text-[32px] text-text-subtle" aria-hidden="true">search_off</span>
        <p className="font-medium text-text-main">Không tìm thấy đơn này</p>
        <p className="max-w-md text-sm text-text-muted">
          Đơn không tồn tại hoặc thuộc về tài khoản khác.
        </p>
        <Link
          href="/account/plans"
          className="mt-2 inline-flex h-10 items-center border border-border px-4 font-mono text-[11px] uppercase tracking-[0.12em] text-text-main transition-colors hover:bg-surface-2"
        >
          Về trang gói
        </Link>
      </div>
    );
  }

  const status = order?.status ?? "pending";
  const tag = STATUS_TAG[status] || STATUS_TAG.pending;
  const expiresMs = order?.expiresAt ? Date.parse(order.expiresAt) : null;
  const remaining = expiresMs ? expiresMs - now : null;
  const isPending = status === "pending";
  const isGateway = !!order?.paymentCode && order?.method !== "manual";

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {/* Live region: only status transitions are announced (design D9). */}
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>

      <header className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="meta text-text-muted">Đơn hàng</span>
          <span className={`border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${tag.cls}`}>
            {tag.label}
          </span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-text-main">
          {order?.planName || order?.planCode || "Đơn hàng"}
        </h1>
        <p className="text-sm text-text-muted">
          Tạo lúc {fmtDate(order?.createdAt)}
          {order?.paidAt ? ` · thanh toán lúc ${fmtDate(order.paidAt)}` : ""}
        </p>
      </header>

      {state.error && (
        <div className="flex items-start gap-2 border border-danger/40 bg-danger/5 px-4 py-3">
          <span className="material-symbols-outlined text-[18px] text-danger" aria-hidden="true">error</span>
          <p className="flex-1 text-sm text-danger">{state.error}</p>
          <Button size="sm" variant="ghost" onClick={() => load({ silent: true })}>Thử lại</Button>
        </div>
      )}

      {status === "paid" && (
        <section className="flex flex-col gap-3 border border-brand-500/30 bg-brand-500/5 px-6 py-5">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[20px] text-brand-600 dark:text-brand-400" aria-hidden="true">
              check_circle
            </span>
            <p className="font-medium text-text-main">Thanh toán thành công — gói đã vào hàng đợi</p>
          </div>
          <p className="text-sm text-text-muted">
            Gói {order?.planName || order?.planCode} đã được kích hoạt và đang chờ tới lượt dùng.
          </p>
          <div>
            <Link
              href="/account/plans"
              className="inline-flex h-10 items-center border border-brand-500 bg-brand-500 px-4 font-mono text-[11px] uppercase tracking-[0.12em] text-white transition-colors hover:bg-brand-600"
            >
              Xem hàng đợi gói
            </Link>
          </div>
        </section>
      )}

      {(status === "expired" || status === "cancelled") && (
        <section className="flex flex-col gap-3 border border-warning/40 bg-warning/5 px-6 py-5">
          <p className="font-medium text-text-main">
            {status === "expired" ? "Đơn đã hết hạn thanh toán" : "Đơn đã được huỷ"}
          </p>
          <p className="text-sm text-text-muted">
            {status === "expired"
              ? "Mã thanh toán không còn hiệu lực. Nếu bạn đã chuyển tiền, admin sẽ đối soát và kích hoạt gói thay bạn."
              : "Đơn này không còn chờ thanh toán. Bạn có thể tạo đơn mới bất cứ lúc nào."}
          </p>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/account/plans"
              className="inline-flex h-10 items-center border border-brand-500 bg-brand-500 px-4 font-mono text-[11px] uppercase tracking-[0.12em] text-white transition-colors hover:bg-brand-600"
            >
              Tạo đơn mới
            </Link>
          </div>
        </section>
      )}

      {isPending && isGateway && payment && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
          {/* QR. The copyable fields below carry the same information, so a failed
              image is an inconvenience, not a blocker. */}
          <section className="flex flex-col gap-3 border border-border bg-surface p-6">
            <span className="meta text-text-subtle">
              {payment.method === "vietqr" ? "Quét VietQR" : "Quét Binance Pay"}
            </span>
            {payment.qrUrl || payment.qrImageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={payment.qrUrl || payment.qrImageUrl}
                alt={
                  payment.method === "vietqr"
                    ? `Mã VietQR chuyển ${payment.amountText} tới ${payment.accountNumber || ""}`
                    : "Mã QR Binance Pay"
                }
                className="w-full border border-border bg-white"
                width={340}
                height={340}
              />
            ) : (
              <div className="flex aspect-square items-center justify-center border border-border bg-surface-2 px-4 text-center">
                <p className="text-sm text-text-muted">
                  Chưa có ảnh QR — dùng các ô bên cạnh để chuyển tiền.
                </p>
              </div>
            )}

            {/* Countdown: a sentence, not a bare number, so it is understandable
                without seeing the layout. */}
            <p className="font-mono text-[12px] text-text-muted">
              {remaining != null && remaining > 0
                ? <>Còn <span className="text-text-main">{fmtCountdown(remaining)}</span> để thanh toán</>
                : <>Hết hạn lúc {fmtDate(order.expiresAt)} — đang chờ hệ thống cập nhật</>}
            </p>
          </section>

          <section className="flex flex-col gap-4 border border-border bg-surface p-6">
            <div className="flex flex-col gap-1">
              <span className="meta text-text-subtle">Số tiền cần chuyển</span>
              <span className="font-mono text-2xl font-semibold text-text-main">
                {payment.amountText}
              </span>
              <span className="text-[12px] text-text-muted">
                Chuyển đúng số này. Thiếu hay thừa ở chuyển khoản đều phải chờ admin duyệt.
              </span>
            </div>

            <CopyField label="Nội dung chuyển khoản" value={payment.content} size="lg" />

            <p className="border border-warning/40 bg-warning/5 px-3 py-2 text-[12px] text-warning">
              {payment.instruction}
            </p>

            {payment.method === "vietqr" ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <CopyField label="Ngân hàng" value={payment.bankName} />
                <CopyField label="Số tài khoản" value={payment.accountNumber} size="lg" />
                <CopyField label="Chủ tài khoản" value={payment.accountName} />
                <CopyField label="Số tiền" value={payment.amountText} />
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <CopyField label="Binance Pay UID" value={payment.payUid} size="lg" />
                <CopyField label="Tên tài khoản" value={payment.accountName} />
                <CopyField label="Số USDT" value={payment.amountUsdt} />
                <CopyField label="Nội dung (Note)" value={payment.content} />
              </div>
            )}

            <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-4">
              <Button variant="secondary" onClick={() => load({ silent: true })}>
                Kiểm tra lại
              </Button>
              <Button variant="ghost" onClick={cancel} loading={cancelling} disabled={!isPending}>
                Huỷ đơn
              </Button>
              <span className="font-mono text-[11px] text-text-subtle">
                Trang tự cập nhật mỗi 5 giây
              </span>
            </div>
          </section>
        </div>
      )}

      {/* A manual order has no gateway details: it waits for an admin. */}
      {isPending && !isGateway && (
        <section className="flex flex-col gap-3 border border-border bg-surface px-6 py-5">
          <p className="font-medium text-text-main">Đơn đang chờ admin duyệt</p>
          <p className="text-sm text-text-muted">
            Đơn thủ công không có mã chuyển khoản. Admin sẽ kiểm tra và kích hoạt gói, sau đó gói
            xuất hiện trong hàng đợi của bạn.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/account/plans"
              className="inline-flex h-10 items-center border border-border px-4 font-mono text-[11px] uppercase tracking-[0.12em] text-text-main transition-colors hover:bg-surface-2"
            >
              Về trang gói
            </Link>
            <Button variant="ghost" onClick={cancel} loading={cancelling}>Huỷ đơn</Button>
          </div>
        </section>
      )}

      {status === "refunded" && (
        <section className="border border-info/30 bg-info/5 px-6 py-5">
          <p className="font-medium text-text-main">Đơn đã được hoàn tiền</p>
          <p className="mt-1 text-sm text-text-muted">
            Admin đã hoàn lại khoản credit tương ứng vào một gói mới.
          </p>
        </section>
      )}
    </div>
  );
}
