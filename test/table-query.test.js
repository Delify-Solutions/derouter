// The shared table toolbar's pure helper (spec admin-usage-views "Shared table toolbar").
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  applyTableQuery, filterRows, sortRows, nextSortState, readTableQuery, writeTableQuery,
  hasActiveQuery, clearQueryFilters, tableStateOf,
} = await import("../src/shared/utils/tableQuery.js");

const rows = [
  { name: "beta", model: "glm-5", providers: ["zai", "openrouter"], requests: 5, cost: 300, lastUsed: 2000 },
  { name: "Alpha", model: "gpt-4o", providers: ["openai"], requests: 5, cost: 100, lastUsed: null },
  { name: "gamma", model: "glm-5", providers: ["zai"], requests: 12, cost: 50, lastUsed: 1000 },
  { name: "delta", model: "claude", providers: ["anthropic"], requests: 1, cost: 900, lastUsed: null },
];
const names = (list) => list.map((r) => r.name);

test("search is case-insensitive across the given fields", () => {
  assert.deepEqual(names(filterRows(rows, { search: "GLM", searchFields: ["model"] })), ["beta", "gamma"]);
  assert.deepEqual(names(filterRows(rows, { search: "alpha", searchFields: ["name", "model"] })), ["Alpha"]);
  assert.deepEqual(names(filterRows(rows, { search: "OpenRouter", searchFields: [(r) => r.providers] })), ["beta"]);
  assert.deepEqual(names(filterRows(rows, { search: "  ", searchFields: ["name"] })), names(rows));
});

test("filters match by equality; a list value matches when it holds the value; empty means all", () => {
  const filterFields = { model: "model", provider: (r) => r.providers };
  assert.deepEqual(names(filterRows(rows, { filters: { model: "glm-5" }, filterFields })), ["beta", "gamma"]);
  assert.deepEqual(names(filterRows(rows, { filters: { provider: "zai" }, filterFields })), ["beta", "gamma"]);
  assert.deepEqual(names(filterRows(rows, { filters: { provider: "zai", model: "glm-5" }, filterFields, search: "gam", searchFields: ["name"] })), ["gamma"]);
  assert.deepEqual(names(filterRows(rows, { filters: { model: "" }, filterFields })), names(rows));
});

test("ties are ordered by name, ascending, in both directions", () => {
  assert.deepEqual(names(sortRows(rows, { sortField: "requests", sortDir: "desc" })), ["gamma", "Alpha", "beta", "delta"]);
  assert.deepEqual(names(sortRows(rows, { sortField: "requests", sortDir: "asc" })), ["delta", "Alpha", "beta", "gamma"]);
});

test("rows without a value sort after every row that has one, in both directions", () => {
  assert.deepEqual(names(sortRows(rows, { sortField: "lastUsed", sortDir: "desc" })), ["beta", "gamma", "Alpha", "delta"]);
  assert.deepEqual(names(sortRows(rows, { sortField: "lastUsed", sortDir: "asc" })), ["gamma", "beta", "Alpha", "delta"]);
});

test("Top N cuts after sorting and the counts report shown, matched and total", () => {
  const out = applyTableQuery(rows, { sortField: "cost", sortDir: "desc", top: 10, filters: { model: "glm-5" }, filterFields: { model: "model" } });
  assert.deepEqual(names(out.rows), ["beta", "gamma"]);
  assert.equal(out.matched, 2);
  assert.equal(out.total, 4);
  assert.equal(applyTableQuery(rows, { top: 0 }).rows.length, 4);
  assert.equal(applyTableQuery(rows, { top: 2 }).rows.length, 4, "only Top 10 / 20 / 50 exist; anything else means all");

  const forty = Array.from({ length: 40 }, (_, i) => ({ name: `u${String(i).padStart(2, "0")}`, cost: i * 10 }));
  const top10 = applyTableQuery(forty, { sortField: "cost", sortDir: "desc", top: 10 });
  assert.equal(top10.rows.length, 10);
  assert.equal(top10.rows[0].name, "u39");
  assert.equal(`${top10.rows.length} / ${top10.total}`, "10 / 40");
});

test("a header click picks the field (most first) and a second click flips the direction", () => {
  let s = { sort: "requests", dir: "desc" };
  s = nextSortState(s, "cost");
  assert.deepEqual(s, { sort: "cost", dir: "desc" });
  s = nextSortState(s, "cost");
  assert.deepEqual(s, { sort: "cost", dir: "asc" });
  assert.deepEqual(nextSortState(s, "name", { ascFirst: ["name"] }), { sort: "name", dir: "asc" });
});

const DEFAULTS = { sort: "cost", dir: "desc", top: 0 };
const OPTIONS = { sortFields: ["requests", "tokens", "cost", "lastUsed"] };

test("the URL round-trips each table's state under its own namespace", () => {
  const params = new URLSearchParams("tab=users&ov-key.sort=requests&ov-key.dir=asc");
  const state = { q: "Acme", sort: "requests", dir: "asc", top: 10, filters: { user: "a@x.vn", activity: "" } };
  writeTableQuery(params, "users", state, DEFAULTS, OPTIONS);
  assert.equal(params.get("users.q"), "Acme");
  assert.equal(params.get("users.sort"), "requests");
  assert.equal(params.get("users.dir"), "asc");
  assert.equal(params.get("users.top"), "10");
  assert.equal(params.get("users.f.user"), "a@x.vn");
  assert.equal(params.has("users.f.activity"), false);
  // other tables' keys are untouched
  assert.equal(params.get("ov-key.sort"), "requests");
  assert.equal(params.get("tab"), "users");

  const back = readTableQuery(new URLSearchParams(params.toString()), "users", DEFAULTS, OPTIONS);
  assert.deepEqual(back, { q: "Acme", sort: "requests", dir: "asc", top: 10, filters: { user: "a@x.vn" } });
  const other = readTableQuery(params, "ov-key", { sort: "requests", dir: "desc", top: 0 }, OPTIONS);
  assert.equal(other.dir, "asc");
});

test("defaults are left out of the URL, so removing the parameters restores them", () => {
  const params = new URLSearchParams("users.sort=requests&users.top=all");
  writeTableQuery(params, "users", { q: "", sort: "cost", dir: "desc", top: 0, filters: {} }, DEFAULTS, OPTIONS);
  assert.equal(params.toString(), "");
  assert.deepEqual(readTableQuery(params, "users", DEFAULTS, OPTIONS), { q: "", sort: "cost", dir: "desc", top: 0, filters: {} });
  // an explicit "all" against a Top default is written as such
  writeTableQuery(params, "t", { top: 0 }, { top: 20 });
  assert.equal(params.get("t.top"), "all");
  assert.equal(readTableQuery(params, "t", { top: 20 }).top, 0);
});

test("invalid URL values fall back to the defaults", () => {
  const s = readTableQuery(new URLSearchParams("users.sort=price&users.dir=sideways&users.top=7"), "users", DEFAULTS, OPTIONS);
  assert.deepEqual(s, { q: "", sort: "cost", dir: "desc", top: 0, filters: {} });
});

test("the legacy sortBy / sortOrder are read as the initial state and dropped on the first write", () => {
  const legacy = { map: { rawModel: "name", requests: "requests", totalTokens: "tokens" } };
  const opts = { sortFields: ["requests", "tokens", "name"], legacy };
  const defaults = { sort: "requests", dir: "desc" };
  const params = new URLSearchParams("sortBy=totalTokens&sortOrder=asc");
  const s = readTableQuery(params, "ov-model", defaults, opts);
  assert.equal(s.sort, "tokens");
  assert.equal(s.dir, "asc");
  // the table's own parameters win over the legacy ones
  assert.equal(readTableQuery(new URLSearchParams("sortBy=totalTokens&ov-model.sort=name"), "ov-model", defaults, opts).sort, "name");
  // an unknown legacy field keeps the default
  assert.equal(readTableQuery(new URLSearchParams("sortBy=inputCost&sortOrder=asc"), "ov-model", defaults, opts).sort, "requests");

  writeTableQuery(params, "ov-model", s, defaults, opts);
  assert.equal(params.has("sortBy"), false);
  assert.equal(params.has("sortOrder"), false);
  assert.equal(params.get("ov-model.sort"), "tokens");
  assert.equal(params.get("ov-model.dir"), "asc");
});

test("clearing filters keeps the sort and Top N; table states", () => {
  const s = { q: "x", sort: "cost", dir: "asc", top: 10, filters: { model: "glm-5" } };
  assert.equal(hasActiveQuery(s), true);
  const cleared = clearQueryFilters(s);
  assert.deepEqual(cleared, { q: "", sort: "cost", dir: "asc", top: 10, filters: {} });
  assert.equal(hasActiveQuery(cleared), false);

  assert.equal(tableStateOf({ loading: true }), "loading");
  assert.equal(tableStateOf({ error: "boom" }), "error");
  assert.equal(tableStateOf({ total: 4, matched: 2 }), "ready");
  assert.equal(tableStateOf({ total: 4, matched: 0, filtersActive: true }), "filtered-empty");
  assert.equal(tableStateOf({ total: 0, matched: 0, filtersActive: true }), "empty");
  assert.equal(tableStateOf({ total: 0, matched: 0 }), "empty");
  // server-side filtering: the unfiltered size is unknown
  assert.equal(tableStateOf({ total: null, matched: 0, filtersActive: true }), "filtered-empty");
});

test("names like __proto__ and constructor are plain names in rows, filters and the URL", () => {
  const named = [
    { name: "__proto__", model: "__proto__", requests: 3 },
    { name: "constructor", model: "constructor", requests: 1 },
    { name: "valueOf", model: "valueOf", requests: 2 },
  ];
  const filterFields = { model: "model" };
  assert.deepEqual(names(filterRows(named, { filters: { model: "constructor" }, filterFields })), ["constructor"]);
  assert.deepEqual(names(sortRows(named, { sortField: "requests", sortDir: "desc" })), ["__proto__", "valueOf", "constructor"]);
  assert.deepEqual(names(filterRows(named, { search: "PROTO", searchFields: ["name"] })), ["__proto__"]);

  // URL filter names that are not filter fields of the table are ignored, never inherited
  const s = readTableQuery(new URLSearchParams("t.f.__proto__=x&t.f.constructor=y&t.f.model=valueOf"), "t");
  assert.ok(Object.hasOwn(s.filters, "__proto__"));
  assert.equal(Object.getPrototypeOf(s.filters), Object.prototype);
  assert.deepEqual(names(filterRows(named, { filters: s.filters, filterFields })), ["valueOf"]);
  // a legacy sort naming an inherited member is not a sort field
  assert.equal(readTableQuery(new URLSearchParams("sortBy=constructor"), "t", { sort: "requests" }, { legacy: { map: {} } }).sort, "requests");
  assert.equal(({}).x, undefined);
  assert.equal(({}).model, undefined);
});

test("search folds Unicode case", () => {
  const vn = [{ name: "Nguyễn Văn Đức" }, { name: "Máy chủ" }, { name: "other" }];
  assert.deepEqual(names(filterRows(vn, { search: "đức", searchFields: ["name"] })), ["Nguyễn Văn Đức"]);
  assert.deepEqual(names(filterRows(vn, { search: "MÁY", searchFields: ["name"] })), ["Máy chủ"]);
  assert.deepEqual(names(filterRows(vn, { search: "đức".normalize("NFD"), searchFields: ["name"] })), ["Nguyễn Văn Đức"]);
});
