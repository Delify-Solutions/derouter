"use client";

import { cn } from "@/shared/utils/cn";

// New shared primitive (change admin-accounts-rbac-vuexy, group 7). No shared
// Toast component existed before this — the dashboard shell
// (src/shared/components/layouts/DashboardLayout.js) currently renders its
// notification stack with its own inline markup wired to
// `@/store/notificationStore`. This component is Vuexy's toast visual shape
// (rounded card, soft shadow, tonal icon chip) as a reusable primitive for
// later reskin batches (OpenSpec tasks groups 8-10) to migrate onto; the
// existing notification stack is left wired exactly as it is today — out of
// scope for this task.
const TYPES = {
  success: { icon: "check_circle", tone: "text-vx-success bg-vx-success/15" },
  error: { icon: "error", tone: "text-vx-danger bg-vx-danger/15" },
  warning: { icon: "warning", tone: "text-vx-warning bg-vx-warning/15" },
  info: { icon: "info", tone: "text-vx-info bg-vx-info/15" },
};

export function Toast({ type = "info", title, message, dismissible = true, onDismiss, className }) {
  const { icon, tone } = TYPES[type] || TYPES.info;
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-3 w-full rounded-vx-lg bg-vx-surface shadow-vx-lg p-4",
        className
      )}
    >
      <span className={cn("flex items-center justify-center size-8 shrink-0 rounded-vx-md", tone)}>
        <span className="material-symbols-outlined text-[18px]">{icon}</span>
      </span>
      <div className="min-w-0 flex-1">
        {title && <p className="text-sm font-semibold text-vx-heading mb-0.5">{title}</p>}
        {message && <p className="text-sm text-vx-text-muted whitespace-pre-wrap break-words">{message}</p>}
      </div>
      {dismissible && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss notification"
          className="shrink-0 text-vx-text-subtle hover:text-vx-text transition-colors"
        >
          <span className="material-symbols-outlined text-[16px]">close</span>
        </button>
      )}
    </div>
  );
}

export function ToastContainer({ children, className }) {
  return (
    <div
      className={cn(
        "fixed top-4 right-4 z-[80] flex w-[min(92vw,380px)] flex-col gap-2",
        className
      )}
    >
      {children}
    </div>
  );
}

export default Toast;
