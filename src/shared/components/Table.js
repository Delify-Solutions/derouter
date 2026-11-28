"use client";

import { cn } from "@/shared/utils/cn";

// New shared primitive (change admin-accounts-rbac-vuexy, group 7). No shared
// Table component existed before this — every table-heavy page currently
// renders its own `<table>` markup inline. This component is Vuexy's table
// visual shape (rounded card wrapper, uppercase muted header row, hairline
// row dividers, hover highlight) so later reskin batches (OpenSpec tasks
// groups 8-10) have a primitive to migrate onto. Nothing is wired up to it
// yet — existing pages are untouched by this task.
// `bare` (additive, change admin-accounts-rbac-vuexy, group 8): skips the
// decorative rounded/surface/shadow wrapper for tables embedded inside a
// container that already provides its own border/surface (e.g. a Card), so
// the table isn't double-boxed. Horizontal scroll behavior is kept either way.
export default function Table({ children, className, wrapperClassName, bare = false }) {
  return (
    <div
      className={cn(
        "w-full overflow-x-auto",
        !bare && "rounded-vx-lg bg-vx-surface shadow-vx-xs",
        wrapperClassName
      )}
    >
      <table className={cn("w-full border-collapse text-sm", className)}>
        {children}
      </table>
    </div>
  );
}

Table.Head = function TableHead({ children, className }) {
  return <thead className={cn("border-b border-vx-border", className)}>{children}</thead>;
};

Table.Body = function TableBody({ children, className }) {
  return <tbody className={cn("divide-y divide-vx-border", className)}>{children}</tbody>;
};

Table.Row = function TableRow({ children, className, onClick, ...props }) {
  return (
    <tr
      className={cn(
        "transition-colors",
        onClick && "cursor-pointer",
        "hover:bg-vx-surface-2/60",
        className
      )}
      onClick={onClick}
      {...props}
    >
      {children}
    </tr>
  );
};

// `align` (additive, change admin-accounts-rbac-vuexy, group 8): a column whose
// values read right-to-left (numbers, an actions column) needs its header text
// aligned to match — plain string concatenation can't reliably override the
// base "text-left", so this swaps it instead of leaving callers to fight it
// with a className override.
const ALIGN = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

Table.HeaderCell = function TableHeaderCell({ children, className, align = "left", ...props }) {
  return (
    <th
      className={cn(
        "px-4 py-3 text-xs font-semibold uppercase tracking-wide text-vx-text-muted",
        ALIGN[align] || ALIGN.left,
        className
      )}
      {...props}
    >
      {children}
    </th>
  );
};

Table.Cell = function TableCell({ children, className, ...props }) {
  return (
    <td className={cn("px-4 py-3 text-vx-text", className)} {...props}>
      {children}
    </td>
  );
};

Table.Empty = function TableEmpty({ colSpan, children, className }) {
  return (
    <tr>
      <td colSpan={colSpan} className={cn("px-4 py-10 text-center text-sm text-vx-text-muted", className)}>
        {children}
      </td>
    </tr>
  );
};
