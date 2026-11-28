"use client";

import { cn } from "@/shared/utils/cn";

// Vuexy select shape (change admin-accounts-rbac-vuexy, group 10 — missed in
// group 7's original primitive list alongside Toggle; same rounded/focus-ring
// treatment as Input.js, retrofitted here so every call site picks it up
// without further edits).
export default function Select({
  label,
  options = [],
  value,
  onChange,
  placeholder = "Select an option",
  error,
  hint,
  disabled = false,
  required = false,
  className,
  selectClassName,
  ...props
}) {
  const hasEmptyOption = options.some((option) => String(option.value) === "");
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <label className="text-xs font-medium text-vx-text-muted">
          {label}
          {required && <span className="text-vx-danger ml-1">*</span>}
        </label>
      )}
      <div className="relative">
        <select
          value={value}
          onChange={onChange}
          disabled={disabled}
          className={cn(
            "w-full py-2.5 px-3 pr-10 text-sm text-vx-text",
            "bg-vx-surface border border-vx-border rounded-vx-md appearance-none",
            "focus:border-vx-primary focus:outline-none focus:ring-2 focus:ring-vx-primary/15",
            "transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed",
            "text-[16px] sm:text-sm",
            error && "border-vx-danger focus:border-vx-danger focus:ring-vx-danger/15",
            selectClassName
          )}
          {...props}
        >
          {/* The placeholder is only for a select with no "empty" choice of its own.
              With both, two options share value "" and the browser shows the
              disabled placeholder instead of the real "All" option. */}
          {!hasEmptyOption && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-vx-text-muted">
          <span className="material-symbols-outlined text-[20px]">expand_more</span>
        </div>
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
