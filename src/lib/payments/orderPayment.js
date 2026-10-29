// The payment block the order page renders (design D5).
//
// Kept in one module so the API and the page cannot disagree about the QR URL or
// the exact copy fields: the customer has to send *these* digits.
//
// The VietQR image is a public quick-link service; when it fails the page still
// shows the copyable fields, so a broken image never blocks a payment.
import { formatVnd, formatUsdt } from "./amounts.js";

const VIETQR_BASE = "https://img.vietqr.io/image";

/**
 * `https://img.vietqr.io/image/<BIN>-<account>-compact2.png?amount=..&addInfo=..&accountName=..`
 *
 * @param {{ bankBin: string, accountNumber: string, accountName?: string, amount: number, content: string }} params
 * @returns {string}
 */
export function buildVietQrUrl({ bankBin, accountNumber, accountName = "", amount, content }) {
  const bin = String(bankBin ?? "").trim();
  const account = String(accountNumber ?? "").trim();
  if (!bin || !account) return null;
  const params = new URLSearchParams({
    amount: String(Math.round(Number(amount) || 0)),
    addInfo: String(content ?? ""),
  });
  if (accountName) params.set("accountName", String(accountName));
  return `${VIETQR_BASE}/${encodeURIComponent(bin)}-${encodeURIComponent(account)}-compact2.png?${params.toString()}`;
}

/**
 * Everything the order page needs to guide the payment, or `null` for a manual order
 * (which has no gateway details — an admin approves it by hand).
 *
 * @param {{ order: object, provider: object|null }} params
 * @returns {object|null}
 */
export function buildPaymentBlock({ order, provider }) {
  if (!order || !order.paymentCode) return null;
  const config = provider?.config ?? {};

  if (order.payCurrency === "USD") return null;

  if (order.payCurrency === "VND") {
    return {
      method: "vietqr",
      currency: "VND",
      amount: Number(order.payAmount) || 0,
      amountText: formatVnd(order.payAmount),
      content: order.paymentCode,
      bankName: config.bankName ?? null,
      bankBin: config.bankBin ?? null,
      accountNumber: config.accountNumber ?? null,
      accountName: config.accountName ?? null,
      providerName: provider?.name ?? null,
      qrUrl: buildVietQrUrl({
        bankBin: config.bankBin,
        accountNumber: config.accountNumber,
        accountName: config.accountName,
        amount: order.payAmount,
        content: order.paymentCode,
      }),
      instruction: "Nhập đúng nội dung chuyển khoản, nếu sai hệ thống không tự kích hoạt được",
    };
  }

  if (order.payCurrency === "USDT") {
    return {
      method: "binance",
      currency: "USDT",
      // nano-USDT; the copy field needs the decimal string.
      amount: Number(order.payAmount) || 0,
      amountText: `${formatUsdt(order.payAmount)} USDT`,
      amountUsdt: formatUsdt(order.payAmount),
      content: order.paymentCode,
      payUid: config.payUid ?? null,
      accountName: config.accountName ?? null,
      qrImageUrl: config.qrImageUrl ?? null,
      providerName: provider?.name ?? null,
      instruction: "Ghi mã vào ô Note khi chuyển Binance Pay",
    };
  }

  return null;
}
