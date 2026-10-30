"use client";

import { useEffect, useRef, useState } from "react";
import { fmtUsdNano } from "@/shared/utils/money";
import { formatVnd } from "@/lib/payments/amounts.js";
import { quoteTopup, topupBounds, topupEnabled } from "@/lib/billing/topup.js";
import { ActionButton, Empty, Section } from "@/app/account/components/ui";

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

const SECTION_TITLE = "Mua thêm gói";
const SECTION_HINT =
  "Chọn cách trả. Chuyển khoản và Binance tạo đơn có mã riêng, tự kích hoạt khi tiền vào đúng số; đơn thủ công do admin duyệt.";

export default function BuyPlans({ plans = [], loading = false, buyingId = null, onBuy, highlightCode = "", highlightRef = null }) {
  const localRef = useRef(null);
  const containerRef = highlightRef ?? localRef;
  // What the customer typed per top-up plan, as digits. Unset = the plan's own price.
  const [typed, setTyped] = useState({});

  useEffect(() => {
    if (!highlightCode) return;
    const node = containerRef?.current;
    if (node && typeof node.scrollIntoView === "function") {
      node.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [highlightCode, containerRef]);

  if (loading) {
    return (
      <Section title={SECTION_TITLE} description={SECTION_HINT}>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2" aria-hidden="true">
          {[0, 1].map((i) => <div key={i} className="h-[320px] border border-border bg-surface-2" />)}
        </div>
      </Section>
    );
  }

  if (!plans.length) {
    return (
      <Section title={SECTION_TITLE} description={SECTION_HINT}>
        <Empty
          icon="sell"
          title="Hiện chưa có gói nào được mở bán"
          body="Mã quà tặng vẫn cộng credit vào tài khoản của bạn."
        />
      </Section>
    );
  }

  return (
    <Section title={SECTION_TITLE} description={SECTION_HINT}>
      <ul className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {plans.map((plan) => {
          const highlighted = highlightCode && String(plan.code).toLowerCase() === highlightCode;
          const limits = Array.isArray(plan.limitsText) ? plan.limitsText : [];
          const methods = Array.isArray(plan.offeredMethods) ? plan.offeredMethods : [];
          const vndText = methods.find((entry) => entry.method === "vietqr")?.amountText
            ?? (plan.priceVndText || null);
          const usdText = methods.find((entry) => entry.method === "binance")?.amountText
            ?? fmtUsdNano(plan.priceNanoUsd);
          // The headline is the price the customer is most likely to pay: VietQR
          // when the plan has one, otherwise USD. The other sits underneath.
          // A top-up plan prices whatever amount is typed, so its headline, credit
          // line and buttons all follow the quote (the same maths the server runs).
          const topup = topupEnabled(plan);
          const bounds = topup ? topupBounds(plan) : null;
          // Prefill with the plan's price, pulled inside the bounds: an admin may set
          // a minimum above the price (or a maximum below it), and the card must not
          // open on an error before the customer has typed anything.
          const defaultAmount = topup
            ? String(Math.min(Math.max(Number(plan.priceVnd) || 0, bounds.minVnd), bounds.maxVnd))
            : "";
          const amountText = typed[plan.id] ?? defaultAmount;
          const quote = topup ? quoteTopup(plan, amountText) : null;
          const quotedVnd = quote?.ok ? formatVnd(quote.amountVnd) : null;
          const quotedUsd = quote?.ok && quote.priceNanoUsd > 0 ? fmtUsdNano(quote.priceNanoUsd) : null;
          const headline = topup
            ? (quotedVnd || "—")
            : vndText || (plan.priceNanoUsd > 0 ? usdText : "Miễn phí");
          const secondary = topup
            ? (quotedVnd && quotedUsd ? quotedUsd : null)
            : vndText && plan.priceNanoUsd > 0 ? usdText : null;
          const inputId = `topup-${plan.id}`;

          return (
            <li
              key={plan.id}
              ref={highlighted ? containerRef : undefined}
              className={`relative flex flex-col border bg-surface ${
                highlighted ? "border-text-main" : "border-border"
              }`}
            >
              {(highlighted || plan.isFeatured) && (
                <div className="flex h-8 items-center bg-text-main px-6 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-bg">
                  {highlighted ? "Bạn đã chọn gói này" : "Nổi bật"}
                </div>
              )}

              <div className="flex flex-col gap-1 px-6 pt-6">
                <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-subtle">{plan.code}</span>
                <h3 className="text-base font-semibold text-text-main">{plan.name}</h3>
                {plan.description && <p className="text-sm leading-6 text-text-muted">{plan.description}</p>}
              </div>

              <div className="px-6 pt-5">
                <p className="flex items-baseline gap-2 text-text-main">
                  <span className="text-3xl font-semibold leading-none tracking-tight">{headline}</span>
                  <span className="font-mono text-xs text-text-muted">/ {plan.durationDays} ngày</span>
                </p>
                {secondary && <p className="mt-1 font-mono text-xs text-text-muted">hoặc {secondary} (Binance USDT)</p>}
                <p className="mt-3 text-sm font-medium text-text-main">
                  {plan.unlimitedCredit
                    ? "Credit không giới hạn"
                    : topup
                      ? (quote?.ok ? `Nhận ${fmtUsdNano(quote.creditNanoUsd)} credit` : "Nhập số tiền để xem credit nhận được")
                      : `Nhận ${fmtUsdNano(plan.creditNanoUsd)} credit`}
                  <span className="font-normal text-text-muted"> · dùng chung mọi model</span>
                </p>
              </div>

              {topup && (
                <div className="flex flex-col gap-1.5 border-t border-border px-6 py-4">
                  <label htmlFor={inputId} className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">
                    Số tiền nạp (đồng)
                  </label>
                  <input
                    id={inputId}
                    value={amountText}
                    onChange={(event) => setTyped((prev) => ({ ...prev, [plan.id]: event.target.value.replace(/\D/g, "") }))}
                    inputMode="numeric"
                    autoComplete="off"
                    aria-invalid={quote && !quote.ok ? "true" : undefined}
                    aria-describedby={`${inputId}-hint`}
                    className="h-11 w-full border border-border bg-surface px-3 font-mono text-base text-text-main placeholder-text-subtle transition-colors duration-150 focus:border-text-main focus:outline-none"
                    placeholder={String(bounds.minVnd)}
                  />
                  <p
                    id={`${inputId}-hint`}
                    role={quote && !quote.ok ? "alert" : undefined}
                    className={`text-xs ${quote && !quote.ok ? "text-danger" : "text-text-muted"}`}
                  >
                    {quote && !quote.ok
                      ? quote.error
                      : `Tỷ lệ ${formatVnd(plan.priceVnd)} = ${fmtUsdNano(plan.creditNanoUsd)} credit · từ ${formatVnd(bounds.minVnd)} đến ${formatVnd(bounds.maxVnd)}`}
                  </p>
                </div>
              )}

              {limits.length > 0 && (
                <ul className="mt-4 flex flex-col gap-1.5 border-t border-border px-6 py-4">
                  {limits.map((line) => (
                    <li key={line} className="flex items-start gap-2 text-sm text-text-muted">
                      <span className="material-symbols-outlined mt-0.5 text-[16px] text-text-subtle" aria-hidden="true">check</span>
                      {line}
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-auto flex flex-col gap-2 border-t border-border px-6 py-5">
                {!plan.purchasable && (
                  <>
                    <ActionButton disabled fullWidth>Chưa mở bán</ActionButton>
                    {plan.blockedReason && <p className="text-xs text-text-muted">{plan.blockedReason}</p>}
                  </>
                )}

                {plan.purchasable && methods.length === 0 && (
                  <p className="text-xs text-text-muted">
                    Gói này chưa có cách thanh toán nào được mở. Liên hệ admin để mua.
                  </p>
                )}

                {plan.purchasable && methods.map((entry) => {
                  const key = `${plan.id}:${entry.method}`;
                  // A top-up button carries the typed amount in its own currency.
                  const entryText = topup
                    ? (quote?.ok
                        ? (entry.method === "vietqr" ? quotedVnd : quotedUsd)
                        : null)
                    : entry.amountText;
                  const busy = buyingId === key;
                  // Gateway buttons are the primary action; manual is deliberately
                  // the quiet one, because it needs a human and should not compete.
                  const primary = entry.method !== "manual";
                  return (
                    <ActionButton
                      key={entry.method}
                      tone={primary ? "solid" : "outline"}
                      fullWidth
                      loading={busy}
                      disabled={topup && !quote?.ok}
                      onClick={() => onBuy(plan, entry.method, topup ? quote.amountVnd : undefined)}
                    >
                      {!busy && (
                        <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                          {METHOD_ICON[entry.method] || "payments"}
                        </span>
                      )}
                      {busy ? "Đang tạo đơn…" : entryText ? `${entry.label} · ${entryText}` : entry.label}
                    </ActionButton>
                  );
                })}

                {plan.purchasable && methods.length > 0 && (
                  <p className="text-xs text-text-muted">Đơn chuyển khoản và Binance có mã riêng, hạn 30 phút.</p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
