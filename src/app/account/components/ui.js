import Link from "next/link";
import { cn } from "@/shared/utils/cn";

// Presentational primitives for the customer area (openspec/ui-dna.md §8).
// No hooks and no "use client": they render from server and client components
// alike. Colour comes from the shared tokens, so dark mode needs no extra work.

/** `// Title` — the page and section heading: mono, with a muted slash prefix. */
export function Heading({ children, as: Tag = "h1", size = "lg", className }) {
  return (
    <Tag
      className={cn(
        "font-mono font-semibold tracking-tight text-text-main",
        size === "lg" ? "text-2xl" : "text-base",
        className
      )}
    >
      <span className="mr-2 text-text-subtle" aria-hidden="true">{"//"}</span>
      {children}
    </Tag>
  );
}

/** A small mono caption above a block, e.g. QUICK LINKS. */
export function Eyebrow({ children, className }) {
  return <p className={cn("meta text-text-muted", className)}>{children}</p>;
}

/** Page frame: heading, one muted line, optional right-hand actions, then the body. */
export function Page({ title, description, actions, children }) {
  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Heading>{title}</Heading>
          {description && <p className="max-w-2xl text-sm leading-6 text-text-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

/**
 * Two-column section: title and description on the left, content on the right.
 * Collapses to one column below `lg`.
 */
export function Section({ title, description, children, id }) {
  return (
    <section id={id} className="grid gap-6 lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)] lg:gap-10">
      <div className="flex flex-col gap-2">
        <Heading as="h2" size="sm">{title}</Heading>
        {description && <p className="text-sm leading-6 text-text-muted">{description}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

/** Bordered surface with a small square at each corner. */
export function Panel({ children, className, as: Tag = "div", ...rest }) {
  return (
    <Tag className={cn("relative border border-border bg-surface", className)} {...rest}>
      {["-left-[3px] -top-[3px]", "-right-[3px] -top-[3px]", "-left-[3px] -bottom-[3px]", "-right-[3px] -bottom-[3px]"].map((pos) => (
        <i key={pos} aria-hidden="true" className={cn("pointer-events-none absolute size-[5px] border border-border bg-bg", pos)} />
      ))}
      {children}
    </Tag>
  );
}

/** One figure with its label: the number is the loudest thing in the block. */
export function Stat({ label, value, unit, hint }) {
  return (
    <div className="flex flex-col gap-3">
      <Eyebrow>{label}</Eyebrow>
      <p className="flex items-baseline gap-2 text-text-main">
        <span className="font-sans text-4xl font-semibold leading-none tracking-tight">{value}</span>
        {unit && <span className="font-mono text-sm text-text-muted">{unit}</span>}
      </p>
      {hint && <p className="text-sm leading-6 text-text-muted">{hint}</p>}
    </div>
  );
}

const TAG_TONES = {
  neutral: "border-border text-text-muted",
  success: "border-brand-500/40 bg-brand-500/10 text-brand-700 dark:text-brand-400",
  warning: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  danger: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400",
};

/** Status tag. Always carries a text label; the tone is only a second signal. */
export function Tag({ tone = "neutral", icon, children, className }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1 border px-2 font-mono text-[11px] font-medium uppercase tracking-[0.08em]",
        TAG_TONES[tone] || TAG_TONES.neutral,
        className
      )}
    >
      {icon && <span className="material-symbols-outlined text-[14px]" aria-hidden="true">{icon}</span>}
      {children}
    </span>
  );
}

const BUTTON_TONES = {
  solid: "border-text-main bg-text-main text-bg hover:bg-text-main/85",
  outline: "border-border bg-surface text-text-main hover:bg-surface-2",
  ghost: "border-transparent text-text-muted hover:bg-surface-2 hover:text-text-main",
};

export function buttonClass({ tone = "outline", size = "md", className } = {}) {
  return cn(
    "inline-flex items-center justify-center gap-2 border font-mono font-medium transition-colors duration-150",
    "disabled:cursor-not-allowed disabled:opacity-50",
    size === "sm" ? "h-8 px-3 text-xs" : "h-10 px-4 text-[13px]",
    BUTTON_TONES[tone] || BUTTON_TONES.outline,
    className
  );
}

export function ButtonLink({ href, tone, size, className, children, ...rest }) {
  return (
    <Link href={href} className={buttonClass({ tone, size, className })} {...rest}>
      {children}
    </Link>
  );
}

/** `<button>` in the same look as ButtonLink, with a busy state for form submits. */
export function ActionButton({ tone, size, loading = false, fullWidth = false, disabled, className, children, ...rest }) {
  return (
    <button
      className={buttonClass({ tone, size, className: cn(fullWidth && "w-full", className) })}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <span className="material-symbols-outlined animate-spin text-[16px]" aria-hidden="true">progress_activity</span>}
      {children}
    </button>
  );
}

/** Icon in a bordered square: the only place a card carries an icon. */
export function IconBox({ icon }) {
  return (
    <span className="flex size-9 shrink-0 items-center justify-center border border-border bg-surface-2 text-text-muted">
      <span className="material-symbols-outlined text-[18px]" aria-hidden="true">{icon}</span>
    </span>
  );
}

/** Row in a list: grey fill, one line of identity, an optional line of detail. */
export function ListRow({ title, detail, tags, actions }) {
  return (
    <li className="flex items-center justify-between gap-4 border border-border bg-surface-2 px-5 py-4">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-mono text-sm text-text-main">{title}</span>
          {tags}
        </div>
        {detail && <p className="text-sm text-text-muted">{detail}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </li>
  );
}

/** Empty state: says what will appear here and offers the one action that fills it. */
export function Empty({ icon = "inbox", title, body, action }) {
  return (
    <div className="flex flex-col items-center gap-3 border border-dashed border-border px-6 py-12 text-center">
      <IconBox icon={icon} />
      <p className="text-sm font-medium text-text-main">{title}</p>
      {body && <p className="max-w-md text-sm leading-6 text-text-muted">{body}</p>}
      {action}
    </div>
  );
}
