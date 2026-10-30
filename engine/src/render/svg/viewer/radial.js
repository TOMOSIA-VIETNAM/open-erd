// Neighborhood layout, computed in the viewer (no ELK in the browser). Pure
// functions so they can be unit-tested in Node and bundled into the SVG.

const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Rings of nodes 1..hops away from `center`: `neighbours(id)` gives the ids
 * linked to a node, `extras` more neighbours of the centre only. Each node
 * is { id, parent }, `parent` being the node of the previous ring it was
 * reached from (the earliest one in that ring). Ring 1 is in id order; each
 * further ring follows its parents' order, so a branch stays together.
 */
export function neighbourRings(center, hops, neighbours, extras = []) {
  const seen = new Set([center]);
  const result = [];
  let previous = [center];
  for (let hop = 1; hop <= hops; hop++) {
    const parent = new Map();
    previous.forEach((p, i) => {
      const next = new Set([...neighbours(p), ...(hop === 1 ? extras : [])]);
      for (const n of [...next].sort(byId)) {
        if (!seen.has(n) && !parent.has(n)) parent.set(n, i);
      }
    });
    const ring = [...parent.keys()].sort((a, b) => parent.get(a) - parent.get(b) || byId(a, b));
    for (const n of ring) seen.add(n);
    result.push(ring.map((id) => ({ id, parent: previous[parent.get(id)] })));
    previous = ring;
  }
  return result;
}

/**
 * Places `center` at the origin and every ring of nodes on a circle around
 * it, as a radial tree: each node sits in the middle of a wedge of the
 * circle, and the nodes hanging off it in the next ring share that wedge,
 * so a branch grows outwards in one direction and its lines stay between
 * its own boxes. Ring 1 starts on the left of the centre and goes
 * clockwise: boxes are taller than wide, so two neighbours sit beside the
 * centre rather than above and below it.
 *
 * A node's wedge is proportional to its weight: the larger of its own
 * footprint (diagonal + gap) and the sum of its children's weights.
 *
 * Each node is treated as the circle around its box (radius = half its
 * diagonal), so boxes cannot overlap whatever angle they end up at:
 *   - within a ring, the radius is the smallest that keeps every pair's
 *     chord at least the sum of their half footprints;
 *   - a ring starts outside the previous one by both rings' largest half
 *     diagonal plus the gap.
 * Between two rings, and outside the last, is therefore a band at least
 * `gap` wide that no box reaches; `channels` holds the radius of the middle
 * of each band, the one around the centre first (see routeLink).
 *
 * center: { id, w, h }; rings: [[{ id, w, h, parent }]], `parent` the id of
 * a node of the previous ring (the centre for ring 1); gap: px between boxes.
 * Returns { positions: { [id]: { x, y } } top-left corners rounded to whole
 * px, channels: [radius] }.
 */
export function radialLayout(center, rings, gap) {
  const diagonal = (n) => Math.hypot(n.w, n.h);
  const corner = (n, cx, cy) => ({ x: Math.round(cx - n.w / 2), y: Math.round(cy - n.h / 2) });
  const positions = { [center.id]: corner(center, 0, 0) };
  const channels = [];
  const filled = rings.filter((ring) => ring.length > 0);

  // Weights from the outermost ring in.
  const weight = new Map();
  const children = new Map();
  for (let k = filled.length - 1; k >= 0; k--) {
    for (const n of filled[k]) {
      const kids = children.get(n.id) ?? [];
      weight.set(n.id, Math.max(diagonal(n) + gap, kids.reduce((s, c) => s + weight.get(c.id), 0)));
      if (!children.has(n.parent)) children.set(n.parent, []);
      children.get(n.parent).push(n);
    }
  }
  const sum = (nodes) => nodes.reduce((s, n) => s + weight.get(n.id), 0);
  // Wedges, [start, size] in radians, from the centre out. The centre's is
  // the whole circle, turned so its first neighbour is centred on the left.
  const wedge = new Map();
  const first = filled[0] ?? [];
  wedge.set(center.id, [first.length ? Math.PI - (Math.PI * weight.get(first[0].id)) / sum(first) : 0, 2 * Math.PI]);
  const divide = (parent) => {
    const kids = children.get(parent);
    const [start, size] = wedge.get(parent);
    const total = weight.get(parent) ?? sum(kids);
    // The children's wedges together, centred in their parent's.
    let at = start + (size - (size * sum(kids)) / total) / 2;
    for (const n of kids) {
      const own = (size * weight.get(n.id)) / total;
      wedge.set(n.id, [at, own]);
      at += own;
    }
  };

  let radius = 0;
  let previous = diagonal(center);
  for (const ring of filled) {
    for (const p of new Set(ring.map((n) => n.parent))) divide(p);
    const angles = ring.map((n) => wedge.get(n.id)[0] + wedge.get(n.id)[1] / 2);
    const foot = ring.map((n) => diagonal(n) + gap);
    const widest = Math.max(...ring.map(diagonal));
    let r = radius + previous / 2 + widest / 2 + gap;
    for (let i = 0; i < ring.length; i++) {
      for (let k = i + 1; k < ring.length; k++) {
        const apart = Math.abs(angles[k] - angles[i]) % (2 * Math.PI);
        const shorter = Math.min(apart, 2 * Math.PI - apart);
        r = Math.max(r, (foot[i] + foot[k]) / 2 / (2 * Math.sin(shorter / 2)));
      }
    }
    ring.forEach((n, i) => {
      positions[n.id] = corner(n, r * Math.cos(angles[i]), r * Math.sin(angles[i]));
    });
    channels.push((radius + previous / 2 + r - widest / 2) / 2);
    radius = r;
    previous = widest;
  }
  channels.push(radius + previous / 2 + gap / 2);
  return { positions, channels };
}

/**
 * Straight line between the borders of boxes `a` and `b` ({ x, y, w, h }),
 * along the line joining their centres. Returns [[x1, y1], [x2, y2]].
 */
export function straightLink(a, b) {
  const ca = [a.x + a.w / 2, a.y + a.h / 2];
  const cb = [b.x + b.w / 2, b.y + b.h / 2];
  const dx = cb[0] - ca[0];
  const dy = cb[1] - ca[1];
  // Fraction of the centre-to-centre vector that stays inside a box.
  const exit = (box) => Math.min(dx === 0 ? Infinity : box.w / 2 / Math.abs(dx), dy === 0 ? Infinity : box.h / 2 / Math.abs(dy));
  const ta = exit(a);
  const tb = exit(b);
  return [
    [ca[0] + dx * ta, ca[1] + dy * ta],
    [cb[0] - dx * tb, cb[1] - dy * tb],
  ];
}

/**
 * True when segment p-q passes through the interior of box `r` grown by
 * `margin` on every side (Liang-Barsky clipping).
 */
function segmentHitsBox([[px, py], [qx, qy]], r, margin = 0) {
  const dx = qx - px;
  const dy = qy - py;
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [
    [-dx, px - (r.x - margin)],
    [dx, r.x + r.w + margin - px],
    [-dy, py - (r.y - margin)],
    [dy, r.y + r.h + margin - py],
  ]) {
    if (p === 0) {
      if (q <= 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 >= t1) return false;
  }
  return true;
}

// Longest straight piece of a routed arc, in px: short enough to read as a curve.
const ARC_STEP = 24;

/**
 * The line between boxes `a` and `b` of a radialLayout ({ x, y, w, h, ring },
 * `ring` 0 for the centre): the straight line between their borders when it
 * keeps `margin` px from every box in `others`; otherwise a detour through
 * the empty band outside the inner of the two rings (`channels` from
 * radialLayout): out of `a` along its radius, round the band, and into `b`
 * along its radius, so it never runs behind a box it does not connect.
 * Rings more than one apart (never in a neighborhood of two hops) keep the
 * straight line. Returns the points of the line, rounded to 0.01 px.
 */
export function routeLink(a, b, others, channels, margin) {
  const straight = straightLink(a, b);
  if (Math.abs(a.ring - b.ring) > 1 || !others.some((o) => segmentHitsBox(straight, o, margin))) return straight.map(roundPoint);
  const rc = channels[Math.min(a.ring, b.ring)];
  const centre = (box) => [box.x + box.w / 2, box.y + box.h / 2];
  // The centre box has no direction of its own: it leaves towards the other end.
  const angleOf = (box, other) => Math.atan2(...centre(box.ring === 0 ? other : box).reverse());
  const ta = angleOf(a, b);
  const tb = angleOf(b, a);
  // Where the radius at `angle` leaves `box`, heading towards the band.
  const border = (box, angle) => {
    const [cx, cy] = centre(box);
    const out = Math.hypot(cx, cy) < rc ? 1 : -1;
    const ux = out * Math.cos(angle);
    const uy = out * Math.sin(angle);
    const t = Math.min(ux === 0 ? Infinity : box.w / 2 / Math.abs(ux), uy === 0 ? Infinity : box.h / 2 / Math.abs(uy));
    return [cx + ux * t, cy + uy * t];
  };
  // The shorter way round the band.
  let turn = (tb - ta) % (2 * Math.PI);
  if (turn > Math.PI) turn -= 2 * Math.PI;
  if (turn < -Math.PI) turn += 2 * Math.PI;
  const steps = Math.max(1, Math.ceil((rc * Math.abs(turn)) / ARC_STEP));
  const arc = Array.from({ length: steps + 1 }, (_, i) => {
    const angle = ta + (turn * i) / steps;
    return [rc * Math.cos(angle), rc * Math.sin(angle)];
  });
  return [border(a, ta), ...arc, border(b, tb)].map(roundPoint);
}

const round2 = (v) => Math.round(v * 100) / 100;
const roundPoint = ([x, y]) => [round2(x), round2(y)];

/**
 * Transforms placing an end marker drawn for a line leaving its box to the
 * right (markerSvg(kind, 0, 0, 1)) at each end of the line through `points`
 * ([[x, y], ...]): at the first point turned towards the second, at the last
 * turned towards the one before it. Returns [from, to] transform strings.
 */
export function endTransforms(points) {
  const angle = ([x1, y1], [x2, y2]) => round2((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI);
  const [first, last] = [points[0], points.at(-1)];
  return [
    `translate(${round2(first[0])} ${round2(first[1])}) rotate(${angle(first, points[1])})`,
    `translate(${round2(last[0])} ${round2(last[1])}) rotate(${round2(angle(points.at(-2), last) + 180)})`,
  ];
}
