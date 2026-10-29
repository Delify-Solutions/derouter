import test from "node:test";
import assert from "node:assert/strict";
import { toCustomerOrder, rowToOrder } from "../src/lib/billing/orders.js";

const row = {
  id: "o1", userId: "u1", planId: "p1", planCode: "go", planName: "Go",
  amountNanoUsd: 10e9, creditNanoUsd: 250e9, durationDays: 30, status: "paid",
  method: "vietqr", paymentCode: "DR8K3Q7MZP", payCurrency: "VND", payAmount: 250000,
  paymentProviderId: "prov-secret-id", expiresAt: "2026-10-29T10:30:00.000Z",
  paymentTransactionId: "tx-1", payerNote: "tôi chuyển rồi", adminNote: "khách quen, nhớ duyệt nhanh",
  approvedBy: "payment:sepay", createdAt: "2026-10-29T10:00:00.000Z", paidAt: "2026-10-29T10:01:00.000Z",
  userEmail: "a@b.c", userDisplayName: "A", limits: null,
};

test("a buyer sees the order's money and status but none of the admin-side fields", () => {
  const view = toCustomerOrder(rowToOrder(row));
  assert.equal(view.id, "o1");
  assert.equal(view.status, "paid");
  assert.equal(view.paymentCode, "DR8K3Q7MZP");
  assert.equal(view.payAmount, 250000);
  assert.equal(view.payerNote, "tôi chuyển rồi");
  for (const hidden of ["adminNote", "approvedBy", "paymentProviderId", "paymentTransactionId", "userId", "userEmail", "userDisplayName", "limits"]) {
    assert.equal(hidden in view, false, `${hidden} must not reach the customer`);
  }
});

test("a column added to the order later stays private by default", () => {
  const view = toCustomerOrder({ ...rowToOrder(row), futureInternalFlag: "x" });
  assert.equal("futureInternalFlag" in view, false);
});

test("a missing order stays null", () => {
  assert.equal(toCustomerOrder(null), null);
});
