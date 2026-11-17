#!/usr/bin/env node
// DeepAI Code protocol probe (open-spec task 4.2).
//
// Reads the deployment's `deepai` connections from the local DB, then talks to
// api.deepai.org exactly like the desktop app v0.3.40 does — same machine digest,
// same lane headers — once per account. Answers the questions left open:
//
//   1. Is the machine digest the same for every account? (it is, by design)
//   2. Does /theos answer each account, and what does the payload look like
//      (balance, grant, lane_version, check_in.seconds)?
//   3. Does the nonce ping-pong hold: the nonce from call N is accepted on
//      call N+1 and replaced?
//   4. With --chat: what does the server say to a real chat request per account
//      on one shared digest — 200, a quota refusal, or machine_required?
//
// Header placement mirrors the app: lane+instance+machine on every call, but the
// check-in nonce and the beacon only on /theos. Chat gets no nonce, no beacon.
//
//   node scripts/deepai-probe.mjs            # /theos per account
//   node scripts/deepai-probe.mjs --chat     # + one minimal chat per account
//   node scripts/deepai-probe.mjs --json     # full payloads, for sharing
//   node scripts/deepai-probe.mjs --model deepseek-v4.1-flash --chat
//
// Nothing is written: the SQLite file is opened read-only, and it never rotates
// accounts, never fabricates identities, and never prints an api key.

import { DatabaseSync } from "node:sqlite";
import {
  DEEPAI_APP_VERSION,
  DEEPAI_BEACON_HEADER,
  DEEPAI_CHECK_IN_HEADER,
  DEEPAI_LANE_VERSION,
  DEEPAI_STATIC_MODELS,
  deepaiAccountKey,
  deepaiBeacon,
  deepaiLaneHeaders,
  deepaiMachineId,
  deepaiModelBase,
} from "../open-sse/services/deepaiClient.js";
import { decryptSecret } from "../src/lib/crypto/secrets.js";
import { DATA_FILE } from "../src/lib/db/paths.js";
import { getDataDir } from "../src/lib/dataDir.js";

const argv = process.argv.slice(2);
const wantChat = argv.includes("--chat");
const wantJson = argv.includes("--json");
const modelFlag = argv.indexOf("--model");
const chatModel = modelFlag >= 0 ? argv[modelFlag + 1] : DEEPAI_STATIC_MODELS[0]?.id;
const TIMEOUT_MS = 20_000;

const short = (v, n = 8) => (typeof v === "string" ? v.slice(0, n) : v);
const redact = (v) => {
  if (v === null || v === undefined) return v;
  if (typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(redact);
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    out[/key|token|secret|nonce/i.test(k) ? `${k}*` : k] = redact(val);
  }
  return out;
};

async function call(path, { apiKey, previousNonce = null, body = null } = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(await deepaiLaneHeaders()),
    ...(apiKey ? { "api-key": apiKey } : {}),
  };
  if (path === "/theos") {
    headers[DEEPAI_BEACON_HEADER] = deepaiBeacon();
    if (previousNonce) headers[DEEPAI_CHECK_IN_HEADER] = previousNonce;
  }
  const started = Date.now();
  let response;
  try {
    response = await fetch(`${deepaiModelBase()}${path}`, {
      method: body ? "POST" : "GET",
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { path, status: 0, ms: Date.now() - started, error: error?.name || "network", body: null };
  }
  const text = await response.text().catch(() => "");
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON refusal */ }
  return {
    path,
    status: response.status,
    ms: Date.now() - started,
    body: json,
    text: json ? null : text.slice(0, 300),
    retryAfter: response.headers.get("retry-after"),
  };
}

function checkIn(body) {
  const value = body?.check_in;
  if (typeof value?.nonce !== "string" || typeof value.seconds !== "number") return null;
  return { nonce: value.nonce, seconds: value.seconds };
}

function refusal(body) {
  if (!body || typeof body !== "object") return null;
  return body.error?.code || body.error?.type || body.error || body.detail || body.code || null;
}

function grantFields(body) {
  if (!body || typeof body !== "object") return {};
  const keep = ["enabled", "lane_version", "balance", "theos", "daily", "grant", "granted", "next_grant", "reset", "resets_at", "is_pro", "pro", "plan"];
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (keep.includes(k) || /balance|grant|theo|reset|daily|quota/i.test(k)) out[k] = v;
  }
  return out;
}

async function probeAccount(connection, index, total) {
  const apiKey = connection.accessToken || connection.apiKey;
  const label = connection.displayName || connection.name || connection.email || connection.id;
  const key = deepaiAccountKey(apiKey).slice(0, 12);
  const result = { index, label, key, connectionId: connection.id, steps: [] };

  if (!apiKey) {
    result.steps.push({ path: "/theos", status: -1, error: "no access token on this connection" });
    return result;
  }

  const first = await call("/theos", { apiKey });
  result.steps.push(first);
  const ci1 = checkIn(first.body);
  result.firstNonce = ci1?.nonce || null;
  result.balance = first.body?.balance ?? null;
  result.grant = grantFields(first.body);

  if (ci1) {
    const second = await call("/theos", { apiKey, previousNonce: ci1.nonce });
    result.steps.push(second);
    const ci2 = checkIn(second.body);
    result.secondNonce = ci2?.nonce || null;
    result.nonceAccepted = second.status === 200;
    result.nonceRotated = Boolean(ci2 && ci2.nonce !== ci1.nonce);
    result.balanceAfter = second.body?.balance ?? null;
  }

  if (wantChat) {
    const chat = await call("/chat/completions", {
      apiKey,
      body: {
        model: chatModel,
        stream: false,
        max_tokens: 8,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
      },
    });
    result.steps.push(chat);
    result.chatStatus = chat.status;
    result.chatRefusal = refusal(chat.body);
  }

  return result;
}

function line(step) {
  const code = step.status === 0 ? `net:${step.error}` : step.status;
  const bits = [`${step.path.padEnd(20)} ${String(code).padEnd(6)} ${String(step.ms).padStart(4)}ms`];
  const ci = checkIn(step.body);
  if (ci) bits.push(`nonce=${short(ci.nonce, 8)}… ${ci.seconds}s`);
  const reason = refusal(step.body);
  if (reason) bits.push(`refusal=${typeof reason === "string" ? reason : JSON.stringify(reason)}`);
  if (step.retryAfter) bits.push(`retry-after=${step.retryAfter}`);
  if (step.text) bits.push(`text=${JSON.stringify(step.text.slice(0, 120))}`);
  return bits.join("  ");
}

// Read-only: same table and same field decryption as connectionsRepo.rowToConn,
// but without booting the DB layer (migrations, post-sync repairs) from a probe.
function loadConnections() {
  let db;
  try {
    db = new DatabaseSync(DATA_FILE, { readOnly: true });
  } catch (error) {
    console.log(`\nNo readable DB at ${DATA_FILE} (${error?.message || error}).`);
    return [];
  }
  try {
    const rows = db
      .prepare(`SELECT id, provider, authType, name, email, priority, isActive, data
                  FROM providerConnections WHERE provider = ?`)
      .all("deepai");
    return rows
      .map((row) => {
        let extra = {};
        try { extra = JSON.parse(row.data || "{}"); } catch { /* keep row columns */ }
        const connection = {
          ...extra,
          id: row.id,
          provider: row.provider,
          authType: row.authType,
          name: row.name,
          email: row.email,
          priority: row.priority,
          isActive: row.isActive === 1 || row.isActive === true,
        };
        for (const field of ["accessToken", "refreshToken", "idToken", "apiKey"]) {
          if (typeof connection[field] === "string") connection[field] = decryptSecret(connection[field]);
        }
        return connection;
      })
      .filter((connection) => connection.isActive && (connection.accessToken || connection.apiKey))
      .sort((a, b) => (a.priority || 999) - (b.priority || 999));
  } finally {
    db.close();
  }
}

async function main() {
  const digest = await deepaiMachineId();
  const connections = loadConnections();

  console.log(`data dir  ${getDataDir()}`);
  console.log(`db        ${DATA_FILE}`);
  console.log(`endpoint  ${deepaiModelBase()}`);
  console.log(`lane      ${DEEPAI_LANE_VERSION}  (beacon v=${DEEPAI_APP_VERSION})`);
  console.log(`machine   ${digest}`);
  console.log(`accounts  ${connections.length}${connections.length > 1 ? "  (all share the digest above)" : ""}`);

  if (connections.length === 0) {
    console.log("\nNo active deepai connection with a token. Sign in first.");
    process.exitCode = 2;
    return;
  }

  const results = [];
  for (let i = 0; i < connections.length; i += 1) {
    const r = await probeAccount(connections[i], i + 1, connections.length);
    results.push(r);
    console.log(`\n── acc ${i + 1}/${connections.length}  ${r.label}  key=${r.key}`);
    for (const step of r.steps) console.log(`   ${line(step)}`);
    if (r.balance !== null && r.balance !== undefined) console.log(`   balance   ${JSON.stringify(r.balance)}`);
    if (r.nonceAccepted !== undefined) {
      console.log(`   ping-pong nonce accepted=${r.nonceAccepted} rotated=${r.nonceRotated}`);
    }
    if (wantJson && r.steps.some((s) => s.body)) {
      for (const s of r.steps) {
        if (s.body) console.log(`   raw ${s.path} ${JSON.stringify(redact(s.body))}`);
      }
    }
  }

  // ── what the answers mean ────────────────────────────────────────────────
  const codes = results.map((r) => r.chatStatus ?? r.steps[0]?.status);
  const machineRequired = results.some((r) =>
    JSON.stringify(r.steps.map((s) => s.body?.error?.code || s.body?.error || "")).includes("machine_required"));
  const balances = results.map((r) => JSON.stringify(r.balance));
  const distinctBalances = new Set(balances).size;

  console.log("\n── summary");
  console.log(`   digest identical for every account : yes (computed once per deployment)`);
  console.log(`   per-account /theos answer          : ${codes.join(", ")}`);
  console.log(`   machine_required seen              : ${machineRequired ? "YES" : "no"}`);
  console.log(`   distinct balances                  : ${distinctBalances} of ${results.length}`);
  if (wantChat) {
    console.log(`   chat model                         : ${chatModel}`);
    console.log(`   chat status per account            : ${results.map((r) => r.chatStatus).join(", ")}`);
    const refusals = [...new Set(results.map((r) => r.chatRefusal).filter(Boolean).map(String))];
    if (refusals.length) console.log(`   chat refusal codes                 : ${refusals.join(" | ")}`);
  }
  console.log(
    "\n   Read: 200 + a nonce on every account means the pool is wired and the\n" +
    "   server does not balk at N accounts on one digest. A quota refusal tells us\n" +
    "   the exact error text to key the account-wide lock on; machine_required\n" +
    "   means the digest is not being accepted at all."
  );
}

main().catch((error) => {
  console.error(`probe failed: ${error?.stack || error}`);
  process.exitCode = 1;
});
