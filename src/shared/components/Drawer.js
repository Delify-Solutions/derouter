"use client";

import { useEffect } from "react";
import { cn } from "@/shared/utils/cn";

export default function Drawer({
  isOpen,
  onClose,
  title,
  children,
  width = "md",
  className
}) {
  const widths = {
    sm: "w-full sm:w-[400px]",
    md: "w-full sm:w-[500px]",
    lg: "w-full sm:w-[600px]",
    xl: "w-full sm:w-[800px]",
    full: "w-full",
  };

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [isOpen]);

  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === "Escape" && isOpen) onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50">
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer panel */}
      <div className={cn(
        "absolute right-0 top-0 h-full bg-surface flex flex-col",
        "rounded-none border-l border-border",
        "slide-in-right",
        widths[width] || widths.md,
        className
      )}>
        {/* Header */}
        <div className="flex items-center justify-between gap-3 h-14 px-6 border-b border-border flex-shrink-0">
          {title ? (
            <h2 className="meta text-text-main truncate">{title}</h2>
          ) : <span />}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex items-center justify-center size-9 shrink-0 border border-border text-text-muted hover:bg-surface-2 hover:text-text-main transition-colors"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
          {children}
        </div>
      </div>
    </div>
  );
}
