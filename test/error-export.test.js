// Exporting error log entries for a fix (spec error-log "Exporting an entry").
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-error-export-"));
// DATA_DIR must be set before the DB driver is imported.
process.env.DATA_DIR = tmpDir;

const repo = await import("../src/lib/db/repos/errorLogsRepo.js");
const { errorReportMarkdown, replayCurl, errorFileName } = await import("../src/lib/errorLog/report.js");

const ENTRY = {
  id: "01JABCDEF123456",
  timestamp: "2026-11-02T07:30:00.000Z",
  source: "upstream",
  status: 400,
  endpoint: "/v1/chat/completions",
  requestedModel: "GLM-5.3",
  provider: "openai-compatible-chat-1234abcd",
  model: "glm-5.3",
  owner: "a@x.vn",
  errorCode: "context_length_exceeded",
  message: "context length exceeded | really",
  stream: true,
  latencyMs: 812,
  bodyBytes: 2048,
  estTokens: 500,
  messageCount: 2,
  data: {
    request: { model: "GLM-5.3", messages: [{ role: "user", content: "it's long" }], stream: true },
    upstreamRequest: { model: "glm-5.3", messages: [{ role: "user", content: "it's long" }] },
    response: '{"error":{"message":"context length exceeded"}}',
    attempts: [{ status: 400, provider: "p1", model: "glm-5.3", connectionName: "conn | A", afterMs: 800, error: "too long" }],
    userAgent: "curl/8",
  },
};

let db;
before(async () => { db = await (await import("../src/lib/db/driver.js")).getAdapter(); });
after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test("the Markdown report carries the error, attempts, client request, upstream body and a replay", () => {
  const md = errorReportMarkdown(ENTRY, { baseUrl: "https://ai.delify.vn/" });
  assert.match(md, /# derouter error 01JABCDEF123456/);
  assert.match(md, /\*\*Status:\*\* 400/);
  assert.match(md, /context_length_exceeded/);
  assert.match(md, /## Upstream attempts \(1\)/);
  assert.match(md, /conn \\\| A/, "pipes inside a table cell are escaped");
  assert.match(md, /## Request from the client\n\n```json\n\{\n  "model": "GLM-5.3"/);
  assert.match(md, /## Body sent upstream/);
  assert.match(md, /"message": "context length exceeded"/, "the raw error response is pretty-printed");
  assert.match(md, /curl -sS 'https:\/\/ai\.delify\.vn\/v1\/chat\/completions'/);
});

test("the replay command never carries a key and survives quotes in the prompt", () => {
  const curl = replayCurl(ENTRY, "https://ai.delify.vn");
  assert.match(curl, /Bearer \$DEROUTER_KEY/);
  assert.match(curl, /it'\\''s long/);
  assert.equal(replayCurl({ ...ENTRY, data: {} }), null, "no stored request, no replay");
  assert.match(replayCurl(ENTRY), /"\$DEROUTER_URL\/v1\/chat\/completions"/);
});

test("a report without a stored prompt says so", () => {
  const md = errorReportMarkdown({ ...ENTRY, data: { attempts: [] } });
  assert.match(md, /_Not stored/);
  assert.doesNotMatch(md, /## Replay/);
});

test("file names are safe and identify the entry", () => {
  assert.equal(errorFileName(ENTRY), "derouter-error-2026-11-02T07-30-00-000Z-01JABCDE.json");
  assert.equal(errorFileName(ENTRY, "md"), "derouter-error-2026-11-02T07-30-00-000Z-01JABCDE.md");
});

test("export returns full entries matching the filters, newest first, capped", async () => {
  const { data, ...cols } = ENTRY;
  await repo.insertErrorLog({ ...cols, timestamp: "2026-11-02T07:00:00.000Z", data });
  await repo.insertErrorLog({ ...cols, timestamp: "2026-11-02T08:00:00.000Z", source: "router", status: 503, data: {} });
  await repo.insertErrorLog({ ...cols, timestamp: "2026-11-02T09:00:00.000Z", data });

  const all = await repo.exportErrorLogs({});
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((e) => e.timestamp.slice(11, 13)), ["09", "08", "07"]);
  assert.deepEqual(all[0].data.request, ENTRY.data.request, "the stored request is included");

  const upstream = await repo.exportErrorLogs({ source: "upstream" });
  assert.equal(upstream.length, 2);
  assert.equal((await repo.exportErrorLogs({ limit: 1 })).length, 1);
});
