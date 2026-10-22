// Crow's foot notation. Each relation end gets one of four markers:
//   one          ||   exactly one
//   zeroOrOne    o|   at most one
//   many         |<   one or more
//   zeroOrMany   o<   any number
//
// The overview, whose lines stand for many relations, marks only direction:
//   arrow        ->   points at the domain holding the referenced keys
//   none              no marker at that end
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
const ARROW_LENGTH = 12;
const ARROW_HALF = 5;

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
    case 'arrow':
      return `<path class="head" d="M${x} ${y}L${at(ARROW_LENGTH)} ${y - ARROW_HALF}L${at(ARROW_LENGTH)} ${y + ARROW_HALF}Z"/>`;
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
