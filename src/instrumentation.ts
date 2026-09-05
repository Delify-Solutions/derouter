/**
 * Next.js instrumentation hook.
 *
 * Previously initialized Node-backend services (console log capture, model catalog sync).
 * After the Node backend deletion (Rust owns all server routes), this is a no-op.
 * Kept as a stub so Next.js does not warn about a missing instrumentation file.
 */
export async function register(): Promise<void> {
  // No-op — Rust backend handles all server-side concerns.
}
