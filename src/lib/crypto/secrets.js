import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as machineIdModule from "node-machine-id";
import { DATA_DIR } from "../dataDir.js";

// CommonJS package: the Next bundler exposes the function as a named export, plain
// Node (tests) only on `default`. Reading either keeps this module loadable in both.
const machineIdSync = machineIdModule.machineIdSync ?? machineIdModule.default?.machineIdSync;

// Provider credentials (OAuth tokens, API keys, session cookies) live in the SQLite
// file, which gets copied around for backups. Encrypting them at rest means a leaked
// copy of data.sqlite no longer hands out working upstream credentials.
//
// Format: enc:v1:<iv-b64>:<tag-b64>:<ciphertext-b64>
const PREFIX = "enc:v1:";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const KEY_SALT = "derouter:secrets:v1";
const MACHINE_ID_FILE = path.join(DATA_DIR, "machine-id");

let cachedKey = null;
let cachedRawId = null;

// Synchronous mirror of loadRawMachineId() in @/shared/utils/machineId: same file,
// same fallback order, so both sides of the app derive one key. It cannot import
// that helper because getRawMachineId() is async and this module's API (encrypt /
// decrypt) is synchronous by contract.
function readRawMachineId() {
  if (cachedRawId) return cachedRawId;
  try {
    const fromFile = fs.readFileSync(MACHINE_ID_FILE, "utf8").trim();
    if (fromFile) {
      cachedRawId = fromFile;
      return cachedRawId;
    }
  } catch {
    // No persisted id yet — derive one exactly like machineId.js does.
  }
  try {
    cachedRawId = machineIdSync();
  } catch {
    cachedRawId = crypto.randomUUID();
  }
  return cachedRawId;
}

// scrypt(machineId, fixed salt) binds every ciphertext to this host: a database
// copied to another machine yields undecryptable values (which read as "no
// credential") rather than usable tokens.
function getKey() {
  if (cachedKey) return cachedKey;
  cachedKey = crypto.scryptSync(String(readRawMachineId()), KEY_SALT, KEY_BYTES);
  return cachedKey;
}

export function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(PREFIX);
}

/**
 * Encrypts a non-empty string. Non-string / empty input is returned unchanged so
 * callers can pass optional fields without branching.
 * @param {string} value
 * @returns {string}
 */
export function encryptSecret(value) {
  if (typeof value !== "string" || value.length === 0) return value;
  if (isEncrypted(value)) return value;
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

/**
 * Decrypts a value produced by encryptSecret. Anything without the `enc:v1:` prefix
 * is passed through untouched, which is what makes existing plaintext rows readable
 * after an upgrade.
 * @param {string} value
 * @returns {string}
 */
export function decryptSecret(value) {
  if (!isEncrypted(value)) return value;
  const body = value.slice(PREFIX.length);
  const parts = body.split(":");
  if (parts.length !== 3) return value;
  const [ivB64, tagB64, dataB64] = parts;
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch {
    // Wrong key (DB restored onto another host) or a corrupted value. Return empty
    // rather than the ciphertext: ciphertext is not a credential and must never be
    // sent upstream. An empty token reads as "needs re-authentication".
    return "";
  }
}
