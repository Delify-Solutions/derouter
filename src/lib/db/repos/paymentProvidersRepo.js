// Receiving providers: CRUD with encrypted secrets and a public projection that
// never hands a secret back (design D2/D8).
//
// Locked accounts are a shared resource: one provider row is one bank/Binance
// account the operator can be paid into. Secrets live in the `secrets` JSON with
// every value encrypted by `encryptSecret`, and leave this module only through
// `getProviderWithSecrets`, which is for fetchers and never for a response.
//
// This repo MAY import the driver and the crypto module (design D2), which is why
// the payment engine itself is driver-free and takes an adapter.
import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { encryptSecret, decryptSecret, isEncrypted } from "../../crypto/secrets.js";
import crypto from "node:crypto";

export const PROVIDER_KINDS = ["sepay", "web2m", "acb", "binance"];

/** Which secret keys each kind uses, and which are required. */
export const SECRET_KEYS = {
  sepay: { required: ["webhookKey"], optional: ["apiToken"] },
  web2m: { required: ["token"], optional: ["password"] },
  acb: { required: ["username", "password"], optional: ["proxyUrl"] },
  binance: { required: ["apiKey", "apiSecret"], optional: [] },
};

/** The poll interval floor per kind (spec payment-reconciliation "Polling providers"). */
export const MIN_POLL_INTERVAL = { sepay: 15, web2m: 15, acb: 30, binance: 15 };

function nowIso() {
  return new Date().toISOString();
}

/** A fresh 32-byte base64url webhook key — the value the admin copies into SePay. */
export function generateWebhookKey() {
  return crypto.randomBytes(32).toString("base64url");
}

function parseConfig(row) {
  const value = parseJson(row.config, {});
  return value && typeof value === "object" ? value : {};
}

function encryptSecretsMap(kind, secrets = {}) {
  const allowed = SECRET_KEYS[kind];
  const out = {};
  if (!allowed) return out;
  for (const key of [...allowed.required, ...allowed.optional]) {
    const value = secrets[key];
    if (typeof value !== "string" || value === "") continue;
    // Already-encrypted input is passed through, so a PATCH that echoes a stored
    // value cannot double-encrypt it.
    out[key] = isEncrypted(value) ? value : encryptSecret(value);
  }
  return out;
}

/**
 * The shape every admin API returns: config plus per-secret `{ set, last4 }`.
 * No ciphertext, no plaintext — the last four characters only, so the admin can
 * recognise which key is stored without being able to use it.
 */
export function toPublicProvider(row) {
  if (!row) return null;
  const kind = row.kind;
  const secrets = parseJson(row.secrets, {}) ?? {};
  const allowed = SECRET_KEYS[kind] ?? { required: [], optional: [] };
  const secretsSet = {};
  for (const key of [...allowed.required, ...allowed.optional]) {
    const stored = typeof secrets[key] === "string" ? secrets[key] : "";
    if (!stored) {
      secretsSet[key] = { set: false, last4: null };
      continue;
    }
    // Decrypt only to read the last four characters. A value that cannot be
    // decrypted (DB copied to another host) still reads as "set" with no suffix:
    // pretending it is absent would send the admin to re-enter a working key.
    let plain = "";
    try {
      plain = decryptSecret(stored);
    } catch {
      plain = "";
    }
    secretsSet[key] = {
      set: true,
      last4: plain ? plain.slice(-4) : null,
      required: allowed.required.includes(key),
    };
  }
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    isActive: row.isActive === 1 || row.isActive === true,
    sortOrder: Number(row.sortOrder) || 0,
    config: parseConfig(row),
    pollIntervalSeconds: Number(row.pollIntervalSeconds) || 30,
    lastPolledAt: row.lastPolledAt ?? null,
    lastError: row.lastError ?? null,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
    secretsSet,
  };
}

/** The row plus decrypted secrets — internal use only (fetchers, the webhook). */
export async function getProviderWithSecrets(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM paymentProviders WHERE id = ?`, [id]);
  if (!row) return null;
  const stored = parseJson(row.secrets, {}) ?? {};
  const secrets = {};
  for (const [key, value] of Object.entries(stored)) {
    secrets[key] = typeof value === "string" ? decryptSecret(value) : value;
  }
  return { ...row, config: parseConfig(row), secrets };
}

/** Every active provider of a kind, with secrets — used by the poller. */
export async function listProvidersWithSecrets({ kind = null, activeOnly = false } = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (kind) { where.push(`kind = ?`); params.push(kind); }
  if (activeOnly) where.push(`isActive = 1`);
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db.all(
    `SELECT * FROM paymentProviders ${clause} ORDER BY COALESCE(sortOrder, 0) ASC, createdAt ASC`,
    params
  );
  return rows.map((row) => {
    const stored = parseJson(row.secrets, {}) ?? {};
    const secrets = {};
    for (const [key, value] of Object.entries(stored)) {
      secrets[key] = typeof value === "string" ? decryptSecret(value) : value;
    }
    return { ...row, config: parseConfig(row), secrets };
  });
}

export async function listProviders() {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT * FROM paymentProviders ORDER BY COALESCE(sortOrder, 0) ASC, createdAt ASC`
  );
  return rows.map(toPublicProvider);
}

export async function getProvider(id) {
  const db = await getAdapter();
  return toPublicProvider(db.get(`SELECT * FROM paymentProviders WHERE id = ?`, [id]));
}

/** Validation shared by POST and PATCH. Returns a Vietnamese message or null. */
export function validateProviderInput(input = {}, { kind = null, creating = false } = {}) {
  const resolvedKind = kind ?? input.kind;
  if (!PROVIDER_KINDS.includes(resolvedKind)) {
    return "Loại nguồn nhận tiền không hợp lệ";
  }
  if (!String(input.name ?? "").trim()) return "Tên nguồn nhận tiền là bắt buộc";

  const config = input.config && typeof input.config === "object" ? input.config : {};
  if (resolvedKind !== "binance") {
    if (!String(config.accountNumber ?? "").trim()) return "Số tài khoản là bắt buộc";
  }
  if (resolvedKind === "binance") {
    if (!String(config.payUid ?? "").trim()) return "Binance Pay UID là bắt buộc";
  }
  if (resolvedKind === "web2m") {
    if (!String(config.apiBase ?? "").trim()) return "API base URL của web2m là bắt buộc";
    if (config.urlStyle && !["token", "password_account_token"].includes(config.urlStyle)) {
      return "Kiểu URL của web2m không hợp lệ";
    }
    if (config.urlStyle === "password_account_token" && creating) {
      const password = input.secrets?.password;
      if (!String(password ?? "").trim()) return "Kiểu URL này cần mật khẩu ngân hàng";
    }
  }
  // A SePay provider is created with a generated webhook key (createProvider), so
  // there is nothing to validate for it here.

  if (input.pollIntervalSeconds != null) {
    const interval = Number(input.pollIntervalSeconds);
    const floor = MIN_POLL_INTERVAL[resolvedKind] ?? 15;
    if (!Number.isInteger(interval) || interval < floor) {
      return `Chu kỳ lấy giao dịch phải là số nguyên từ ${floor} giây`;
    }
  }
  if (input.sortOrder != null) {
    const sortOrder = Number(input.sortOrder);
    if (!Number.isInteger(sortOrder)) return "Thứ tự phải là số nguyên";
  }
  return null;
}

export async function createProvider(input = {}) {
  const kind = input.kind;
  const error = validateProviderInput(input, { kind, creating: true });
  if (error) throw new Error(error);

  const db = await getAdapter();
  const at = nowIso();
  const secrets = { ...(input.secrets ?? {}) };
  // SePay's webhook key is generated here, never chosen by the admin: it has to be
  // 32 random bytes and the admin only ever copies it into SePay.
  if (kind === "sepay" && !String(secrets.webhookKey ?? "").trim()) {
    secrets.webhookKey = generateWebhookKey();
  }

  const row = {
    id: uuidv4(),
    kind,
    name: String(input.name).trim(),
    isActive: input.isActive === false ? 0 : 1,
    sortOrder: Number.isInteger(Number(input.sortOrder)) ? Number(input.sortOrder) : 0,
    config: stringifyJson(sanitizeConfig(kind, input.config ?? {})),
    secrets: stringifyJson(encryptSecretsMap(kind, secrets)),
    pollIntervalSeconds: Number.isInteger(Number(input.pollIntervalSeconds))
      ? Number(input.pollIntervalSeconds)
      : MIN_POLL_INTERVAL[kind] ?? 30,
    createdAt: at,
    updatedAt: at,
  };

  db.run(
    `INSERT INTO paymentProviders(id, kind, name, isActive, sortOrder, config, secrets, pollIntervalSeconds, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.kind, row.name, row.isActive, row.sortOrder, row.config, row.secrets, row.pollIntervalSeconds, row.createdAt, row.updatedAt]
  );

  // Returned ONCE, at creation, so the admin can copy it into SePay. Every later
  // read of this provider shows only `last4`.
  return { provider: toPublicProvider(db.get(`SELECT * FROM paymentProviders WHERE id = ?`, [row.id])), webhookKey: secrets.webhookKey ?? null };
}

/** Only the documented non-secret keys are kept, so a typo cannot invent config. */
export function sanitizeConfig(kind, config = {}) {
  const allowed = {
    sepay: ["bankBin", "bankName", "accountNumber", "accountName"],
    web2m: ["bankBin", "bankName", "accountNumber", "accountName", "apiBase", "urlStyle"],
    acb: ["bankBin", "bankName", "accountNumber", "accountName", "clientId", "appApiKey", "deviceId", "appVersion", "baseUrl"],
    binance: ["payUid", "accountName", "qrImageUrl"],
  }[kind] ?? [];
  const out = {};
  for (const key of allowed) {
    const value = config[key];
    if (value == null) continue;
    if (typeof value !== "string" && typeof value !== "number") continue;
    out[key] = String(value).trim();
  }
  // ACB is the only kind whose bank code never varies.
  if (kind === "acb") {
    // ACB is the only kind with a bank code that is always the same.
    if (!out.bankBin) out.bankBin = "970416";
    if (!out.bankName) out.bankName = "ACB";
  }
  return out;
}

/**
 * Update a provider. An empty secret field keeps the stored value; a non-empty one
 * replaces it. `regenerateWebhookKey` issues a new key and returns it once.
 */
export async function updateProvider(id, patch = {}) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM paymentProviders WHERE id = ?`, [id]);
  if (!row) return null;

  const kind = row.kind;
  const mergedConfig = { ...parseConfig(row), ...(patch.config ?? {}) };
  const error = validateProviderInput(
    { name: patch.name ?? row.name, config: mergedConfig, pollIntervalSeconds: patch.pollIntervalSeconds ?? row.pollIntervalSeconds, kind },
    { kind, creating: false }
  );
  if (error) throw new Error(error);

  const storedSecrets = parseJson(row.secrets, {}) ?? {};
  const incoming = patch.secrets && typeof patch.secrets === "object" ? patch.secrets : {};

  // Merge BEFORE encrypting so a kept value stays exactly the ciphertext it was;
  // re-encrypting it would change nothing functionally but would churn the row.
  const nextSecrets = { ...storedSecrets };
  for (const [key, value] of Object.entries(incoming)) {
    if (!Object.prototype.hasOwnProperty.call(SECRET_KEYS[kind] ?? {}, key)) {
      // Not a documented secret for this kind: refuse rather than store an
      // unexpected ciphertext nobody will ever read.
      continue;
    }
    if (typeof value !== "string") continue;
    if (value === "") continue;
    nextSecrets[key] = isEncrypted(value) ? value : encryptSecret(value);
  }

  let regenerated = null;
  if (patch.regenerateWebhookKey === true) {
    if (kind !== "sepay") throw new Error("Chỉ nguồn SePay có webhook key");
    regenerated = generateWebhookKey();
    nextSecrets.webhookKey = encryptSecret(regenerated);
  }

  const credentialsChanged = ["username", "password", "apiKey", "apiSecret", "token", "proxyUrl"]
    .some((key) => incoming[key] != null && incoming[key] !== "");
  const identityChanged = ["clientId", "appApiKey", "deviceId", "baseUrl"].some(
    (key) => patch.config && Object.prototype.hasOwnProperty.call(patch.config, key)
  );

  db.run(
    `UPDATE paymentProviders
        SET name = ?, isActive = ?, sortOrder = ?, config = ?, secrets = ?, pollIntervalSeconds = ?, updatedAt = ?
      WHERE id = ?`,
    [
      String(patch.name ?? row.name).trim(),
      patch.isActive == null ? row.isActive : patch.isActive ? 1 : 0,
      patch.sortOrder == null ? row.sortOrder : Number(patch.sortOrder),
      stringifyJson(patch.config ? sanitizeConfig(kind, mergedConfig) : parseConfig(row)),
      stringifyJson(nextSecrets),
      patch.pollIntervalSeconds == null ? row.pollIntervalSeconds : Number(patch.pollIntervalSeconds),
      nowIso(),
      id,
    ]
  );

  return {
    provider: toPublicProvider(db.get(`SELECT * FROM paymentProviders WHERE id = ?`, [id])),
    webhookKey: regenerated,
    // The caller clears the ACB token cache when credentials changed (design D1/7.3).
    credentialsChanged: credentialsChanged || identityChanged,
  };
}

/** Why a provider cannot be deleted, or null when it can. */
export async function providerDeleteBlocker(id) {
  const db = await getAdapter();
  const orders = db.get(`SELECT COUNT(*) AS n FROM orders WHERE paymentProviderId = ?`, [id]);
  if (Number(orders?.n ?? 0) > 0) {
    return { code: "has_orders", count: Number(orders.n) };
  }
  const transactions = db.get(`SELECT COUNT(*) AS n FROM paymentTransactions WHERE providerId = ?`, [id]);
  if (Number(transactions?.n ?? 0) > 0) {
    return { code: "has_transactions", count: Number(transactions.n) };
  }
  return null;
}

export async function deleteProvider(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT id FROM paymentProviders WHERE id = ?`, [id]);
  if (!row) return { ok: false, reason: "not_found" };
  const blocker = await providerDeleteBlocker(id);
  if (blocker) return { ok: false, reason: blocker.code, count: blocker.count };
  db.run(`DELETE FROM paymentProviders WHERE id = ?`, [id]);
  return { ok: true };
}

/** Record the outcome of one poll (design D6). Never throws. */
export async function recordPollResult(id, { at, error = null } = {}) {
  const db = await getAdapter();
  db.run(
    `UPDATE paymentProviders SET lastPolledAt = ?, lastError = ? WHERE id = ?`,
    [at ?? nowIso(), error == null ? null : String(error).slice(0, 500), id]
  );
}

/** The active provider whose webhook key verifies this header, or null. */
export async function findSepayProviderByWebhookKey(authorizationHeader) {
  // Imported lazily to keep this repo from depending on the pure module at load
  // time; the comparison itself is the constant-time one in the provider.
  const { verifyWebhookAuth } = await import("../../payments/providers/sepay.js");
  const candidates = await listProvidersWithSecrets({ kind: "sepay", activeOnly: true });
  for (const provider of candidates) {
    const key = provider.secrets?.webhookKey;
    if (verifyWebhookAuth(authorizationHeader, key)) return provider;
  }
  return null;
}
