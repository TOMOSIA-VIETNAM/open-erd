import { compareStrings } from '../model/load.js';
import { PALETTE } from '../palette.js';
import { boundingBox, padFrame } from './clusters.js';
import { buildDiagram } from './diagram.js';
import { layoutGroups, layoutTables } from './elk-layout.js';
import { LAYOUT_FILE, LAYOUT_SCHEMA_VERSION } from './layout-file.js';
import { carryRenames } from './renames.js';
import { insertNextTo, settle } from './stability.js';
import { attachOffset, ceilToGrid } from './table-box.js';
import { OVERVIEW, STUB_SLOT, leavesOf, viewNames, viewTree } from './views.js';

const sameSize = (a, b) => a.w === b.w && a.h === b.h;

// Boxes taken from different sources (a hand-edited layout.json, or the diff
// merging two snapshots) may overlap; such a group must go through settle.
const anyOverlap = (boxes) => boxes.some((a, i) => boxes.slice(i + 1).some((b) => overlaps(a, b)));

// The children of `group` sharing the most relations with `id` (all of them
// when it has none), in id order. An overview line counts its relations.
function mostLinked(id, placedIds, pairs) {
  const links = new Map(placedIds.map((k) => [k, 0]));
  for (const { from: a, to: b, weight } of pairs) {
    if (a === id && b !== id && links.has(b)) links.set(b, links.get(b) + weight);
    if (b === id && a !== id && links.has(a)) links.set(a, links.get(a) + weight);
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
// one side keep that order top to bottom. A side holds stubs up to the
// height of the domain (SIDE_STRETCH times, at least SIDE_MIN px); the
// rest go in rows above or below the domain, on the half of their anchor,
// left to right in anchor order, so many stubs keep the view compact.
const SIDE_STRETCH = 1.2;
const SIDE_MIN = 400;
const ROWS_ASPECT = 16 / 9;
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
    sides.get(side).push({ stub, want: leaf.y + attachOffset(boxes.get(node), column) - stub.h / 2, wantX: leaf.x + leaf.w / 2, upper: leaf.y + leaf.h / 2 < frame.y + frame.h / 2 });
  }
  const room = Math.max(SIDE_MIN, frame.h * SIDE_STRETCH);
  const rows = new Map([[-1, []], [1, []]]);
  let top = frame.y;
  let bottom = frame.y + frame.h;
  for (const [side, list] of sides) {
    list.sort((a, b) => a.want - b.want || compareStrings(a.stub.id, b.stub.id));
    // Keep the stubs nearest the middle of the domain on the side.
    const middle = frame.y + frame.h / 2;
    const byDistance = [...list].sort((a, b) => Math.abs(a.want + a.stub.h / 2 - middle) - Math.abs(b.want + b.stub.h / 2 - middle) || compareStrings(a.stub.id, b.stub.id));
    const kept = new Set();
    let used = 0;
    for (const item of byDistance) {
      if (used > 0 && used + item.stub.h > room) {
        rows.get(item.upper ? -1 : 1).push(item);
        continue;
      }
      kept.add(item);
      used += item.stub.h + group.gap;
    }
    const x = (stub) => (side < 0 ? frame.x - group.gap - stub.w : frame.x + frame.w + group.gap);
    for (const block of stackAround(list.filter((i) => kept.has(i)), group.gap)) {
      let y = block.top;
      top = Math.min(top, block.top);
      for (const { stub } of block.items) {
        positions.set(stub.id, { x: x(stub), y });
        y += stub.h + group.gap;
      }
      bottom = Math.max(bottom, y - group.gap);
    }
  }
  // Rows above and below: at least as wide as the domain and its side
  // stubs, wider when that keeps the whole view near ROWS_ASPECT, wrapped.
  const left = Math.min(frame.x, ...[...positions.values()].map((p) => p.x));
  const right = Math.max(frame.x + frame.w, ...stubs.filter((s) => positions.has(s.id)).map((s) => positions.get(s.id).x + s.w));
  const area = [...rows.values()].flat().reduce((n, i) => n + (i.stub.w + group.gap) * (i.stub.h + group.gap), (right - left) * (bottom - top));
  const width = Math.max(right - left, SIDE_MIN, Math.sqrt(area * ROWS_ASPECT));
  for (const [dir, list] of rows) {
    list.sort((a, b) => a.wantX - b.wantX || compareStrings(a.stub.id, b.stub.id));
    const lines = [];
    let line = [];
    let lineWidth = 0;
    for (const item of list) {
      if (line.length > 0 && lineWidth + item.stub.w > width) {
        lines.push(line);
        line = [];
        lineWidth = 0;
      }
      line.push(item);
      lineWidth += item.stub.w + group.gap;
    }
    if (line.length > 0) lines.push(line);
    // Lines nearest the domain first.
    let edge = dir < 0 ? top : bottom;
    for (const items of lines) {
      const height = Math.max(...items.map((i) => i.stub.h));
      const y = dir < 0 ? edge - group.gap - height : edge + group.gap;
      const total = items.reduce((n, i) => n + i.stub.w, 0) + group.gap * (items.length - 1);
      let x = Math.round(left + (right - left - total) / 2);
      for (const { stub } of items) {
        positions.set(stub.id, { x, y: dir < 0 ? y + height - stub.h : y });
        x += stub.w + group.gap;
      }
      edge = dir < 0 ? y : y + height;
    }
  }
  return positions;
}

// Stacks boxes in the given order, `gap` apart, each as close to its wanted
// top `want` as the others allow: a run of boxes that would overlap is
// centred on their wanted tops (least squares), so a crowd of stubs linked
// to one row spreads above and below it instead of hanging below it.
// Returns runs as [{ top, items }], top to bottom.
function stackAround(list, gap) {
  const blocks = [];
  for (const item of list) {
    let block = { items: [item], height: item.stub.h, sum: item.want };
    for (;;) {
      block.top = Math.round(block.sum / block.items.length);
      const prev = blocks.at(-1);
      if (!prev || prev.top + prev.height + gap <= block.top) break;
      blocks.pop();
      // Each item of the later run now sits below the earlier run, so its
      // wanted top counts minus that offset.
      const shift = prev.height + gap;
      block = { items: [...prev.items, ...block.items], height: shift + block.height, sum: prev.sum + block.sum - shift * block.items.length };
    }
    blocks.push(block);
  }
  return blocks;
}

// Overview cards from scratch: equal boxes in reading order (the order of
// the group's children), as many per row as brings the grid closest to the
// group's aspect.
function cardGrid(children, group) {
  const { w, h } = children[0];
  const n = children.length;
  const off = (cols) => Math.abs(Math.log((cols * (w + group.gap)) / (Math.ceil(n / cols) * (h + group.gap)) / group.aspect));
  let cols = 1;
  for (let c = 2; c <= n; c++) if (off(c) < off(cols) - 1e-9) cols = c;
  return new Map(children.map((c, i) => [c.id, { x: (i % cols) * (w + group.gap), y: Math.floor(i / cols) * (h + group.gap) }]));
}

const FRESH = {
  layered: (children, pairs, group) => layoutTables(children, pairs, new Set(group.children.filter((c) => c.node?.central).map((c) => c.id))),
  pack: (children, pairs, group) => layoutGroups(children, pairs, group.gap, group.aspect),
  cards: (children, pairs, group) => cardGrid(children, group),
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
    .map((l) => ({ from: owner.get(l.from.node), to: owner.get(l.to.node), weight: l.count ?? 1 }));

  const unchanged = kept.length > 0 && fresh.length === 0 && kept.every((r) => r.unchanged) && !anyOverlap(kept.map((r) => r.ref));
  let positions;
  if (kept.length === 0) {
    const children = results.map((r) => ({ id: r.id, w: r.extent.w, h: r.extent.h, origin: r.origin, extent: r.extent, leaves: r.leaves }));
    positions = await FRESH[node.strategy](children, pairs, node, links, boxes);
  } else if (unchanged) {
    positions = new Map(results.map((r) => [r.id, r.origin]));
  } else {
    // Boxes stored at the very same corner would share both keys and could
    // never be pulled apart; later ones (child order) rank after the first
    // on y, so settle stacks them.
    const corners = new Map();
    const items = kept.map((r) => {
      const corner = `${r.ref.x},${r.ref.y}`;
      const rank = corners.get(corner) ?? 0;
      corners.set(corner, rank + 1);
      return { id: r.id, key: { x: [r.ref.x, 0], y: [r.ref.y, rank] }, ref: r.ref, w: r.extent.w, h: r.extent.h };
    });
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
    unchanged,
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

// Value of `relayout` that lays out every view from scratch.
export const EVERY_VIEW = '*';

/**
 * Central tables of `clusters` (layout.json groups of one view) that sit
 * outside the middle third of their group, horizontally or vertically: a
 * fresh layout puts them in the middle, kept positions may not.
 */
function offCentre(clusters, diagram) {
  const off = [];
  for (const [key, members] of Object.entries(clusters)) {
    if (key === STUB_SLOT) continue;
    const boxes = Object.values(members);
    if (boxes.length < 3) continue;
    const frame = boundingBox(boxes);
    for (const [id, b] of Object.entries(members)) {
      if (!diagram.nodes.get(id)?.central) continue;
      const [cx, cy] = [b.x + b.w / 2 - frame.x, b.y + b.h / 2 - frame.y];
      const middle = (v, size) => v >= size / 3 && v <= (2 * size) / 3;
      if (!middle(cx, frame.w) || (frame.h > 2 * b.h && !middle(cy, frame.h))) off.push(`${id} in ${key}`);
    }
  }
  return off.sort(compareStrings);
}

/**
 * Computes layout.json for `model`: every view (overview, all, one per
 * domain) is placed by the same rules from its own previous positions, so
 * each view stays stable on its own. Views of domains that no longer exist
 * are dropped. Renamed tables keep their positions (see carryRenames).
 * `relayout` lists views placed from scratch, ignoring their previous
 * positions (EVERY_VIEW for all of them); colours are kept either way.
 * Returns { layout, report, offCentre } with one report per view;
 * `offCentre` names the views whose kept positions leave a central table
 * away from the middle of its domain, with those tables.
 */
export async function computeLayout(model, previousLayout, { relayout = [] } = {}) {
  const diagram = buildDiagram(model);
  const { layout: previous, renamed } = carryRenames(model, diagram, previousLayout);
  const names = viewNames(diagram);
  const unknown = relayout.filter((v) => v !== EVERY_VIEW && !names.includes(v));
  if (unknown.length > 0) throw new Error(`--relayout: unknown view ${unknown.map((v) => JSON.stringify(v)).join(', ')} (views: ${names.join(', ')}, or ${EVERY_VIEW} for every view)`);
  const fresh = (name) => relayout.includes(EVERY_VIEW) || relayout.includes(name);
  const views = {};
  const report = {};
  const offCentreViews = {};
  for (const name of [...names].sort(compareStrings)) {
    const { root, links } = viewTree(model, diagram, name);
    const old = fresh(name) ? {} : (previous?.views?.[name]?.clusters ?? {});
    const boxes = new Map(leavesOf(root).map((l) => [l.id, l.box]));
    const { leaves } = await arrange(root, old, links, boxes);
    const clusters = {};
    for (const [id, { slot, x, y, w, h }] of leaves) {
      clusters[slot] ??= {};
      clusters[slot][id] = { x, y, w, h };
    }
    views[name] = { clusters };
    if (Object.keys(old).length > 0 && name !== OVERVIEW) {
      // Worth a hint only where a fresh layout would actually centre them.
      let off = offCentre(clusters, diagram);
      if (off.length > 0) {
        const { leaves: freshLeaves } = await arrange(root, {}, links, boxes);
        const freshClusters = {};
        for (const [id, { slot, ...b }] of freshLeaves) (freshClusters[slot] ??= {})[id] = b;
        const stillOff = new Set(offCentre(freshClusters, diagram));
        off = off.filter((entry) => !stillOff.has(entry));
      }
      if (off.length > 0) offCentreViews[name] = off;
    }
    const placed = new Set(Object.values(clusters).flatMap((members) => Object.keys(members)));
    report[name] = { ...diffLayouts(old, clusters), renamed: renamed.filter(([, now]) => placed.has(now)) };
  }
  const layout = {
    schema_version: LAYOUT_SCHEMA_VERSION,
    colors: assignColors(previous?.colors ?? {}, [...diagram.clusters.keys()]),
    views,
  };
  return { layout, report, offCentre: offCentreViews };
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
