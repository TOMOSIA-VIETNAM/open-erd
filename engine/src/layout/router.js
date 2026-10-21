import { compareStrings } from '../model/load.js';
import { GRID } from './table-box.js';

// Orthogonal router: A* over the layout grid with state (cell, direction).
// Lines may only use grid points outside every obstacle inflated by a margin, so
// no segment can pass through a box. Costs favour few bends, then avoid
// crossing or running on top of lines routed earlier.

// Obstacles block grid points within this distance, so lines keep at least
// MARGIN + GRID px away from boxes they do not attach to.
export const MARGIN = 20;
// Straight segment from a box side to the first routable point. Crow's foot
// markers are drawn inside it, so other lines never cut through a marker.
export const STUB = MARGIN + GRID;
// A self-reference leaves and re-enters the same side. With the plain stub its
// vertical run would sit right at the tips of its own markers; two grid steps
// more keep the loop readable.
export const SELF_STUB = STUB + 2 * GRID;
const CANVAS_MARGIN = 6 * GRID;

const STEP = 1;
const BEND = 6;
const CROSS = 8;
const OVERLAP = 40;
// Running right next to a box is legal but reads as "attached"; a small cost
// moves lines one track further out when there is room.
const NEAR_BOX = 0.4;
const ALONG_FRAME = 1;
// Two relation ends with different markers on one attachment point would draw
// overlapping, unreadable markers; they take the box's other side when free.
const MIXED_MARKERS = 200;
// Another relation's attachment point: passing through it would look like a
// junction.
const FOREIGN_PORT = 40;

const DX = [1, -1, 0, 0];
const DY = [0, 0, 1, -1];
const OPPOSITE = [1, 0, 3, 2];
const HORIZONTAL = (d) => d < 2;

class MinHeap {
  constructor() {
    this.items = [];
    this.seq = 0;
  }
  get size() {
    return this.items.length;
  }
  // Ties on cost are broken by insertion order, which is itself deterministic.
  less(a, b) {
    return a.f < b.f || (a.f === b.f && a.seq < b.seq);
  }
  push(f, state) {
    const items = this.items;
    items.push({ f, state, seq: this.seq++ });
    let i = items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(items[i], items[p])) break;
      [items[i], items[p]] = [items[p], items[i]];
      i = p;
    }
  }
  pop() {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && this.less(items[l], items[m])) m = l;
        if (r < items.length && this.less(items[r], items[m])) m = r;
        if (m === i) break;
        [items[i], items[m]] = [items[m], items[i]];
        i = m;
      }
    }
    return top;
  }
}

function makeGrid(obstacles, frames) {
  const x0 = Math.floor((Math.min(...obstacles.map((o) => o.x)) - CANVAS_MARGIN) / GRID) * GRID;
  const y0 = Math.floor((Math.min(...obstacles.map((o) => o.y)) - CANVAS_MARGIN) / GRID) * GRID;
  const x1 = Math.ceil((Math.max(...obstacles.map((o) => o.x + o.w)) + CANVAS_MARGIN) / GRID) * GRID;
  const y1 = Math.ceil((Math.max(...obstacles.map((o) => o.y + o.h)) + CANVAS_MARGIN) / GRID) * GRID;
  const cols = (x1 - x0) / GRID + 1;
  const rows = (y1 - y0) / GRID + 1;
  const blocked = new Uint8Array(cols * rows);
  const near = new Uint8Array(cols * rows);
  const mark = (arr, o, margin) => {
    const c0 = Math.max(0, Math.ceil((o.x - margin - x0) / GRID));
    const c1 = Math.min(cols - 1, Math.floor((o.x + o.w + margin - x0) / GRID));
    const r0 = Math.max(0, Math.ceil((o.y - margin - y0) / GRID));
    const r1 = Math.min(rows - 1, Math.floor((o.y + o.h + margin - y0) / GRID));
    for (let r = r0; r <= r1; r++) arr.fill(1, r * cols + c0, r * cols + c1 + 1);
  };
  for (const o of obstacles) {
    mark(blocked, o, MARGIN);
    mark(near, o, MARGIN + GRID);
  }
  // Tracks running alongside a frame border, a few px off it, read as part of
  // the border. Moving along such a track costs extra; crossing it is free.
  const alongH = new Uint8Array(cols * rows);
  const alongV = new Uint8Array(cols * rows);
  for (const f of frames) {
    const track = (v, origin) => [Math.floor((v - origin) / GRID), Math.ceil((v - origin) / GRID)];
    const [c0, c1] = [Math.max(0, Math.floor((f.x - x0) / GRID)), Math.min(cols - 1, Math.ceil((f.x + f.w - x0) / GRID))];
    const [r0, r1] = [Math.max(0, Math.floor((f.y - y0) / GRID)), Math.min(rows - 1, Math.ceil((f.y + f.h - y0) / GRID))];
    for (const border of [f.y, f.y + f.h]) {
      for (const r of track(border, y0)) if (r >= 0 && r < rows) alongH.fill(1, r * cols + c0, r * cols + c1 + 1);
    }
    for (const border of [f.x, f.x + f.w]) {
      for (const c of track(border, x0)) {
        if (c < 0 || c >= cols) continue;
        for (let r = r0; r <= r1; r++) alongV[r * cols + c] = 1;
      }
    }
  }
  return {
    cols,
    rows,
    blocked,
    near,
    alongH,
    alongV,
    occH: new Uint16Array(cols * rows),
    occV: new Uint16Array(cols * rows),
    foreignPorts: new Uint16Array(cols * rows),
    portMarkers: new Map(),
    cell: (x, y) => ((y - y0) / GRID) * cols + (x - x0) / GRID,
    point: (cell) => [x0 + (cell % cols) * GRID, y0 + Math.floor(cell / cols) * GRID],
  };
}

// Candidate attachments of one relation end: the column's row on the left and
// right side of its box. A side whose first routable point is blocked (another
// box too close) is skipped.
function ports(grid, end, stubs) {
  const result = [];
  for (const side of [-1, 1]) {
    const edgeX = side < 0 ? end.box.x : end.box.x + end.box.w;
    const stub = stubs.find((s) => !grid.blocked[grid.cell(edgeX + side * s, end.y)]);
    if (stub === undefined) continue;
    result.push({ side, edgeX, cell: grid.cell(edgeX + side * stub, end.y), outward: side > 0 ? 0 : 1, marker: end.marker });
  }
  if (result.length === 0) throw new Error(`router: no free side on ${end.box.id} at y=${end.y}`);
  return result;
}

// Markers already attached at each port cell, as marker -> count.
function portPenalty(grid, port) {
  const used = grid.portMarkers.get(port.cell);
  if (!used) return 0;
  return [...used].some(([marker, count]) => count > 0 && marker !== port.marker) ? MIXED_MARKERS : 0;
}

function search(grid, starts, goals, ownCells) {
  const { cols, rows } = grid;
  const n = cols * rows * 4;
  const g = new Float64Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const heap = new MinHeap();
  const goalXY = goals.map((goal) => grid.point(goal.cell));
  const h = (cell) => {
    const [x, y] = grid.point(cell);
    let best = Infinity;
    for (const [gx, gy] of goalXY) best = Math.min(best, (Math.abs(gx - x) + Math.abs(gy - y)) / GRID);
    return best * STEP;
  };
  for (const s of starts) {
    const state = s.cell * 4 + s.outward;
    g[state] = portPenalty(grid, s);
    heap.push(g[state] + h(s.cell), state);
  }
  let best = { cost: Infinity };
  while (heap.size > 0) {
    const { f, state } = heap.pop();
    if (f >= best.cost) break;
    const cell = state >> 2;
    const dir = state & 3;
    const cost = g[state];
    if (f > cost + h(cell) + 1e-9) continue;
    const cx = cell % cols;
    const cy = Math.floor(cell / cols);
    for (let d = 0; d < 4; d++) {
      if (d === OPPOSITE[dir]) continue;
      const nx = cx + DX[d];
      const ny = cy + DY[d];
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const next = ny * cols + nx;
      if (grid.blocked[next]) continue;
      let step = STEP + (d !== dir ? BEND : 0);
      if (HORIZONTAL(d)) {
        if (grid.occH[next]) step += OVERLAP;
        if (grid.occV[next]) step += CROSS;
        if (grid.alongH[next]) step += ALONG_FRAME;
      } else {
        if (grid.occV[next]) step += OVERLAP;
        if (grid.occH[next]) step += CROSS;
        if (grid.alongV[next]) step += ALONG_FRAME;
      }
      if (grid.near[next]) step += NEAR_BOX;
      if (grid.foreignPorts[next] && !ownCells.has(next)) step += FOREIGN_PORT;
      const ns = next * 4 + d;
      const ng = cost + step;
      if (ng >= g[ns]) continue;
      g[ns] = ng;
      came[ns] = state;
      for (const goal of goals) {
        // Arriving while moving away from the box would need a U-turn.
        if (goal.cell !== next || d === goal.outward) continue;
        const total = ng + (d === OPPOSITE[goal.outward] ? 0 : BEND) + portPenalty(grid, goal);
        if (total < best.cost) best = { cost: total, state: ns, goal };
      }
      heap.push(ng + h(next), ns);
    }
  }
  if (!best.goal) return null;
  const cells = [];
  for (let s = best.state; s !== -1; s = came[s]) cells.push(s >> 2);
  cells.reverse();
  const start = starts.find((s) => s.cell === cells[0]);
  return { cells, start, goal: best.goal };
}

function occupy(grid, { cells, start, goal }, delta) {
  for (const port of [start, goal]) {
    if (!grid.portMarkers.has(port.cell)) grid.portMarkers.set(port.cell, new Map());
    const used = grid.portMarkers.get(port.cell);
    used.set(port.marker, (used.get(port.marker) ?? 0) + delta);
  }
  for (let i = 1; i < cells.length; i++) {
    const [a, b] = [cells[i - 1], cells[i]];
    const occ = Math.abs(a - b) === 1 ? grid.occH : grid.occV;
    occ[a] += delta;
    occ[b] += delta;
  }
}

function simplify(points) {
  const out = [];
  for (const p of points) {
    if (out.length > 0 && out[out.length - 1][0] === p[0] && out[out.length - 1][1] === p[1]) continue;
    if (out.length >= 2) {
      const [a, b] = [out[out.length - 2], out[out.length - 1]];
      if ((a[0] === b[0] && b[0] === p[0]) || (a[1] === b[1] && b[1] === p[1])) out.pop();
    }
    out.push(p);
  }
  return out;
}

const centre = (b) => [b.x + b.w / 2, b.y + b.h / 2];

// Ends attached to the same column row but drawing different markers must not
// share an attachment point. Before routing, the marker used by most of those
// ends gets the side most of their far ends lie on, the next marker gets the
// other side. Deciding up front keeps every line short; leaving it to path
// costs sent whole bundles around the box. A third marker on one row, or a
// blocked side, falls back to the MIXED_MARKERS cost.
function splitMixedPorts(prepared) {
  const groups = new Map();
  for (const p of prepared) {
    for (const [role, end, other] of [
      ['starts', p.edge.from, p.edge.to],
      ['goals', p.edge.to, p.edge.from],
    ]) {
      const key = `${end.box.id}\u0000${end.y}`;
      if (!groups.has(key)) groups.set(key, []);
      const vote = Math.sign(centre(other.box)[0] - centre(end.box)[0]);
      groups.get(key).push({ p, role, marker: end.marker, vote });
    }
  }
  for (const ends of groups.values()) {
    const byMarker = new Map();
    for (const e of ends) {
      if (!byMarker.has(e.marker)) byMarker.set(e.marker, []);
      byMarker.get(e.marker).push(e);
    }
    if (byMarker.size < 2) continue;
    const [first, second] = [...byMarker].sort(([ma, a], [mb, b]) => b.length - a.length || compareStrings(ma, mb));
    const side = first[1].reduce((sum, e) => sum + e.vote, 0) >= 0 ? 1 : -1;
    for (const [list, wanted] of [
      [first[1], side],
      [second[1], -side],
    ]) {
      for (const { p, role } of list) {
        const kept = p[role].filter((port) => port.side === wanted);
        if (kept.length > 0) p[role] = kept;
      }
    }
  }
}

/**
 * Routes every edge around the obstacles.
 * obstacles: [{ id, x, y, w, h }] - table boxes and labels, on the grid or not.
 * frames: [{ x, y, w, h }] - cluster frames; lines cross them but avoid running
 *   along their borders.
 * edges: [{ id, from: { box, y, marker }, to: { box, y, marker } }] - `y` is the
 *   absolute row centre where the line attaches; boxes must be on the grid;
 *   `marker` names the end symbol so differing symbols do not share a point.
 * Returns [{ id, points, fromSide, toSide }] in input order; points start and
 * end on the box sides, sides are -1 (left) / 1 (right).
 */
export function routeEdges(obstacles, frames, edges) {
  if (edges.length === 0) return [];
  const grid = makeGrid(obstacles, frames);
  const prepared = edges.map((e) => {
    // A longer stub is tried first for self-references, the plain one when
    // the box next to it leaves no room.
    const stubs = e.from.box.id === e.to.box.id ? [SELF_STUB, STUB] : [STUB];
    return { edge: e, starts: ports(grid, e.from, stubs), goals: ports(grid, e.to, stubs) };
  });
  splitMixedPorts(prepared);
  for (const p of prepared) {
    p.own = new Set([...p.starts, ...p.goals].map((port) => port.cell));
    for (const c of p.own) grid.foreignPorts[c] += 1;
  }

  // Short relations first: they have the fewest alternatives, so they get the
  // straight tracks and long ones detour around them.
  const length = ({ edge }) => {
    const [a, b] = [centre(edge.from.box), centre(edge.to.box)];
    return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
  };
  const order = [...prepared].sort((a, b) => length(a) - length(b) || compareStrings(a.edge.id, b.edge.id));

  const routes = new Map();
  const route = (p) => {
    const found = search(grid, p.starts, p.goals, p.own);
    if (!found) throw new Error(`router: no path for relation ${p.edge.id}`);
    occupy(grid, found, 1);
    routes.set(p, found);
  };
  for (const p of order) route(p);
  // One rip-up pass: each line is re-routed knowing every other line, which
  // removes most crossings caused by routing order.
  for (const p of order) {
    occupy(grid, routes.get(p), -1);
    route(p);
  }

  return prepared.map((p) => {
    const { cells, start, goal } = routes.get(p);
    const points = [[start.edgeX, p.edge.from.y], ...cells.map((c) => grid.point(c)), [goal.edgeX, p.edge.to.y]];
    return { id: p.edge.id, points: simplify(points), fromSide: start.side, toSide: goal.side };
  });
}
