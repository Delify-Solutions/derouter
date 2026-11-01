// Response time in the usage histories: TTFT and total (spec usage-accuracy
// "Response time"). A stream records its time to first chunk next to the total;
// other requests record the total only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-usage-ttft-"));
// DATA_DIR must be set before the DB driver is imported.
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const usage = await import("../src/lib/db/repos/usageRepo.js");
const { formatLatency, detailTtft } = await import("../src/shared/utils/latencyFormat.js");

let db;
before(async () => { db = await getAdapter(); });
after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const base = () => ({
  timestamp: new Date().toISOString(), provider: "p", model: "m", apiKey: "k-ttft",
  tokens: { prompt_tokens: 10, completion_tokens: 5 }, status: "ok",
});

const lastMeta = () => JSON.parse(db.get(`SELECT meta FROM usageHistory ORDER BY id DESC LIMIT 1`).meta);

test("a stream stores TTFT next to the total", async () => {
  await usage.saveRequestUsage({ ...base(), latencyMs: 19338, ttftMs: 810 });
  const meta = lastMeta();
  assert.equal(meta.latencyMs, 19338);
  assert.equal(meta.ttftMs, 810);
});

test("a request without TTFT stores the total only", async () => {
  await usage.saveRequestUsage({ ...base(), latencyMs: 1200, ttftMs: null });
  const meta = lastMeta();
  assert.equal(meta.latencyMs, 1200);
  assert.equal("ttftMs" in meta, false);
});

test("formatLatency shows both, the total alone, or a dash", () => {
  assert.equal(formatLatency(19338, 810), "TTFT 810ms / Tổng 19338ms");
  assert.equal(formatLatency(19338.4, 809.6), "TTFT 810ms / Tổng 19338ms", "whole milliseconds");
  assert.equal(formatLatency(1200, null), "Tổng 1200ms");
  assert.equal(formatLatency(1200, undefined), "Tổng 1200ms");
  assert.equal(formatLatency(null, null), "—");
  assert.equal(formatLatency(null, 300), "TTFT 300ms");
  assert.equal(formatLatency(0, null), "Tổng 0ms");
  assert.equal(formatLatency(-5, "x"), "—");
});

test("detailTtft treats 0, a missing value and TTFT = total as unknown", () => {
  assert.equal(detailTtft({ ttft: 810, total: 19338 }), 810);
  assert.equal(detailTtft({ ttft: null, total: 1200 }), null, "non-streamed request");
  assert.equal(detailTtft({ ttft: 0, total: 1200 }), null, "older error rows wrote 0");
  assert.equal(detailTtft({ ttft: 1200, total: 1200 }), null, "older non-streamed rows wrote the total");
  assert.equal(detailTtft(undefined), null);
});
