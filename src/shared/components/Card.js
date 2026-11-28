"use client";

import { cn } from "@/shared/utils/cn";

// Vuexy card shape (change admin-accounts-rbac-vuexy, group 7): no border by
// default (Vuexy's $card-border-width is 0), rounded corners, a soft
// elevation shadow instead of a border carrying the hierarchy. `elev` was an
// existing prop that previously had no visual effect (the old className
// builder never read it) — wiring it up here is a visual-only fix, not a new
// prop.
export default function Card({
  children,
  title,
  subtitle,
  icon,
  action,
  padding = "md",
  hover = false,
  elev = false,
  className,
  ...props
}) {
  const paddings = {
    none: "",
    xs: "p-3",
    sm: "p-4",
    md: "p-6",
    lg: "p-8",
  };

  return (
    <div
      className={cn(
        "rounded-vx-lg bg-vx-surface shadow-vx-xs",
        hover && "hover:shadow-vx-sm transition-shadow cursor-pointer",
        elev && "shadow-vx-md",
        paddings[padding],
        className
      )}
      {...props}
    >
      {(title || action) && (
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            {icon && (
              <div className="flex items-center justify-center size-10 rounded-vx-md bg-vx-primary/10 text-vx-primary">
                <span className="material-symbols-outlined text-[20px]">{icon}</span>
              </div>
            )}
            <div>
              {title && (
                <h3 className="text-vx-heading font-semibold">{title}</h3>
              )}
              {subtitle && (
                <p className="text-sm text-vx-text-muted">{subtitle}</p>
              )}
            </div>
          </div>
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

Card.Section = function CardSection({ children, className, ...props }) {
  return (
    <div
      className={cn(
        "p-4 rounded-vx-md bg-vx-page",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
};

Card.Row = function CardRow({ children, className, ...props }) {
  return (
    <div
      className={cn(
        "p-3 -mx-3 px-3 transition-colors",
        "border-b border-vx-border last:border-b-0",
        "hover:bg-vx-surface-2/60",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
};

Card.ListItem = function CardListItem({
  children,
  actions,
  className,
  ...props
}) {
  return (
    <div
      className={cn(
        "group flex items-center justify-between p-3 -mx-3 px-3",
        "border-b border-vx-border last:border-b-0",
        "hover:bg-vx-surface-2/60 transition-colors",
        className
      )}
      {...props}
    >
      <div className="flex-1 min-w-0">{children}</div>
      {actions && (
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {actions}
        </div>
      )}
    </div>
  );
};
