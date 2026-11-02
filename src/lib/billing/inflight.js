// Concurrent-request cap per customer account.
//
// Admission only asks "does a plan still have credit?" and the charge is taken when
// a request FINISHES. Without a cap, a burst of N parallel requests is admitted on
// the same remaining credit and every cost past it becomes debt; on an unlimited
// plan the same burst overshoots the "$X per window" limits. The cap bounds what
// one burst can run up to (cap × one request) — a second burst is refused by
// admission because the credit is gone or the window is full.
//
// A request holds one slot from admission until its response body is finished,
// cancelled or errored. The slot lives in an AsyncLocalStorage scope opened by
// the handler wrapper (withInflightScope), so enforcement deep in the call stack
// can take it without threading a handle through every handler. A request that
// runs outside such a scope is not capped (tests, internal callers). A slot that
// is never released expires after LEASE_TTL_MS so a missed release can never lock
// an account out for good.
//
// Single-process, in-memory: the deployment is one instance.
// Relative imports only: tests import this file under plain `node --test`.
import { AsyncLocalStorage } from "node:async_hooks";

export const LEASE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_CONCURRENT = 10;

/** Per-account cap. CUSTOMER_MAX_CONCURRENT_REQUESTS=0 disables it. */
export function maxConcurrentRequests() {
  const raw = process.env.CUSTOMER_MAX_CONCURRENT_REQUESTS;
  if (raw == null || String(raw).trim() === "") return DEFAULT_MAX_CONCURRENT;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_CONCURRENT;
}

export function concurrencyLimitMessage(max) {
  return `Tài khoản đang có quá nhiều request chạy cùng lúc (tối đa ${max}). Đợi request trước xong rồi thử lại.`;
}

// Survives dev hot-reload; shared by every route bundle in the process.
if (!global._derouterInflight) global._derouterInflight = { byUser: new Map(), seq: 0, als: new AsyncLocalStorage() };
const state = global._derouterInflight;

function activeLeases(userId, now) {
  const leases = state.byUser.get(userId);
  if (!leases) return null;
  for (const [id, acquiredAt] of leases) {
    if (now - acquiredAt >= LEASE_TTL_MS) leases.delete(id);
  }
  if (leases.size === 0) {
    state.byUser.delete(userId);
    return null;
  }
  return leases;
}

/** Slots held by `userId` right now (diagnostics and tests). */
export function inflightCount(userId, now = Date.now()) {
  return activeLeases(userId, now)?.size ?? 0;
}

/** Open a scope for one request. */
export function createRequestScope() {
  return { releases: new Map(), released: false };
}

/** Release every slot the scope holds. Idempotent. */
export function releaseScope(scope) {
  if (!scope || scope.released) return;
  scope.released = true;
  for (const release of scope.releases.values()) release();
  scope.releases.clear();
}

export function runInScope(scope, fn) {
  return state.als.run(scope, fn);
}

export function currentScope() {
  return state.als.getStore() ?? null;
}

/**
 * Take a slot for `userId` in the current request scope.
 * @returns {{ ok: true } | { ok: false, max: number }}
 */
export function acquireSlot(userId, { max = maxConcurrentRequests(), now = Date.now(), scope = currentScope() } = {}) {
  if (!userId || max <= 0 || !scope || scope.released) return { ok: true };
  if (scope.releases.has(userId)) return { ok: true }; // one slot per request, however many checks it runs

  const leases = activeLeases(userId, now);
  if (leases && leases.size >= max) return { ok: false, max };

  const id = ++state.seq;
  const map = leases || new Map();
  map.set(id, now);
  state.byUser.set(userId, map);
  scope.releases.set(userId, () => {
    const current = state.byUser.get(userId);
    if (!current) return;
    current.delete(id);
    if (current.size === 0) state.byUser.delete(userId);
  });
  return { ok: true };
}

/**
 * The response with `release` bound to the end of its body: run once when the
 * body is fully read, cancelled by the client or errors. A response without a
 * body releases immediately.
 */
export function releaseWhenDone(response, release) {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    release();
  };
  if (!response || !response.body) {
    once();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done: finished, value } = await reader.read();
        if (finished) {
          once();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        once();
        controller.error(error);
      }
    },
    async cancel(reason) {
      once();
      try { await reader.cancel(reason); } catch { /* already closed */ }
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/**
 * Wrap a route handler so it runs in a request scope and releases its slots when
 * the response finishes. A handler called from inside another wrapped handler
 * shares the outer scope; the outer one releases.
 */
export function withInflightScope(handler) {
  return async function inflightScoped(request, ...rest) {
    if (currentScope()) return handler(request, ...rest);
    const scope = createRequestScope();
    let response;
    try {
      response = await runInScope(scope, () => handler(request, ...rest));
    } catch (error) {
      releaseScope(scope);
      throw error;
    }
    if (scope.releases.size === 0) {
      scope.released = true;
      return response;
    }
    return releaseWhenDone(response, () => releaseScope(scope));
  };
}
