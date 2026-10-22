import { compareStrings } from '../model/load.js';
import { MARGIN, routeEdges } from './router.js';
import { GRID, roundToGrid } from './table-box.js';

// Lines of the overview: one per pair of domains. A domain box has no rows,
// so a line may meet any of its four sides, at any free slot along it (one
// grid step apart, a line per slot). Lines are placed one at a time, the ones
// standing for most relations first, each taking the cheapest of these
// shapes that keeps MARGIN px clear of every other box and group label and
// never runs along a line placed before it:
//   straight    the boxes face each other: a horizontal or vertical line;
//   one bend    out of one box's side, into the other's top or bottom;
//   two bends   out and back in through a free channel: a U under or over
//               both boxes, a C beside both, or a Z through the gap between
//               them;
//   diagonal    a straight line between the box centres, when that is clear.
// Cost is length, plus a fixed amount per bend, per crossing of a line
// already placed, per badge it runs through, and for a diagonal. Only a line
// none of these fits goes to the orthogonal router of the other views.
// ponytail: the router fallback does not see the lines placed before it, so
// it may run over one; pass them to the router as occupied tracks if that
// ever shows on a real schema.

const BEND_COST = 60;
const CROSS_COST = 150;
const BADGE_COST = 400;
const DIAGONAL_COST = 120;
// Slots tried per end: the free ones nearest to where the end would ideally be.
const SLOTS_PER_END = 3;
// Channels tried for a two-bend line, one grid step apart.
const CHANNELS = 16;
// Parallel lines closer than this side by side read as a bundle of cables.
const PARALLEL_GAP = 2 * GRID;
const BADGE_HEIGHT = 16;
// Where along its line a badge may go, in order of preference.
const BADGE_SPOTS = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8];
// Room a badge takes, with a little air around it.
const badgeAround = ([x, y]) => ({ x: x - BADGE_HEIGHT, y: y - BADGE_HEIGHT / 2 - 2, w: 2 * BADGE_HEIGHT, h: BADGE_HEIGHT + 4 });
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const horizontalSide = (side) => side === 'left' || side === 'right';
const centre = (b) => [b.x + b.w / 2, b.y + b.h / 2];
const inflate = (b, by) => ({ x: b.x - by, y: b.y - by, w: b.w + 2 * by, h: b.h + 2 * by });

/** Point on side `side` of box `b` at coordinate `at` along that side. */
function sidePoint(b, side, at) {
  if (side === 'left') return [b.x, at];
  if (side === 'right') return [b.x + b.w, at];
  if (side === 'top') return [at, b.y];
  return [at, b.y + b.h];
}

// True when segment p-q passes through the open interior of rectangle r
// (Liang-Barsky clipping).
export function segmentCrosses([px, py], [qx, qy], r) {
  const dx = qx - px;
  const dy = qy - py;
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [
    [-dx, px - r.x],
    [dx, r.x + r.w - px],
    [-dy, py - r.y],
    [dy, r.y + r.h - py],
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

// Whether a polyline from box a to box b keeps clear of every other box and
// label, and of its own boxes beyond the segments touching them.
function clear(points, a, b, nodes, labels) {
  const segs = points.slice(1).map((q, i) => [points[i], q]);
  return segs.every(([p, q], i) => {
    const skip = new Set([...(i === 0 ? [a.id] : []), ...(i === segs.length - 1 ? [b.id] : [])]);
    return nodes.every((n) => skip.has(n.id) || !segmentCrosses(p, q, inflate(n, MARGIN - 1))) && labels.every((l) => !segmentCrosses(p, q, inflate(l, MARGIN - 1)));
  });
}

const orient = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
// Proper crossing of two segments (touching at an end does not count).
function crosses([p1, p2], [q1, q2]) {
  return orient(p1, p2, q1) * orient(p1, p2, q2) < 0 && orient(q1, q2, p1) * orient(q1, q2, p2) < 0;
}
// Two parallel axis-aligned segments too close side by side.
function alongside([p1, p2], [q1, q2]) {
  const overlap = (a1, a2, b1, b2) => Math.min(Math.max(a1, a2), Math.max(b1, b2)) - Math.max(Math.min(a1, a2), Math.min(b1, b2)) > 0;
  if (p1[1] === p2[1] && q1[1] === q2[1]) return Math.abs(p1[1] - q1[1]) < PARALLEL_GAP - 1 && overlap(p1[0], p2[0], q1[0], q2[0]);
  if (p1[0] === p2[0] && q1[0] === q2[0]) return Math.abs(p1[0] - q1[0]) < PARALLEL_GAP - 1 && overlap(p1[1], p2[1], q1[1], q2[1]);
  return false;
}

const segmentsOf = (points) => points.slice(1).map((q, i) => [points[i], q]);
const lengthOf = (points) => segmentsOf(points).reduce((s, [p, q]) => s + Math.hypot(q[0] - p[0], q[1] - p[1]), 0);

// Point at fraction `t` of a polyline's length.
function pointAt(points, t) {
  let rest = lengthOf(points) * t;
  for (const [p, q] of segmentsOf(points)) {
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (rest <= len) {
      const t = len === 0 ? 0 : rest / len;
      return [Math.round((p[0] + (q[0] - p[0]) * t) * 100) / 100, Math.round((p[1] + (q[1] - p[1]) * t) * 100) / 100];
    }
    rest -= len;
  }
  return points.at(-1);
}

// Slots of one side: PARALLEL_GAP apart, so lines leaving one side side by
// side stay apart; a grid step (two on a long side) in from the corners.
function slotsOf(box, side) {
  const [from, length] = horizontalSide(side) ? [box.y, box.h] : [box.x, box.w];
  const inset = horizontalSide(side) ? GRID : 2 * GRID;
  const out = [];
  for (let v = from + inset; v <= from + length - inset; v += PARALLEL_GAP) out.push(v);
  return out;
}

/**
 * Routes the overview lines. `nodes`: domain boxes { id, x, y, w, h } on
 * the grid; `labels`: group label boxes to keep clear of; `frames`: group
 * frames (for the router fallback); `links`: overview links ({ id, count,
 * from: { node }, to: { node } }). Returns, in link order, { id, points,
 * middle: [x, y] } where `middle` is where its count badge goes.
 */
export function routeOverview(nodes, labels, frames, links) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const taken = new Set();
  const placed = [];
  const badges = [];
  const slotKey = (box, side, v) => `${box.id}\u0000${side}\u0000${v}`;
  // The free slots of a side nearest to `want`, nearest first.
  const free = (box, side, want, count = SLOTS_PER_END) =>
    slotsOf(box, side)
      .filter((v) => !taken.has(slotKey(box, side, v)))
      .sort((p, q) => Math.abs(p - want) - Math.abs(q - want) || p - q)
      .slice(0, count);

  function candidates(a, b) {
    const out = [];
    const [ax, ay] = centre(a);
    const [bx, by] = centre(b);
    const add = (points, ends, bends, extra = 0) => out.push({ points, ends, bends, extra });
    const facingX = bx >= ax ? ['right', 'left'] : ['left', 'right'];
    const facingY = by >= ay ? ['bottom', 'top'] : ['top', 'bottom'];
    // Straight: one coordinate free on both facing sides.
    const yLo = Math.max(a.y, b.y);
    const yHi = Math.min(a.y + a.h, b.y + b.h);
    if (a.x + a.w < b.x || b.x + b.w < a.x) {
      const [sa, sb] = facingX;
      for (const y of free(a, sa, (yLo + yHi) / 2, Infinity).filter((v) => v > yLo && v < yHi && !taken.has(slotKey(b, sb, v))).slice(0, SLOTS_PER_END)) {
        add([sidePoint(a, sa, y), sidePoint(b, sb, y)], [[a, sa, y], [b, sb, y]], 0);
      }
    }
    const xLo = Math.max(a.x, b.x);
    const xHi = Math.min(a.x + a.w, b.x + b.w);
    if (a.y + a.h < b.y || b.y + b.h < a.y) {
      const [sa, sb] = facingY;
      for (const x of free(a, sa, (xLo + xHi) / 2, Infinity).filter((v) => v > xLo && v < xHi && !taken.has(slotKey(b, sb, v))).slice(0, SLOTS_PER_END)) {
        add([sidePoint(a, sa, x), sidePoint(b, sb, x)], [[a, sa, x], [b, sb, x]], 0);
      }
    }
    // One bend: side of `h` facing `v`, top or bottom of `v` facing `h`.
    for (const [h, v, reverse] of [
      [a, b, false],
      [b, a, true],
    ]) {
      const [hx, hy] = centre(h);
      const [vx, vy] = centre(v);
      const sh = vx >= hx ? 'right' : 'left';
      const sv = hy <= vy ? 'top' : 'bottom';
      for (const y of free(h, sh, hy)) {
        for (const x of free(v, sv, hx)) {
          const pts = [sidePoint(h, sh, y), [x, y], sidePoint(v, sv, x)];
          const ends = [[h, sh, y], [v, sv, x]];
          add(reverse ? pts.reverse() : pts, reverse ? ends.reverse() : ends, 1);
        }
      }
    }
    // Two bends through a channel. U: both bottoms (or tops); C: both right
    // (or left) sides; Z: facing sides through the gap between the boxes.
    for (const side of ['bottom', 'top', 'right', 'left']) {
      const horizontal = horizontalSide(side);
      const sign = side === 'bottom' || side === 'right' ? 1 : -1;
      const edge = (box) => (side === 'bottom' ? box.y + box.h : side === 'top' ? box.y : side === 'right' ? box.x + box.w : box.x);
      const start = sign > 0 ? Math.max(edge(a), edge(b)) : Math.min(edge(a), edge(b));
      for (const ea of free(a, side, horizontal ? by : bx, 2)) {
        for (const eb of free(b, side, horizontal ? ay : ax, 2)) {
          for (let k = 3; k < 3 + CHANNELS; k++) {
            const c = roundToGrid(start) + sign * k * GRID;
            const pts = horizontal
              ? [sidePoint(a, side, ea), [c, ea], [c, eb], sidePoint(b, side, eb)]
              : [sidePoint(a, side, ea), [ea, c], [eb, c], sidePoint(b, side, eb)];
            add(pts, [[a, side, ea], [b, side, eb]], 2);
          }
        }
      }
    }
    for (const [[sa, sb], horizontal] of [
      [facingX, true],
      [facingY, false],
    ]) {
      const [lo, hi] = horizontal ? [Math.min(a.x + a.w, b.x + b.w), Math.max(a.x, b.x)] : [Math.min(a.y + a.h, b.y + b.h), Math.max(a.y, b.y)];
      if (hi - lo < 2 * MARGIN + 2 * GRID) continue;
      const mid = roundToGrid((lo + hi) / 2);
      const channels = [];
      for (let d = 0; mid - d > lo + MARGIN || mid + d < hi - MARGIN; d += GRID) channels.push(...(d === 0 ? [mid] : [mid - d, mid + d]).filter((c) => c > lo + MARGIN && c < hi - MARGIN));
      for (const ea of free(a, sa, horizontal ? ay : ax, 2)) {
        for (const eb of free(b, sb, horizontal ? by : bx, 2)) {
          for (const c of channels.slice(0, CHANNELS)) {
            const pts = horizontal
              ? [sidePoint(a, sa, ea), [c, ea], [c, eb], sidePoint(b, sb, eb)]
              : [sidePoint(a, sa, ea), [ea, c], [eb, c], sidePoint(b, sb, eb)];
            add(pts, [[a, sa, ea], [b, sb, eb]], ea === eb ? 0 : 2);
          }
        }
      }
    }
    // Diagonal, border to border along the centre line.
    const dx = bx - ax;
    const dy = by - ay;
    const exit = (box, sign) => {
      const t = Math.min(dx === 0 ? Infinity : box.w / 2 / Math.abs(dx), dy === 0 ? Infinity : box.h / 2 / Math.abs(dy));
      const [cx, cy] = centre(box);
      return [Math.round((cx + sign * dx * t) * 100) / 100, Math.round((cy + sign * dy * t) * 100) / 100];
    };
    if (dx !== 0 && dy !== 0) add([exit(a, 1), exit(b, -1)], [], 0, DIAGONAL_COST);
    return out;
  }

  // Heaviest lines first: they get the shortest routes; then shorter ones.
  const distance = (l) => {
    const [p, q] = [centre(byId.get(l.from.node)), centre(byId.get(l.to.node))];
    return Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]);
  };
  const order = [...links].sort((x, y) => (y.count ?? 1) - (x.count ?? 1) || distance(x) - distance(y) || compareStrings(x.id, y.id));
  const result = new Map();
  const fallback = [];
  for (const link of order) {
    const [a, b] = [byId.get(link.from.node), byId.get(link.to.node)];
    let best = null;
    for (const c of candidates(a, b)) {
      const segs = segmentsOf(c.points);
      if (segs.some((s) => placed.some((t) => alongside(s, t)))) continue;
      let cost = lengthOf(c.points) + c.bends * BEND_COST + c.extra;
      if (best && cost >= best.cost) continue;
      for (const s of segs) for (const t of placed) if (crosses(s, t)) cost += CROSS_COST;
      for (const s of segs) for (const r of badges) if (segmentCrosses(s[0], s[1], r)) cost += BADGE_COST;
      if (best && cost >= best.cost) continue;
      if (!clear(c.points, a, b, nodes, labels)) continue;
      best = { ...c, cost };
    }
    if (!best) {
      fallback.push(link);
      continue;
    }
    for (const [box, side, v] of best.ends) taken.add(slotKey(box, side, v));
    placed.push(...segmentsOf(best.points));
    const middle = pointAt(best.points, 0.5);
    badges.push(badgeAround(middle));
    result.set(link.id, { id: link.id, points: best.points });
  }
  if (fallback.length > 0) {
    // Leave and enter on the sides facing each other, at a free slot.
    const edges = fallback.map((link) => {
      const [a, b] = [byId.get(link.from.node), byId.get(link.to.node)];
      const toRight = centre(b)[0] >= centre(a)[0];
      const end = (box, side) => {
        const [y = box.y + roundToGrid(box.h / 2)] = free(box, side, centre(box)[1], 1);
        taken.add(slotKey(box, side, y));
        return { box, y, marker: 'none', side: side === 'left' ? -1 : 1 };
      };
      return { id: link.id, from: end(a, toRight ? 'right' : 'left'), to: end(b, toRight ? 'left' : 'right') };
    });
    routeEdges([...nodes, ...labels], frames, edges).forEach((r) => result.set(r.id, { id: r.id, points: r.points }));
  }
  // Count badges: at the middle of their line when that spot is free, else
  // the spot nearest to it along the line that is clear of other badges,
  // boxes and lines (or, when none is, covers the fewest).
  const spots = [];
  const lines = [...result.values()];
  for (const link of order) {
    const line = result.get(link.id);
    const others = lines.filter((x) => x !== line).flatMap((x) => segmentsOf(x.points));
    // Covering a badge or a box is worse than sitting on another line.
    const clash = (r) =>
      100 * (spots.filter((q) => overlaps(r, q)).length + nodes.filter((n) => overlaps(r, n)).length + labels.filter((l) => overlaps(r, l)).length) +
      others.filter(([p, q]) => segmentCrosses(p, q, r)).length;
    const scored = BADGE_SPOTS.map((t) => pointAt(line.points, t)).map((p) => ({ p, clash: clash(badgeAround(p)) }));
    const at = scored.reduce((best, x) => (x.clash < best.clash ? x : best)).p;
    spots.push(badgeAround(at));
    line.middle = at;
  }
  return links.map((l) => result.get(l.id));
}
