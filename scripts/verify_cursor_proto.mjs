/**
 * D1 Byte-Verification Script
 *
 * Generates deterministic protobuf bytes from cursorProtobuf.js
 * by monkey-patching uuidv4 and Date to return fixed values.
 *
 * The Rust port must produce IDENTICAL bytes for the same inputs.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { tmpdir } from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Deterministic UUID generator ---
// Cycle through a fixed list of UUIDs so every uuidv4() call is predictable.
const FIXED_UUIDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
  "00000000-0000-4000-8000-000000000005",
  "00000000-0000-4000-8000-000000000006",
  "00000000-0000-4000-8000-000000000007",
  "00000000-0000-4000-8000-000000000008",
  "00000000-0000-4000-8000-000000000009",
  "00000000-0000-4000-8000-00000000000a",
];
const FIXED_TIMESTAMP = "2025-01-01T00:00:00.000Z";

// Read the cursorProtobuf.js source, patch it to use deterministic values.
const protoSource = readFileSync(join(__dirname, "..", "open-sse", "utils", "cursorProtobuf.js"), "utf-8");

// Build the patched source: inject deterministic UUID/timestamp, remove external deps.
let patched = protoSource;

// Replace uuid import with inline deterministic generator (expose counter for reset)
patched = patched.replace(
  /import \{ v4 as uuidv4 \} from "uuid";/,
  `export const __uuidIdx = { v: 0 };\nconst __uuids = ${JSON.stringify(FIXED_UUIDS)};\nconst uuidv4 = () => __uuids[__uuidIdx.v++ % __uuids.length];`
);

// Replace zlib import with no-op stub (encoding never compresses)
patched = patched.replace(
  /import zlib from "zlib";/,
  `const zlib = { gzipSync: (b) => new Uint8Array(b), gunzipSync: (b) => new Uint8Array(b) };`
);

// Replace new Date().toISOString() with fixed timestamp
patched = patched.replace(
  /new Date\(\)\.toISOString\(\)/,
  `"${FIXED_TIMESTAMP}"`
);

// Replace process.platform, process.arch, process.version, process.cwd
patched = patched.replace(/process\.platform \|\| "linux"/g, '"linux"');
patched = patched.replace(/process\.arch \|\| "x64"/g, '"x64"');
patched = patched.replace(/process\.version \|\| "v20\.0\.0"/g, '"v20.0.0"');
patched = patched.replace(/process\.cwd\?\.\(\) \|\| "\/"/g, '"/"');

// Write patched source to temp file and import it
const tmpDir = mkdtempSync(join(tmpdir(), "cursor-proto-verify-"));
const tmpFile = join(tmpDir, "patched_proto.mjs");
writeFileSync(tmpFile, patched, "utf-8");

const { generateCursorBody, __uuidIdx } = await import(tmpFile);

// --- Test inputs ---
// (a) Single user message "Hello" with model "gpt-4", no tools
__uuidIdx.v = 0;
const messagesA = [
  { role: "user", content: "Hello" }
];
const bodyA = generateCursorBody(messagesA, "gpt-4", [], null, false);
const hexA = Buffer.from(bodyA).toString("hex");
console.log("HEX_A:" + hexA);

// (b) Two messages: user "Hi" + assistant "Hello!" with model "claude-3-5-sonnet", no tools
// Reset the UUID counter so input (b) starts from index 0 (matches Rust's fresh-counter-per-call behavior).
__uuidIdx.v = 0;
const messagesB = [
  { role: "user", content: "Hi" },
  { role: "assistant", content: "Hello!" }
];
const bodyB = generateCursorBody(messagesB, "claude-3-5-sonnet", [], null, false);
const hexB = Buffer.from(bodyB).toString("hex");
console.log("HEX_B:" + hexB);

// Clean up
rmSync(tmpDir, { recursive: true, force: true });
