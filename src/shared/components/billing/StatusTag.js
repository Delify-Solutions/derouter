"use client";

// Status label for a queued purchase: icon + text, never colour alone
// (openspec/ui-dna.md: colour is never the only carrier of state).
//
// The label comes from the server (`statusLabel` from queueViewSync), so the page
// and the request path cannot disagree about which plan is paying.

const STATUS = {
  paying: { label: "Đang trả", icon: "play_circle", cls: "border-brand-500/40 bg-brand-500/10 text-brand-700 dark:text-brand-400" },
  waiting: { label: "Chờ", icon: "schedule", cls: "border-border bg-surface-2 text-text-muted" },
  // A later period of a multi-period term, or a plan queued behind the same one.
  scheduled: { label: "Chờ kích hoạt", icon: "event_upcoming", cls: "border-border bg-surface-2 text-text-muted" },
  blocked: { label: "Tạm khóa", icon: "lock", cls: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  exhausted: { label: "Hết credit", icon: "battery_alert", cls: "border-border bg-surface-2 text-text-muted" },
  expired: { label: "Hết hạn", icon: "event_busy", cls: "border-border bg-surface-2 text-text-muted" },
  refunded: { label: "Đã hoàn tiền", icon: "undo", cls: "border-border bg-surface-2 text-text-muted" },
  revoked: { label: "Đã thu hồi", icon: "block", cls: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400" },
};

/** `HH:MM` in the browser's local time. */
export function timeOf(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  // 24-hour clock, as Vietnamese customers read times ("13:08", not "01:08 PM").
  return date.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

/** `dd/mm/yyyy HH:MM` in the browser's local time. */
export function dateTimeOf(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return `${dateOf(iso)} ${timeOf(iso)}`;
}

/** "27 ngày 3 giờ", "5 giờ 20 phút", "12 phút" — a remaining span, coarse to fine. */
export function spanText(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 60_000) || 0);
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  if (days > 0) return hours > 0 ? `${days} ngày ${hours} giờ` : `${days} ngày`;
  if (hours > 0) return minutes > 0 ? `${hours} giờ ${minutes} phút` : `${hours} giờ`;
  return minutes > 0 ? `${minutes} phút` : "dưới 1 phút";
}

/** `dd/mm/yyyy` in the browser's local time. */
export function dateOf(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export default function StatusTag({ status, reopenAt = null, className = "" }) {
  const spec = STATUS[status] ?? STATUS.waiting;
  // A blocked plan names when it comes back: "Tạm khóa đến 15:30" is the whole
  // question a customer has at that moment. A scheduled one says "Chờ kích hoạt";
  // its start date is on the card's own line, where it has room.
  const label = status === "blocked" && reopenAt ? `Tạm khóa đến ${timeOf(reopenAt)}` : spec.label;

  return (
    <span
      className={`inline-flex h-6 items-center gap-1 border px-2 font-mono text-[11px] font-medium uppercase tracking-[0.08em] whitespace-nowrap ${spec.cls} ${className}`}
      title={label}
      data-status={status}
    >
      <span className="material-symbols-outlined text-[14px]" aria-hidden="true">{spec.icon}</span>
      {label}
    </span>
  );
}
