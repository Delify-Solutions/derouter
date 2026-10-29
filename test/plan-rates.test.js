// RPM / TPM live on the plan (spec plan-templates "Plan rates"): validated like the
// other plan fields, stored as NULL when empty or 0, and read back as numbers.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-planrates-test-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const { createPlan, updatePlan, validatePlanInput } = await import("../src/lib/db/repos/billingRepo.js");

let db;
before(async () => { db = await getAdapter(); });
after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const base = { code: "go", name: "Go", priceNanoUsd: 10e9, creditNanoUsd: 250e9, durationDays: 30 };

test("a plan stores and returns its rpm and tpm", async () => {
  const plan = await createPlan({ ...base, rpm: 60, tpm: 200000 });
  assert.equal(plan.rpm, 60);
  assert.equal(plan.tpm, 200000);
});

test("empty and 0 both mean unlimited (NULL)", async () => {
  const empty = await createPlan({ ...base, code: "empty", rpm: "", tpm: null });
  assert.equal(empty.rpm, null);
  assert.equal(empty.tpm, null);
  const zero = await createPlan({ ...base, code: "zero", rpm: 0, tpm: 0 });
  assert.equal(zero.rpm, null);
  assert.equal(zero.tpm, null);
});

test("a plan without rpm/tpm fields is unlimited", async () => {
  const plan = await createPlan({ ...base, code: "plain" });
  assert.equal(plan.rpm, null);
  assert.equal(plan.tpm, null);
});

test("negative or fractional rates are refused with a Vietnamese message", () => {
  assert.match(validatePlanInput({ ...base, rpm: -1 }), /RPM/);
  assert.match(validatePlanInput({ ...base, tpm: 1.5 }), /TPM/);
  assert.equal(validatePlanInput({ ...base, rpm: 10, tpm: 10 }), null);
});

test("updating a plan changes its rates and can clear them", async () => {
  const plan = await createPlan({ ...base, code: "edit", rpm: 5, tpm: 5 });
  const raised = await updatePlan(plan.id, { rpm: 500 });
  assert.equal(raised.rpm, 500);
  assert.equal(raised.tpm, 5, "a field not in the patch keeps its value");
  const cleared = await updatePlan(plan.id, { rpm: null, tpm: "" });
  assert.equal(cleared.rpm, null);
  assert.equal(cleared.tpm, null);
});
