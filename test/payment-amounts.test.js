// Payment amounts (design D2, task 3.1).
//
// These pin the exactness that the matching rules depend on: a payment is
// compared with `===`, so the parser must not round "0.00000001" to 9 nano and
// must not accept a value it cannot represent.
import { test } from "node:test";
import assert from "node:assert/strict";

const { parseDecimalToNano, formatVnd, formatUsdt } = await import("../src/lib/payments/amounts.js");

test("parseDecimalToNano: whole numbers and fractions", () => {
  assert.equal(parseDecimalToNano("10"), 10_000_000_000);
  assert.equal(parseDecimalToNano("10.5"), 10_500_000_000);
  assert.equal(parseDecimalToNano("0.00000001"), 10);
  assert.equal(parseDecimalToNano("23.72469206"), 23_724_692_060);
  assert.equal(parseDecimalToNano("0"), 0);
  assert.equal(parseDecimalToNano(" 7.25 "), 7_250_000_000);
});

test("parseDecimalToNano: trailing zeros beyond 9 decimals still parse exactly", () => {
  assert.equal(parseDecimalToNano("0.0000000100"), 10);
  assert.equal(parseDecimalToNano("5.000000000"), 5_000_000_000);
});

test("parseDecimalToNano: rejects what it cannot represent", () => {
  for (const bad of ["1e3", "abc", "-1", "-0.5", "1.0000000001", "", " ", "1,5", ".5", "1.", "+1", null, undefined, {}, "0x10"]) {
    assert.equal(parseDecimalToNano(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("parseDecimalToNano: numbers that already lost precision are refused", () => {
  // 1e-9 as a JS number is 1e-9 exactly in decimal terms, but 0.0000000001 is not
  // representable in nano-units.
  assert.equal(parseDecimalToNano(0.0000000001), null);
  assert.equal(parseDecimalToNano(10.5), 10_500_000_000);
});

test("formatVnd: Vietnamese thousands separators", () => {
  assert.equal(formatVnd(250000), "250.000đ");
  assert.equal(formatVnd(0), "0đ");
  assert.equal(formatVnd(999), "999đ");
  assert.equal(formatVnd(1_250_000), "1.250.000đ");
  assert.equal(formatVnd(1234567890), "1.234.567.890đ");
});

test("formatUsdt: plain decimal, no rounding", () => {
  assert.equal(formatUsdt(10_000_000_000), "10");
  assert.equal(formatUsdt(10_500_000_000), "10.5");
  assert.equal(formatUsdt(10), "0.00000001");
  assert.equal(formatUsdt(0), "0");
  assert.equal(formatUsdt(23_724_692_060), "23.72469206");
});
