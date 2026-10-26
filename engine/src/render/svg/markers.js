// Crow's foot notation. Each relation end gets one of four markers:
//   one          ||   exactly one
//   zeroOrOne    o|   at most one
//   many         |<   one or more
//   zeroOrMany   o<   any number
//
// `none` draws no marker at that end (a view's line to its source, the
// lines of a polymorphic node).
//
// `cardinality` is "<from>-<to>" and `optional` says whether the referencing
// (from) columns may be NULL. So:
//   - the to end shows how many rows one from-row points at: its side of the
//     cardinality, with the zero ring when the reference is optional;
//   - the from end shows how many rows may point at one to-row. Nothing forces
//     a referenced row to be referenced, so it always carries the zero ring.
export function endMarkers({ cardinality, optional }) {
  const [fromSide, toSide] = cardinality.split('-');
  const name = (side, zero) => (side === 'n' ? (zero ? 'zeroOrMany' : 'many') : zero ? 'zeroOrOne' : 'one');
  return { from: name(fromSide, true), to: name(toSide, optional) };
}

// Distances from the box side, in px, along the line. All fit inside the
// router's stub so no other line crosses a marker.
const CROW_LENGTH = 12;
const CROW_SPREAD = 7;
const BAR_NEAR = 10;
const BAR_FAR = 16;
const BAR_HALF = 6;
const RING_CENTRE = 21;
const RING_RADIUS = 4;

/**
 * SVG elements for a marker at point (x, y) on a box side; `side` is -1 when
 * the line leaves the box to the left, 1 to the right.
 */
export function markerSvg(kind, x, y, side) {
  const at = (d) => x + side * d;
  const bar = (d) => `<path d="M${at(d)} ${y - BAR_HALF}V${y + BAR_HALF}"/>`;
  const crow = `<path d="M${x} ${y - CROW_SPREAD}L${at(CROW_LENGTH)} ${y}L${x} ${y + CROW_SPREAD}"/>`;
  const ring = `<circle class="ring" cx="${at(RING_CENTRE)}" cy="${y}" r="${RING_RADIUS}"/>`;
  switch (kind) {
    case 'none':
      return '';
    case 'one':
      return bar(BAR_NEAR) + bar(BAR_FAR);
    case 'zeroOrOne':
      return bar(BAR_NEAR) + ring;
    case 'many':
      return crow + bar(BAR_FAR);
    case 'zeroOrMany':
      return crow + ring;
    default:
      throw new Error(`unknown marker ${kind}`);
  }
}

/**
 * How far a fact can be trusted: `trusted` (a database constraint, or a
 * fact a person reviewed), `doubtful` (an inference nobody reviewed yet, or
 * a reviewed fact the code no longer supports) or `declared` (everything in
 * between: an association the code declares, a cross-DB or polymorphic
 * reference found in code).
 */
export function trustOf(kind, review) {
  if (review === 'reviewed' || kind === 'db_fk') return 'trusted';
  if (kind === 'inferred' || review === 'stale') return 'doubtful';
  return 'declared';
}

// Every diagram (SVG views, neighborhood, join path, draw.io) has two line
// styles only: solid for a confirmed reference, dashed for one found in code
// that nobody confirmed. Kind (cross-DB, polymorphic) is told by the label or
// the node, review state by colour in review mode only.
export const UNCONFIRMED_DASH = '6 4';

// The lines from a polymorphic node to its targets are drawn from the start
// when it has few targets and the view holds them all: the targets are then
// plainly linked, not tables standing alone. More targets, or some outside
// the view, would tangle it; those lines show when the node is selected.
export const POLY_LINES_MAX = 3;
export const polyLinesShown = (inView, total) => inView === total && total <= POLY_LINES_MAX;
export const isConfirmed = (kind, review) => trustOf(kind, review) !== 'doubtful';

// An overview line stands for every relation between two domains; the more
// relations, the thicker it is, in a few steps so widths stay comparable.
const OVERVIEW_WIDTHS = [
  [1, 1.2],
  [3, 2],
  [7, 3],
  [Infinity, 4],
];
export const overviewStrokeWidth = (count) => OVERVIEW_WIDTHS.find(([most]) => count <= most)[1];

const round2 = (v) => Math.round(v * 100) / 100;

/**
 * The mark of a column with enum values, centred at (cx, cy): a tiny list,
 * three bullets with a short line each, drawn as one stroked path (CSS class
 * `hint-enum`). Eight px wide, inside the gap a row keeps after its name.
 */
export function enumIconSvg(cx, cy) {
  const d = [-3, 0, 3].map((dy) => `M${round2(cx - 4)} ${round2(cy + dy)}h1.2M${round2(cx - 1)} ${round2(cy + dy)}H${round2(cx + 4)}`).join('');
  return `<path class="hint-enum" d="${d}"/>`;
}

// Small icons drawn in table boxes and the viewer's legend, each centred at
// (cx, cy) and about 10 px across, as paths with a CSS class (colours live
// in the stylesheet). Paths only: a table group's last <rect> is its border,
// which highlighting and the viewer read.
const icon = (cls, d) => `<path class="${cls}" d="${d}"/>`;
// Absolute point, x and y of offsets from the icon's centre.
const offsets = (cx, cy) => ({ p: (dx, dy) => `${round2(cx + dx)} ${round2(cy + dy)}`, x: (dx) => round2(cx + dx), y: (dy) => round2(cy + dy) });

/** Primary key: a key, ring on the left, bit to the right. */
export function keyIconSvg(cx, cy) {
  const { p, x } = offsets(cx, cy);
  return icon('icon-pk', `M${p(-1.5, 0)}A2.5 2.5 0 1 1 ${p(-6.5, 0)}A2.5 2.5 0 1 1 ${p(-1.5, 0)}H${x(5)}M${p(3, 0)}V${round2(cy + 2.5)}M${p(5, 0)}V${round2(cy + 2)}`);
}

/** Column referencing another table: two chain links. */
export function linkIconSvg(cx, cy) {
  const { p, x } = offsets(cx, cy);
  return icon('icon-fk', `M${p(-1, -2.5)}H${x(-3)}A2.5 2.5 0 0 0 ${p(-3, 2.5)}H${x(-1)}M${p(1, -2.5)}H${x(3)}A2.5 2.5 0 0 1 ${p(3, 2.5)}H${x(1)}M${p(-2, 0)}H${x(2)}`);
}

/** Column in an index: a small lightning bolt (fast lookup). */
export function indexIconSvg(cx, cy) {
  const { p, x } = offsets(cx, cy);
  return icon('icon-index', `M${p(1, -5)}L${p(-3, 1)}H${x(0)}L${p(-1, 5)}L${p(3, -1)}H${x(0)}Z`);
}

/** A table: a box with a header line and one column line. */
export function tableIconSvg(cx, cy) {
  const { p, x, y } = offsets(cx, cy);
  return icon('icon-table', `M${p(-5, -4)}H${x(5)}V${y(4)}H${x(-5)}ZM${p(-5, -1.5)}H${x(5)}M${p(-1, -1.5)}V${y(4)}`);
}

/** A central table: a five-pointed star. */
export function starIconSvg(cx, cy) {
  const points = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 5.5 : 2.4;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    points.push(`${round2(cx + r * Math.cos(a))} ${round2(cy + r * Math.sin(a))}`);
  }
  return icon('icon-central', `M${points.join('L')}Z`);
}

/**
 * Review state of a fact as an icon (CSS classes review-icon-<state>):
 * reviewed a check, pending a hollow clock, stale a warning triangle.
 * REVIEW_WORDS has the words for each, for tooltips.
 */
export function reviewIconSvg(state, cx, cy) {
  const { p, x, y } = offsets(cx, cy);
  if (state === 'reviewed') return icon('review-icon review-icon-reviewed', `M${p(-4, 0)}L${p(-1.2, 3)}L${p(4.5, -3.5)}`);
  if (state === 'stale') return icon('review-icon review-icon-stale', `M${p(0, -5)}L${p(5.2, 4)}H${x(-5.2)}ZM${p(0, -1.5)}V${y(1.2)}M${p(0, 2.4)}V${y(2.6)}`);
  return icon('review-icon review-icon-pending', `M${p(4.5, 0)}A4.5 4.5 0 1 1 ${p(-4.5, 0)}A4.5 4.5 0 1 1 ${p(4.5, 0)}M${p(0, -2.5)}V${y(0)}H${x(2)}`);
}

/** What each review state means to a reader, for tooltips. */
export const REVIEW_WORDS = { reviewed: 'Confirmed', pending: 'Not confirmed yet', stale: 'Code changed since confirmed' };

/**
 * Paint of each icon class above as SVG presentation attributes, for an icon
 * drawn outside this file's SVG (a standalone image in a draw.io label),
 * where the SVG stylesheet does not apply. The SVG stylesheet is generated from it.
 */
export const ICON_PAINT = {
  'hint-enum': { fill: 'none', stroke: '#7c5cc4', 'stroke-width': 1.3, 'stroke-linecap': 'round' },
  'icon-pk': { fill: 'none', stroke: '#c98a04', 'stroke-width': 1.4, 'stroke-linecap': 'round' },
  'icon-fk': { fill: 'none', stroke: '#2f6fd6', 'stroke-width': 1.3, 'stroke-linecap': 'round' },
  'icon-index': { fill: '#1f9d8f', stroke: 'none' },
  'icon-table': { fill: 'none', stroke: '#5f6b7e', 'stroke-width': 1.1 },
  'icon-central': { fill: '#f2b705', stroke: '#a87a00', 'stroke-width': 0.8, 'stroke-linejoin': 'round' },
};
