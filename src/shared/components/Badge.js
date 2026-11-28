"use client";

import { cn } from "@/shared/utils/cn";

// Vuexy "label" badge shape (change admin-accounts-rbac-vuexy, group 7):
// tonal fill, no border, slight rounding, sentence case (Vuexy badges are not
// uppercase). Same variant keys as before — default/primary/success/warning/
// error/info — so every existing call site keeps its meaning unchanged.
const variants = {
  default: "bg-vx-surface-3 text-vx-text-muted",
  primary: "bg-vx-primary/15 text-vx-primary",
  success: "bg-vx-success/15 text-vx-success",
  warning: "bg-vx-warning/15 text-vx-warning",
  error: "bg-vx-danger/15 text-vx-danger",
  info: "bg-vx-info/15 text-vx-info",
};

// "xs" (additive, change admin-accounts-rbac-vuexy, group 8): a few call
// sites need a tighter badge than "sm" (e.g. a plan tag beside a dense card
// title); sensible default behavior for every other caller is unchanged.
const sizes = {
  xs: "px-1.5 py-0.5 text-[10px]",
  sm: "px-2 py-0.5 text-[11px]",
  md: "px-2.5 py-1 text-xs",
  lg: "px-3 py-1.5 text-sm",
};

export default function Badge({
  children,
  variant = "default",
  size = "md",
  dot = false,
  icon,
  className,
  ...props
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-vx-sm font-medium",
        variants[variant] || variants.default,
        sizes[size],
        className
      )}
      {...props}
    >
      {dot && (
        <span
          className={cn(
            "size-1.5 rounded-full",
            variant === "success" && "bg-vx-success",
            variant === "warning" && "bg-vx-warning",
            variant === "error" && "bg-vx-danger",
            variant === "info" && "bg-vx-info",
            variant === "primary" && "bg-vx-primary",
            variant === "default" && "bg-vx-text-muted"
          )}
        />
      )}
      {icon && <span className="material-symbols-outlined text-[14px]">{icon}</span>}
      {children}
    </span>
  );
}
