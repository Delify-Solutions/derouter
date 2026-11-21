// Sealed ids: public ids for internal values that reveal nothing about them and
// that only this server can open again (spec model-privacy: a customer's
// request-detail ids, whose stored form may embed the upstream model).
//
// AES-256-GCM, with the nonce an HMAC of the value, so one value always gives
// the same id (stable across requests and restarts) and the server resolves it
// directly instead of scanning; the GCM tag rejects a forged or altered id, and
// `purpose` is authenticated data, so an id sealed for one use never opens for
// another. Every plaintext is padded to the same SEALED_PLAINTEXT_BYTES, so every
// sealed id has the same length whatever it hides; a longer value is not sealed.
//
// The keys come from a dedicated random secret in DATA_DIR (auth/sealed-id-secret),
// never from the machine id: customers hold these ciphertexts, whose plaintext
// starts with a guessable timestamp, so a key derived from a low-entropy machine
// id (on Alpine it falls back to the host name) would let them test guesses of
// the root that also encrypts provider credentials (secrets.js) offline. Deleting
// DATA_DIR makes every sealed id issued before unresolvable (a 404), which is
// fine: they are handed out per listing. Creation is lock-free and every process
// uses the value on disk (loadSecret).
//
// Relative imports only (tests import it).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../dataDir.js";

const SECRET_FILE = path.join(DATA_DIR, "auth", "sealed-id-secret");
const SECRET_PATTERN = /^[0-9a-f]{64}$/;
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
/** Every sealed value is padded to exactly this many bytes. */
export const SEALED_PLAINTEXT_BYTES = 256;
/** The length of every sealed id (base64url of nonce + tag + padded plaintext). */
export const SEALED_ID_LENGTH = Math.ceil(((IV_BYTES + TAG_BYTES + SEALED_PLAINTEXT_BYTES) * 4) / 3);

let cachedKeys = null;

// The secret lives in the first of these slots that holds a valid one. A slot is
// written once and never replaced, so every process walking them in order stops
// at the same file. A corrupted slot is skipped, never repaired: two processes
// that both find it corrupted both move to the next slot, and only one of them
// can create that.
const SECRET_SLOTS = 8;
const slotPath = (index) => (index === 0 ? SECRET_FILE : `${SECRET_FILE}.${index}`);
// A slot that looks half-written (empty or a hex prefix) is only worth waiting for
// while it is this young by mtime: it can only be a creator still writing, on a
// filesystem without hard links (see createSlot; with them a slot appears whole).
// An older one is a leftover (a crash, a full disk, a stray `touch`) and is
// skipped at once, so no process start ever waits on it again.
const HALF_WRITTEN_YOUNG_MS = 1000;

/** `{ secret }` for a valid slot, `{ missing }`, `{ partial, ageMs }` (young hex prefix) or `{ corrupt }`. */
function readSlot(file) {
  let text;
  let mtimeMs;
  try {
    text = fs.readFileSync(file, "utf8").trim();
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch (error) {
    return error?.code === "ENOENT" ? { missing: true } : { corrupt: true };
  }
  if (SECRET_PATTERN.test(text)) return { secret: text };
  const ageMs = Date.now() - mtimeMs;
  if (/^[0-9a-f]{0,63}$/.test(text) && ageMs < HALF_WRITTEN_YOUNG_MS) return { partial: true, ageMs };
  return { corrupt: true };
}

let warnedInMemory = false;

/** The process could not persist or read a secret: say so once (no secret in it). */
function warnInMemory(reason) {
  if (warnedInMemory) return;
  warnedInMemory = true;
  console.warn(`[sealed-ids] ${reason}: using an in-memory secret; request-detail ids issued by this process will not resolve after a restart or in other workers.`);
}

// A short synchronous pause (the secret is created inside a sync call).
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Publish `secret` at `file` only if no file is there: written whole to a
 * private temporary file first, then hard-linked into place (atomic and
 * exclusive: the file appears complete or not at all). On a filesystem without
 * hard links it is copied with COPYFILE_EXCL instead (still exclusive; a reader
 * may then catch it half-written, which readSlot reports as partial).
 * @returns {boolean} true when this call created it
 */
function createSlot(file, secret) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeSync(fd, secret);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    try {
      fs.copyFileSync(tmp, file, fs.constants.COPYFILE_EXCL);
      return true;
    } catch (copyError) {
      if (copyError?.code === "EEXIST") return false;
      throw copyError;
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
}

/**
 * The dedicated secret, as on disk. Walks the slots: the first valid one is the
 * secret; a young half-written one is waited for, at most until it is no longer
 * young (under HALF_WRITTEN_YOUNG_MS, and only on a filesystem without hard
 * links); an old or corrupted one is skipped at once; a missing one is created
 * (exclusively) and then read back, so the value used is always the one on disk,
 * whichever process wrote it. If nothing can be persisted the process keeps an
 * in-memory secret and warns once: ids then stop resolving after a restart.
 */
function loadSecret() {
  const fresh = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true, mode: 0o700 });
  } catch {
    /* read-only: reading may still work */
  }
  for (let index = 0; index < SECRET_SLOTS; index += 1) {
    const file = slotPath(index);
    let slot = readSlot(file);
    if (slot.missing) {
      try {
        createSlot(file, fresh);
      } catch {
        const found = readSlot(file).secret;
        if (found) return found;
        warnInMemory("the secret file cannot be written");
        return fresh;
      }
      slot = readSlot(file);
    }
    // Bounded by the slot's youth: never more than HALF_WRITTEN_YOUNG_MS in all.
    while (slot.partial) {
      pause(Math.min(20, Math.max(1, HALF_WRITTEN_YOUNG_MS - slot.ageMs)));
      slot = readSlot(file);
    }
    if (slot.secret) return slot.secret;
    // Corrupted, or a leftover that never completed: the next slot.
  }
  warnInMemory("every secret slot is corrupted");
  return fresh;
}

function keys() {
  if (!cachedKeys) {
    const secret = Buffer.from(loadSecret(), "hex");
    const derive = (info) => Buffer.from(crypto.hkdfSync("sha256", secret, Buffer.alloc(0), info, KEY_BYTES));
    cachedKeys = { enc: derive("derouter sealed-id aes-256-gcm v1"), mac: derive("derouter sealed-id nonce v1") };
  }
  return cachedKeys;
}

/**
 * The sealed id of `value` for `purpose`, always SEALED_ID_LENGTH characters, or
 * null when the value is longer than SEALED_PLAINTEXT_BYTES (it cannot be hidden
 * in an id of the fixed length; the caller must use another reference).
 * @param {string} purpose
 * @param {string} value
 * @returns {string|null}
 */
export function sealId(purpose, value) {
  const plain = Buffer.from(String(value), "utf8");
  if (plain.length > SEALED_PLAINTEXT_BYTES || plain.includes(0)) return null;
  const { enc, mac } = keys();
  const padded = Buffer.concat([plain, Buffer.alloc(SEALED_PLAINTEXT_BYTES - plain.length)]);
  const iv = crypto.createHmac("sha256", mac).update(`${purpose}\u0000`).update(plain).digest().subarray(0, IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, enc, iv);
  cipher.setAAD(Buffer.from(purpose, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

/**
 * The value behind an id from sealId, or null when it is not one (wrong length or
 * purpose, altered, sealed under another secret).
 * @param {string} purpose
 * @param {string} sealed
 * @returns {string|null}
 */
export function openSealedId(purpose, sealed) {
  if (typeof sealed !== "string" || sealed.length !== SEALED_ID_LENGTH || !/^[A-Za-z0-9_-]+$/.test(sealed)) return null;
  const raw = Buffer.from(sealed, "base64url");
  if (raw.length !== IV_BYTES + TAG_BYTES + SEALED_PLAINTEXT_BYTES) return null;
  try {
    const { enc } = keys();
    const decipher = crypto.createDecipheriv(ALGORITHM, enc, raw.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(purpose, "utf8"));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    const plain = Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
    let end = plain.length;
    while (end > 0 && plain[end - 1] === 0) end -= 1;
    return plain.subarray(0, end).toString("utf8");
  } catch {
    return null;
  }
}
