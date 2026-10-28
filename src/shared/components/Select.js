"use client";

import { cn } from "@/shared/utils/cn";

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
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <label className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">
          {label}
          {required && <span className="text-red-600 ml-1">*</span>}
        </label>
      )}
      <div className="relative">
        <select
          value={value}
          onChange={onChange}
          disabled={disabled}
          className={cn(
            "w-full py-2.5 px-3 pr-10 text-sm text-text-main",
            "bg-surface border border-border rounded-none appearance-none",
            "focus:border-brand-500 focus:outline-none",
            "transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed",
            "text-[16px] sm:text-sm",
            error && "border-red-600",
            selectClassName
          )}
          {...props}
        >
          <option value="" disabled>
            {placeholder}
          </option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-text-muted">
          <span className="material-symbols-outlined text-[20px]">expand_more</span>
        </div>
      </div>
      {error && (
        <p className="text-[11px] text-red-600 flex items-center gap-1">
          <span className="material-symbols-outlined text-[14px]">error</span>
          {error}
        </p>
      )}
      {hint && !error && (
        <p className="text-[11px] text-text-muted">{hint}</p>
      )}
    </div>
  );
}
