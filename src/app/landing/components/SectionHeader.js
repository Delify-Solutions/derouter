import PropTypes from "prop-types";

// Eyebrow + title + optional lines for every landing section. The eyebrow is a
// `// LABEL` with a trailing hairline (openspec/ui-dna.md §8).
export default function SectionHeader({ eyebrow, title, children }) {
  return (
    <header className="max-w-3xl">
      {eyebrow ? (
        <p className="flex items-center gap-3 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">
          <span className="text-text-subtle" aria-hidden="true">{"//"}</span>
          {eyebrow}
          <span className="h-px w-16 bg-border" aria-hidden="true" />
        </p>
      ) : null}
      <h2 className="mt-4 text-2xl font-semibold leading-tight tracking-tight text-text-main md:text-4xl">{title}</h2>
      {children ? <div className="mt-4 flex flex-col gap-2 text-base leading-7 text-text-muted">{children}</div> : null}
    </header>
  );
}

SectionHeader.propTypes = {
  eyebrow: PropTypes.string,
  title: PropTypes.string.isRequired,
  children: PropTypes.node,
};
