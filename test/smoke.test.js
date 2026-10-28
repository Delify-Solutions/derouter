// Minimal smoke tests: pure functions only — no DB, no network, no env.
// Run with `npm test` (node --test test/).
import { test } from "node:test";
import assert from "node:assert/strict";

import { cn } from "../src/shared/utils/cn.js";
import { FORMATS } from "../open-sse/translator/formats.js";
import { checkLock, recordFail, recordSuccess } from "../src/lib/auth/loginLimiter.js";

test("cn() joins class names and strips falsy/duplicate whitespace", () => {
  assert.equal(cn("px-2", "py-1"), "px-2 py-1");
  assert.equal(cn("flex", null, undefined, false, "gap-2"), "flex gap-2");
  assert.equal(cn("  a   b  "), "a b");
});

test("open-sse FORMATS exposes the expected transport keys", () => {
  for (const key of ["OPENAI", "OPENAI_RESPONSES", "CLAUDE", "GEMINI", "GEMINI_CLI", "VERTEX", "CODEX"]) {
    assert.equal(typeof FORMATS[key], "string", `missing FORMATS.${key}`);
  }
  assert.equal(FORMATS.OPENAI, "openai");
  assert.equal(FORMATS.CLAUDE, "claude");
});

test("loginLimiter.checkLock() reports unlocked for a fresh IP", () => {
  const ip = "ip-x";
  assert.deepEqual(checkLock(ip), { locked: false });
  // A single failure must not lock the bucket (threshold is 5).
  recordFail(ip);
  assert.equal(checkLock(ip).locked, false);
  recordSuccess(ip);
  assert.deepEqual(checkLock(ip), { locked: false });
});
