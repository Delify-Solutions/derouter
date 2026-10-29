"use client";

// Status label for a queued purchase: icon + text, never colour alone
// (openspec/ui-dna.md: colour is never the only carrier of state).
//
// The label comes from the server (`statusLabel` from queueViewSync), so the page
// and the request path cannot disagree about which plan is paying.

const STATUS = {
  paying: { label: "Đang trả", icon: "play_circle", cls: "border-brand-500/40 bg-brand-500/10 text-brand-700 dark:text-brand-400" },
  waiting: { label: "Chờ", icon: "schedule", cls: "border-border bg-surface-2 text-text-muted" },
  blocked: { label: "Tạm khoá", icon: "lock", cls: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  exhausted: { label: "Hết credit", icon: "battery_alert", cls: "border-border bg-surface-2 text-text-muted" },
  expired: { label: "Hết hạn", icon: "event_busy", cls: "border-border bg-surface-2 text-text-muted" },
  revoked: { label: "Đã thu hồi", icon: "block", cls: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400" },
};

/** `HH:MM` in the browser's local time. */
export function timeOf(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
  // A blocked plan names when it comes back: "Tạm khoá đến 15:30" is the whole
  // question a customer has at that moment.
  const label = status === "blocked" && reopenAt ? `Tạm khoá đến ${timeOf(reopenAt)}` : spec.label;

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
