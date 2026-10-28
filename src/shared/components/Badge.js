"use client";

import { cn } from "@/shared/utils/cn";

const variants = {
  default: "bg-surface-2 text-text-muted border-border",
  primary: "bg-brand-500/10 text-brand-700 border-brand-500/30 dark:text-brand-400",
  success: "bg-green-500/10 text-green-700 border-green-500/30 dark:text-green-400",
  warning: "bg-yellow-500/10 text-yellow-700 border-yellow-500/30 dark:text-yellow-400",
  error: "bg-red-500/10 text-red-700 border-red-500/30 dark:text-red-400",
  info: "bg-blue-500/10 text-blue-700 border-blue-500/30 dark:text-blue-400",
};

const sizes = {
  sm: "px-2 py-0.5",
  md: "px-2.5 py-1",
  lg: "px-3 py-1.5",
};

export default function Badge({
  children,
  variant = "default",
  size = "md",
  dot = false,
  icon,
  className,
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-none font-mono text-[10px] uppercase tracking-wider border",
        variants[variant],
        sizes[size],
        className
      )}
    >
      {dot && (
        <span
          className={cn(
            "size-1.5",
            variant === "success" && "bg-green-500",
            variant === "warning" && "bg-yellow-500",
            variant === "error" && "bg-red-500",
            variant === "info" && "bg-blue-500",
            variant === "primary" && "bg-brand-500",
            variant === "default" && "bg-text-muted"
          )}
        />
      )}
      {icon && <span className="material-symbols-outlined text-[14px]">{icon}</span>}
      {children}
    </span>
  );
}
