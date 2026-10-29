// Plan limit validation and labelling (spec plan-templates).
//
// One passing and one failing case per rule of "Limit validation", plus the
// window labels and the preview sentence the admin form and the landing page show.
// Everything here is pure, so no database is involved.
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  WINDOW_PRESETS,
  MAX_LIMITS,
  windowLabel,
  describeLimit,
  describeLimits,
  normalizeLimits,
  validateLimits,
  serializeLimits,
  parseLimits,
} = await import("../src/lib/billing/limits.js");
const { NANO } = await import("../src/shared/utils/money.js");

const USD = (n) => Math.round(n * NANO);
const PLAN = { creditNanoUsd: USD(250), durationDays: 30 };

// ── windowLabel ────────────────────────────────────────────────────────────

test("windowLabel maps the presets and falls back to N giờ", () => {
  assert.equal(windowLabel(5), "5 giờ");
  assert.equal(windowLabel(24), "1 ngày");
  assert.equal(windowLabel(168), "1 tuần");
  assert.equal(windowLabel(12), "12 giờ");
  assert.equal(windowLabel(1), "1 giờ");
});

test("WINDOW_PRESETS holds the three lengths the form offers", () => {
  assert.deepEqual(WINDOW_PRESETS, [
    { hours: 5, label: "5 giờ" },
    { hours: 24, label: "1 ngày" },
    { hours: 168, label: "1 tuần" },
  ]);
});

test("describeLimit / describeLimits render the preview sentence fragments", () => {
  assert.equal(describeLimit({ hours: 5, maxNanoUsd: USD(20) }), "Tối đa $20 mỗi 5 giờ");
  assert.deepEqual(
    describeLimits([{ hours: 168, maxNanoUsd: USD(80) }, { hours: 5, maxNanoUsd: USD(20) }]),
    ["Tối đa $20 mỗi 5 giờ", "Tối đa $80 mỗi 1 tuần"]
  );
  assert.deepEqual(describeLimits(null), []);
});

// ── Rule: hours is an integer within 1..durationDays*24 ────────────────────

test("hours must be a whole number >= 1", () => {
  assert.equal(validateLimits([{ hours: 5, maxNanoUsd: USD(20) }], PLAN), null);
  assert.match(validateLimits([{ hours: 0, maxNanoUsd: USD(20) }], PLAN), /số giờ phải là số nguyên/);
  assert.match(validateLimits([{ hours: -5, maxNanoUsd: USD(20) }], PLAN), /số giờ phải là số nguyên/);
  assert.match(validateLimits([{ hours: 2.5, maxNanoUsd: USD(20) }], PLAN), /số giờ phải là số nguyên/);
});

test("hours may not exceed the plan duration in hours", () => {
  // 30 days * 24 = 720 hours.
  assert.equal(validateLimits([{ hours: 720, maxNanoUsd: USD(20) }], PLAN), null);
  const error = validateLimits([{ hours: 721, maxNanoUsd: USD(20) }], PLAN);
  assert.match(error, /dài hơn thời hạn gói/);
});

// ── Rule: maximum > 0 and strictly below the credit ────────────────────────

test("the maximum must be greater than zero", () => {
  assert.equal(validateLimits([{ hours: 5, maxNanoUsd: USD(1) }], PLAN), null);
  assert.match(validateLimits([{ hours: 5, maxNanoUsd: 0 }], PLAN), /lớn hơn \$0/);
});

test("the maximum must be strictly below the credit", () => {
  // Spec scenario: a plan with $250 credit cannot carry a $250 limit.
  const error = validateLimits([{ hours: 24, maxNanoUsd: USD(250) }], PLAN);
  assert.match(error, /nhỏ hơn credit của gói/);
  assert.equal(validateLimits([{ hours: 24, maxNanoUsd: USD(249.99) }], PLAN), null);
});

// ── Rule: no two limits share the same hours ───────────────────────────────

test("two limits may not share a window length", () => {
  const error = validateLimits(
    [{ hours: 5, maxNanoUsd: USD(10) }, { hours: 5, maxNanoUsd: USD(20) }],
    PLAN
  );
  assert.match(error, /hai hạn mức cùng dùng cửa sổ 5 giờ/);
});

// ── Rule: monotonic in the window length ───────────────────────────────────

test("a shorter window may not allow a larger maximum", () => {
  // Spec scenario: [{5h, $50}, {168h, $40}] must be rejected naming the 5-hour one.
  const error = validateLimits(
    [{ hours: 5, maxNanoUsd: USD(50) }, { hours: 168, maxNanoUsd: USD(40) }],
    PLAN
  );
  assert.match(error, /5 giờ/);
  assert.match(error, /\$50/);
});

test("equal maximums across different windows are allowed", () => {
  assert.equal(
    validateLimits([{ hours: 5, maxNanoUsd: USD(20) }, { hours: 168, maxNanoUsd: USD(20) }], PLAN),
    null
  );
});

test("the Go example validates", () => {
  assert.equal(
    validateLimits([{ hours: 5, maxNanoUsd: USD(20) }, { hours: 168, maxNanoUsd: USD(80) }], PLAN),
    null
  );
});

// ── Rule: at most 5 limits ────────────────────────────────────────────────

test("a plan may carry at most five limits", () => {
  const five = [5, 12, 24, 72, 168].map((hours, i) => ({ hours, maxNanoUsd: USD(10 * (i + 1)) }));
  assert.equal(validateLimits(five, PLAN), null);
  const six = [...five, { hours: 200, maxNanoUsd: USD(200) }];
  assert.match(validateLimits(six, PLAN), /tối đa 5 hạn mức/);
  assert.equal(MAX_LIMITS, 5);
});

// ── Normalisation / serialisation ─────────────────────────────────────────

test("no limits are valid and serialise to null", () => {
  assert.equal(validateLimits([], PLAN), null);
  assert.equal(validateLimits(null, PLAN), null);
  assert.equal(serializeLimits([]), null);
  assert.equal(serializeLimits(null), null);
});

test("normalizeLimits sorts by hours and coerces to integers", () => {
  const normalised = normalizeLimits([
    { hours: "168", max: 80 * NANO },
    { hours: 5, maxNanoUsd: 20 * NANO },
  ]);
  assert.deepEqual(normalised, [
    { hours: 5, maxNanoUsd: USD(20) },
    { hours: 168, maxNanoUsd: USD(80) },
  ]);
});

test("normalizeLimits rejects a non-array instead of silently allowing everything", () => {
  assert.throws(() => normalizeLimits({ hours: 5 }), TypeError);
  assert.throws(() => normalizeLimits("[not json"), TypeError);
  assert.throws(() => normalizeLimits([42]), TypeError);
});

test("serializeLimits round-trips through parseLimits", () => {
  const limits = [{ hours: 5, maxNanoUsd: USD(20) }, { hours: 168, maxNanoUsd: USD(80) }];
  const stored = serializeLimits(limits);
  assert.equal(typeof stored, "string");
  assert.deepEqual(parseLimits(stored), limits);
});

test("parseLimits treats corrupt data as 'no limits' rather than crashing admission", () => {
  assert.deepEqual(parseLimits(null), []);
  assert.deepEqual(parseLimits(""), []);
  assert.deepEqual(parseLimits("{oops"), []);
  assert.deepEqual(parseLimits('{"a":1}'), []);
});
