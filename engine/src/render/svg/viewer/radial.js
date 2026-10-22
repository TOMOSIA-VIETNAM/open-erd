// Neighborhood layout, computed in the viewer (no ELK in the browser). Pure
// functions so they can be unit-tested in Node and bundled into the SVG.

/**
 * Places `center` at the origin and every ring of nodes on a circle around
 * it, ring after ring, in the given order clockwise from the top.
 *
 * Each node is treated as the circle around its box (radius = half its
 * diagonal), so boxes cannot overlap whatever angle they end up at:
 *   - within a ring, node i gets a share of the circle proportional to its
 *     footprint (diagonal + gap); the radius is the smallest that keeps every
 *     pair's chord at least the sum of their half footprints;
 *   - a ring starts outside the previous one by both rings' largest half
 *     diagonal plus the gap.
 *
 * center: { id, w, h }; rings: [[{ id, w, h }]]; gap: px between boxes.
 * Returns { [id]: { x, y } } top-left corners, rounded to whole px.
 */
export function radialLayout(center, rings, gap) {
  const diagonal = (n) => Math.hypot(n.w, n.h);
  const corner = (n, cx, cy) => ({ x: Math.round(cx - n.w / 2), y: Math.round(cy - n.h / 2) });
  const positions = { [center.id]: corner(center, 0, 0) };
  let radius = 0;
  let previous = diagonal(center);
  for (const ring of rings) {
    if (ring.length === 0) continue;
    const foot = ring.map((n) => diagonal(n) + gap);
    const total = foot.reduce((a, b) => a + b, 0);
    const angles = [];
    // Shares are centred on their node; the first node sits straight up.
    let run = -foot[0] / 2;
    for (const f of foot) {
      angles.push(-Math.PI / 2 + (2 * Math.PI * (run + f / 2)) / total);
      run += f;
    }
    const widest = Math.max(...ring.map(diagonal));
    let r = radius + previous / 2 + widest / 2 + gap;
    for (let i = 0; i < ring.length; i++) {
      for (let k = i + 1; k < ring.length; k++) {
        const apart = Math.abs(angles[k] - angles[i]);
        const shorter = Math.min(apart, 2 * Math.PI - apart);
        r = Math.max(r, (foot[i] + foot[k]) / 2 / (2 * Math.sin(shorter / 2)));
      }
    }
    ring.forEach((n, i) => {
      positions[n.id] = corner(n, r * Math.cos(angles[i]), r * Math.sin(angles[i]));
    });
    radius = r;
    previous = widest;
  }
  return positions;
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

const round2 = (v) => Math.round(v * 100) / 100;

/**
 * Transforms placing an end marker drawn for a line leaving its box to the
 * right (markerSvg(kind, 0, 0, 1)) at each end of the straight line
 * [[x1, y1], [x2, y2]]: at the first point turned towards the second, at the
 * second turned towards the first. Returns [from, to] transform strings.
 */
export function endTransforms([[x1, y1], [x2, y2]]) {
  const angle = round2((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI);
  return [`translate(${round2(x1)} ${round2(y1)}) rotate(${angle})`, `translate(${round2(x2)} ${round2(y2)}) rotate(${round2(angle + 180)})`];
}
