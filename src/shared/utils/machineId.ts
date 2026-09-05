import { machineIdSync } from 'node-machine-id';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// Inlined from @/lib/dataDir to avoid @/lib/ dependency after Node backend deletion.
const APP_NAME = 'derouter';

function defaultDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), APP_NAME);
  }
  return path.join(os.homedir(), `.${APP_NAME}`);
}

function getDataDir(): string {
  const configured = process.env.DATA_DIR;
  if (!configured) return defaultDir();
  if (process.platform === 'win32' && /^\//.test(configured)) {
    return defaultDir();
  }
  try {
    fs.mkdirSync(configured, { recursive: true });
    return configured;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'EACCES' || (e as NodeJS.ErrnoException)?.code === 'EPERM') {
      return defaultDir();
    }
    throw e;
  }
}

const DATA_DIR = getDataDir();

const MACHINE_ID_FILE = path.join(DATA_DIR, 'machine-id');
const AUTH_DIR = path.join(DATA_DIR, 'auth');
const CLI_SECRET_FILE = path.join(AUTH_DIR, 'cli-secret');
const CLI_AUTH_SALT = 'dr-cli-auth';
let cachedRawId: string | null = null;
let cachedCliSecret: string | null = null;

// Persist raw machine ID to file → guarantees CLI/server/middleware see same value
// even when machineIdSync fails or returns inconsistent values across runtimes.
function loadRawMachineId(): string {
  if (cachedRawId) return cachedRawId;
  try {
    cachedRawId = fs.readFileSync(MACHINE_ID_FILE, 'utf8').trim();
    if (cachedRawId) return cachedRawId;
  } catch { /* ignore */ }
  try {
    cachedRawId = machineIdSync();
  } catch {
    cachedRawId = crypto.randomUUID();
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(MACHINE_ID_FILE, cachedRawId, { mode: 0o600 });
  } catch { /* ignore */ }
  return cachedRawId;
}

// Random secret persisted on first run → unpredictable CLI token even when machineId leaks.
function loadCliSecret(): string {
  if (cachedCliSecret) return cachedCliSecret;
  try {
    cachedCliSecret = fs.readFileSync(CLI_SECRET_FILE, 'utf8').trim();
    if (cachedCliSecret) return cachedCliSecret;
  } catch { /* ignore */ }
  cachedCliSecret = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    fs.writeFileSync(CLI_SECRET_FILE, cachedCliSecret, { mode: 0o600 });
  } catch { /* ignore */ }
  return cachedCliSecret;
}

export async function getConsistentMachineId(salt: string | null = null): Promise<string> {
  const saltValue = salt || process.env.MACHINE_ID_SALT || 'endpoint-proxy-salt';
  const raw = loadRawMachineId();
  const extra = saltValue === CLI_AUTH_SALT ? loadCliSecret() : '';
  return crypto.createHash('sha256').update(raw + saltValue + extra).digest('hex').substring(0, 16);
}

export async function getRawMachineId(): Promise<string> {
  return loadRawMachineId();
}

/**
 * Check if we're running in browser or server environment
 */
export function isBrowser(): boolean {
  return typeof window !== 'undefined';
}
