"use client";

import { useId } from "react";
import { cn } from "@/shared/utils/cn";

// Vuexy input shape (change admin-accounts-rbac-vuexy, group 7): rounded
// corners, sentence-case label, focus ring instead of a bare border swap.
export default function Input({
  label,
  type = "text",
  placeholder,
  value,
  onChange,
  error,
  hint,
  icon,
  // Additive (change admin-accounts-rbac-vuexy, group 9): several "try it out"
  // example-call fields (media-providers/[kind]/[id]) need a clear ("x")
  // button that empties the field, previously hand-rolled as an absolutely
  // positioned button next to a raw <input>. Optional and inert unless a
  // caller passes a handler, so every existing call site is unaffected.
  onClear,
  disabled = false,
  required = false,
  className,
  inputClassName,
  id,
  ...props
}) {
  // Tie the visible label to the field so it is the field's accessible name.
  const autoId = useId();
  const inputId = id || autoId;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <label htmlFor={inputId} className="text-xs font-medium text-vx-text-muted">
          {label}
          {required && <span className="text-vx-danger ml-1">*</span>}
        </label>
      )}
      <div className="relative">
        {icon && (
          <div className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none text-vx-text-muted">
            <span className="material-symbols-outlined text-[20px]">{icon}</span>
          </div>
        )}
        <input
          id={inputId}
          type={type}
          placeholder={placeholder}
          value={value}
          onChange={onChange}
          disabled={disabled}
          className={cn(
            "w-full py-2.5 px-3 text-sm text-vx-text bg-vx-surface rounded-vx-md",
            "border border-vx-border placeholder-vx-text-subtle",
            "focus:border-vx-primary focus:outline-none focus:ring-2 focus:ring-vx-primary/15",
            "transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed",
            // iOS zoom fix
            "text-[16px] sm:text-sm",
            icon && "pl-10",
            onClear && value && "pr-9",
            error && "border-vx-danger focus:border-vx-danger focus:ring-vx-danger/15",
            inputClassName
          )}
          {...props}
        />
        {onClear && value && (
          <button
            type="button"
            onClick={onClear}
            aria-label="Xóa nội dung"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-vx-text-muted hover:text-vx-primary transition-colors"
          >
            <span className="material-symbols-outlined text-[14px]">close</span>
          </button>
        )}
      </div>
      {error && (
        <p className="text-xs text-vx-danger flex items-center gap-1">
          <span className="material-symbols-outlined text-[14px]">error</span>
          {error}
        </p>
      )}
      {hint && !error && (
        <p className="text-xs text-vx-text-muted">{hint}</p>
      )}
    </div>
  );
}
