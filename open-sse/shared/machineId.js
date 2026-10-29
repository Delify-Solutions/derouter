import * as machineIdModule from "node-machine-id";
import crypto from "node:crypto";

// CommonJS package: the Next bundler exposes it as a named export, plain Node (tests)
// only on `default`.
const machineIdSync = machineIdModule.machineIdSync ?? machineIdModule.default?.machineIdSync;

let cachedRawId = null;

function loadRawMachineId() {
  if (cachedRawId) return cachedRawId;
  try {
    cachedRawId = machineIdSync();
  } catch {
    cachedRawId = crypto.randomUUID();
  }
  return cachedRawId;
}

export async function getConsistentMachineId(salt = "endpoint-proxy-salt") {
  const rawId = loadRawMachineId();
  return crypto.createHash("sha256").update(rawId + salt).digest("hex").substring(0, 16);
}
