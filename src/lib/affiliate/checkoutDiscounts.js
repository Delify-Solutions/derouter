// Discounts applied when an order is created (spec affiliate-program "Voucher at
// checkout", "Referred-buyer bonus"). One pure pricing step shared by the gateway
// path (checkout.js) and the manual path (/api/account/orders), so both price an
// order the same way.
//
// Order: the term discount is already in `payAmount`; then the referral discount
// (unlimited plans only); then the voucher.
//
// SYNCHRONOUS + DRIVER-FREE. Relative imports only.
import { readAffiliateSettingsSync } from "./settings.js";
import { referralDiscountBpSync, bpOf } from "./buyerBonus.js";
import { holdVoucherSync, normalizeVoucherCode, usableVoucherSync, voucherDiscountFor } from "./vouchers.js";

export const VOUCHER_INVALID_MESSAGE = "Voucher không hợp lệ hoặc đã được dùng";

/** amountNanoUsd scaled by the same ratio as payAmount, floored in BigInt. */
function scaled(amountNanoUsd, newPay, oldPay) {
  const a = BigInt(Math.trunc(Number(amountNanoUsd) || 0));
  const n = BigInt(Math.trunc(Number(newPay) || 0));
  const o = BigInt(Math.trunc(Number(oldPay) || 0));
  if (o <= 0n) return Number(a);
  return Number((a * n) / o);
}

/**
 * @param {object} db
 * @param {{ userId: string, unlimited: boolean, payCurrency: "VND"|"USD"|"USDT",
 *           payAmount: number, amountNanoUsd: number, voucherCode?: string|null,
 *           settings?: object }} input
 * @returns {{ ok: true, payAmount: number, amountNanoUsd: number, voucher: object|null,
 *             voucherDiscount: number, referralDiscountBp: number }
 *          | { ok: false, code: string, error: string, status: number }}
 */
export function applyCheckoutDiscountsSync(db, {
  userId, unlimited, payCurrency, payAmount, amountNanoUsd, voucherCode = null, settings = null,
}) {
  const s = settings || readAffiliateSettingsSync(db);
  const original = Math.max(0, Math.trunc(Number(payAmount) || 0));
  let pay = original;

  const referralDiscountBp = referralDiscountBpSync(db, userId, { unlimited: Boolean(unlimited), settings: s });
  if (referralDiscountBp > 0) pay -= bpOf(pay, referralDiscountBp);

  let voucher = null;
  let voucherDiscount = 0;
  if (normalizeVoucherCode(voucherCode)) {
    voucher = usableVoucherSync(db, voucherCode);
    if (!voucher) return { ok: false, code: "bad_voucher", error: VOUCHER_INVALID_MESSAGE, status: 400 };
    voucherDiscount = voucherDiscountFor(voucher, {
      payCurrency: payCurrency === "VND" ? "VND" : "USD",
      payAmount: pay,
      vndPerUsd: s.affiliateVndPerUsd,
    });
    pay -= voucherDiscount;
  }

  pay = Math.max(0, pay);
  // Binance takes at most 8 decimals; a percentage or a cross-currency voucher
  // can leave 9. Round the USDT amount UP to a cent so it is payable exactly.
  if (payCurrency === "USDT" && pay !== original && pay > 0) {
    const cent = 10_000_000;
    pay = Math.min(original, Math.ceil(pay / cent) * cent);
  }
  return {
    ok: true,
    payAmount: pay,
    amountNanoUsd: pay === original ? Number(amountNanoUsd) : scaled(amountNanoUsd, pay, original),
    voucher,
    voucherDiscount,
    referralDiscountBp,
  };
}

/** Record the discounts on the order row and hold the voucher. */
export function recordCheckoutDiscountsSync(db, orderId, priced) {
  db.run(
    `UPDATE orders SET voucherId = ?, voucherDiscount = ?, referralDiscountBp = ? WHERE id = ?`,
    [
      priced.voucher?.id ?? null,
      priced.voucher ? priced.voucherDiscount : null,
      priced.referralDiscountBp > 0 ? priced.referralDiscountBp : null,
      orderId,
    ]
  );
  if (priced.voucher) holdVoucherSync(db, priced.voucher.id, orderId);
}
