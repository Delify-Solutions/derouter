// Checkout: which payment methods a plan offers, creating a gateway order, and
// expiring stale ones (design D5).
//
// SYNCHRONOUS + DRIVER-FREE (design D2): the adapter is passed in, so a test can
// drive every rule without a server. Relative imports only.
import { v4 as uuidv4 } from "uuid";
import { generatePaymentCode, isValidPrefix } from "./codes.js";
import { snapshotLimitsOf } from "../billing/orders.js";
import { nano } from "../billing/ledger.js";
import { quoteTopup } from "../billing/topup.js";

export const METHOD_LABELS = {
  vietqr: "Chuyển khoản VietQR",
  binance: "Binance USDT",
  manual: "Thủ công",
};

/** Which provider kinds can collect VND. */
export const VND_KINDS = ["sepay", "web2m", "acb"];
/** Which provider kinds can collect USDT. */
export const USDT_KINDS = ["binance"];

/** Why this user may not open more unpaid gateway orders, or null when allowed. */
export const MAX_PENDING_GATEWAY_ORDERS = 5;
export const PENDING_LIMIT_MESSAGE =
  "Bạn đang có quá nhiều đơn chưa thanh toán — thanh toán hoặc hủy bớt đơn cũ";

function nowIsoDefault() {
  return new Date().toISOString();
}

/** Active providers of a kind, in the order a new order should use them. */
export function listActiveProvidersSync(db, kind) {
  return db.all(
    `SELECT * FROM paymentProviders
      WHERE kind = ? AND isActive = 1
      ORDER BY COALESCE(sortOrder, 0) ASC, createdAt ASC`,
    [kind]
  );
}

/** The provider a new order of this kind must use (lowest sort order). */
export function pickProviderSync(db, kind) {
  return listActiveProvidersSync(db, kind)[0] ?? null;
}

/**
 * Which payment methods a plan currently offers (spec plan-dual-pricing
 * "Offered payment methods").
 *
 * A method is offered only when BOTH halves exist: a price the admin set and an
 * active account to receive it. Offering VietQR with no bank account would send
 * the customer to a page with nowhere to transfer to.
 *
 * @param {object} db adapter
 * @param {object} plan plan row (rowToPlan shape: priceNanoUsd, priceVnd)
 * @param {object} settings merged settings
 * @returns {Array<{method: "vietqr"|"binance"|"manual", label: string,
 *                  currency: "VND"|"USDT"|"USD", amount: number, amountText: string,
 *                  providerId: string|null}>}
 */
export function offeredMethodsSync(db, plan, settings = {}) {
  if (!plan || plan.isActive === false || plan.isPurchasable === false) return [];

  const out = [];
  const priceVnd = nano(plan.priceVnd);
  if (priceVnd > 0) {
    // Any active VND collector counts; which one a new order uses is the lowest
    // sort order among them, so a SePay account can sit ahead of a web2m one.
    const provider = firstOf(db, VND_KINDS);
    if (provider) {
      out.push({
        method: "vietqr",
        label: METHOD_LABELS.vietqr,
        currency: "VND",
        amount: priceVnd,
        amountText: formatVndText(priceVnd),
        providerId: provider.id,
      });
    }
  }

  const priceUsd = nano(plan.priceNanoUsd);
  if (priceUsd > 0) {
    const provider = pickProviderSync(db, USDT_KINDS[0]);
    if (provider) {
      out.push({
        method: "binance",
        label: METHOD_LABELS.binance,
        currency: "USDT",
        amount: priceUsd,
        amountText: formatUsdText(priceUsd),
        providerId: provider.id,
      });
    }
  }

  // Manual orders are the fallback, not a price: they always exist while the
  // operator leaves the setting on.
  if (settings?.allowManualOrders !== false && priceUsd > 0) {
    out.push({
      method: "manual",
      label: METHOD_LABELS.manual,
      currency: "USD",
      amount: priceUsd,
      amountText: formatUsdText(priceUsd),
      providerId: null,
    });
  }

  return out;
}

/**
 * The single provider a new order of these kinds should use: lowest sortOrder
 * across ALL of them, then oldest. Sorting per kind and stopping at the first
 * kind would let a SePay account with sortOrder 99 beat a web2m one at 0.
 */
function firstOf(db, kinds) {
  const placeholders = kinds.map(() => "?").join(", ");
  return db.get(
    `SELECT * FROM paymentProviders
      WHERE kind IN (${placeholders}) AND isActive = 1
      ORDER BY COALESCE(sortOrder, 0) ASC, createdAt ASC
      LIMIT 1`,
    kinds
  ) ?? null;
}

function formatVndText(amount) {
  const digits = String(Math.round(amount));
  let out = "";
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ".";
    out += digits[i];
  }
  return `${out}đ`;
}

function formatUsdText(nanoUsd) {
  const usd = Math.round(nanoUsd) / 1e9;
  return `$${usd % 1 === 0 ? usd.toFixed(0) : usd.toFixed(2)}`;
}

/** Pending gateway orders this customer holds right now. */
export function countPendingGatewayOrdersSync(db, userId) {
  const row = db.get(
    `SELECT COUNT(*) AS n FROM orders
      WHERE userId = ? AND status = 'pending' AND method IN ('vietqr', 'binance')`,
    [userId]
  );
  return Number(row?.n ?? 0);
}

/**
 * Create a pending gateway order.
 *
 * Everything the customer will be asked to pay is snapshotted here — code, amount,
 * currency, provider, expiry — so neither a plan edit nor a provider reorder can
 * change an order already on screen.
 *
 * @param {object} db adapter
 * @param {{ userId: string, plan: object, method: "vietqr"|"binance",
 *           settings?: object, nowIso?: string }} params
 * @returns {{ ok: true, order: object } | { ok: false, code: string, error: string, status: number }}
 */
export function createGatewayOrderSync(db, {
  userId,
  plan,
  method,
  settings = {},
  nowIso = null,
  amountVnd = null,
} = {}) {
  if (!userId) return { ok: false, code: "invalid", error: "Thiếu người dùng", status: 400 };
  if (!plan) return { ok: false, code: "invalid", error: "Gói không tồn tại", status: 400 };
  if (method !== "vietqr" && method !== "binance") {
    return { ok: false, code: "invalid", error: "Phương thức thanh toán không hợp lệ", status: 400 };
  }

  const offered = offeredMethodsSync(db, plan, settings).find((entry) => entry.method === method);
  if (!offered) {
    return {
      ok: false,
      code: "not_offered",
      error:
        method === "vietqr"
          ? "Gói này chưa mở bán bằng chuyển khoản VietQR"
          : "Gói này chưa mở bán bằng Binance USDT",
      status: 400,
    };
  }

  // A custom-amount top-up prices the order from the typed amount at the plan's own
  // rate; the plan's fixed price and credit are used otherwise. The quote is taken
  // BEFORE anything is written, so a bad amount leaves no order behind.
  let quote = null;
  if (amountVnd != null) {
    quote = quoteTopup(plan, amountVnd);
    if (!quote.ok) return { ok: false, code: "bad_amount", error: quote.error, status: 400 };
  }

  const pending = countPendingGatewayOrdersSync(db, userId);
  if (pending >= MAX_PENDING_GATEWAY_ORDERS) {
    return { ok: false, code: "too_many_pending", error: PENDING_LIMIT_MESSAGE, status: 429 };
  }

  const at = nowIso || nowIsoDefault();
  const ttlMinutes = clampTtl(settings?.paymentOrderTtlMinutes);
  const expiresAt = new Date(Date.parse(at) + ttlMinutes * 60_000).toISOString();

  const prefix = String(settings?.paymentCodePrefix || "DR").toUpperCase();
  if (!isValidPrefix(prefix)) {
    return { ok: false, code: "bad_prefix", error: "Tiền tố mã thanh toán không hợp lệ", status: 500 };
  }

  const user = db.get(`SELECT id, email, groupId FROM users WHERE id = ?`, [userId]);
  if (!user) return { ok: false, code: "invalid", error: "Không tìm thấy người dùng", status: 400 };

  const providerId = offered.providerId;
  if (!providerId) {
    return { ok: false, code: "no_provider", error: "Chưa có nguồn nhận tiền đang hoạt động", status: 400 };
  }
  const providerActive = db.get(
    `SELECT id FROM paymentProviders WHERE id = ? AND isActive = 1`,
    [providerId]
  );
  if (!providerActive) {
    return { ok: false, code: "no_provider", error: "Chưa có nguồn nhận tiền đang hoạt động", status: 400 };
  }

  // Code collisions are a UNIQUE-index conflict, not a logic error: retry a few
  // times and then give up rather than looping forever on a broken generator.
  let paymentCode = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = generatePaymentCode(prefix);
    const clash = db.get(`SELECT id FROM orders WHERE paymentCode = ?`, [candidate]);
    if (!clash) {
      paymentCode = candidate;
      break;
    }
  }
  if (!paymentCode) {
    return { ok: false, code: "code_collision", error: "Không tạo được mã thanh toán, thử lại", status: 500 };
  }

  const payCurrency = offered.currency;
  // VietQR is paid in the typed đồng; USDT in the USD price of that amount.
  const payAmount = quote ? (payCurrency === "VND" ? quote.amountVnd : quote.priceNanoUsd) : offered.amount;

  const order = {
    id: uuidv4(),
    userId,
    planId: plan.id,
    // `amountNanoUsd` keeps its existing meaning (the USD price of this order: the
    // plan's price, or for a custom-amount top-up the quoted price of the typed
    // amount) so every finance/statistics query built on it keeps working unchanged.
    amountNanoUsd: quote ? quote.priceNanoUsd : nano(plan.priceNanoUsd),
    creditNanoUsd: quote ? quote.creditNanoUsd : nano(plan.creditNanoUsd),
    unlimitedCredit: plan.unlimitedCredit ? 1 : 0,
    durationDays: nano(plan.durationDays),
    status: "pending",
    method,
    paymentCode,
    payCurrency,
    payAmount,
    paymentProviderId: providerId,
    expiresAt,
    emailSnapshot: user.email ?? null,
    limits: snapshotLimitsOf(plan),
    createdAt: at,
  };

  db.run(
    `INSERT INTO orders(
       id, userId, planId, amountNanoUsd, creditNanoUsd, unlimitedCredit, durationDays, status, method,
       paymentCode, payCurrency, payAmount, paymentProviderId, expiresAt,
       emailSnapshot, limits, createdAt
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      order.id, order.userId, order.planId, order.amountNanoUsd, order.creditNanoUsd,
      order.unlimitedCredit, order.durationDays, order.status, order.method, order.paymentCode, order.payCurrency,
      order.payAmount, order.paymentProviderId, order.expiresAt, order.emailSnapshot,
      order.limits, order.createdAt,
    ]
  );

  return { ok: true, order: readGatewayOrder(db, order.id) };
}

export function clampTtl(value) {
  const ttl = Number(value);
  if (!Number.isInteger(ttl)) return 30;
  return Math.min(Math.max(ttl, 10), 1440);
}

/** One order row in the shape the checkout API and page use. */
export function readGatewayOrder(db, orderId) {
  const row = db.get(
    `SELECT o.*, p.code AS planCode, p.name AS planName
       FROM orders o LEFT JOIN plans p ON p.id = o.planId
      WHERE o.id = ?`,
    [orderId]
  );
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    planId: row.planId,
    planCode: row.planCode ?? null,
    planName: row.planName ?? null,
    amountNanoUsd: nano(row.amountNanoUsd),
    creditNanoUsd: nano(row.creditNanoUsd),
    unlimitedCredit: Number(row.unlimitedCredit) === 1,
    durationDays: nano(row.durationDays),
    status: row.status,
    method: row.method ?? "manual",
    paymentCode: row.paymentCode ?? null,
    payCurrency: row.payCurrency ?? null,
    payAmount: row.payAmount == null ? null : nano(row.payAmount),
    paymentProviderId: row.paymentProviderId ?? null,
    expiresAt: row.expiresAt ?? null,
    paymentTransactionId: row.paymentTransactionId ?? null,
    createdAt: row.createdAt ?? null,
    paidAt: row.paidAt ?? null,
    approvedBy: row.approvedBy ?? null,
  };
}

/**
 * Sweep pending gateway orders whose window closed (spec payment-checkout
 * "Cancel and expiry"). Returns the ids it expired.
 *
 * Only `pending` rows with an `expiresAt` are touched: a manual order has no
 * window, and an already-paid order must never be expired by a clock.
 */
export function expireGatewayOrdersSync(db, nowIso = null) {
  const at = nowIso || nowIsoDefault();
  const rows = db.all(
    `SELECT id FROM orders
      WHERE status = 'pending' AND expiresAt IS NOT NULL AND expiresAt <= ?`,
    [at]
  );
  if (!rows.length) return [];
  for (const row of rows) {
    db.run(
      `UPDATE orders SET status = 'expired' WHERE id = ? AND status = 'pending'`,
      [row.id]
    );
  }
  return rows.map((row) => row.id);
}
