// Drive a TransformStream from open-sse/utils/stream.js with scripted upstream chunks and
// collect what the client would receive. The harness registers the "@/" alias hook first.
import { register } from "node:module";

register("./alias-hook.mjs", import.meta.url);

/**
 * Poll `predicate` until it is truthy, or throw after `timeoutMs`.
 *
 * Loopback tests must not assume the upstream handler ran within a fixed sleep:
 * `node --test` runs files in parallel, and a CPU-starved event loop can take
 * hundreds of milliseconds to dispatch a request the kernel already accepted.
 * Waiting for the observable condition is both faster and load-independent.
 */
export async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 10, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export const streamMod = await import("../../open-sse/utils/stream.js");
export const { FORMATS } = await import("../../open-sse/translator/formats.js");

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Pipe `chunks` (strings or byte arrays) through `ts`; resolve to { out, completed }. */
export async function drive(ts, chunks) {
  const writer = ts.writable.getWriter();
  const reader = ts.readable.getReader();
  const parts = [];
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(dec.decode(value, { stream: true }));
    }
  })();
  for (const c of chunks) await writer.write(typeof c === "string" ? enc.encode(c) : c);
  await writer.close();
  await pump;
  return parts.join("");
}

/** Build a stream whose onStreamComplete result is captured on `result`. */
export function capture() {
  const result = { content: null, usage: undefined, calls: 0 };
  result.onStreamComplete = (content, usage) => { result.content = content; result.usage = usage; result.calls++; };
  return result;
}

/** SSE helpers */
export const data = (obj) => `data: ${typeof obj === "string" ? obj : JSON.stringify(obj)}\n\n`;
export const event = (name, obj) => `event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`;
export const DONE = "data: [DONE]\n\n";

/** Parse every `data:` JSON payload of an SSE text (skips [DONE]). */
export function payloads(sse) {
  return sse.split("\n").filter((l) => l.startsWith("data:") && !l.includes("[DONE]")).map((l) => JSON.parse(l.slice(5)));
}
export function countDone(sse) {
  return sse.split("\n").filter((l) => l.trim() === "data: [DONE]").length;
}
