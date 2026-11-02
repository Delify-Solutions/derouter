// In-memory stand-in for src/lib/usageDb.js used by stream tests.
export const calls = { trackPendingRequest: [], appendRequestLog: [], saveRequestDetail: [] };
export function trackPendingRequest(...args) { calls.trackPendingRequest.push(args); }
export async function appendRequestLog(entry) { calls.appendRequestLog.push(entry); }
export async function saveRequestDetail(detail) { calls.saveRequestDetail.push(detail); }
export async function saveRequestUsage() {}
