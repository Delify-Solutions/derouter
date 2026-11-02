// Size a large figure (price, credit, token count) so it fits its box.
//
// Hero figures are set at 30–36px, which holds "250.000đ" but not
// "123.456.789.000đ" in a 2-column tile on a 360px phone. Instead of letting the
// number spill out of its card, the font scales down with the box width:
//
//   font-size = clamp(minRem, 100cqi / widthInEm, maxRem)
//
// `cqi` is 1% of the nearest size container's inline size, so the element that
// holds the figure needs `@container` (container-type: inline-size). `widthInEm`
// is an upper-bound estimate of the string's advance width at 1em, which keeps a
// short figure at full size and shrinks a long one just enough to fit. Below
// `minRem` the figure is allowed to wrap (pair it with `max-w-full break-words`)
// rather than overflow.

const NARROW = new Set([".", ",", " ", "\u00a0", ":", "'", "(", ")", "|", "!", "·"]);
const WIDE = new Set(["M", "W", "m", "w", "%", "@"]);

/**
 * Approximate advance width of `text` in em for a semibold/bold figure in the
 * sans face (digits measure ~0.65em, separators ~0.31em). Errs on the wide side
 * so the estimate is an upper bound.
 */
export function figureWidthEm(text) {
  let em = 0;
  for (const ch of String(text)) {
    if (NARROW.has(ch)) em += 0.34;
    else if (WIDE.has(ch)) em += 0.92;
    else if (/[A-ZĐÀ-Ỹ]/.test(ch)) em += 0.8;
    else if (ch === "~" || ch === "-" || ch === "/" || ch === "+") em += 0.52;
    else em += 0.69;
  }
  return Math.max(em, 1);
}

/**
 * Inline style for a figure that must fit its `@container` parent.
 * Returns undefined for non-text values so callers can pass any node.
 */
export function fitFigureStyle(text, { maxRem = 2.25, minRem = 1 } = {}) {
  if (typeof text !== "string" && typeof text !== "number") return undefined;
  // Words wrap on their own; only the longest one has to fit on a line.
  const longest = String(text).split(/\s+/).reduce((a, b) => (figureWidthEm(b) > figureWidthEm(a) ? b : a), "");
  const em = figureWidthEm(longest);
  return { fontSize: `clamp(${minRem}rem, calc(100cqi / ${em.toFixed(2)}), ${maxRem}rem)` };
}
