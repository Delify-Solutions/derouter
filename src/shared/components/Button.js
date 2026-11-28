"use client";

import { cn } from "@/shared/utils/cn";

// Vuexy visual shape (change admin-accounts-rbac-vuexy, group 7): rounded
// corners, no shadow on buttons (Vuexy's own $btn-box-shadow is none),
// sentence-case sans label. Solid colors for the eight Bootstrap-style
// theme colors, plus an outline/tonal counterpart for each, since Vuexy
// uses both shapes.
const VX_SOLID = {
  primary: "bg-vx-primary text-white hover:bg-vx-primary-hover",
  secondary: "bg-vx-secondary text-white hover:brightness-95",
  success: "bg-vx-success text-white hover:brightness-95",
  danger: "bg-vx-danger text-white hover:brightness-95",
  warning: "bg-vx-warning text-white hover:brightness-95",
  info: "bg-vx-info text-white hover:brightness-95",
  light: "bg-vx-light text-vx-text hover:brightness-95",
  dark: "bg-vx-dark text-white hover:brightness-95",
};

const VX_OUTLINE = {
  primary: "border border-vx-primary/50 text-vx-primary bg-transparent hover:bg-vx-primary/10 hover:border-vx-primary",
  secondary: "border border-vx-secondary/50 text-vx-secondary bg-transparent hover:bg-vx-secondary/10 hover:border-vx-secondary",
  success: "border border-vx-success/50 text-vx-success bg-transparent hover:bg-vx-success/10 hover:border-vx-success",
  danger: "border border-vx-danger/50 text-vx-danger bg-transparent hover:bg-vx-danger/10 hover:border-vx-danger",
  warning: "border border-vx-warning/50 text-vx-warning bg-transparent hover:bg-vx-warning/10 hover:border-vx-warning",
  info: "border border-vx-info/50 text-vx-info bg-transparent hover:bg-vx-info/10 hover:border-vx-info",
  light: "border border-vx-border text-vx-text bg-transparent hover:bg-vx-surface-2",
  dark: "border border-vx-dark/50 text-vx-dark dark:text-vx-text bg-transparent hover:bg-vx-dark/10",
};

// Existing call sites only ever pass the six keys below (primary, secondary,
// outline, ghost, danger, success) — their meaning is unchanged, only the
// rendered shape/colors move to Vuexy's language. warning/info/light/dark and
// the explicit "-outline" keys are new, additive variants for pages reskinned
// in later groups (8-10); no current caller uses them yet.
const variants = {
  primary: VX_SOLID.primary,
  secondary: VX_OUTLINE.secondary,
  outline: VX_OUTLINE.primary,
  ghost: "text-vx-text-muted bg-transparent hover:bg-vx-surface-2 hover:text-vx-text",
  danger: VX_SOLID.danger,
  success: VX_SOLID.success,

  warning: VX_SOLID.warning,
  info: VX_SOLID.info,
  light: VX_SOLID.light,
  dark: VX_SOLID.dark,

  "primary-outline": VX_OUTLINE.primary,
  "secondary-outline": VX_OUTLINE.secondary,
  "success-outline": VX_OUTLINE.success,
  "danger-outline": VX_OUTLINE.danger,
  "warning-outline": VX_OUTLINE.warning,
  "info-outline": VX_OUTLINE.info,
  "light-outline": VX_OUTLINE.light,
  "dark-outline": VX_OUTLINE.dark,
};

const sizes = {
  sm: "h-8 px-4 text-xs",
  md: "h-10 px-5 text-sm",
  lg: "h-12 px-7 text-base",
};

export default function Button({
  children,
  variant = "primary",
  size = "md",
  icon,
  iconRight,
  disabled = false,
  loading = false,
  fullWidth = false,
  className,
  ...props
}) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-vx-md font-medium transition-colors duration-150 cursor-pointer",
        "focus-visible:outline-2 focus-visible:outline-vx-primary focus-visible:outline-offset-2",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        variants[variant] || variants.primary,
        sizes[size],
        fullWidth && "w-full",
        className
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <span className="material-symbols-outlined animate-spin text-[18px]">progress_activity</span>
      ) : icon ? (
        <span className="material-symbols-outlined text-[18px]">{icon}</span>
      ) : null}
      {children}
      {iconRight && !loading && (
        <span className="material-symbols-outlined text-[18px]">{iconRight}</span>
      )}
    </button>
  );
}
