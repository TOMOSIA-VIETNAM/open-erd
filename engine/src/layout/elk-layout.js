// The worker-free build: the package entry point spawns a worker thread, which
// neither the esbuild bundle nor a deterministic run needs.
import ELK from 'elkjs/lib/elk.bundled.js';
import { compareStrings } from '../model/load.js';
import { TABLE_GAP } from './clusters.js';
import { roundToGrid } from './table-box.js';

// Domains are arranged with ELK's rectangle packing (the overview's domain
// cards on a plain grid instead, see cardGrid in index.js): it fills rows towards a
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
function affinityOrder(ids, weights) {
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
 * Edges for the layered layout, [source, target]: from the referenced box to
 * the referencing one, so referenced tables sit left of those pointing at
 * them. A central table (most connected, see centrality.js) would then end
 * up at the left edge of its domain with everything fanning out to the
 * right; instead its neighbours are dealt to both sides, every other one
 * (in id order) with its edge reversed, so ELK puts the central table in a
 * middle layer with related tables around it.
 */
export function layeredEdges(ids, links, central = new Set()) {
  const edges = links.filter((l) => l.from !== l.to && ids.has(l.from) && ids.has(l.to)).map((l) => [l.to, l.from]);
  for (const c of [...central].filter((id) => ids.has(id)).sort(compareStrings)) {
    const around = [...new Set(edges.filter(([a, b]) => a === c || b === c).map(([a, b]) => (a === c ? b : a)))].sort(compareStrings);
    const left = new Set(around.filter((_, i) => i % 2 === 1));
    for (const e of edges) {
      const other = e[0] === c ? e[1] : e[1] === c ? e[0] : null;
      if (other === null || central.has(other)) continue;
      // Left neighbours point at the central table, right ones away from it.
      if (left.has(other)) [e[0], e[1]] = [other, c];
      else [e[0], e[1]] = [c, other];
    }
  }
  return edges.sort(([a, b], [c, d]) => compareStrings(a, c) || compareStrings(b, d));
}

/**
 * Places the boxes of one cluster from scratch.
 * `boxes`: [{ id, w, h }]; `links`: [{ from, to }] box ids, from referencing
 * to; `central`: ids of central tables, placed in the middle (see
 * layeredEdges). Returns Map id -> { x, y } on the grid.
 */
export async function layoutTables(boxes, links, central = new Set()) {
  const ids = new Set(boxes.map((b) => b.id));
  const edges = layeredEdges(ids, links, central);
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
