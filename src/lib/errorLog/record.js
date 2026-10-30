// Turns a failed request into one errorLogs row. Called by the handler wrapper
// (src/lib/errorLog/wrap.js) for failed responses and for streams that die half way.
//
// Logging must never break the request it is describing, so recordErrorLog()
// swallows every failure. Relative imports only: tests import this under plain
// `node --test`; the repo functions are injectable for the same reason.

import { compactBody, describeBody, maskSecrets } from "./compact.js";
import {
  getErrorLogConfig,
  insertErrorLog,
  pruneErrorLogs,
} from "../db/repos/errorLogsRepo.js";

const MAX_MESSAGE = 1000;
const MAX_RESPONSE = 8 * 1024;
const MAX_ATTEMPT_ERROR = 2 * 1024;
const MAX_ATTEMPTS = 20;

const PRUNE_EVERY_WRITES = 25;
const PRUNE_EVERY_MS = 10 * 60_000;
let writesSincePrune = 0;
let lastPruneAt = 0;

/** Where the failure came from, judged by what the router did before it. */
export function classifySource({ attempts, status }) {
  if (attempts && attempts.length) return "upstream";
  const s = Number(status);
  if (s === 401 || s === 402 || s === 403 || s === 429) return "platform"; // the router's own verdicts
  if (s >= 400 && s < 500) return "request"; // bad body, unknown model
  return "router"; // nothing reached an upstream: no credentials, all accounts cooling down, a crash
}

/**
 * True when a failed response is not worth an entry:
 *  - 499: the client went away, nothing failed;
 *  - 401 with no upstream call: scanner traffic with attacker-controlled bodies and no key to
 *    attribute it to. A 401 an upstream returned (an expired provider credential) is kept.
 */
export function isSkipped({ status, attemptCount, forced }) {
  if (forced) return false;
  const s = Number(status);
  if (s === 499) return true;
  return s === 401 && attemptCount === 0;
}

function parseError(responseText) {
  const text = typeof responseText === "string" ? responseText : "";
  try {
    const j = JSON.parse(text);
    const err = j?.error ?? j;
    const message = typeof err === "string" ? err : err?.message ?? j?.message;
    return {
      message: typeof message === "string" ? message : text,
      code: err?.code != null ? String(err.code) : j?.code != null ? String(j.code) : null,
    };
  } catch {
    return { message: text, code: null };
  }
}

function parseText(text) {
  if (typeof text !== "string" || !text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function attemptRow(a, t0) {
  return {
    provider: a.provider ?? null,
    model: a.model ?? null,
    connectionId: a.connectionId ?? null,
    connectionName: a.connectionName ?? null,
    status: Number(a.status) || 0,
    error: maskSecrets(String(a.error ?? "")).slice(0, MAX_ATTEMPT_ERROR),
    afterMs: a.at && t0 ? Math.max(0, a.at - t0) : null,
  };
}

async function lazy(value) {
  return typeof value === "function" ? value() : value;
}

/**
 * @param {object} input
 * @param {object} input.trace          errorTrace trace (clientBodyText, requestedModel, attempts, startedAt)
 * @param {string} [input.endpoint]
 * @param {number} input.status         status the client saw (200 for a mid-stream failure)
 * @param {string} [input.responseText] error response body
 * @param {unknown|(() => Promise<unknown>)} [input.requestBody] client body when the trace holds no raw text;
 *   a function is only called once the entry is known to be kept
 * @param {object|(() => Promise<object|null>)} [input.key] {apiKeyId, owner}; same laziness
 * @param {string} [input.userAgent]
 * @param {string} [input.source]       forces the source (mid-stream failures)
 * @param {string} [input.message]      forces the message (mid-stream failures)
 * @param {string} [input.upstreamText] JSON text of the body sent upstream when no attempt carries it
 * @param {object} [input.streamInfo]   {chunks, bytes} of a stream that died
 * @param {object} [deps]               test seams
 * @returns {Promise<string|null>} id of the stored row, or null when nothing was stored
 */
export async function recordErrorLog(input, deps = {}) {
  try {
    const getConfig = deps.getConfig || getErrorLogConfig;
    const insert = deps.insert || insertErrorLog;
    const prune = deps.prune || pruneErrorLogs;

    const status = Number(input.status) || 0;
    const trace = input.trace || { attempts: [], startedAt: null, clientBodyText: null, requestedModel: null };
    const attempts = (trace.attempts || []).slice(-MAX_ATTEMPTS);
    if (isSkipped({ status, attemptCount: attempts.length, forced: !!input.source })) return null;
    const cfg = await getConfig();
    if (!cfg.enabled) return null;

    // Past this point the entry is kept, so the costly parts (parsing the body, key lookup) run.
    const last = attempts[attempts.length - 1] || null;
    const source = input.source || classifySource({ attempts, status });
    const parsed = parseError(input.responseText);
    // The engine prefixes upstream errors with a "[provider-id/model]" tag; the row has those columns.
    const message = maskSecrets(input.message ?? parsed.message ?? "")
      .replace(/^\[[^\]\s]+\/[^\]\s]+\]\s*/, "")
      .slice(0, MAX_MESSAGE);

    // The request exactly as the client sent it: raw text kept by the trace (never the parsed
    // object, which the engine rewrites), or the body read back through a clone.
    const rawText = typeof trace.clientBodyText === "string" ? trace.clientBodyText : null;
    const clientBody = rawText != null ? parseText(rawText) : await lazy(input.requestBody);
    const bodyBytes = rawText != null ? Buffer.byteLength(rawText) : undefined;
    const facts = describeBody(clientBody, bodyBytes);
    // A request too large to keep as text still has its size recorded.
    if (trace.clientBodyBytes != null) {
      facts.bodyBytes = trace.clientBodyBytes;
      facts.estTokens = Math.round(trace.clientBodyBytes / 4);
    }
    // Platform denials say nothing the key owner's request would explain, and would
    // push real upstream errors out of the capped log.
    const keepBody = cfg.storePrompt && source !== "platform" && clientBody != null;
    const limit = { maxBytes: cfg.maxBodyKB * 1024 };

    const request = keepBody ? compactBody(clientBody, { ...limit, originalBytes: facts.bodyBytes }) : null;
    const upstreamBody = keepBody ? parseText(last?.upstreamBodyText ?? input.upstreamText) : null;
    const upstreamRequest = upstreamBody != null ? compactBody(upstreamBody, limit) : null;
    const key = await lazy(input.key);

    const row = {
      source,
      status,
      endpoint: input.endpoint || trace.endpoint || null,
      requestedModel: trace.requestedModel ?? (typeof clientBody?.model === "string" ? clientBody.model : null),
      provider: last?.provider ?? null,
      model: last?.model ?? null,
      connectionId: last?.connectionId ?? null,
      connectionName: last?.connectionName ?? null,
      apiKeyId: key?.apiKeyId ?? null,
      owner: key?.owner ?? null,
      errorCode: parsed.code,
      message,
      stream: facts.stream,
      bodyBytes: facts.bodyBytes,
      estTokens: facts.estTokens,
      messageCount: facts.messageCount,
      latencyMs: trace.startedAt ? Date.now() - trace.startedAt : 0,
      data: {
        // A preview is prompt text too: it follows the same rule as the stored body.
        preview: keepBody ? facts.preview : "",
        response: maskSecrets(String(input.responseText ?? "")).slice(0, MAX_RESPONSE),
        attempts: attempts.map((a) => attemptRow(a, trace.startedAt)),
        request: request ? request.value : null,
        requestTruncated: request ? request.truncated : false,
        upstreamRequest: upstreamRequest ? upstreamRequest.value : null,
        upstreamTruncated: upstreamRequest ? upstreamRequest.truncated : false,
        upstreamBytes: upstreamRequest ? upstreamRequest.originalBytes : 0,
        promptStored: !!request,
        userAgent: input.userAgent ? String(input.userAgent).slice(0, 200) : null,
        stream: input.streamInfo ?? null,
      },
    };

    const id = await insert(row);

    writesSincePrune += 1;
    if (writesSincePrune >= PRUNE_EVERY_WRITES || Date.now() - lastPruneAt > PRUNE_EVERY_MS) {
      writesSincePrune = 0;
      lastPruneAt = Date.now();
      await prune({ retentionDays: cfg.retentionDays, maxRows: cfg.maxRows });
    }
    return id;
  } catch (err) {
    // Never include the request or response in this line: it may hold customer text.
    console.error("[errorLog] could not record a failed request:", err?.message || err);
    return null;
  }
}

/** Test hook: forget when the last prune ran. */
export function __resetPruneClock() {
  writesSincePrune = 0;
  lastPruneAt = 0;
}
