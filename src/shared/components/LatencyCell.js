import { latencyParts } from "@/shared/utils/latencyFormat";

// Response time in a history table, on two short lines so the column stays narrow:
//   TTFT 2034ms     (muted, only when recorded)
//   Tổng 20213ms
// "—" when nothing was measured. Same figures as formatLatency().
export default function LatencyCell({ totalMs, ttftMs }) {
  const { total, ttft } = latencyParts(totalMs, ttftMs);
  if (total == null && ttft == null) return <span>—</span>;
  return (
    <span className="inline-flex flex-col items-end leading-tight">
      {ttft != null && <span className="text-[11px] text-text-muted">TTFT {ttft}ms</span>}
      {total != null && <span>Tổng {total}ms</span>}
    </span>
  );
}
