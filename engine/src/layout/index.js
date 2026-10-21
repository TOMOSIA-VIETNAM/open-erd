import { compareStrings } from '../model/load.js';
import { PALETTE } from '../palette.js';
import { boundingBox, padFrame } from './clusters.js';
import { buildDiagram } from './diagram.js';
import { layoutGroups, layoutTables } from './elk-layout.js';
import { LAYOUT_FILE, LAYOUT_SCHEMA_VERSION } from './layout-file.js';
import { carryRenames } from './renames.js';
import { insertNextTo, settle } from './stability.js';
import { attachOffset, ceilToGrid } from './table-box.js';
import { leavesOf, viewNames, viewTree } from './views.js';

const sameSize = (a, b) => a.w === b.w && a.h === b.h;

// The children of `group` sharing the most lines with `id` (all of them when
// it has none), in id order.
function mostLinked(id, placedIds, pairs) {
  const links = new Map(placedIds.map((k) => [k, 0]));
  for (const { from: a, to: b } of pairs) {
    if (a === id && b !== id && links.has(b)) links.set(b, links.get(b) + 1);
    if (b === id && a !== id && links.has(a)) links.set(a, links.get(a) + 1);
  }
  const most = Math.max(...links.values());
  return placedIds.filter((k) => links.get(k) === most).sort(compareStrings);
}

// Adds boxes one by one (id order), each next to the placed box it is most
// linked with. Every step is a stability-preserving remap, so the result keeps
// the order of everything placed before.
function insertAll(boxes, newIds, sizes, pairs, gap, aspect) {
  let current = boxes;
  for (const id of [...newIds].sort(compareStrings)) {
    const anchors = mostLinked(id, [...current.keys()], pairs);
    const positions = insertNextTo(current, id, sizes.get(id), anchors, gap, aspect);
    const next = new Map();
    for (const [k, p] of positions) {
      const { w, h } = k === id ? sizes.get(id) : current.get(k);
      next.set(k, { x: p.x, y: p.y, w, h });
    }
    current = next;
  }
  return current;
}

// Domain view from scratch: the domain keeps its own arrangement and each
// stub goes beside it, on the side and at the height of the domain node it is
// most linked with, so every stub line is short and mostly straight. Stubs on
// one side keep that order top to bottom.
function placeAround(children, links, group, boxes) {
  const [core, ...stubs] = children;
  const frame = { ...core.origin, w: core.extent.w, h: core.extent.h };
  const positions = new Map([[core.id, core.origin]]);
  const sides = new Map([[-1, []], [1, []]]);
  for (const stub of stubs) {
    const counts = new Map();
    for (const l of links) {
      const [mine, other] = l.from.node === stub.id ? [l.from, l.to] : l.to.node === stub.id ? [l.to, l.from] : [];
      if (!mine || !core.leaves.has(other.node)) continue;
      // JSON keeps a null column (a view's line to its source) apart from a
      // column named "null".
      const key = JSON.stringify([other.node, other.column]);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const [anchor] = [...counts].sort(([a, x], [b, y]) => y - x || compareStrings(a, b));
    const [node, column] = JSON.parse(anchor[0]);
    const leaf = core.leaves.get(node);
    const side = leaf.x + leaf.w / 2 < frame.x + frame.w / 2 ? -1 : 1;
    sides.get(side).push({ stub, want: leaf.y + attachOffset(boxes.get(node), column) - stub.h / 2 });
  }
  for (const [side, list] of sides) {
    list.sort((a, b) => a.want - b.want || compareStrings(a.stub.id, b.stub.id));
    let bottom = -Infinity;
    for (const { stub, want } of list) {
      const y = Math.max(want, bottom + group.gap);
      bottom = y + stub.h;
      positions.set(stub.id, { x: side < 0 ? frame.x - group.gap - stub.w : frame.x + frame.w + group.gap, y });
    }
  }
  return positions;
}

const FRESH = {
  layered: (children, pairs) => layoutTables(children, pairs),
  pack: (children, pairs, group) => layoutGroups(children, pairs, group.gap, group.aspect),
  around: (children, pairs, group, links, boxes) => placeAround(children, links, group, boxes),
};

/**
 * Places one node of a view tree. With an old layout, existing leaves move
 * only by the stability rules: children of a group keep their relative order
 * (settle), new children go next to the child they share most lines with
 * (insertNextTo), and a group whose content did not change keeps its
 * arrangement and is at most translated by its parent.
 *
 * Returns, in this node's own coordinate space:
 *   leaves   Map leaf id -> { x, y, w, h, slot }
 *   kept     whether any leaf existed before
 *   ref      old frame (old geometry, for ordering against siblings)
 *   origin   corner the extent is measured from (old corner when kept)
 *   extent   { w, h } of the new frame measured from origin
 */
async function arrange(node, old, links, boxes) {
  if (!node.children) {
    const prev = old[node.slot]?.[node.id];
    const size = { w: node.box.w, h: node.box.h };
    const origin = prev ? { x: prev.x, y: prev.y } : { x: 0, y: 0 };
    return {
      id: node.id,
      kept: Boolean(prev),
      unchanged: Boolean(prev) && sameSize(prev, size),
      ref: prev ? { x: prev.x, y: prev.y, w: prev.w, h: prev.h } : null,
      origin,
      extent: size,
      leaves: new Map([[node.id, { ...origin, ...size, slot: node.slot }]]),
    };
  }
  const results = [];
  for (const child of node.children) results.push(await arrange(child, old, links, boxes));
  const kept = results.filter((r) => r.kept);
  const fresh = results.filter((r) => !r.kept);
  const owner = new Map();
  for (const r of results) for (const id of r.leaves.keys()) owner.set(id, r.id);
  const pairs = links
    .filter((l) => owner.has(l.from.node) && owner.has(l.to.node))
    .map((l) => ({ from: owner.get(l.from.node), to: owner.get(l.to.node) }));

  let positions;
  if (kept.length === 0) {
    const children = results.map((r) => ({ id: r.id, w: r.extent.w, h: r.extent.h, origin: r.origin, extent: r.extent, leaves: r.leaves }));
    positions = await FRESH[node.strategy](children, pairs, node, links, boxes);
  } else if (fresh.length === 0 && kept.every((r) => r.unchanged)) {
    positions = new Map(results.map((r) => [r.id, r.origin]));
  } else {
    const items = kept.map((r) => ({ id: r.id, key: { x: [r.ref.x, 0], y: [r.ref.y, 0] }, ref: r.ref, w: r.extent.w, h: r.extent.h }));
    const settled = settle(items, node.gap);
    const placed = new Map(kept.map((r) => [r.id, { ...settled.get(r.id), ...r.extent }]));
    const sizes = new Map(results.map((r) => [r.id, r.extent]));
    positions = insertAll(placed, fresh.map((r) => r.id), sizes, pairs, node.gap, node.aspect);
  }

  // Children move by whole grid steps so every leaf stays on the grid. Frames
  // sit off the grid by their padding; rounding the move up never brings two
  // children closer than half a grid step below their gap.
  const leaves = new Map();
  const frames = [];
  for (const r of results) {
    const p = positions.get(r.id);
    const t = { x: ceilToGrid(p.x - r.origin.x), y: ceilToGrid(p.y - r.origin.y) };
    for (const [id, b] of r.leaves) leaves.set(id, { ...b, x: b.x + t.x, y: b.y + t.y });
    frames.push({ x: r.origin.x + t.x, y: r.origin.y + t.y, ...r.extent });
  }
  const around = (b) => (node.pad ? padFrame(b, node.pad) : b);
  const frame = around(boundingBox(frames));
  const ref = kept.length > 0 ? around(boundingBox(kept.map((r) => r.ref))) : null;
  const origin = ref ? { x: Math.min(ref.x, frame.x), y: Math.min(ref.y, frame.y) } : { x: frame.x, y: frame.y };
  return {
    id: node.id,
    kept: kept.length > 0,
    unchanged: fresh.length === 0 && kept.every((r) => r.unchanged),
    ref,
    origin,
    extent: { w: frame.x + frame.w - origin.x, h: frame.y + frame.h - origin.y },
    leaves,
  };
}

// New clusters, in name order, take the lowest palette index nobody holds;
// once every index is held they take the least used one (lowest on ties).
function assignColors(previous, keys) {
  const colors = { ...previous };
  for (const key of keys) {
    if (colors[key] !== undefined) continue;
    const uses = PALETTE.map(() => 0);
    for (const index of Object.values(colors)) uses[index % PALETTE.length] += 1;
    colors[key] = uses.indexOf(Math.min(...uses));
  }
  return colors;
}

/**
 * Computes layout.json for `model`: every view (overview, all, one per
 * domain) is placed by the same rules from its own previous positions, so
 * each view stays stable on its own. Views of domains that no longer exist
 * are dropped. Renamed tables keep their positions (see carryRenames).
 * Returns { layout, report } with one report per view.
 */
export async function computeLayout(model, previousLayout) {
  const diagram = buildDiagram(model);
  const { layout: previous, renamed } = carryRenames(model, diagram, previousLayout);
  const views = {};
  const report = {};
  for (const name of viewNames(diagram).sort(compareStrings)) {
    const { root, links } = viewTree(model, diagram, name);
    const old = previous?.views?.[name]?.clusters ?? {};
    const boxes = new Map(leavesOf(root).map((l) => [l.id, l.box]));
    const { leaves } = await arrange(root, old, links, boxes);
    const clusters = {};
    for (const [id, { slot, x, y, w, h }] of leaves) {
      clusters[slot] ??= {};
      clusters[slot][id] = { x, y, w, h };
    }
    views[name] = { clusters };
    const placed = new Set(Object.values(clusters).flatMap((members) => Object.keys(members)));
    report[name] = { ...diffLayouts(old, clusters), renamed: renamed.filter(([, now]) => placed.has(now)) };
  }
  const layout = {
    schema_version: LAYOUT_SCHEMA_VERSION,
    colors: assignColors(previous?.colors ?? {}, [...diagram.clusters.keys()]),
    views,
  };
  return { layout, report };
}

function flatten(clusters) {
  const nodes = new Map();
  for (const [key, members] of Object.entries(clusters)) {
    for (const [id, n] of Object.entries(members)) nodes.set(id, { ...n, cluster: key });
  }
  return nodes;
}

/**
 * What `layout` changed in one view, for the report printed to the user. A
 * group whose nodes all moved by the same vector is reported once as a
 * translation.
 */
export function diffLayouts(before, after) {
  const old = flatten(before);
  const now = flatten(after);
  const added = [...now.keys()].filter((id) => !old.has(id) || old.get(id).cluster !== now.get(id).cluster);
  const removed = [...old.keys()].filter((id) => !now.has(id) || old.get(id).cluster !== now.get(id).cluster);
  const translated = [];
  const moved = [];
  for (const key of Object.keys(after).sort(compareStrings)) {
    const ids = Object.keys(after[key])
      .filter((id) => old.get(id)?.cluster === key)
      .sort(compareStrings);
    const deltas = ids.map((id) => ({ id, dx: now.get(id).x - old.get(id).x, dy: now.get(id).y - old.get(id).y }));
    const shifted = deltas.filter((d) => d.dx !== 0 || d.dy !== 0);
    if (shifted.length === 0) continue;
    const whole =
      ids.length === Object.keys(after[key]).length &&
      ids.length === Object.keys(before[key]).length &&
      deltas.every((d) => d.dx === deltas[0].dx && d.dy === deltas[0].dy);
    if (whole) translated.push({ cluster: key, dx: deltas[0].dx, dy: deltas[0].dy });
    else moved.push(...shifted);
  }
  return {
    added: added.sort(compareStrings),
    removed: removed.sort(compareStrings),
    translated,
    moved,
  };
}

/** Report of every view: a header line per view, then its changes and totals. */
export function formatReport(report) {
  const vec = ({ dx, dy }) => `(${dx >= 0 ? '+' : ''}${dx}, ${dy >= 0 ? '+' : ''}${dy})`;
  const lines = [];
  for (const view of Object.keys(report).sort(compareStrings)) {
    const r = report[view];
    lines.push(
      `view ${view}`,
      ...r.added.map((id) => `  added      ${id}`),
      ...r.removed.map((id) => `  removed    ${id}`),
      ...(r.renamed ?? []).map(([from, to]) => `  renamed    ${from} -> ${to}`),
      ...r.translated.map((t) => `  translated group ${t.cluster} by ${vec(t)}`),
      ...r.moved.map((m) => `  moved      ${m.id} by ${vec(m)}`),
      `${r.added.length} added, ${r.removed.length} removed, ` +
        `${r.translated.length} group(s) translated, ${r.moved.length} node(s) moved inside their group` +
        (r.renamed?.length > 0 ? `, ${r.renamed.length} renamed` : ''),
    );
  }
  return lines.join('\n');
}

function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Positions of view `name` for rendering. Throws when layout.json is missing
 * a node, holds it in another group, or recorded a different box size (the
 * model changed after the last `layout` run).
 *
 * `fitStored` is for a model filtered by a sharing profile: layout.json was
 * computed (and checked, see checkLayout) for the full model, and filtering
 * only removes content, so a box may be smaller than recorded. It is drawn
 * at its stored corner with its own size, and nothing is re-laid out: the
 * shared diagram keeps the positions readers know, with gaps where hidden
 * tables were.
 *
 * Returns { name, nodes: [{ id, kind, box, node?, x, y, w, h, slot }],
 *   groups: [{ kind: 'db'|'cluster', group, frame }] (outer before inner),
 *   links }.
 */
export function resolveView(model, layout, name, diagram = buildDiagram(model), { fitStored = false } = {}) {
  const { root, links } = viewTree(model, diagram, name);
  const stored = layout.views?.[name]?.clusters ?? {};
  const problems = [];
  const nodes = [];
  for (const leaf of leavesOf(root)) {
    const pos = stored[leaf.slot]?.[leaf.id];
    if (!pos) problems.push(`no position for ${leaf.id} in group "${leaf.slot}"`);
    else if (fitStored ? leaf.box.w > pos.w || leaf.box.h > pos.h : !sameSize(pos, leaf.box)) {
      problems.push(`${leaf.id} is ${leaf.box.w}x${leaf.box.h} but was laid out as ${pos.w}x${pos.h}`);
    } else nodes.push({ ...leaf, x: pos.x, y: pos.y, w: leaf.box.w, h: leaf.box.h });
  }
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (overlaps(nodes[i], nodes[j])) problems.push(`${nodes[i].id} overlaps ${nodes[j].id}`);
    }
  }
  for (const key of diagram.clusters.keys()) {
    if (layout.colors?.[key] === undefined) problems.push(`no color for cluster "${key}"`);
  }
  if (problems.length > 0) {
    throw new Error(`${LAYOUT_FILE} is out of date for view "${name}" (run layout):\n  ${problems.join('\n  ')}`);
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const groups = [];
  const frameOf = (node) => {
    if (!node.children) return byId.get(node.id);
    const entry = node.kind === 'page' ? null : { kind: node.kind, group: node };
    if (entry) groups.push(entry);
    const inner = boundingBox(node.children.map(frameOf));
    const frame = node.pad ? padFrame(inner, node.pad) : inner;
    if (entry) entry.frame = frame;
    return frame;
  };
  frameOf(root);
  return { name, nodes, groups, links };
}

/** Throws unless layout.json holds every view of `model` exactly as `layout` last wrote it. */
export function checkLayout(model, layout) {
  const diagram = buildDiagram(model);
  for (const name of viewNames(diagram)) resolveView(model, layout, name, diagram);
}
