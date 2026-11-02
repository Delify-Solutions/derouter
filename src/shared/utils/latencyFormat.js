// Response time of one request, as shown in the usage histories:
//   "TTFT 810ms / Tổng 19338ms" for a stream that reported its first chunk,
//   "Tổng 19338ms" when only the total is known (non-streamed, older rows),
//   "—" when nothing was measured.
// Whole milliseconds, no unit switching, so rows compare at a glance.

const ms = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) || Number(v) < 0 ? null : Math.round(Number(v)));

/**
 * TTFT of a stored request detail, or null when unknown. Rows written before TTFT
 * was tracked honestly carry 0 or the total for "unknown"; a real TTFT is always
 * above 0 and below the total.
 */
export function detailTtft(latency) {
  const ttft = ms(latency?.ttft);
  const total = ms(latency?.total);
  if (ttft == null || ttft <= 0) return null;
  if (total != null && ttft >= total) return null;
  return ttft;
}

/** Whole-millisecond TTFT and total, each null when not measured. */
export function latencyParts(totalMs, ttftMs) {
  return { total: ms(totalMs), ttft: ms(ttftMs) };
}

export function formatLatency(totalMs, ttftMs) {
  const total = ms(totalMs);
  const ttft = ms(ttftMs);
  if (total == null && ttft == null) return "—";
  if (ttft == null) return `Tổng ${total}ms`;
  if (total == null) return `TTFT ${ttft}ms`;
  return `TTFT ${ttft}ms / Tổng ${total}ms`;
}
