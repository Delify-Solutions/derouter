// Custom-amount top-up: the customer types an amount in đồng and receives credit at
// the plan's own exchange rate (plan.priceVnd đồng buys plan.creditNanoUsd credit).
//
// PURE (no imports, no I/O): the server prices the order with it and the purchase
// card previews with it, so the number a customer sees is the number they are
// charged. Integer arithmetic only — BigInt for the products, because
// 50,000,000đ × 400e9 nano overflows 2^53 long before it overflows a real balance.

/** Highest amount a single top-up may be when the plan sets no maximum. */
export const TOPUP_DEFAULT_MAX_VND = 50_000_000;

/** A USD price is rounded UP to a whole cent, so a customer never underpays. */
const CENT_NANO = 10_000_000n;

/**
 * Can this plan be topped up with a free amount? Needs the flag and both halves of
 * the exchange rate; an unlimited plan has no credit to scale.
 */
export function topupEnabled(plan) {
  return Boolean(
    plan &&
      plan.allowCustomAmount === true &&
      plan.unlimitedCredit !== true &&
      Number(plan.priceVnd) > 0 &&
      Number(plan.creditNanoUsd) > 0
  );
}

/** Smallest and largest amount in đồng a top-up of this plan accepts. */
export function topupBounds(plan) {
  const minVnd = Number(plan?.customMinVnd) > 0 ? Number(plan.customMinVnd) : Number(plan?.priceVnd) || 0;
  const maxVnd = Number(plan?.customMaxVnd) > 0 ? Number(plan.customMaxVnd) : TOPUP_DEFAULT_MAX_VND;
  return { minVnd, maxVnd };
}

function fmtVnd(value) {
  return `${String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ".")}đ`;
}

/**
 * Price a top-up.
 *
 *   credit   = floor(amountVnd × plan.creditNanoUsd ÷ plan.priceVnd)
 *   usdPrice = ceil to a cent of amountVnd × plan.priceNanoUsd ÷ plan.priceVnd
 *              (0 when the plan has no USD price, i.e. USDT/manual are not offered)
 *
 * @param {object} plan  rowToPlan shape (allowCustomAmount, priceVnd, creditNanoUsd,
 *                       priceNanoUsd, customMinVnd, customMaxVnd, unlimitedCredit)
 * @param {number|string} amountVnd integer đồng
 * @returns {{ok:true, amountVnd:number, creditNanoUsd:number, priceNanoUsd:number}
 *          |{ok:false, error:string}}
 */
export function quoteTopup(plan, amountVnd) {
  if (!topupEnabled(plan)) return { ok: false, error: "Gói này không nạp số tiền tùy ý" };

  // Only a number or a string is an amount: Number([50000]) or Number(true) would
  // otherwise coerce into one. A string must be plain digits, because Number() also
  // accepts "1e5", "0x10" or " ".
  if (typeof amountVnd !== "number" && typeof amountVnd !== "string") {
    return { ok: false, error: "Số tiền phải là số đồng nguyên dương" };
  }
  const raw = typeof amountVnd === "string" ? amountVnd.trim() : amountVnd;
  const amount = typeof raw === "string" ? (/^\d+$/.test(raw) ? Number(raw) : NaN) : Number(raw);
  if (raw === "" || raw == null || !Number.isSafeInteger(amount) || amount <= 0) {
    return { ok: false, error: "Số tiền phải là số đồng nguyên dương" };
  }

  const { minVnd, maxVnd } = topupBounds(plan);
  if (amount < minVnd) return { ok: false, error: `Số tiền tối thiểu là ${fmtVnd(minVnd)}` };
  if (amount > maxVnd) return { ok: false, error: `Số tiền tối đa là ${fmtVnd(maxVnd)}` };

  const amountBig = BigInt(amount);
  const priceVnd = BigInt(Math.round(Number(plan.priceVnd)));
  const creditNanoUsd = (amountBig * BigInt(Math.round(Number(plan.creditNanoUsd)))) / priceVnd;
  if (creditNanoUsd <= 0n) return { ok: false, error: "Số tiền quá nhỏ để quy đổi ra credit" };

  const usdNum = amountBig * BigInt(Math.round(Number(plan.priceNanoUsd) || 0));
  const exactUsd = usdNum / priceVnd + (usdNum % priceVnd === 0n ? 0n : 1n);
  const priceNanoUsd = ((exactUsd + CENT_NANO - 1n) / CENT_NANO) * CENT_NANO;

  // Money is stored as safe integers. The default ceiling keeps every real quote
  // far below this; an extreme admin-set maximum must not reach it silently.
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  if (creditNanoUsd > maxSafe || priceNanoUsd > maxSafe) {
    return { ok: false, error: "Số tiền quá lớn" };
  }

  return {
    ok: true,
    amountVnd: amount,
    creditNanoUsd: Number(creditNanoUsd),
    priceNanoUsd: Number(priceNanoUsd),
  };
}
