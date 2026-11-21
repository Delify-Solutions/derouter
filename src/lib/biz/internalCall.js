// Server-side guard and embedding calls (design D5).
//
// The guard model and the embedding model are paid by the operator, not the
// customer: both run on the default admin key, which bypasses admission and has no
// plan queue behind it. They still go through the router's own handlers
// (`handleChat` / `handleEmbeddings`), so combos, fallbacks and provider
// credentials behave exactly as they do for a customer request, and the cost shows
// up in usage under the admin key.
//
// Every failure — non-2xx, unparseable body, timeout — becomes one error type,
// `GuardUnavailableError`, because the pipeline must fail closed and must not be
// able to tell "the guard was slow" apart from "the guard was down".

// 15 s per the spec; BIZ_GUARD_TIMEOUT_MS lets the unit test prove the deadline
// without waiting a real quarter of a minute.
export const GUARD_TIMEOUT_MS = (() => {
  const raw = Number(process.env.BIZ_GUARD_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
})();
export const GUARD_MAX_TOKENS = 200;

/** Any failure of an internal guard/embedding call. */
export class GuardUnavailableError extends Error {
  constructor(message = "guard_unavailable", { cause = null, status = 0 } = {}) {
    super(message);
    this.name = "GuardUnavailableError";
    this.cause = cause;
    this.status = status;
  }
}

export function isGuardUnavailable(error) {
  return error instanceof GuardUnavailableError || error?.name === "GuardUnavailableError";
}

// Injectable for tests: the pipeline never imports a Next.js handler directly at
// module scope, and a unit test can stub both calls without an HTTP server.
let overrides = {
  chat: null,
  embeddings: null,
  adminKey: null,
};

/** Test seam: replace the callers (pass `null` to restore the real ones). */
export function setInternalCallers(patch = {}) {
  overrides = { ...overrides, ...patch };
}

/**
 * A deadline for one internal call.
 *
 * The `Request.signal` alone is not enough: the router's handlers run in-process
 * and never read it, so a hung guard model would hold the customer's request open
 * forever. `race` is therefore what enforces the deadline — it rejects with
 * GuardUnavailableError after `GUARD_TIMEOUT_MS` whatever the handler is doing.
 */
function withTimeout(signal) {
  const controller = new AbortController();
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new GuardUnavailableError("internal call timed out"));
    }, GUARD_TIMEOUT_MS);
    // Deliberately NOT unref'd: the deadline is the only thing keeping a hung
    // guard call from holding the process open with nothing else to do.
  });
  // Swallow the rejection when the call wins the race, or it surfaces as an
  // unhandled rejection on every successful guard call.
  timeout.catch(() => {});
  const abort = () => controller.abort();
  signal?.addEventListener?.("abort", abort, { once: true });
  return {
    signal: controller.signal,
    race: (promise) => Promise.race([promise, timeout]),
    done: () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.("abort", abort);
    },
  };
}

async function adminSecret() {
  if (overrides.adminKey) return overrides.adminKey;
  const { ensureDefaultAdminKey } = await import("../db/repos/apiKeysRepo.js");
  const { getConsistentMachineId } = await import("../../shared/utils/machineId.js");
  const machineId = await getConsistentMachineId();
  await ensureDefaultAdminKey(machineId);
  const db = (await import("../db/driver.js")).getAdapter;
  const adapter = await db();
  const row = adapter.get(`SELECT key FROM apiKeys WHERE userId IS NULL ORDER BY createdAt ASC LIMIT 1`);
  if (!row?.key) throw new GuardUnavailableError("no admin key");
  return row.key;
}

function jsonRequest(path, body, secret, signal) {
  const base = process.env.INTERNAL_BASE_URL || "http://127.0.0.1";
  return new Request(new URL(path, base), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * One non-streaming chat completion through the router, on the admin key.
 *
 * @returns {Promise<string>} the assistant text
 * @throws {GuardUnavailableError}
 */
export async function callGuardChat({ model, messages, temperature = 0, maxTokens = GUARD_MAX_TOKENS, signal = null } = {}) {
  if (!model) throw new GuardUnavailableError("guard model is not set");
  const clock = withTimeout(signal);
  try {
    const secret = await adminSecret();
    const handler = overrides.chat ?? (await import("../../sse/handlers/chat.js")).handleChat;
    const request = jsonRequest(
      "/v1/chat/completions",
      { model, messages, temperature, max_tokens: maxTokens, stream: false },
      secret,
      clock.signal
    );
    const response = await clock.race(handler(request));
    if (!response || !response.ok) {
      throw new GuardUnavailableError("guard call failed", { status: response?.status ?? 0 });
    }
    const data = await clock.race(response.json().catch(() => null));
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text === "string") return text;
    // A content array (some providers) still carries the text pieces.
    if (Array.isArray(text)) {
      const joined = text.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("");
      if (joined) return joined;
    }
    throw new GuardUnavailableError("guard call returned no text");
  } catch (error) {
    if (isGuardUnavailable(error)) throw error;
    throw new GuardUnavailableError("guard call failed", { cause: error });
  } finally {
    clock.done();
  }
}

/**
 * Embed one or more texts with the configured embedding model.
 *
 * @returns {Promise<Float32Array[]>} one vector per input, in order
 * @throws {GuardUnavailableError}
 */
export async function callEmbeddings({ model, input, signal = null } = {}) {
  if (!model) throw new GuardUnavailableError("embedding model is not set");
  const texts = Array.isArray(input) ? input : [input];
  if (texts.length === 0) return [];
  const clock = withTimeout(signal);
  try {
    const secret = await adminSecret();
    const handler = overrides.embeddings ?? (await import("../../sse/handlers/embeddings.js")).handleEmbeddings;
    const request = jsonRequest("/v1/embeddings", { model, input: texts }, secret, clock.signal);
    const response = await clock.race(handler(request));
    if (!response || !response.ok) {
      throw new GuardUnavailableError("embedding call failed", { status: response?.status ?? 0 });
    }
    const data = await clock.race(response.json().catch(() => null));
    const rows = Array.isArray(data?.data) ? data.data : null;
    if (!rows || rows.length !== texts.length) throw new GuardUnavailableError("embedding call returned no vectors");
    return rows.map((row) => {
      const values = row?.embedding;
      if (!Array.isArray(values) || values.length === 0) throw new GuardUnavailableError("embedding vector is empty");
      return Float32Array.from(values);
    });
  } catch (error) {
    if (isGuardUnavailable(error)) throw error;
    throw new GuardUnavailableError("embedding call failed", { cause: error });
  } finally {
    clock.done();
  }
}

/** Embed a single text (the retrieval path). */
export async function embedOne(model, text, { signal = null } = {}) {
  const [vector] = await callEmbeddings({ model, input: [text], signal });
  if (!vector) throw new GuardUnavailableError("embedding vector is empty");
  return vector;
}
