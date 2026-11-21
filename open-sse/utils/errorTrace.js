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
// An error body is a short JSON document; the error log keeps at most 8 KB of one
// (MAX_RESPONSE in src/lib/errorLog/record.js), so a bigger cap would only hold memory.
const MAX_RAW_ERROR_TEXT = 16 * 1024;

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
    // The error body exactly as the router produced it, BEFORE the customer-facing mask
    // rewrote it (src/lib/models/publicModel.js). The mask replaces the upstream's own
    // explanation with a generic Vietnamese sentence, which erases the one field that
    // names the fault ("param":"tool_choice"). The log is admin-only and already runs
    // maskSecrets over everything it stores, so the raw text is what makes an entry
    // actionable. Null when nothing was masked.
    rawErrorResponseText: null,
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
 * Remember an error response body before the customer-facing mask rewrites it.
 *
 * The mask is applied to the live response (src/lib/models/publicModel.js), so by the
 * time the error log reads the body it holds the generic sentence the customer sees —
 * `"Invalid input"` with no `param`, no upstream wording, nothing to debug from. The
 * app layer calls this with the text it read BEFORE masking. Only the first call wins:
 * a combo retries, but the masked body the client finally received describes the last
 * failure, and that is the one worth keeping.
 */
export function noteRawErrorResponse(text) {
  const t = getTrace();
  if (!t || t.rawErrorResponseText != null) return;
  if (typeof text !== "string" || !text) return;
  t.rawErrorResponseText = text.length > MAX_RAW_ERROR_TEXT ? text.slice(0, MAX_RAW_ERROR_TEXT) : text;
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
