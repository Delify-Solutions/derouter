// Knowledge-base ingestion worker (spec business-bots "Knowledge base ingestion",
// design D8).
//
// Documents are created in `processing` with their chunks already stored and no
// embeddings. This worker embeds them in the background: an in-process kick when a
// document is added or retried, plus a 30-second sweep as the fallback, so a
// document left behind by a failed kick (or a crash) still completes.
//
// Same shape as src/lib/billing/expiry.js: a `globalThis` guard (Next.js dev
// hot-reload re-evaluates modules), unref'd timers, a build-phase skip and a start
// line in `runHeavyStartup`.
import { getAdapter } from "../db/driver.js";
import {
  pendingDocumentsSync,
  pendingChunksSync,
  saveChunkEmbeddingSync,
  finishDocumentSync,
  failDocumentSync,
} from "../db/repos/bizDocumentsRepo.js";
import { encodeVector } from "./vector.js";
import { callEmbeddings, GuardUnavailableError } from "./internalCall.js";
import { getBusinessSettings } from "./settings.js";
import { invalidateBotCache } from "./retrieval.js";

export const INGEST_INTERVAL_MS = 30_000;
export const INGEST_BATCH_CHUNKS = 32;

const g = (globalThis.__bizIngestWorker ??= {
  started: false,
  interval: null,
  running: false,
  kick: null,
  lastRunAt: null,
  lastResult: null,
  lastError: null,
});

// Injectable for tests: the real embedding call goes through the router's handlers,
// which a unit test cannot run. `null` restores the real one.
let embedOverride = null;

/** Test seam: replace the embedding caller (pass `null` to restore). */
export function setIngestEmbedder(fn) {
  embedOverride = typeof fn === "function" ? fn : null;
}

function isTruthyEnv(value) {
  if (value == null) return false;
  const v = String(value).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Embed every pending chunk of one document.
 *
 * @returns {Promise<"ready"|"failed">}
 */
async function embedDocument(db, doc, embeddingModel) {
  for (;;) {
    const chunks = pendingChunksSync(db, doc.id, INGEST_BATCH_CHUNKS);
    if (chunks.length === 0) break;
    let vectors;
    try {
      const embed = embedOverride ?? callEmbeddings;
      vectors = await embed({
        model: embeddingModel,
        input: chunks.map((chunk) => chunk.text),
      });
    } catch (error) {
      const message =
        error instanceof GuardUnavailableError
          ? "Không tạo được embedding cho tài liệu, vui lòng thử lại sau"
          : "Không tạo được embedding cho tài liệu";
      db.transaction(() => failDocumentSync(db, doc.id, message));
      return "failed";
    }
    db.transaction(() => {
      chunks.forEach((chunk, index) => {
        const vector = vectors[index];
        if (!vector) return;
        saveChunkEmbeddingSync(db, chunk.id, {
          embedding: encodeVector(vector),
          embeddingModel,
          dims: vector.length,
        });
      });
    });
  }
  const status = db.transaction(() => finishDocumentSync(db, doc.id, { embeddingModel }));
  return status;
}

/**
 * One sweep. Never throws: a DB or provider hiccup must not kill the interval.
 *
 * @param {{ limit?:number, embeddingModel?:string }} [options]
 * @returns {Promise<{ processed:number, ready:number, failed:number }|null>}
 */
export async function runIngestTick({ limit = 8, embeddingModel = null } = {}) {
  if (g.running) return null;
  g.running = true;
  try {
    const model = embeddingModel ?? (await getBusinessSettings()).embeddingModel;
    if (!model) {
      // Nothing can be embedded until the admin sets the model; documents stay
      // `processing` and pick up on the first sweep after it is set.
      g.lastRunAt = new Date().toISOString();
      g.lastResult = { processed: 0, ready: 0, failed: 0 };
      return g.lastResult;
    }

    const db = await getAdapter();
    const docs = pendingDocumentsSync(db, limit);
    let ready = 0;
    let failed = 0;
    for (const doc of docs) {
      const status = await embedDocument(db, doc, model);
      invalidateBotCache(doc.botId);
      if (status === "ready") ready += 1;
      else failed += 1;
    }
    g.lastRunAt = new Date().toISOString();
    g.lastResult = { processed: docs.length, ready, failed };
    g.lastError = null;
    return g.lastResult;
  } catch (error) {
    g.lastError = error?.message || String(error);
    console.warn("[IngestWorker] sweep failed (swallowed):", g.lastError);
    return null;
  } finally {
    g.running = false;
  }
}

/** Ask for an immediate sweep; coalesces concurrent kicks into one. */
export function kickIngest() {
  if (g.kick) return g.kick;
  g.kick = Promise.resolve()
    .then(() => runIngestTick())
    .catch(() => null)
    .finally(() => {
      g.kick = null;
    });
  return g.kick;
}

/**
 * Start the sweeper. Idempotent.
 * @returns {boolean} true when this call started it
 */
export function startIngestWorker({ intervalMs = INGEST_INTERVAL_MS } = {}) {
  if (g.started) return false;
  if (isTruthyEnv(process.env.DISABLE_BIZ_INGEST_WORKER)) return false;
  if (process.env.NEXT_PHASE === "phase-production-build") return false;

  g.started = true;
  const period = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : INGEST_INTERVAL_MS;
  // Startup resume: documents still `processing` when the server stopped pick up
  // on the first sweep, which is exactly what a kick from here does.
  const safeTick = () => {
    runIngestTick().catch((error) => {
      console.warn("[IngestWorker] unhandled tick rejection (swallowed):", error?.message || error);
    });
  };
  g.interval = setInterval(safeTick, period);
  if (g.interval.unref) g.interval.unref();
  const first = setTimeout(safeTick, 0);
  if (first.unref) first.unref();
  return true;
}

export function stopIngestWorker() {
  if (g.interval) {
    clearInterval(g.interval);
    g.interval = null;
  }
  g.started = false;
}

export function getIngestWorkerStatus() {
  return {
    started: g.started,
    running: g.running,
    intervalMs: INGEST_INTERVAL_MS,
    lastRunAt: g.lastRunAt,
    lastResult: g.lastResult,
    lastError: g.lastError,
  };
}
