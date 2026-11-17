// DeepAI Code hosted-model client (api.deepai.org/deepai_code).
//
// Protocol (read from the DeepAI Code desktop app, v0.3.40):
//   - sign-in:   browser → /deepai_code/desktop_auth/?state&port → 127.0.0.1:port/auth-callback?code
//                POST /deepai_code/desktop_auth/exchange/ {code} → {api_key, username, is_pro}
//   - chat:      POST /deepai_code/chat/completions (OpenAI format), header `api-key`
//   - catalog:   GET  /deepai_code/models
//   - check-in:  GET  /deepai_code/theos → {enabled, balance, check_in:{nonce,seconds}, ...}
//                the nonce is presented on the NEXT /theos call, not on chat: every
//                API call carries lane+machine, but only /theos carries the check-in
//                nonce and the beacon (app v0.3.40, src/deepai/api.ts: checkInHeaders()
//                is passed only when path === "/theos"). One /theos fires before each
//                chat request, so the server sees a live client without a nonce per call.
//
// Device identity is per account: each signed-in account presents as its own
// desktop install — its own machine digest (persisted in the data dir so it
// survives restarts), its own per-launch instance id, and its own uptime offset
// — so the upstream cannot tie the deployment's accounts to one another through
// these headers. Presence signals the desktop app reads from a window (focus,
// agent activity) are omitted — the client itself omits them when unknown.

import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { proxyAwareFetch } from "../utils/proxyFetch.js";
import deepaiRegistry from "../providers/registry/deepai.js";

export const DEEPAI_API_ORIGIN = "https://api.deepai.org";
export const DEEPAI_CHAT_URL = `${DEEPAI_API_ORIGIN}/deepai_code/chat/completions`;
export const DEEPAI_APP_VERSION = "0.3.40";
// Billing lane the app bills under; the server answers an older lane with a legacy catalog.
export const DEEPAI_LANE_VERSION = "7";

export const DEEPAI_CHECK_IN_HEADER = "X-DeepAI-Code-Check-In";
export const DEEPAI_BEACON_HEADER = "X-DeepAI-Code-Beacon";
export const DEEPAI_MACHINE_HEADER = "X-DeepAI-Code-Machine";

// Local test routing is an explicit process opt-in and only ever a loopback origin,
// never a server- or request-provided URL (same rule as the desktop app's local mode).
export function deepaiModelBase() {
  const override = process.env.DEEPAI_LOCAL_TEST_ORIGIN;
  const origin = override && /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(override)
    ? override
    : DEEPAI_API_ORIGIN;
  return `${origin}/deepai_code`;
}

// A check-in the server refused or never answered is not retried for a while, so an
// outage or a refused account costs one short wait, not one per chat request.
const CHECK_IN_TIMEOUT_MS = 5_000;
const CHECK_IN_FAILURE_BACKOFF_MS = 60_000;
const MODELS_TIMEOUT_MS = 10_000;
const MODEL_ID = /^[a-zA-Z0-9_.-]{1,128}$/;

// Fallback catalog, used until a connection's live /models answer is cached.
// Kept in step with the registry entry (open-sse/providers/registry/deepai.js).
export const DEEPAI_STATIC_MODELS = deepaiRegistry.models.map(({ id, name }) => ({ id, name }));

const startedAt = Date.now();

// ─── device identity (one per account) ───────────────────────────────────────

export function deepaiAccountKey(apiKey) {
  return createHash("sha256").update(String(apiKey || "")).digest("hex");
}

/** @type {Map<string, string>} account key → machine digest */
const machineIds = new Map();
/** @type {Map<string, string>} account key → per-launch instance id */
const instanceIds = new Map();
/** @type {Map<string, number>} account key → fixed uptime offset (seconds) */
const beaconOffsets = new Map();

function machineIdFile(accountKey) {
  const dir = process.env.DATA_DIR || path.join(os.homedir(), ".derouter");
  return path.join(dir, "deepai-machine-ids", `${accountKey}.uuid`);
}

// Each account gets its own random UUID, kept in the data dir: the account keeps
// the same machine digest across restarts, like a real install keeps its hardware id.
function readOrCreateMachineUuid(accountKey) {
  const file = machineIdFile(accountKey);
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch { /* create below */ }
  const id = randomUUID();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, id, { mode: 0o600 });
  } catch { /* keep the in-memory id for this process */ }
  return id;
}

/** This account's machine digest (64 hex chars); stable for the account across restarts. */
export function deepaiMachineId(apiKey) {
  const key = deepaiAccountKey(apiKey);
  let digest = machineIds.get(key);
  if (!digest) {
    digest = createHash("sha256").update(readOrCreateMachineUuid(key)).digest("hex");
    machineIds.set(key, digest);
  }
  return digest;
}

/** This account's instance id — one per account per process, like the app's per-launch id. */
export function deepaiInstanceId(apiKey) {
  const key = deepaiAccountKey(apiKey);
  let id = instanceIds.get(key);
  if (!id) {
    id = randomBytes(16).toString("hex");
    instanceIds.set(key, id);
  }
  return id;
}

export function resetDeepAIStateForTests() {
  machineIds.clear();
  instanceIds.clear();
  beaconOffsets.clear();
  checkIns.clear();
  models.clear();
}

// ─── headers ─────────────────────────────────────────────────────────────────

export function deepaiBeacon(apiKey) {
  // Each account's "app" claims a launch time up to 4h before this process, fixed
  // for the process lifetime, so two accounts never report the same uptime tick.
  const key = deepaiAccountKey(apiKey);
  let offset = beaconOffsets.get(key);
  if (offset === undefined) {
    offset = randomInt(0, 4 * 60 * 60 + 1);
    beaconOffsets.set(key, offset);
  }
  return `v=${DEEPAI_APP_VERSION};up=${Math.floor((Date.now() - startedAt) / 1000) + offset}`;
}

export function deepaiLaneHeaders(apiKey) {
  return {
    "X-DeepAI-Code-Theos": DEEPAI_LANE_VERSION,
    "X-DeepAI-Code-Instance": deepaiInstanceId(apiKey),
    [DEEPAI_MACHINE_HEADER]: deepaiMachineId(apiKey),
  };
}

// ─── check-in ────────────────────────────────────────────────────────────────

/** @type {Map<string, { nonce: string, seconds: number, at: number, pending?: Promise<void> }>} */
const checkIns = new Map();

function readCheckIn(payload) {
  const value = payload?.check_in;
  return typeof value?.nonce === "string" && /^[0-9a-f]{32}$/.test(value.nonce)
    && typeof value.seconds === "number" && value.seconds > 0
    ? { nonce: value.nonce, seconds: value.seconds }
    : null;
}

/** The nonce to send with a chat request, or null when none is current. */
export function currentCheckInNonce(apiKey) {
  const entry = checkIns.get(deepaiAccountKey(apiKey));
  if (!entry || Date.now() - entry.at >= entry.seconds * 1000) return null;
  return entry.nonce;
}

async function requestTheos(apiKey, previousNonce, proxyOptions) {
  const response = await proxyAwareFetch(`${deepaiModelBase()}/theos`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      ...deepaiLaneHeaders(apiKey),
      "api-key": apiKey,
      [DEEPAI_BEACON_HEADER]: deepaiBeacon(apiKey),
      ...(previousNonce ? { [DEEPAI_CHECK_IN_HEADER]: previousNonce } : {}),
    },
    redirect: "error",
    signal: AbortSignal.timeout(CHECK_IN_TIMEOUT_MS),
  }, proxyOptions);
  const body = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, body };
}

/**
 * Renew the account's check-in when it is missing or past half its lifetime.
 * Concurrent callers share one in-flight request. Never throws: on failure the
 * chat request goes out without a fresh nonce and the server's own error reaches
 * the caller.
 */
export async function ensureDeepAICheckIn(apiKey, proxyOptions = null, log = null) {
  if (!apiKey) return;
  const key = deepaiAccountKey(apiKey);
  const entry = checkIns.get(key);
  if (entry?.pending) return entry.pending;
  const now = Date.now();
  if (entry?.retryAt && now < entry.retryAt) return;
  if (entry && now - entry.at < (entry.seconds * 1000) / 2) return;

  const pending = (async () => {
    let renewed = false;
    try {
      const result = await requestTheos(apiKey, entry?.nonce || null, proxyOptions);
      const next = readCheckIn(result.body);
      if (next) {
        checkIns.set(key, { ...next, at: Date.now() });
        renewed = true;
      } else if (!result.ok) {
        log?.warn?.("DEEPAI", `check-in refused (${result.status})`);
      }
    } catch (error) {
      log?.warn?.("DEEPAI", `check-in failed: ${error?.name || "error"}`);
    } finally {
      const latest = checkIns.get(key);
      if (latest) {
        delete latest.pending;
        // A failed renewal keeps the previous nonce until its own lifetime ends.
        if (!renewed) latest.retryAt = Date.now() + CHECK_IN_FAILURE_BACKOFF_MS;
      }
    }
  })();
  checkIns.set(key, { ...(entry || { nonce: "", seconds: 0, at: 0 }), pending });
  return pending;
}

/** Account allowance from /theos (balance, daily grant), or null. For the usage panel. */
export async function fetchDeepAIAllowance(apiKey, proxyOptions = null) {
  try {
    const result = await requestTheos(apiKey, currentCheckInNonce(apiKey), proxyOptions);
    const next = readCheckIn(result.body);
    if (next) checkIns.set(deepaiAccountKey(apiKey), { ...next, at: Date.now() });
    return result.ok ? result.body : null;
  } catch {
    return null;
  }
}

// ─── model catalog ───────────────────────────────────────────────────────────

/** @type {Map<string, { models: object[], at: number }>} */
const models = new Map();
const MODELS_TTL_MS = 5 * 60 * 1000;

export function normalizeDeepAIModels(payload) {
  const list = payload?.models;
  if (!Array.isArray(list) || list.length === 0 || list.length > 100) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || typeof item.id !== "string" || !MODEL_ID.test(item.id) || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push({
      id: item.id,
      name: typeof item.name === "string" && item.name.trim() ? item.name.trim().slice(0, 100) : item.id,
      ...(Number(item.contextWindow) > 0 ? { contextLength: Number(item.contextWindow) } : {}),
      ...(Number(item.maxTokens) > 0 ? { maxOutputTokens: Number(item.maxTokens) } : {}),
    });
  }
  return out;
}

/** Live catalog for an account; falls back to the static list when unreachable. */
export async function resolveDeepAIModels(credentials, { proxyOptions = null } = {}) {
  const apiKey = credentials?.apiKey || credentials?.accessToken;
  if (!apiKey) return { models: DEEPAI_STATIC_MODELS, source: "static" };
  const key = deepaiAccountKey(apiKey);
  const cached = models.get(key);
  if (cached && Date.now() - cached.at < MODELS_TTL_MS) return { models: cached.models, source: "cache" };
  try {
    const response = await proxyAwareFetch(`${deepaiModelBase()}/models`, {
      method: "GET",
      headers: { "Content-Type": "application/json", ...deepaiLaneHeaders(apiKey), "api-key": apiKey },
      redirect: "error",
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    }, proxyOptions);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const list = normalizeDeepAIModels(await response.json());
    if (!list.length) throw new Error("empty catalog");
    models.set(key, { models: list, at: Date.now() });
    return { models: list, source: "live" };
  } catch {
    return { models: DEEPAI_STATIC_MODELS, source: "static" };
  }
}
