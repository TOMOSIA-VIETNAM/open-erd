import metrics from './inter-metrics.json' with { type: 'json' };

// CJK glyphs come from the viewer's fallback font, not Inter; counting them as
// one em is the widest they render, so boxes never overflow.
export const FULL_WIDTH = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿！-｠￠-￦]/u;
const ELLIPSIS = '…';

// Characters outside the subset also render in a fallback font with unknown
// width; the widest Inter glyph is a safe upper bound.
const TABLES = Object.fromEntries(
  Object.entries(metrics.advances).map(([weight, advances]) => [
    weight,
    { advances, fallback: Math.max(...Object.values(advances)) },
  ]),
);

function tableFor(weight = 400) {
  return TABLES[weight >= 600 ? '700' : '400'];
}

function charUnits(ch, table) {
  const advance = table.advances[ch.codePointAt(0)];
  if (advance !== undefined) return advance;
  return FULL_WIDTH.test(ch) ? metrics.unitsPerEm : table.fallback;
}

/** Width in px of `str` rendered in Inter at `size` px with kerning disabled. */
export function measureText(str, { size, weight } = {}) {
  const table = tableFor(weight);
  let units = 0;
  for (const ch of str) units += charUnits(ch, table);
  return (units * size) / metrics.unitsPerEm;
}

/**
 * Shorten `str` with a trailing ellipsis so it fits `maxWidth` px. Cuts on code
 * points so surrogate pairs are never split. Callers show the full text in a
 * tooltip when `truncated` is true.
 */
export function truncate(str, maxWidth, { size, weight } = {}) {
  if (measureText(str, { size, weight }) <= maxWidth) return { text: str, truncated: false };
  const table = tableFor(weight);
  const budget = (maxWidth * metrics.unitsPerEm) / size - charUnits(ELLIPSIS, table);
  if (budget < 0) return { text: '', truncated: true };
  let units = 0;
  let text = '';
  for (const ch of str) {
    units += charUnits(ch, table);
    if (units > budget) break;
    text += ch;
  }
  return { text: text.trimEnd() + ELLIPSIS, truncated: true };
}
