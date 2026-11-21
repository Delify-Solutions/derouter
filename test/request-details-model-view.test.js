// Usage → Details by model (spec admin-usage-views "Request details by model"): the
// requestedModel column and its backfill, the model filter per view, sorting by tokens and
// latency with missing figures last, and the route's validation.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "derouter-details-model-view-"));
// DATA_DIR must be set before the DB driver is imported.
process.env.DATA_DIR = tmpDir;

const { getAdapter } = await import("../src/lib/db/driver.js");
const details = await import("../src/lib/db/repos/requestDetailsRepo.js");

let db;

// Rows as stored before the requestedModel column existed: the requested model only in data.
function legacyRow(id, ts, { model, provider, requestedModel, tokens, latency }) {
  const data = { id, timestamp: ts, provider, model, requestedModel, status: "200", tokens, latency };
  db.run(
    `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, apiKey, status, data) VALUES(?, ?, ?, ?, NULL, NULL, '200', ?)`,
    [id, ts, provider, model, JSON.stringify(data)]
  );
}

before(async () => {
  db = await getAdapter();
  legacyRow("r1", "2026-11-10T01:00:00.000Z", { model: "glm-5.3:pre", provider: "zai", requestedModel: "glm-5",
    tokens: { prompt_tokens: 100, completion_tokens: 50 }, latency: { total: 900 } });
  legacyRow("r2", "2026-11-10T02:00:00.000Z", { model: "glm-5", provider: "openrouter", requestedModel: "glm-5",
    tokens: { input_tokens: 500, output_tokens: 20 }, latency: { total: 300 } });
  legacyRow("r3", "2026-11-10T03:00:00.000Z", { model: "gpt-4o", provider: "openai", requestedModel: null,
    tokens: {}, latency: {} });
  legacyRow("r4", "2026-11-10T04:00:00.000Z", { model: "glm-5.3:pre", provider: "zai", requestedModel: "glm-5",
    tokens: { prompt_tokens: 10, completion_tokens: 1 }, latency: { total: 1500 } });
  legacyRow("r5", "2026-11-10T05:00:00.000Z", { model: "claude-x", provider: "anthropic", requestedModel: "claude-sonnet",
    tokens: { prompt_tokens: 0, completion_tokens: 0 }, latency: { total: 50 } });
  assert.equal(db.get(`SELECT COUNT(*) AS c FROM requestDetails WHERE requestedModel IS NOT NULL`).c, 0);
});

after(() => {
  try { db?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const ids = (res) => res.details.map((d) => d.id);

test("rows stored before the column are backfilled from their data on first listing", async () => {
  await details.getRequestDetails({ page: 1, pageSize: 10 });
  const rows = db.all(`SELECT id, requestedModel FROM requestDetails ORDER BY id`);
  assert.deepEqual(rows.map((r) => [r.id, r.requestedModel]), [
    ["r1", "glm-5"], ["r2", "glm-5"], ["r3", null], ["r4", "glm-5"], ["r5", "claude-sonnet"],
  ]);
});

test("the model filter matches the model of the chosen view, before pagination", async () => {
  const combo = await details.getRequestDetails({ modelView: "requested", model: "glm-5", page: 1, pageSize: 2, includeModels: true });
  assert.equal(combo.pagination.totalItems, 3, "every request that asked for glm-5, whichever upstream served it");
  assert.deepEqual(ids(combo), ["r4", "r2"]);
  const page2 = await details.getRequestDetails({ modelView: "requested", model: "glm-5", page: 2, pageSize: 2 });
  assert.deepEqual(ids(page2), ["r1"]);
  // A request without a requested model is listed under its upstream model.
  assert.deepEqual(ids(await details.getRequestDetails({ modelView: "requested", model: "gpt-4o", page: 1, pageSize: 10 })), ["r3"]);
  assert.deepEqual(combo.models, ["claude-sonnet", "glm-5", "gpt-4o"]);

  const upstream = await details.getRequestDetails({ modelView: "upstream", model: "glm-5", page: 1, pageSize: 10, includeModels: true });
  assert.deepEqual(ids(upstream), ["r2"]);
  assert.deepEqual(upstream.models, ["claude-x", "glm-5", "glm-5.3:pre", "gpt-4o"]);
  // Callers that do not choose a view keep the historical upstream match, and get no list.
  const legacy = await details.getRequestDetails({ model: "glm-5", page: 1, pageSize: 10 });
  assert.deepEqual(ids(legacy), ["r2"]);
  assert.equal(legacy.models, undefined);
});

test("sorting by tokens and latency puts rows without the figure last, in both directions", async () => {
  const all = { page: 1, pageSize: 10 };
  // tokens: r2 520, r1 150, r4 11, r5 0, r3 none
  assert.deepEqual(ids(await details.getRequestDetails({ ...all, sort: "tokens", order: "desc" })), ["r2", "r1", "r4", "r5", "r3"]);
  assert.deepEqual(ids(await details.getRequestDetails({ ...all, sort: "tokens", order: "asc" })), ["r5", "r4", "r1", "r2", "r3"]);
  // latency: r4 1500, r1 900, r2 300, r5 50, r3 none
  assert.deepEqual(ids(await details.getRequestDetails({ ...all, sort: "latency", order: "desc" })), ["r4", "r1", "r2", "r5", "r3"]);
  assert.deepEqual(ids(await details.getRequestDetails({ ...all, sort: "latency", order: "asc" })), ["r5", "r2", "r1", "r4", "r3"]);
  // time, default newest first; and oldest first
  assert.deepEqual(ids(await details.getRequestDetails(all)), ["r5", "r4", "r3", "r2", "r1"]);
  assert.deepEqual(ids(await details.getRequestDetails({ ...all, sort: "time", order: "asc" })), ["r1", "r2", "r3", "r4", "r5"]);
  // sort applies before pagination
  assert.deepEqual(ids(await details.getRequestDetails({ page: 2, pageSize: 2, sort: "tokens", order: "desc" })), ["r4", "r5"]);
});

test("free-text search matches model names and provider", async () => {
  assert.deepEqual(ids(await details.getRequestDetails({ q: "SONNET", page: 1, pageSize: 10 })), ["r5"]);
  assert.deepEqual(ids(await details.getRequestDetails({ q: "openrouter", page: 1, pageSize: 10 })), ["r2"]);
  // LIKE wildcards in the text are literal
  assert.deepEqual(ids(await details.getRequestDetails({ q: "%", page: 1, pageSize: 10 })), []);
});

test("the flush writes the requested model column", async () => {
  const { updateSettings } = await import("../src/lib/db/repos/settingsRepo.js");
  delete process.env.ENABLE_REQUEST_LOGS;
  await updateSettings({ enableObservability: true, observabilityBatchSize: 1 });
  await details.saveRequestDetail({
    id: "r6", provider: "zai", model: "glm-5.3:pre", requestedModel: "glm-5", status: "200",
    timestamp: "2026-11-10T06:00:00.000Z",
  });
  for (let i = 0; i < 100 && !db.get(`SELECT 1 AS x FROM requestDetails WHERE id = 'r6'`); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(db.get(`SELECT requestedModel FROM requestDetails WHERE id = 'r6'`).requestedModel, "glm-5");
});

test("the route rejects an invalid sort or order with HTTP 400 and lists nothing", async () => {
  register("./helpers/src-alias-hook.mjs", import.meta.url);
  // Plain Node does not resolve the extensionless "next/server" the bundler accepts.
  register(
    "data:text/javascript,export async function resolve(s, c, next) { return next(s === 'next/server' ? 'next/server.js' : s, c); }",
    import.meta.url
  );
  const { GET } = await import("../src/app/api/usage/request-details/route.js");

  for (const qs of ["sort=price", "order=up", "sort=tokens&order=sideways"]) {
    const res = await GET(new Request(`http://localhost/api/usage/request-details?${qs}`));
    assert.equal(res.status, 400, qs);
    const body = await res.json();
    assert.equal(body.details, undefined);
  }

  const ok = await GET(new Request("http://localhost/api/usage/request-details?modelView=requested&model=glm-5&sort=latency&order=asc"));
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.deepEqual(body.details.map((d) => d.id), ["r2", "r1", "r4", "r6"]);
  assert.deepEqual(body.details.map((d) => [d.requestedModel, d.upstreamModel]), [
    ["glm-5", "glm-5"], ["glm-5", "glm-5.3:pre"], ["glm-5", "glm-5.3:pre"], ["glm-5", "glm-5.3:pre"],
  ]);
  assert.ok(body.models.includes("glm-5"));
  assert.equal(body.modelView, "requested");

  // Anything other than "upstream" is the requested view.
  const fallback = await GET(new Request("http://localhost/api/usage/request-details?modelView=foo&model=glm-5"));
  assert.equal((await fallback.json()).pagination.totalItems, 4);
});

test("search folds Unicode case: Vietnamese capitals match lowercase input and back", async () => {
  const owner = { userId: "u-vn", email: "duc@x.vn", displayName: "Nguyễn Văn Đức", keyName: "Máy chủ Hà Nội" };
  const data = { id: "r-vn", timestamp: "2026-11-10T07:00:00.000Z", provider: "zai", model: "glm-5.3:pre", requestedModel: "glm-5", status: "200", owner };
  db.run(
    // as the flush writes it, requestedModel column included
    `INSERT INTO requestDetails(id, timestamp, provider, model, status, data, userId, requestedModel) VALUES(?, ?, ?, ?, '200', ?, 'u-vn', ?)`,
    [data.id, data.timestamp, data.provider, data.model, JSON.stringify(data), data.requestedModel]
  );
  const find = async (q) => ids(await details.getRequestDetails({ q, page: 1, pageSize: 50 }));
  assert.deepEqual(await find("đức"), ["r-vn"]);
  assert.deepEqual(await find("ĐỨC"), ["r-vn"]);
  assert.deepEqual(await find("MÁY"), ["r-vn"]);
  assert.deepEqual(await find("nguyễn văn"), ["r-vn"]);
  // typed decomposed (combining marks) still matches the composed stored text
  assert.deepEqual(await find("đức".normalize("NFD")), ["r-vn"]);
  assert.deepEqual(await find("hà nội"), ["r-vn"]);
  // search combines with the other filters and counts before pagination
  const res = await details.getRequestDetails({ q: "đức", modelView: "requested", model: "glm-5", page: 1, pageSize: 1 });
  assert.equal(res.pagination.totalItems, 1);
  assert.deepEqual(ids(await details.getRequestDetails({ q: "đức", provider: "openai", page: 1, pageSize: 10 })), []);
});

test("the search scan reads the table in slices and finds the same rows", async () => {
  const all = { page: 1, pageSize: 50 };
  for (const q of ["glm", "đức", "openai", "zzz-none"]) {
    const whole = await details.getRequestDetails({ ...all, q });
    // one row per slice: every slice boundary is crossed
    const sliced = await details.getRequestDetails({ ...all, q, searchSliceRows: 1 });
    assert.deepEqual(ids(sliced), ids(whole), q);
    assert.equal(sliced.pagination.totalItems, whole.pagination.totalItems, q);
  }
  // a slice size of 0, a negative or a non-number still advances
  for (const bad of [0, -5, "x", 0.4]) {
    assert.deepEqual(ids(await details.getRequestDetails({ ...all, q: "glm", searchSliceRows: bad })),
      ids(await details.getRequestDetails({ ...all, q: "glm" })), String(bad));
  }
  // slices combine with the other filters
  const combo = await details.getRequestDetails({ ...all, q: "glm", provider: "zai", searchSliceRows: 2 });
  assert.ok(combo.details.every((d) => d.provider === "zai"));
  assert.deepEqual(ids(combo), ids(await details.getRequestDetails({ ...all, q: "glm", provider: "zai" })));
});

test("the requested-model filter and model list use the expression index", () => {
  const plan = (sql, params = []) => db.all(`EXPLAIN QUERY PLAN ${sql}`, params).map((r) => r.detail).join(" | ");
  assert.match(
    plan(`SELECT COUNT(*) FROM requestDetails WHERE COALESCE(NULLIF(requestedModel, ''), model) = ?`, ["glm-5"]),
    /idx_rd_effmodel/
  );
  assert.match(
    plan(`SELECT DISTINCT COALESCE(NULLIF(requestedModel, ''), model) AS m FROM requestDetails
           WHERE COALESCE(COALESCE(NULLIF(requestedModel, ''), model), '') != '' ORDER BY m ASC LIMIT 500`),
    /idx_rd_effmodel/
  );
});
