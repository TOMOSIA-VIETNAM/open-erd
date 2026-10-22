// The worker-free build: the package entry point spawns a worker thread, which
// neither the esbuild bundle nor a deterministic run needs.
import ELK from 'elkjs/lib/elk.bundled.js';
import { compareStrings } from '../model/load.js';
import { TABLE_GAP } from './clusters.js';
import { roundToGrid } from './table-box.js';

// Domains are arranged with ELK's rectangle packing (the overview's domain
// boxes on a grid instead, see gridPlace): it fills rows towards a
// 16:9 page instead of growing one long row the way a layered layout does.
// Packing ignores edges, so relation structure enters through the input order
// (see affinityOrder): ELK keeps that order row by row, which puts strongly
// linked domains next to each other.
//
// Every option that influences positions is spelled out so an ELK default
// change cannot silently move tables; elkjs is pinned to an exact version in
// package.json for the same reason. Spacing is the minimum gap plus one grid
// step so rounding to the grid never brings boxes closer than the stability
// pass allows.
function packingOptions(spacing, aspectRatio) {
  return {
    'elk.algorithm': 'rectpacking',
    'elk.randomSeed': '1',
    'elk.aspectRatio': String(aspectRatio),
    'elk.spacing.nodeNode': String(spacing),
    'elk.padding': '[top=0,left=0,bottom=0,right=0]',
    'elk.contentAlignment': 'V_TOP H_LEFT',
    'elk.rectpacking.orderBySize': 'false',
    'elk.rectpacking.widthApproximation.strategy': 'GREEDY',
    'elk.rectpacking.widthApproximation.optimizationGoal': 'ASPECT_RATIO_DRIVEN',
    'elk.rectpacking.widthApproximation.lastPlaceShift': 'true',
    'elk.rectpacking.packing.strategy': 'COMPACTION',
    'elk.rectpacking.packing.compaction.rowHeightReevaluation': 'false',
    'elk.rectpacking.packing.compaction.iterations': '1',
    // Boxes must keep their measured size; whitespace elimination would
    // stretch them to fill rows.
    'elk.rectpacking.whiteSpaceElimination.strategy': 'NONE',
    'elk.rectpacking.trybox': 'false',
  };
}

// Inside a domain relations matter more than shape: a layered layout puts
// referenced tables left of the tables that reference them, so lines run
// mostly one way with few crossings.
function layeredOptions(spacing) {
  return {
    'elk.algorithm': 'layered',
    'elk.direction': 'RIGHT',
    'elk.randomSeed': '1',
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.spacing.nodeNode': String(spacing),
    'elk.spacing.componentComponent': String(spacing),
    'elk.spacing.edgeNode': '30',
    'elk.spacing.edgeEdge': '20',
    'elk.layered.spacing.nodeNodeBetweenLayers': String(spacing + 40),
    'elk.layered.spacing.edgeNodeBetweenLayers': '30',
    'elk.layered.spacing.edgeEdgeBetweenLayers': '20',
    'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    'elk.layered.cycleBreaking.strategy': 'GREEDY',
    'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',
    'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.layered.thoroughness': '7',
    'elk.separateConnectedComponents': 'true',
    'elk.aspectRatio': String(TABLE_ASPECT),
    'elk.padding': '[top=0,left=0,bottom=0,right=0]',
  };
}

// Target shape of one domain.
const TABLE_ASPECT = 1.3;

const elk = new ELK();

/**
 * Order in which boxes are handed to the packer: breadth-first from the most
 * connected box, visiting the strongest-linked neighbours first, so boxes
 * that share relations end up adjacent in the packed rows. Ties go to the
 * smaller id; unconnected boxes follow in id order.
 * `weights`: Map "a\u0000b" (a < b) -> number of relations between a and b.
 */
export function affinityOrder(ids, weights) {
  const neighbours = new Map(ids.map((id) => [id, new Map()]));
  for (const [pair, w] of weights) {
    const [a, b] = pair.split('\u0000');
    neighbours.get(a).set(b, w);
    neighbours.get(b).set(a, w);
  }
  const degree = (id) => [...neighbours.get(id).values()].reduce((s, w) => s + w, 0);
  const byStrength = (a, b) => b.w - a.w || compareStrings(a.id, b.id);
  const remaining = [...ids].sort((a, b) => degree(b) - degree(a) || compareStrings(a, b));
  const order = [];
  const seen = new Set();
  for (const root of remaining) {
    if (seen.has(root)) continue;
    seen.add(root);
    const queue = [root];
    while (queue.length > 0) {
      const id = queue.shift();
      order.push(id);
      const next = [...neighbours.get(id)].map(([n, w]) => ({ id: n, w })).filter((n) => !seen.has(n.id)).sort(byStrength);
      for (const n of next) {
        seen.add(n.id);
        queue.push(n.id);
      }
    }
  }
  return order;
}

const pairKey = (a, b) => (compareStrings(a, b) < 0 ? `${a}\u0000${b}` : `${b}\u0000${a}`);

// `pairs`: [a, b, weight?]; a pair without a weight counts once.
function pairWeights(pairs) {
  const weights = new Map();
  for (const [a, b, w = 1] of pairs) {
    if (a === b) continue;
    weights.set(pairKey(a, b), (weights.get(pairKey(a, b)) ?? 0) + w);
  }
  return weights;
}

// ELK packs in rows only, so one tall box next to several short ones leaves
// a hole under the short ones. Packing the transposed boxes yields columns;
// whichever arrangement needs less area wins (rows on ties).
async function pack(boxes, pairs, spacing, aspectRatio) {
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const order = affinityOrder(boxes.map((b) => b.id), pairWeights(pairs));
  const run = async (transposed) => {
    const graph = {
      id: 'root',
      layoutOptions: packingOptions(spacing, transposed ? 1 / aspectRatio : aspectRatio),
      children: order.map((id) => {
        const { w, h } = byId.get(id);
        return { id, width: transposed ? h : w, height: transposed ? w : h };
      }),
    };
    const result = await elk.layout(graph);
    const positions = new Map(
      result.children.map((c) => [c.id, transposed ? { x: roundToGrid(c.y), y: roundToGrid(c.x) } : { x: roundToGrid(c.x), y: roundToGrid(c.y) }]),
    );
    const right = Math.max(...boxes.map((b) => positions.get(b.id).x + b.w));
    const bottom = Math.max(...boxes.map((b) => positions.get(b.id).y + b.h));
    return { positions, area: right * bottom };
  };
  const rows = await run(false);
  const columns = await run(true);
  return (columns.area < rows.area ? columns : rows).positions;
}

/**
 * Places the boxes of one cluster from scratch.
 * `boxes`: [{ id, w, h }]; `links`: [{ from, to }] box ids, from referencing to.
 * Returns Map id -> { x, y } on the grid.
 */
export async function layoutTables(boxes, links) {
  const ids = new Set(boxes.map((b) => b.id));
  const edges = links
    .filter((l) => l.from !== l.to && ids.has(l.from) && ids.has(l.to))
    .map((l) => [l.to, l.from])
    .sort(([a, b], [c, d]) => compareStrings(a, c) || compareStrings(b, d));
  const graph = {
    id: 'root',
    layoutOptions: layeredOptions(TABLE_GAP + 20),
    children: boxes.map((b) => ({ id: b.id, width: b.w, height: b.h })),
    edges: edges.map(([source, target], i) => ({ id: `e${i}`, sources: [source], targets: [target] })),
  };
  const result = await elk.layout(graph);
  return new Map(result.children.map((c) => [c.id, { x: roundToGrid(c.x), y: roundToGrid(c.y) }]));
}

/**
 * Packs group frames from scratch. `frames`: [{ id, w, h }]; `links`:
 * [{ from, to }] frame ids, which decide the packing order (see affinityOrder).
 */
export function layoutGroups(frames, links, gap, aspectRatio) {
  return pack(frames, links.map((l) => [l.from, l.to, l.weight]), gap + 20, aspectRatio);
}

// Grid distance between two cells as a line between them reads: next to
// each other in a row or column is a straight line (1), diagonal neighbours
// a line with one bend (2); further apart in one row or column a box sits in
// between and the line must go round it, which costs one step more.
function cellDistance(p, q) {
  const [dr, dc] = [Math.abs(p.r - q.r), Math.abs(p.c - q.c)];
  return dr + dc + ((dr === 0 || dc === 0) && dr + dc > 1 ? 1 : 0);
}

/**
 * Places boxes from scratch on a grid of rows and columns, so that boxes
 * sharing many relations are neighbours (a short straight line, or one bend)
 * and lines rarely cross. Used for the domains of one database on the
 * overview, whose boxes are all the same height.
 *
 * Deterministic greedy placement on relation counts, then local swaps:
 *   1. the number of columns gives the frame the shape closest to `aspect`;
 *   2. the most connected box takes the middle cell; then, one at a time,
 *      the box most linked to the placed ones (ties: most links overall,
 *      then id) takes the free cell nearest, by relation count times grid
 *      distance, to the boxes it is linked with (ties: nearer the middle,
 *      then reading order); boxes without links fill the remaining cells
 *      last, in id order;
 *   3. any swap of two cells (or a move to a free one) that lowers the
 *      total of relation count times distance is made, in a fixed order,
 *      until none is left.
 * Columns are as wide as their widest box, boxes centred in them; empty
 * rows and columns take no space. `pairs`: [{ from, to, weight? }].
 * Returns Map id -> { x, y } on the grid.
 */
export function gridPlace(boxes, pairs, gap, aspect) {
  const spacing = gap + 20;
  const n = boxes.length;
  const weights = pairWeights(pairs.map((p) => [p.from, p.to, p.weight]));
  const weight = (a, b) => (a === b ? 0 : (weights.get(pairKey(a, b)) ?? 0));
  const ids = boxes.map((b) => b.id).sort(compareStrings);
  const degree = new Map(ids.map((id) => [id, ids.reduce((s, o) => s + weight(id, o), 0)]));
  const cellW = boxes.reduce((s, b) => s + b.w, 0) / n + spacing;
  const cellH = Math.max(...boxes.map((b) => b.h)) + spacing;
  let cols = 1;
  for (let c = 2; c <= n; c++) {
    const off = (k) => Math.abs(Math.log((k * cellW) / (Math.ceil(n / k) * cellH) / aspect));
    if (off(c) < off(cols) - 1e-9) cols = c;
  }
  const rows = Math.ceil(n / cols);
  const cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push({ r, c });
  const middle = { r: (rows - 1) / 2, c: (cols - 1) / 2 };
  const fromMiddle = (p) => Math.abs(p.r - middle.r) + Math.abs(p.c - middle.c);

  const at = new Map();
  const taken = new Map();
  const cost = (id, cell) => [...at].reduce((s, [o, p]) => s + weight(id, o) * cellDistance(cell, p), 0);
  const linked = ids.filter((id) => degree.get(id) > 0);
  const unplaced = new Set(linked);
  while (unplaced.size > 0) {
    const towards = (id) => [...at.keys()].reduce((s, o) => s + weight(id, o), 0);
    const [id] = [...unplaced].sort((a, b) => towards(b) - towards(a) || degree.get(b) - degree.get(a) || compareStrings(a, b));
    const free = cells.filter((p) => !taken.has(`${p.r},${p.c}`));
    const [cell] = free.sort((p, q) => cost(id, p) - cost(id, q) || fromMiddle(p) - fromMiddle(q) || p.r - q.r || p.c - q.c);
    at.set(id, cell);
    taken.set(`${cell.r},${cell.c}`, id);
    unplaced.delete(id);
  }
  for (const id of ids.filter((x) => degree.get(x) === 0)) {
    const cell = cells.find((p) => !taken.has(`${p.r},${p.c}`));
    at.set(id, cell);
    taken.set(`${cell.r},${cell.c}`, id);
  }

  // Total cost changes when `id` moves to `cell` and whatever is there moves
  // to `id`'s old cell.
  const swapGain = (id, cell) => {
    const other = taken.get(`${cell.r},${cell.c}`);
    const home = at.get(id);
    const around = (x, from, to) => ids.reduce((s, o) => (o === x || o === other || o === id ? s : s + weight(x, o) * (cellDistance(to, at.get(o)) - cellDistance(from, at.get(o)))), 0);
    return around(id, home, cell) + (other ? around(other, cell, home) : 0);
  };
  for (let improved = true, rounds = 0; improved && rounds < 50; rounds++) {
    improved = false;
    for (const id of linked) {
      for (const cell of cells) {
        if (swapGain(id, cell) >= -1e-9) continue;
        const home = at.get(id);
        const other = taken.get(`${cell.r},${cell.c}`);
        taken.delete(`${home.r},${home.c}`);
        if (other) {
          at.set(other, home);
          taken.set(`${home.r},${home.c}`, other);
        }
        at.set(id, cell);
        taken.set(`${cell.r},${cell.c}`, id);
        improved = true;
      }
    }
  }

  const byId = new Map(boxes.map((b) => [b.id, b]));
  const usedRows = [...new Set([...at.values()].map((p) => p.r))].sort((a, b) => a - b);
  const usedCols = [...new Set([...at.values()].map((p) => p.c))].sort((a, b) => a - b);
  const colWidth = new Map(usedCols.map((c) => [c, Math.max(...ids.filter((id) => at.get(id).c === c).map((id) => byId.get(id).w))]));
  const colX = new Map();
  let x = 0;
  for (const c of usedCols) {
    colX.set(c, x);
    x += colWidth.get(c) + spacing;
  }
  const rowY = new Map(usedRows.map((r, i) => [r, i * cellH]));
  return new Map(
    boxes.map((b) => {
      const p = at.get(b.id);
      return [b.id, { x: colX.get(p.c) + roundToGrid((colWidth.get(p.c) - b.w) / 2), y: rowY.get(p.r) }];
    }),
  );
}
