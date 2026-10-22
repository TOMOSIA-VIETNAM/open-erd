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
