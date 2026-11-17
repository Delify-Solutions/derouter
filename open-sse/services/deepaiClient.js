// DeepAI Code hosted-model client (api.deepai.org/deepai_code).
//
// Protocol (read from the DeepAI Code desktop app, v0.3.40):
//   - sign-in:   browser → /deepai_code/desktop_auth/?state&port → 127.0.0.1:port/auth-callback?code
//                POST /deepai_code/desktop_auth/exchange/ {code} → {api_key, username, is_pro}
//   - chat:      POST /deepai_code/chat/completions (OpenAI format), header `api-key`
//   - catalog:   GET  /deepai_code/models
//   - check-in:  GET  /deepai_code/theos → {enabled, balance, check_in:{nonce,seconds}, ...}
//                the nonce rides every chat request as X-DeepAI-Code-Check-In.
//
// Identity headers are NOT fabricated per account: every account on this
// deployment reports the same machine digest (this host's own identifier), and
// the beacon carries only facts derivable here (uptime). Presence signals the
// desktop app reads from a window (focus, agent activity) are omitted — the
// client itself omits them when unknown.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
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
// One instance id per process, like the app's per-launch id.
const INSTANCE_ID = randomBytes(16).toString("hex");

// ─── machine id (one per deployment) ─────────────────────────────────────────

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
let machineIdPromise = null;

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: "utf8", timeout: 10_000, windowsHide: true }, (error, stdout) =>
      resolve(error ? "" : stdout));
  });
}

async function readHostIdentifier() {
  try {
    if (process.platform === "darwin") {
      const out = await run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
      const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out);
      if (m && UUID_RE.test(m[1])) return m[1].toLowerCase();
    } else if (process.platform === "linux") {
      for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
        try {
          const id = fs.readFileSync(file, "utf8").trim().toLowerCase();
          if (/^[0-9a-f]{32}$/.test(id) && !/^0+$/.test(id)) return id;
        } catch { /* try next */ }
      }
    }
  } catch { /* fall through to the persisted id */ }
  return null;
}

function persistedIdFile() {
  const dir = process.env.DATA_DIR || path.join(os.homedir(), ".derouter");
  return path.join(dir, "deepai-machine-id");
}

// A container has no stable firmware id, so the fallback is generated once and
// kept in the data dir: the same value for every account, across restarts.
function readOrCreatePersistedId() {
  const file = persistedIdFile();
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

/** SHA-256 digest of this host's identifier; computed once per process. */
export function deepaiMachineId() {
  machineIdPromise ??= readHostIdentifier().then((raw) =>
    createHash("sha256").update(raw || readOrCreatePersistedId()).digest("hex"));
  return machineIdPromise;
}

export function resetDeepAIStateForTests() {
  machineIdPromise = null;
  checkIns.clear();
  models.clear();
}

// ─── headers ─────────────────────────────────────────────────────────────────

export function deepaiBeacon() {
  return `v=${DEEPAI_APP_VERSION};up=${Math.floor((Date.now() - startedAt) / 1000)}`;
}

export async function deepaiLaneHeaders() {
  return {
    "X-DeepAI-Code-Theos": DEEPAI_LANE_VERSION,
    "X-DeepAI-Code-Instance": INSTANCE_ID,
    [DEEPAI_MACHINE_HEADER]: await deepaiMachineId(),
  };
}

export function deepaiAccountKey(apiKey) {
  return createHash("sha256").update(String(apiKey || "")).digest("hex");
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
      ...(await deepaiLaneHeaders()),
      "api-key": apiKey,
      [DEEPAI_BEACON_HEADER]: deepaiBeacon(),
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
      headers: { "Content-Type": "application/json", ...(await deepaiLaneHeaders()), "api-key": apiKey },
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
