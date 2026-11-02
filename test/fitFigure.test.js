import { test } from "node:test";
import assert from "node:assert/strict";
import { figureWidthEm, fitFigureStyle } from "../src/shared/utils/fitFigure.js";

test("figureWidthEm grows with the figure and counts separators as narrow", () => {
  assert.ok(figureWidthEm("123.456.789.000đ") > figureWidthEm("250.000đ"));
  assert.ok(figureWidthEm("1,000") < figureWidthEm("10000"));
});

test("fitFigureStyle scales by container width, capped at the design size", () => {
  const style = fitFigureStyle("7,363,001,391");
  assert.match(style.fontSize, /^clamp\(1rem, calc\(100cqi \/ [\d.]+\), 2\.25rem\)$/);
  assert.match(fitFigureStyle("$12.40", { maxRem: 1.5, minRem: 0.875 }).fontSize, /^clamp\(0\.875rem, .*1\.5rem\)$/);
});

test("fitFigureStyle sizes text by its longest word and ignores non-text", () => {
  const sentence = fitFigureStyle("Không giới hạn").fontSize;
  const word = fitFigureStyle("Không").fontSize;
  assert.equal(sentence, word);
  assert.equal(fitFigureStyle(null), undefined);
  assert.equal(fitFigureStyle({}), undefined);
});
