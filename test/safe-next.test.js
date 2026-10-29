// Safe post-authentication redirect (design D17, spec account-registration "Safe
// post-authentication redirect").
//
// The failure this prevents is an open redirect: `?next=//evil.example` would bounce
// a freshly signed-in customer to another site that looks like this one.
import { test } from "node:test";
import assert from "node:assert/strict";

const { safeNext } = await import("../src/shared/utils/safeNext.js");

test("accepts account paths, including a query string", () => {
  assert.equal(safeNext("/account"), "/account");
  assert.equal(safeNext("/account/plans"), "/account/plans");
  assert.equal(safeNext("/account/plans?plan=go"), "/account/plans?plan=go");
  assert.equal(safeNext("/account/ledger?page=2&kind=charge"), "/account/ledger?page=2&kind=charge");
  assert.equal(safeNext("/account/keys#top"), "/account/keys#top");
});

test("rejects a protocol-relative URL", () => {
  assert.equal(safeNext("//evil.example"), null);
  assert.equal(safeNext("//evil.example/account"), null);
  assert.equal(safeNext("/account//evil.example"), null);
});

test("rejects an absolute URL", () => {
  assert.equal(safeNext("https://x"), null);
  assert.equal(safeNext("http://x/account"), null);
  assert.equal(safeNext("javascript:alert(1)"), null);
});

test("rejects paths outside the account area", () => {
  assert.equal(safeNext("/dashboard"), null);
  assert.equal(safeNext("/"), null);
  assert.equal(safeNext("/accounting"), null, "prefix must be /account, not /accounting");
  assert.equal(safeNext("/admin"), null);
});

test("rejects a backslash, which browsers normalise to a slash", () => {
  assert.equal(safeNext("/account\\x"), null);
  assert.equal(safeNext("\\\\evil.example"), null);
  assert.equal(safeNext("/account\\..\\dashboard"), null);
});

test("rejects non-strings", () => {
  assert.equal(safeNext(null), null);
  assert.equal(safeNext(undefined), null);
  assert.equal(safeNext(42), null);
  assert.equal(safeNext({}), null);
  assert.equal(safeNext(["/account"]), null);
  assert.equal(safeNext(""), null);
});

test("rejects a nested absolute URL hidden after a colon", () => {
  assert.equal(safeNext("/account:https://evil.example"), null);
  assert.equal(safeNext("/account/http://evil"), null);
});
