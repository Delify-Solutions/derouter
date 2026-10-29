// One password policy, stated in Vietnamese (spec account-registration "One
// password policy", verify finding N2).
//
// The message is asserted here rather than at each route because every path that
// sets a password — public signup, reset by token, the signed-in change form, admin
// create and admin reset — surfaces this exact string.
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  validatePassword,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
} = await import("../src/lib/users/passwordPolicy.js");

test("the policy is 10–200 characters", () => {
  assert.equal(PASSWORD_MIN_LENGTH, 10);
  assert.equal(PASSWORD_MAX_LENGTH, 200);
});

test("a password inside the range is accepted", () => {
  assert.equal(validatePassword("a".repeat(10)), null);
  assert.equal(validatePassword("a".repeat(200)), null);
  assert.equal(validatePassword("correct horse battery"), null);
});

test("the message is Vietnamese and names the rule", () => {
  const short = validatePassword("a".repeat(9));
  assert.match(short, /Mật khẩu/);
  assert.match(short, /10/);
  assert.match(short, /200/);
  assert.doesNotMatch(short, /must be/i, "no English leakage");

  const long = validatePassword("a".repeat(201));
  assert.match(long, /Mật khẩu/);
  assert.match(long, /10/);
  assert.match(long, /200/);
  assert.doesNotMatch(long, /must be/i);
});

test("both violations state the same rule, so the UI cannot show two versions", () => {
  assert.equal(validatePassword("short"), validatePassword("a".repeat(201)));
});

test("non-strings are rejected with the same message", () => {
  for (const value of [null, undefined, 123, {}, []]) {
    assert.match(validatePassword(value), /Mật khẩu/);
  }
});
