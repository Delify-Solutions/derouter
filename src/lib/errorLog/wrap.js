// The handler wrapper behind the error log, with its collaborators injected so it can be
// tested under plain `node --test` (relative imports only). src/sse/utils/withErrorLog.js
// binds it to the real key lookup.
//
// The handler runs inside an error trace (open-sse/utils/errorTrace.js): the engine notes the
// client request and each failed upstream attempt there, and this wrapper turns it into one
// entry when the response is >= 400, or when a stream dies after its headers were sent.
// Recording starts after the response is handed back, so it can never slow or break the
// request it describes.

import { createTrace, runWithTrace } from "../../../open-sse/utils/errorTrace.js";
import { recordErrorLog } from "./record.js";

// An error body is a short JSON document; anything bigger is not an error body.
const MAX_ERROR_BODY = 16 * 1024;
// Bodies read back through a clone are held in memory until the handler is done.
const MAX_CLONE_BYTES = 16 * 1024 * 1024;

async function readErrorBody(response) {
  try {
    const text = await response.text();
    return text.length > MAX_ERROR_BODY ? text.slice(0, MAX_ERROR_BODY) : text;
  } catch {
    return "";
  }
}

function canClone(request) {
  const type = request.headers.get("content-type") || "";
  const length = Number(request.headers.get("content-length") || 0);
  return /json/i.test(type) && length <= MAX_CLONE_BYTES;
}

/**
 * @param {{ resolveKey: (request: Request) => Promise<{apiKeyId?: string, owner?: string}|null>,
 *           record?: typeof recordErrorLog }} deps
 */
export function createWithErrorLog({ resolveKey, record = recordErrorLog }) {
  /**
   * @param {(request: Request, ...rest: any[]) => Promise<Response>} handler
   * @param {{ cloneBody?: boolean }} [opts] cloneBody: read the JSON body back through a clone when
   *   the handler does not note the raw request on the trace itself (every handler except chat)
   */
  return function withErrorLog(handler, { cloneBody = false } = {}) {
    return async function withErrorLogged(request, ...rest) {
      const trace = createTrace(new URL(request.url).pathname);
      const userAgent = request.headers.get("user-agent") || "";
      let bodyCopy = null;
      if (cloneBody && canClone(request)) {
        try { bodyCopy = request.clone(); } catch { /* body already used: nothing to read back */ }
      }

      // Everything costly (reading the clone, the key lookup) is passed as a function: the
      // recorder runs it only once it knows the entry is kept.
      const write = (fields) => record({
        trace,
        requestBody: bodyCopy ? async () => { try { return await bodyCopy.json(); } catch { return null; } } : null,
        key: () => resolveKey(request),
        userAgent,
        ...fields,
      });

      // A stream that fails after its headers went out is still a 200 to the client.
      trace.onStreamError = (info) => {
        const attempt = {
          at: Date.now(), provider: info.provider, model: info.model, connectionId: info.connectionId,
          status: 200, error: info.message, upstreamBodyText: info.upstreamText ?? null,
        };
        write({
          trace: { ...trace, attempts: [...trace.attempts, attempt] },
          source: "stream", status: 200, message: `Stream failed: ${info.message}`,
          streamInfo: { chunks: info.chunks ?? null, bytes: info.bytes ?? null },
        }).catch(() => {});
      };

      let response;
      try {
        response = await runWithTrace(trace, () => handler(request, ...rest));
      } catch (error) {
        // The route handler threw: Next answers 500. Keep what we know, then let it propagate.
        write({ status: 500, responseText: JSON.stringify({ error: { message: error?.message || String(error) } }) }).catch(() => {});
        throw error;
      }

      if (response && response.status >= 400) {
        // Clone synchronously: the framework consumes the original right after we return.
        const copy = response.clone();
        readErrorBody(copy).then((responseText) => write({ status: response.status, responseText })).catch(() => {});
      }
      return response;
    };
  };
}
