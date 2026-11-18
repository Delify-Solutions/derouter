// A provider with no connection test must not have its working connections
// marked as broken by the "Test connection" button, and Command Code's request rejections
// must not be reported as outages.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

register("./helpers/src-alias-hook.mjs", import.meta.url);
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-untestable-"));

const { getAdapter } = await import("../src/lib/db/driver.js");
const { createProviderConnection, getProviderConnectionById } = await import("../src/lib/db/repos/connectionsRepo.js");
const { testSingleConnection } = await import("../src/app/api/providers/[id]/test/testUtils.js");
const { parseCommandCodeError } = await import("../open-sse/executors/commandcode.js");

await getAdapter();

test("testing a connection of a provider without a test leaves the connection as it was", async () => {
  const conn = await createProviderConnection({ provider: "acme-no-test", authType: "apikey", name: "cc-1", apiKey: "k-abc", testStatus: "active" });
  const before = await getProviderConnectionById(conn.id);
  const result = await testSingleConnection(conn.id);
  assert.equal(result.untestable, true);
  assert.equal(result.valid, false);
  const after = await getProviderConnectionById(conn.id);
  assert.equal(after.testStatus, before.testStatus, "not marked as error");
  assert.equal(after.lastError ?? null, before.lastError ?? null, "no stale 'not supported' message written");
});

test("a real lock reason is not overwritten by a later test", async () => {
  const conn = await createProviderConnection({ provider: "acme-no-test", authType: "apikey", name: "cc-2", apiKey: "k-def", testStatus: "unavailable", lastError: "Invalid model: x(none)" });
  await testSingleConnection(conn.id);
  const after = await getProviderConnectionById(conn.id);
  assert.equal(after.lastError, "Invalid model: x(none)");
});

test("Command Code: a refused request is a 400, an outage stays a 503", () => {
  const status = (msg) => parseCommandCodeError({ error: msg }).statusCode;
  for (const msg of ["Invalid model: deepseek/x(none)", "Model deepseek/x(none) is not supported", "unknown model", "Validation failed: messages", "Bad request"]) {
    assert.equal(status(msg), 400, msg);
    assert.equal(parseCommandCodeError({ error: msg }).type, "invalid_request_error");
  }
  for (const msg of [
    "service unavailable", "model overloaded", "internal server error", "something weird happened",
    // outages that only MENTION a model must stay retryable 503s
    "The model is temporarily not available", "Model not available, please try again later",
    "Unknown error while calling model", "Invalid response from model provider",
    "upstream model returned invalid JSON", "Upstream model unknown error",
  ]) {
    assert.equal(status(msg), 503, msg);
  }
  // the explicit classes keep their meaning
  assert.equal(status("Rate limit exceeded"), 429);
  assert.equal(status("Unauthorized"), 401);
  assert.equal(status("model not found"), 404);
  // an explicit status from upstream always wins
  assert.equal(parseCommandCodeError({ error: { message: "Invalid model", statusCode: 422 } }).statusCode, 422);
});
