"use client";

import { useEffect, useRef } from "react";
import { fmtUsdNano } from "@/shared/utils/money";

/**
 * The shop on "Gói của tôi": every active plan as a card stating exactly what it
 * buys — price per payment method, credit usable on any model, duration, and each
 * window limit (spec customer-portal "Buying from the page", spec plan-dual-pricing
 * "Prices on public and customer pages").
 *
 * One button per OFFERED method, each carrying its own price, because the two
 * prices are independent: "Chuyển khoản VietQR · 250.000đ" is what the customer
 * will transfer, "$10" is what they will send in USDT. The list comes from the
 * server (`offeredMethods`), the same function the checkout route uses, so a card
 * can never offer a method the API would refuse.
 *
 * The blocking reason is shown instead of a dead button: "Gói này chỉ dành cho một
 * số nhóm" is actionable ("ask the admin"), an unexplained 403 is not.
 *
 * `?plan=<code>` from the landing page highlights and scrolls to that card.
 */
const METHOD_ICON = {
  vietqr: "qr_code_2",
  binance: "currency_bitcoin",
  manual: "receipt_long",
};

export default function BuyPlans({ plans = [], loading = false, buyingId = null, onBuy, highlightCode = "", highlightRef = null }) {
  const localRef = useRef(null);
  const containerRef = highlightRef ?? localRef;

  useEffect(() => {
    if (!highlightCode) return;
    const node = containerRef?.current;
    if (node && typeof node.scrollIntoView === "function") {
      node.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [highlightCode, containerRef]);

  if (loading) {
    return (
      <section className="flex flex-col gap-3">
        <span className="meta text-text-muted">Mua thêm gói</span>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-[300px] border border-border bg-surface-2/50" aria-hidden="true" />
          ))}
        </div>
      </section>
    );
  }

  if (!plans.length) {
    return (
      <section className="flex flex-col gap-3">
        <span className="meta text-text-muted">Mua thêm gói</span>
        <div className="flex flex-col items-center gap-2 border border-border px-6 py-10 text-center">
          <span className="material-symbols-outlined text-[28px] text-text-subtle" aria-hidden="true">sell</span>
          <p className="text-sm font-medium text-text-main">Hiện chưa có gói nào được mở bán</p>
          <p className="max-w-sm text-sm text-text-muted">
            Mã quà tặng vẫn cộng credit vào tài khoản của bạn.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <div>
        <span className="meta text-text-muted">Mua thêm gói</span>
        <p className="mt-1 text-xs text-text-muted">
          Chọn cách trả. Chuyển khoản và Binance tạo đơn có mã riêng, tự kích hoạt khi tiền vào
          đúng số; đơn thủ công do admin duyệt.
        </p>
      </div>

      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {plans.map((plan) => {
          const highlighted = highlightCode && String(plan.code).toLowerCase() === highlightCode;
          const limits = Array.isArray(plan.limitsText) ? plan.limitsText : [];
          const methods = Array.isArray(plan.offeredMethods) ? plan.offeredMethods : [];
          const vndText = methods.find((entry) => entry.method === "vietqr")?.amountText
            ?? (plan.priceVndText || null);
          const usdText = methods.find((entry) => entry.method === "binance")?.amountText
            ?? fmtUsdNano(plan.priceNanoUsd);

          return (
            <li
              key={plan.id}
              ref={highlighted ? containerRef : undefined}
              className={`flex flex-col border bg-surface ${
                highlighted ? "border-brand-500 ring-1 ring-brand-500/40" : "border-border"
              }`}
            >
              <div className="flex flex-col gap-1 px-6 pt-6">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-subtle">
                    {plan.code}
                  </span>
                  {highlighted && (
                    <span className="border border-brand-500/30 bg-brand-500/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-brand-700 dark:text-brand-400">
                      Đã chọn
                    </span>
                  )}
                </div>
                <h3 className="text-base font-semibold text-text-main">{plan.name}</h3>
                {plan.description && <p className="mt-1 text-sm text-text-muted">{plan.description}</p>}
              </div>

              {/* Both prices, each labelled with the rail it belongs to. A plan
                  with only one price shows only that one. */}
              <dl className="mt-4 flex flex-col gap-2 border-y border-border px-6 py-4">
                {vndText && (
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-subtle">
                      Chuyển khoản
                    </dt>
                    <dd className="font-mono text-xl font-semibold text-text-main">{vndText}</dd>
                  </div>
                )}
                {plan.priceNanoUsd > 0 && (
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-subtle">
                      Binance USDT
                    </dt>
                    <dd className="font-mono text-xl font-semibold text-text-main">{usdText}</dd>
                  </div>
                )}
                <div className="flex items-baseline justify-between gap-3 border-t border-border pt-2">
                  <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-subtle">
                    Credit nhận
                  </dt>
                  <dd className="font-mono text-[13px] text-text-main">
                    {fmtUsdNano(plan.creditNanoUsd)}
                  </dd>
                </div>
                <p className="text-[12px] text-text-muted">Dùng chung mọi model · {plan.durationDays} ngày</p>
              </dl>

              {limits.length > 0 && (
                <ul className="mt-3 flex flex-col gap-0.5 px-6 font-mono text-[12px] text-text-muted">
                  {limits.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}

              <div className="mt-auto flex flex-col gap-2 px-6 py-6">
                {!plan.purchasable && (
                  <>
                    <button
                      type="button"
                      disabled
                      aria-disabled="true"
                      className="h-10 w-full cursor-not-allowed border border-border font-mono text-[11px] uppercase tracking-[0.12em] text-text-muted opacity-50"
                    >
                      Chưa mở bán
                    </button>
                    {plan.blockedReason && <p className="text-[11px] text-text-muted">{plan.blockedReason}</p>}
                  </>
                )}

                {plan.purchasable && methods.length === 0 && (
                  <p className="text-[11px] text-text-muted">
                    Gói này chưa có cách thanh toán nào được mở. Liên hệ admin để mua.
                  </p>
                )}

                {plan.purchasable && methods.map((entry) => {
                  const key = `${plan.id}:${entry.method}`;
                  const busy = buyingId === key;
                  // Gateway buttons are the primary action; manual is deliberately
                  // the quiet one, because it needs a human and should not compete.
                  const primary = entry.method !== "manual";
                  return (
                    <button
                      key={entry.method}
                      type="button"
                      onClick={() => onBuy(plan, entry.method)}
                      disabled={buyingId === key}
                      className={
                        primary
                          ? "flex h-10 w-full items-center justify-center gap-2 border border-brand-500 bg-brand-500 px-3 font-mono text-[11px] uppercase tracking-[0.12em] text-white transition-colors duration-150 hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
                          : "flex h-10 w-full items-center justify-center gap-2 border border-border px-3 font-mono text-[11px] uppercase tracking-[0.12em] text-text-main transition-colors duration-150 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
                      }
                    >
                      <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                        {METHOD_ICON[entry.method] || "payments"}
                      </span>
                      {busy ? "Đang tạo đơn…" : `${entry.label} · ${entry.amountText}`}
                    </button>
                  );
                })}

                <p className="text-[11px] text-text-muted">
                  Đơn chuyển khoản và Binance có mã riêng, hạn 30 phút.
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
