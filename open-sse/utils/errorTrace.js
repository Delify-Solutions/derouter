// Per-request trace that lets the engine hand what it knows about a failing request
// (the client body, each failed upstream attempt, the body actually sent upstream)
// to whoever logs errors, without the engine importing the app layer.
//
// The app wraps a handler in runWithTrace(); engine code calls the note* helpers,
// which do nothing when no trace is active. No dependencies, so it can be imported
// from open-sse and from src alike.

import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

// Keep in step with MAX_COMPACT_INPUT_BYTES in src/lib/errorLog/compact.js.
const MAX_CLIENT_TEXT = 8 * 1024 * 1024;

export function createTrace(endpoint = "") {
  return {
    endpoint,
    startedAt: Date.now(),
    // The request exactly as received. The parsed body is NOT kept: the engine rewrites it in
    // place (model id, roles, injected prompts, compressed tool results), so a reference to it
    // would show the router's version as the customer's.
    clientBodyText: null,
    // Size of a request too large to keep as text (see MAX_CLIENT_TEXT).
    clientBodyBytes: null,
    requestedModel: null,
    // Body of the upstream call that just failed, as JSON text (a later combo attempt would otherwise
    // rewrite the shared objects); markAccountUnavailable() attaches it to the failure it reports.
    pendingUpstreamText: null,
    attempts: [],
    // Set by the app layer: receives a failure that happens after the response started (mid-stream).
    onStreamError: null,
  };
}

export function runWithTrace(trace, fn) {
  return storage.run(trace, fn);
}

export function getTrace() {
  return storage.getStore() || null;
}

/**
 * Remember the request as the client sent it: the raw JSON text (a string cannot be mutated)
 * and the model string, which the engine overwrites on the parsed body.
 */
export function noteClientBody(body, rawText) {
  const t = getTrace();
  if (!t || t.clientBodyText != null || t.clientBodyBytes != null) return;
  t.requestedModel = typeof body?.model === "string" ? body.model : null;
  if (typeof rawText !== "string") return;
  // A request this large is described, never stored, so holding a second copy for its whole
  // lifetime would only cost memory.
  if (rawText.length > MAX_CLIENT_TEXT) t.clientBodyBytes = Buffer.byteLength(rawText);
  else t.clientBodyText = rawText;
}

/**
 * Remember the body that was sent upstream (after translation and token-saver rewrites).
 * Called on the failure path only, so serialising it here is not a per-request cost.
 */
export function noteUpstreamBody(body) {
  const t = getTrace();
  if (t) t.pendingUpstreamText = bodyText(body);
}

/** JSON text of a body, or null when it has none or cannot be serialised. */
export function bodyText(body) {
  if (body == null) return null;
  try {
    return JSON.stringify(body);
  } catch {
    return null;
  }
}

/**
 * One failed upstream call; carries the pending upstream body text of the call that just failed.
 * @param {{provider?:string, model?:string, connectionId?:string, status?:number, error?:string}} attempt
 */
export function noteAttempt(attempt) {
  const t = getTrace();
  if (!t) return;
  // Only the last attempt's body is ever stored; earlier copies would be held for nothing.
  for (const a of t.attempts) a.upstreamBodyText = null;
  t.attempts.push({
    at: Date.now(),
    ...attempt,
    upstreamBodyText: attempt.upstreamBodyText ?? t.pendingUpstreamText ?? null,
  });
  t.pendingUpstreamText = null;
}

/** Report a failure after the response headers were sent, using the trace captured at request start. */
export function reportStreamError(trace, info) {
  try {
    trace?.onStreamError?.(info);
  } catch {
    // logging must never disturb the stream teardown
  }
}
