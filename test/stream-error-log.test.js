// buildOnStreamComplete (open-sse/handlers/chatCore/streamingHandler.js): when a
// translator turned an upstream error event into masked message content (spec
// model-privacy — content itself is never masked, so without this the failure
// would be invisible), the raw text surfaces to reportStreamError exactly the
// way a stream that physically disconnects after its headers already does —
// same source ("stream"), same status (200), same place an admin already looks.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

register("./helpers/src-alias-hook.mjs", import.meta.url);
register("./helpers/next-server-hook.mjs", import.meta.url);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-stream-errlog-"));
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const { buildOnStreamComplete } = await import("../open-sse/handlers/chatCore/streamingHandler.js");
const { createWithErrorLog } = await import("../src/lib/errorLog/wrap.js");
const repo = await import("../src/lib/db/repos/errorLogsRepo.js");

let db;
before(async () => { db = await getAdapter(); });
after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(async () => {
  db.run(`DELETE FROM errorLogs`);
  await repo.setErrorLogConfig({ enabled: true, storePrompt: true, retentionDays: 14, maxRows: 1000, maxBodyKB: 64 });
});

const withLog = createWithErrorLog({ resolveKey: async () => null });

async function runStreamComplete({ upstreamErrorInfo }) {
  // buildOnStreamComplete captures errorTrace (getTrace()) synchronously, the same
  // moment chatCore.js's real streaming path does — while the request's trace
  // context is still active, well before the stream that uses it later finishes.
  // withLog assigns trace.onStreamError onto that exact trace before the handler
  // (and so this capture) ever runs.
  let onStreamComplete;
  const handler = withLog(async () => {
    ({ onStreamComplete } = buildOnStreamComplete({
      provider: "p", model: "m", connectionId: "c1", apiKey: null,
      requestStartTime: Date.now(), body: {}, stream: true,
      finalBody: null, translatedBody: null, clientRawRequest: {}, pxpipe: null,
      reqTag: "t", log: null,
    }));
    return new Response("ok");
  });
  await handler(new Request("http://x/v1/chat/completions", { method: "POST", body: "{}" }));
  // The handler has already returned (its 200 went out) — same timing as a real
  // stream, which only finishes well after that.
  onStreamComplete({ content: "[Error] Model tạm thời gặp lỗi." }, null, null, upstreamErrorInfo);
  for (let i = 0; i < 100 && !db.get(`SELECT 1 AS x FROM errorLogs`); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return db.get(`SELECT * FROM errorLogs`);
}

test("an upstream error turned into stream content is logged with the raw text, source stream, status 200", async () => {
  const raw = "KVTransferError(bootstrap_room=123): NIXL_ERR_REMOTE_DISCONNECT";
  const row = await runStreamComplete({ upstreamErrorInfo: { message: raw } });
  assert.ok(row, "a row was written");
  assert.equal(row.source, "stream");
  assert.equal(row.status, 200);
  assert.equal(row.message, `Stream failed: ${raw}`);
  assert.equal(row.provider, "p");
  assert.equal(row.model, "m");
});

test("no upstreamErrorInfo: nothing is logged", async () => {
  const row = await runStreamComplete({ upstreamErrorInfo: null });
  assert.equal(row, undefined);
});
