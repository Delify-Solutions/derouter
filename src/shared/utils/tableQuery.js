// Search / filter / sort / Top N for the admin usage tables (spec admin-usage-views
// "Shared table toolbar"), plus the URL form of that state.
//
// Pure functions, no imports: tests load this file under plain `node --test`, and the
// client components (TableToolbar, the usage tables) share one implementation.
//
// URL keys are namespaced per table so two tables on one page never override each other:
//   <ns>.q        search text
//   <ns>.sort     sort field
//   <ns>.dir      "desc" | "asc"
//   <ns>.top      10 | 20 | 50 | "all"
//   <ns>.f.<name> equality filter
// A value equal to the table's default is left out of the URL, so removing the
// parameters restores the default order.

export const SORT_DIRS = ["desc", "asc"];
export const TOP_VALUES = [10, 20, 50];

/** True for a value that has nothing to sort on (never used, no last request…). */
export function isEmptyValue(value) {
  return value == null || value === "" || (typeof value === "number" && Number.isNaN(value));
}

function asText(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(asText).join(" ");
  return String(value);
}

const fold = (s) => asText(s).normalize("NFC").toLowerCase();

// Field and filter names may come from the URL (`<ns>.f.<name>`) and row keys from client
// model names: own properties only, so "__proto__" or "constructor" are plain names.
const own = (obj, key) => (obj != null && Object.hasOwn(obj, key) ? obj[key] : undefined);
function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
}
const read = (row, field) => (typeof field === "function" ? field(row) : own(row, field));

/** 10 | 20 | 50, or 0 for "all". */
export function normalizeTop(value) {
  const n = Number(value);
  return TOP_VALUES.includes(n) ? n : 0;
}

/**
 * Keep the rows matching every active filter and the search text.
 *   searchFields  fields (or getters) whose text is searched, case-insensitively;
 *   filters       { name: value } — "" or null means "all";
 *   filterFields  { name: field | getter } — a getter may return a list (the row matches
 *                 when the list holds the value).
 */
export function filterRows(rows, { search = "", searchFields = [], filters = {}, filterFields = {} } = {}) {
  const q = fold(search).trim();
  const active = Object.entries(filters || {}).filter(([name, v]) => !isEmptyValue(v) && own(filterFields, name));
  if (!q && active.length === 0) return [...rows];
  return rows.filter((row) => {
    for (const [name, want] of active) {
      const got = read(row, own(filterFields, name));
      const ok = Array.isArray(got) ? got.some((g) => String(g) === String(want)) : String(got ?? "") === String(want);
      if (!ok) return false;
    }
    if (!q) return true;
    return searchFields.some((f) => fold(read(row, f)).includes(q));
  });
}

/**
 * Compare two rows for `sortField` / `sortDir`. Rows without a value sort after every row
 * that has one, in both directions; equal rows are ordered by name, ascending.
 */
export function compareRows(a, b, options = {}) {
  const { sortField, sortDir = "desc" } = options;
  // Own properties only: every object inherits a `valueOf` from Object.prototype, so a
  // destructuring default would never apply.
  const valueOf = Object.hasOwn(options, "valueOf") ? options.valueOf : read;
  const nameOf = Object.hasOwn(options, "nameOf") ? options.nameOf : (r) => r?.name;
  if (sortField) {
    const va = valueOf(a, sortField);
    const vb = valueOf(b, sortField);
    const ea = isEmptyValue(va);
    const eb = isEmptyValue(vb);
    if (ea !== eb) return ea ? 1 : -1;
    if (!ea) {
      const c = typeof va === "number" && typeof vb === "number"
        ? Math.sign(va - vb)
        : String(va).localeCompare(String(vb), undefined, { sensitivity: "base", numeric: true });
      if (c !== 0) return sortDir === "asc" ? c : -c;
    }
  }
  return asText(nameOf(a)).localeCompare(asText(nameOf(b)), undefined, { sensitivity: "base", numeric: true });
}

export function sortRows(rows, options = {}) {
  return [...rows].sort((a, b) => compareRows(a, b, options));
}

/**
 * Filter, sort and cut rows. Returns { rows, matched, total }: the rows to show, how many
 * matched the search and filters, and how many there were.
 */
export function applyTableQuery(rows, options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const matched = filterRows(list, options);
  const sorted = sortRows(matched, options);
  const top = normalizeTop(options.top);
  return { rows: top ? sorted.slice(0, top) : sorted, matched: matched.length, total: list.length };
}

/**
 * Next state after a click on a sortable column header: the same field flips the
 * direction; another field starts at "desc" (or "asc" for fields in `ascFirst`, e.g. names).
 */
export function nextSortState(state, field, { ascFirst = [] } = {}) {
  if (state.sort === field) return { ...state, dir: state.dir === "asc" ? "desc" : "asc" };
  return { ...state, sort: field, dir: ascFirst.includes(field) ? "asc" : "desc" };
}

/** Whether a search text or a filter is set. */
export function hasActiveQuery(state) {
  return Boolean(String(state?.q || "").trim()) || Object.values(state?.filters || {}).some((v) => !isEmptyValue(v));
}

/** "Xoá bộ lọc": search and filters reset, sort and Top N kept. */
export function clearQueryFilters(state) {
  return { ...state, q: "", filters: {} };
}

/**
 * Which state a table shows:
 *   "loading" | "error" | "ready" | "filtered-empty" (data exists, nothing matches) | "empty".
 * `total` may be null when the size of the unfiltered data is unknown (server-side
 * filtering); `filtersActive` then tells the two empty states apart.
 */
export function tableStateOf({ loading = false, error = null, total = null, matched = 0, filtersActive = false } = {}) {
  if (loading) return "loading";
  if (error) return "error";
  if (matched > 0) return "ready";
  if (filtersActive && total !== 0) return "filtered-empty";
  return "empty";
}

function defaultsOf(defaults = {}) {
  return {
    q: "",
    sort: defaults.sort ?? null,
    dir: SORT_DIRS.includes(defaults.dir) ? defaults.dir : "desc",
    top: normalizeTop(defaults.top),
    filters: { ...(defaults.filters || {}) },
  };
}

function entriesOf(searchParams) {
  if (!searchParams) return [];
  if (typeof searchParams.entries === "function") return [...searchParams.entries()];
  return Object.entries(searchParams);
}

/**
 * Read one table's state from the URL.
 *   defaults   { sort, dir, top, filters }
 *   sortFields the allowed sort fields (anything else falls back to the default)
 *   legacy     { map: { oldField: newField } } — reads the pre-namespace `sortBy` /
 *              `sortOrder` parameters when the table has no sort of its own in the URL,
 *              so old links keep their order.
 */
export function readTableQuery(searchParams, ns, defaults = {}, { sortFields = null, legacy = null } = {}) {
  const base = defaultsOf(defaults);
  const get = (key) => (typeof searchParams?.get === "function" ? searchParams.get(key) : own(searchParams, key)) ?? null;
  const allowed = (field) => typeof field === "string" && field !== "" && (!sortFields || sortFields.includes(field));

  const state = { ...base, filters: { ...base.filters } };
  state.q = get(`${ns}.q`) ?? "";

  const sort = get(`${ns}.sort`);
  const dir = get(`${ns}.dir`);
  if (allowed(sort)) {
    state.sort = sort;
    if (SORT_DIRS.includes(dir)) state.dir = dir;
  } else {
    if (SORT_DIRS.includes(dir)) state.dir = dir;
    const legacySort = legacy ? get("sortBy") : null;
    const mapped = legacySort != null ? own(legacy.map, legacySort) : null;
    if (allowed(mapped)) {
      state.sort = mapped;
      const legacyDir = get("sortOrder");
      if (SORT_DIRS.includes(legacyDir)) state.dir = legacyDir;
    }
  }

  const top = get(`${ns}.top`);
  if (top === "all") state.top = 0;
  else if (top != null) state.top = normalizeTop(top) || base.top;

  const prefix = `${ns}.f.`;
  for (const [key, value] of entriesOf(searchParams)) {
    if (key.startsWith(prefix) && value !== "") setOwn(state.filters, key.slice(prefix.length), value);
  }
  return state;
}

/**
 * Write one table's state into `params` (a URLSearchParams, mutated and returned). Keys of
 * other tables are left alone; values equal to the defaults are removed. With `legacy`, the
 * old `sortBy` / `sortOrder` parameters are dropped: they are only an initial state.
 */
export function writeTableQuery(params, ns, state, defaults = {}, { legacy = null } = {}) {
  const base = defaultsOf(defaults);
  for (const key of [...params.keys()]) {
    if (key.startsWith(`${ns}.`)) params.delete(key);
  }
  if (legacy) {
    params.delete("sortBy");
    params.delete("sortOrder");
  }
  const q = String(state.q || "").trim() ? String(state.q) : "";
  if (q) params.set(`${ns}.q`, q);
  if (state.sort && state.sort !== base.sort) params.set(`${ns}.sort`, state.sort);
  if (SORT_DIRS.includes(state.dir) && state.dir !== base.dir) params.set(`${ns}.dir`, state.dir);
  const top = normalizeTop(state.top);
  if (top !== base.top) params.set(`${ns}.top`, top ? String(top) : "all");
  for (const [name, value] of Object.entries(state.filters || {})) {
    if (!isEmptyValue(value) && String(own(base.filters, name) ?? "") !== String(value)) params.set(`${ns}.f.${name}`, String(value));
  }
  return params;
}
