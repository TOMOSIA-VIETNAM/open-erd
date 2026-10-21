import subset from './inter-subset.json' with { type: 'json' };

export const FONT_FAMILY = 'Inter';

// measureText sums per-glyph advances, so the browser must not apply kerning or
// contextual alternates; every element that renders measured text must carry this.
export const TEXT_STYLE_CSS =
  "font-kerning: none; font-variant-ligatures: none; font-feature-settings: 'kern' 0, 'liga' 0, 'calt' 0;";

// @font-face rules with the Latin subset inlined, so output files render the
// measured font without network access.
export function fontFaceCss() {
  return Object.keys(subset.woff2)
    .sort()
    .map(
      (weight) =>
        `@font-face { font-family: '${FONT_FAMILY}'; font-style: normal; font-weight: ${weight}; ` +
        `src: url(data:font/woff2;base64,${subset.woff2[weight]}) format('woff2'); }`,
    )
    .join('\n');
}
