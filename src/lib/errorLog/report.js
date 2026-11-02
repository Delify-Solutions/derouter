// Turning one error log entry into something a person can hand over for a fix
// (spec error-log "Exporting an entry"): a Markdown report, a curl command that
// replays the customer's request, and a file name. PURE — no imports, no I/O — so
// the admin page builds them in the browser and tests run them under plain node.
//
// Nothing here adds a secret: the stored entry is already masked when it is
// recorded, and the curl command carries a placeholder instead of any API key.

const fence = (lang, text) => `\`\`\`${lang}\n${text}\n\`\`\``;

function json(value) {
  if (value == null) return "";
  if (typeof value === "string") {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }
  return JSON.stringify(value, null, 2);
}

/** `derouter-error-<time>-<id8>.json`, safe on every file system. */
export function errorFileName(entry, ext = "json") {
  const time = String(entry?.timestamp || "").replace(/[:.]/g, "-").replace(/[^0-9TZ-]/g, "") || "unknown";
  const id = String(entry?.id || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "entry";
  return `derouter-error-${time}-${id}.${ext}`;
}

/**
 * A curl command that sends the customer's stored request to this router again,
 * to reproduce the failure. `null` when no request body was stored. The key is the
 * literal `$DEROUTER_KEY`, to be set by whoever runs it.
 */
export function replayCurl(entry, baseUrl = "") {
  const body = entry?.data?.request;
  if (!body || typeof body !== "object") return null;
  const origin = String(baseUrl || "").replace(/\/+$/, "");
  const path = entry?.endpoint && String(entry.endpoint).startsWith("/") ? entry.endpoint : "/v1/chat/completions";
  const payload = JSON.stringify(body).replace(/'/g, "'\\''");
  return [
    `curl -sS ${origin ? `'${origin}${path}'` : `"$DEROUTER_URL${path}"`} \\`,
    `  -H "Authorization: Bearer $DEROUTER_KEY" \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  --data-binary '${payload}'`,
  ].join("\n");
}

/**
 * A self-contained Markdown report of one entry: what failed, where, every
 * upstream attempt, the error body, the request the customer sent and the body
 * the router sent upstream. Paste it into an issue or a chat to get it fixed.
 */
export function errorReportMarkdown(entry, { baseUrl = "" } = {}) {
  if (!entry) return "";
  const data = entry.data || {};
  const lines = [];
  lines.push(`# derouter error ${entry.id || ""}`.trim());
  lines.push("");
  const fields = [
    ["Time", entry.timestamp],
    ["Source", entry.source],
    ["Status", entry.status],
    ["Error code", entry.errorCode],
    ["Endpoint", entry.endpoint],
    ["Requested model", entry.requestedModel],
    ["Routed to", entry.provider ? `${entry.provider} / ${entry.model || "—"}` : null],
    ["Connection", entry.connectionName || entry.connectionId],
    ["Key owner", entry.owner],
    ["Stream", entry.stream ? "yes" : "no"],
    ["Latency", entry.latencyMs != null ? `${entry.latencyMs} ms` : null],
    ["Request size", entry.bodyBytes != null ? `${entry.bodyBytes} bytes, ~${entry.estTokens ?? 0} tokens, ${entry.messageCount ?? 0} turns` : null],
    ["User-Agent", data.userAgent],
  ].filter(([, v]) => v != null && v !== "");
  for (const [k, v] of fields) lines.push(`- **${k}:** ${v}`);

  lines.push("", "## Error", "", fence("", entry.message || "—"));
  if (data.response) lines.push("", "### Raw error response", "", fence("json", json(data.response)));
  if (entry.source === "stream" && data.stream) {
    lines.push("", `Stream broke after ${data.stream.chunks ?? "?"} chunks, ${data.stream.bytes ?? "?"} bytes (HTTP 200 already sent).`);
  }

  if (Array.isArray(data.attempts) && data.attempts.length) {
    lines.push("", `## Upstream attempts (${data.attempts.length})`, "", "| # | Status | Provider / model | Connection | After | Error |", "|---|---|---|---|---|---|");
    data.attempts.forEach((a, i) => {
      const cell = (v) => String(v ?? "—").replace(/\|/g, "\\|").replace(/\n/g, " ");
      lines.push(`| ${i + 1} | ${cell(a.status)} | ${cell(`${a.provider || "—"} / ${a.model || "—"}`)} | ${cell(a.connectionName || a.connectionId)} | ${a.afterMs != null ? `${a.afterMs} ms` : "—"} | ${cell(a.error)} |`);
    });
  }

  lines.push("", "## Request from the client", "");
  if (data.request) {
    if (data.requestTruncated) lines.push("_Truncated to fit the log: long strings cut in the middle, inline images replaced._", "");
    lines.push(fence("json", json(data.request)));
  } else {
    lines.push("_Not stored (platform error, or prompt storage is off)._");
  }

  if (data.upstreamRequest) {
    lines.push("", "## Body sent upstream", "");
    if (data.upstreamTruncated) lines.push("_Truncated to fit the log._", "");
    lines.push(fence("json", json(data.upstreamRequest)));
  }

  const curl = replayCurl(entry, baseUrl);
  if (curl) lines.push("", "## Replay", "", fence("bash", curl));
  return `${lines.join("\n")}\n`;
}
