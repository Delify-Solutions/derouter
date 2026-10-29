// Payment codes (design D2, task 3.2).
//
// The extraction cases here are the two real-world memos named in the spec:
// a bank-wrapped code and a customer's spaced-out one. Getting either wrong means
// a paying customer waits for an admin.
import { test } from "node:test";
import assert from "node:assert/strict";

const { CODE_ALPHABET, generatePaymentCode, isValidPrefix, extractCandidateCodes } =
  await import("../src/lib/payments/codes.js");

test("code shape: prefix + 8 characters from the safe alphabet", () => {
  const re = new RegExp(`^DR[${CODE_ALPHABET}]{8}$`);
  for (let i = 0; i < 200; i += 1) {
    const code = generatePaymentCode("DR");
    assert.match(code, re);
  }
});

test("code alphabet omits the characters a human mistypes", () => {
  for (const ch of ["I", "L", "O", "0", "1"]) {
    assert.equal(CODE_ALPHABET.includes(ch), false, `${ch} must not be in the alphabet`);
  }
});

test("generatePaymentCode: randomInt is injectable and drives the characters", () => {
  const code = generatePaymentCode("DR", () => 0);
  assert.equal(code, `DR${CODE_ALPHABET[0].repeat(8)}`);
});

test("generatePaymentCode: refuses an invalid prefix", () => {
  assert.throws(() => generatePaymentCode("dr-1"));
  assert.throws(() => generatePaymentCode("D"));
  assert.throws(() => generatePaymentCode(""));
});

test("isValidPrefix: 2–6 uppercase letters", () => {
  assert.equal(isValidPrefix("DR"), true);
  assert.equal(isValidPrefix("ABCDEF"), true);
  assert.equal(isValidPrefix("A"), false);
  assert.equal(isValidPrefix("ABCDEFG"), false);
  assert.equal(isValidPrefix("dr"), false);
  assert.equal(isValidPrefix("D1"), false);
  assert.equal(isValidPrefix(null), false);
});

test("extractCandidateCodes: code wrapped in the bank's own prefix", () => {
  const codes = extractCandidateCodes("MBVCB.1234567.DR8K3Q7MZP.CT tu 0123 toi 9876", "DR");
  assert.deepEqual(codes, ["DR8K3Q7MZP"]);
});

test("extractCandidateCodes: customer inserted spaces", () => {
  const codes = extractCandidateCodes("dr8k 3q7m zp thanh toan", "DR");
  assert.deepEqual(codes, ["DR8K3Q7MZP"]);
});

test("extractCandidateCodes: lower case and punctuation", () => {
  assert.deepEqual(extractCandidateCodes("chuyen tien dr8k-3q7m-zp", "DR"), ["DR8K3Q7MZP"]);
});

test("extractCandidateCodes: text without a code yields nothing", () => {
  assert.deepEqual(extractCandidateCodes("thanh toan tien hang", "DR"), []);
  assert.deepEqual(extractCandidateCodes("", "DR"), []);
  assert.deepEqual(extractCandidateCodes(null, "DR"), []);
  // Nearly a code: too short.
  assert.deepEqual(extractCandidateCodes("DR8K3Q7MZ", "DR"), []);
});

test("extractCandidateCodes: a custom prefix is required, not assumed", () => {
  assert.deepEqual(extractCandidateCodes("DR8K3Q7MZP", "PAY"), []);
  assert.deepEqual(extractCandidateCodes("PAY8K3Q7MZP", "PAY"), ["PAY8K3Q7MZP"]);
});

test("extractCandidateCodes: several candidates keep their order and de-duplicate", () => {
  const codes = extractCandidateCodes("DR8K3Q7MZP and DRAAAA2222 then DR8K3Q7MZP again", "DR");
  assert.deepEqual(codes, ["DR8K3Q7MZP", "DRAAAA2222"]);
});

test("extractCandidateCodes: accented text does not glue onto a code", () => {
  const codes = extractCandidateCodes("Đặng DR8K3Q7MZP chuyển khoản", "DR");
  assert.deepEqual(codes, ["DR8K3Q7MZP"]);
});
