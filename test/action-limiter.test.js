// Public endpoint limiter (spec account-registration "Public account endpoints are
// rate limited", design D16).
//
// The limiter is pure in-memory state, so these tests drive it with an explicit
// `now` and reset the store between cases — no timers, no sleeping.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { hitLimit, checkLimits, resetAll, bucketCount } = await import("../src/lib/auth/actionLimiter.js");

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 29, 10, 0, 0);

beforeEach(() => { resetAll(); });

test("a bucket allows exactly `limit` attempts inside the window", () => {
  const bucket = "register:ip:1.1.1.1";
  for (let i = 0; i < 5; i += 1) {
    const result = hitLimit(bucket, { limit: 5, windowMs: HOUR, now: T0 + i * 1000 });
    assert.equal(result.allowed, true, `attempt ${i + 1} of 5`);
  }
  const sixth = hitLimit(bucket, { limit: 5, windowMs: HOUR, now: T0 + 5000 });
  assert.equal(sixth.allowed, false);
  assert.equal(sixth.remaining, 0);
});

test("retryAfterSec counts down to when the oldest hit expires", () => {
  const bucket = "resend:email:a@b.com";
  hitLimit(bucket, { limit: 3, windowMs: HOUR, now: T0 });
  hitLimit(bucket, { limit: 3, windowMs: HOUR, now: T0 + 1000 });
  hitLimit(bucket, { limit: 3, windowMs: HOUR, now: T0 + 2000 });

  const denied = hitLimit(bucket, { limit: 3, windowMs: HOUR, now: T0 + 3000 });
  assert.equal(denied.allowed, false);
  // The FIRST hit falls out one hour after T0; at T0+3s that is 3597s away.
  assert.equal(denied.retryAfterSec, 3597);

  // Half an hour later the wait is halved.
  const later = hitLimit(bucket, { limit: 3, windowMs: HOUR, now: T0 + 30 * 60 * 1000 });
  assert.equal(later.allowed, false);
  assert.equal(later.retryAfterSec, 1800);
});

test("the window expires and the bucket allows again", () => {
  const bucket = "forgot:ip:2.2.2.2";
  for (let i = 0; i < 10; i += 1) hitLimit(bucket, { limit: 10, windowMs: HOUR, now: T0 });
  assert.equal(hitLimit(bucket, { limit: 10, windowMs: HOUR, now: T0 + 1000 }).allowed, false);

  // One hour after the hits, they no longer count.
  const after = hitLimit(bucket, { limit: 10, windowMs: HOUR, now: T0 + HOUR + 1 });
  assert.equal(after.allowed, true);
});

test("a denied attempt is not recorded, so the window still recovers", () => {
  const bucket = "register:ip:3.3.3.3";
  for (let i = 0; i < 5; i += 1) hitLimit(bucket, { limit: 5, windowMs: HOUR, now: T0 });
  // Hammer 100 times inside the window.
  for (let i = 0; i < 100; i += 1) {
    hitLimit(bucket, { limit: 5, windowMs: HOUR, now: T0 + 60_000 + i * 1000 });
  }
  // The 5 real hits still expire one hour after T0, not one hour after the last
  // denied attempt.
  assert.equal(hitLimit(bucket, { limit: 5, windowMs: HOUR, now: T0 + HOUR + 1 }).allowed, true);
});

test("buckets are independent", () => {
  const a = "resend:email:a@b.com";
  const b = "resend:email:c@d.com";
  for (let i = 0; i < 3; i += 1) hitLimit(a, { limit: 3, windowMs: HOUR, now: T0 });

  assert.equal(hitLimit(a, { limit: 3, windowMs: HOUR, now: T0 + 1 }).allowed, false);
  assert.equal(hitLimit(b, { limit: 3, windowMs: HOUR, now: T0 + 1 }).allowed, true);
});

test("checkLimits stops at the first exhausted bucket", () => {
  const email = "forgot:email:x@y.com";
  const ip = "forgot:ip:4.4.4.4";
  for (let i = 0; i < 3; i += 1) {
    checkLimits([
      { bucket: email, limit: 3, windowMs: HOUR },
      { bucket: ip, limit: 10, windowMs: HOUR },
    ], T0 + i);
  }

  const denied = checkLimits([
    { bucket: email, limit: 3, windowMs: HOUR },
    { bucket: ip, limit: 10, windowMs: HOUR },
  ], T0 + 10);
  assert.equal(denied.allowed, false);
  assert.equal(denied.bucket, email);
  assert.ok(denied.retryAfterSec > 0);

  // The IP bucket was not charged for the refused attempt: it still has room.
  const ipOnly = checkLimits([{ bucket: ip, limit: 10, windowMs: HOUR }], T0 + 11);
  assert.equal(ipOnly.allowed, true);
});

test("the store is bounded", () => {
  // Each bucket holds one hit; the cap evicts the oldest names.
  for (let i = 0; i < 10_050; i += 1) {
    hitLimit(`register:ip:10.0.${Math.floor(i / 250)}.${i % 250}`, { limit: 5, windowMs: HOUR, now: T0 });
  }
  assert.ok(bucketCount() <= 10_000, `bucket count ${bucketCount()} exceeds the cap`);
});
