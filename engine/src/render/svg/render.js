import { DB_FACT_FONT, DB_LABEL_FONT, ENGINE_FONT, LABEL_FONT, LABEL_OFFSET, clusterLabel, dbLabel, labelBox } from '../../layout/clusters.js';
import { VIEW_SOURCE, buildDiagram, polyLinkId, relationId } from '../../layout/diagram.js';
import { resolveView } from '../../layout/index.js';
import { STUB, routeEdges } from '../../layout/router.js';
import { GRID, BADGE_ARROW_WIDTH, BADGE_FONT, DOMAIN_COUNT_FONT, DOMAIN_TITLE_FONT, EMBED_INSET, FACT_FONT, HEADER_HEIGHT, PADDING_X, ROW_HEIGHT, TAG_FONT, attachOffset } from '../../layout/table-box.js';
import { ALL_VIEW, OVERVIEW, viewNames } from '../../layout/views.js';
import { columnEntries, technicalColumns } from '../../model/columns.js';
import { compareStrings } from '../../model/load.js';
import { measureText } from '../../text/measure.js';
import { FONT_FAMILY, TEXT_STYLE_CSS, fontFaceCss } from '../../text/font.js';
import { PALETTE } from '../../palette.js';
import { endMarkers, markerSvg } from './markers.js';
import viewerBundle from './viewer-bundle.json' with { type: 'json' };

const CANVAS_MARGIN = 40;
const CORNER = 6;
const EDGE_LABEL_FONT = { size: 10, weight: 700 };
const EDGE_LABEL_PAD = { x: 4, y: 3 };

// Rules the embedded viewer script relies on. Without script none of these
// classes is ever set, so the static drawing is unaffected.
const VIEWER_STYLE = `.row-hit { fill: transparent; }
.column:hover .row-hit { fill: #eef3fb; }
.column.hl-column .row-hit { fill: #fff1b8; }
.domain, .stub, .table, .poly, .relation-group, .hub-badge { cursor: pointer; }
.relation-hit { fill: none; stroke: transparent; stroke-width: 12; }
.view.dimmed :is(.table, .stub, .poly, .domain, .relation-group):not(.hl) { opacity: 0.16; }
.view.dimmed.center-selected :is(.table, .poly).hop-2:not(.hl) { opacity: 1; }
.view.dimmed.center-selected .hop-2:not(.hl) > rect:last-of-type { stroke: #d9dee6; }
.view.dimmed.center-selected .relation-group.hop-2:not(.hl) { opacity: 0.5; }
.hl > rect:last-of-type { stroke: #5b8def; stroke-width: 2; }
.selected > rect:last-of-type { stroke: #1d4ed8; stroke-width: 3; }
.flow-target > rect:last-of-type { stroke: #e8590c; stroke-width: 3; animation: oe-pulse 0.9s ease-in-out infinite alternate; }
.relation-group.hl .relation, .relation-group.hl .marker { stroke: #2563eb; stroke-width: 2; }
.relation-group.flowing .relation { stroke-opacity: 0.35; }
.flow { fill: none; stroke: #2563eb; stroke-width: 3; stroke-dasharray: 6 10; pointer-events: none; animation: oe-flow 0.8s linear infinite; }
.poly-route { fill: none; stroke: #a07a2c; stroke-width: 1.8; stroke-dasharray: 2 3; }
@keyframes oe-flow { to { stroke-dashoffset: -16; } }
@keyframes oe-pulse { to { stroke-width: 6; } }
.business .column-type { display: none; }
.business .column.technical { opacity: 0.18; }
.oe-ui { font-family: '${FONT_FAMILY}', sans-serif; font-size: 13px; color: #1f2a3d; box-sizing: border-box; }
.oe-ui * { box-sizing: border-box; }
.oe-toolbar { display: flex; align-items: center; gap: 10px; height: 44px; padding: 0 12px; background: #ffffff; border-bottom: 1px solid #d5dbe4; position: relative; }
.oe-crumbs { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; }
.oe-crumbs .sep { color: #9aa4b5; }
.oe-crumbs .here { font-weight: 700; }
.oe-link { color: #1d4ed8; cursor: pointer; background: none; border: 0; padding: 0; font: inherit; }
.oe-link:hover { text-decoration: underline; }
.oe-btn { font: inherit; padding: 4px 10px; border: 1px solid #c3cad5; border-radius: 6px; background: #ffffff; color: #1f2a3d; cursor: pointer; }
.oe-btn:hover { background: #f1f4f8; }
.oe-btn:disabled { color: #a7b0bf; cursor: default; background: #ffffff; }
.oe-btn.on { background: #1f2a3d; border-color: #1f2a3d; color: #ffffff; }
.oe-seg { display: flex; }
.oe-seg .oe-btn { border-radius: 0; }
.oe-seg .oe-btn:first-child { border-radius: 6px 0 0 6px; }
.oe-seg .oe-btn:last-child { border-radius: 0 6px 6px 0; margin-left: -1px; }
.oe-search { position: relative; }
.oe-search input { font: inherit; width: 220px; padding: 5px 9px; border: 1px solid #c3cad5; border-radius: 6px; }
.oe-results { position: absolute; top: 34px; right: 0; width: 360px; max-height: 360px; overflow: auto; background: #ffffff; border: 1px solid #c3cad5; border-radius: 6px; box-shadow: 0 6px 18px rgba(20, 30, 50, 0.15); }
.oe-result { display: block; width: 100%; text-align: left; padding: 6px 10px; border: 0; background: none; font: inherit; cursor: pointer; }
.oe-result:hover, .oe-result.active { background: #eef3fb; }
.oe-result .where { color: #7a8597; font-size: 11px; }
.oe-panel { background: #ffffff; border: 1px solid #c3cad5; border-radius: 8px; padding: 12px 14px; box-shadow: 0 6px 18px rgba(20, 30, 50, 0.12); overflow: auto; }
.oe-panel h3 { margin: 0 0 4px; font-size: 14px; word-break: break-all; }
.oe-panel .sub { color: #7a8597; font-size: 12px; margin-bottom: 8px; word-break: break-all; }
.oe-panel .row { display: flex; gap: 6px; align-items: center; margin: 8px 0; }
.oe-panel ul { margin: 4px 0 0; padding-left: 16px; }
.oe-panel li { margin: 3px 0; word-break: break-all; }
.oe-panel p { margin: 6px 0; }
.oe-panel .muted { color: #7a8597; }
.oe-tip { background: #1f2a3d; color: #f4f6f9; border-radius: 6px; padding: 8px 10px; font-size: 12px; line-height: 1.45; max-width: 340px; display: inline-block; }
.oe-tip b { color: #ffffff; }
.oe-tip .muted { color: #aab4c4; }
.oe-tip .pii { color: #ffb4a2; font-weight: 700; }`;

// Line colour carries the review state, dash pattern the kind:
//   reviewed grey, pending amber, stale red;
//   inferred dashed until reviewed, cross_db dash-dot-dot, polymorphic dotted.
const STYLE = `${fontFaceCss()}
text { font-family: '${FONT_FAMILY}', sans-serif; ${TEXT_STYLE_CSS} }
.cluster-label { font-size: ${LABEL_FONT.size}px; font-weight: ${LABEL_FONT.weight}; }
.db-frame { fill: #fbfcfd; stroke: #94a0b2; stroke-width: 1.2; }
.db-name { font-size: ${DB_LABEL_FONT.size}px; font-weight: ${DB_LABEL_FONT.weight}; fill: #1f2a3d; }
.db-icon { fill: #e4e9f0; stroke: #5b6880; stroke-width: 1.2; }
.engine-pill { fill: #2f3b4f; }
.engine-name { font-size: ${ENGINE_FONT.size}px; font-weight: ${ENGINE_FONT.weight}; fill: #ffffff; }
.table-box { fill: #ffffff; stroke: #b8c2d0; stroke-width: 1; }
.table-title { font-size: 13px; font-weight: 700; fill: #172033; }
.column-name { font-size: 12px; font-weight: 400; fill: #2a3546; }
.column-name.pk { font-weight: 700; }
.column-type { font-size: 12px; font-weight: 400; fill: #7a8597; }
.badge-text { font-size: ${BADGE_FONT.size}px; font-weight: ${BADGE_FONT.weight}; fill: #56627a; }
.badge-arrow { fill: none; stroke: #56627a; stroke-width: 1.2; }
.poly-box { fill: #fffdf7; stroke: #a08a5c; stroke-width: 1; stroke-dasharray: 4 3; }
.poly-title { font-size: 13px; font-weight: 700; fill: #6b5428; }
.poly-target { font-size: 12px; font-weight: 400; fill: #4a4236; }
.stub-box { fill: #f3f5f8; stroke: #c3cad5; stroke-width: 1; stroke-dasharray: 3 3; }
.stub-title { font-size: 12px; font-weight: 400; fill: #8a94a6; }
.domain-title { font-size: ${DOMAIN_TITLE_FONT.size}px; font-weight: ${DOMAIN_TITLE_FONT.weight}; }
.domain-count { font-size: ${DOMAIN_COUNT_FONT.size}px; font-weight: ${DOMAIN_COUNT_FONT.weight}; fill: #5f6b7e; }
.relation { fill: none; stroke: #6b778a; stroke-width: 1.4; stroke-linejoin: round; }
.marker { fill: none; stroke: #6b778a; stroke-width: 1.4; }
.marker .ring { fill: #ffffff; }
.edge-label rect { fill: #ffffff; }
.edge-label text { font-size: ${EDGE_LABEL_FONT.size}px; font-weight: ${EDGE_LABEL_FONT.weight}; fill: #4f5b6e; }
.review-pending .relation, .review-pending .marker { stroke: #c27c0e; }
.review-pending .edge-label text { fill: #9a6208; }
.review-stale .relation, .review-stale .marker { stroke: #c53030; }
.review-stale .edge-label text { fill: #a61f1f; }
.kind-inferred.review-pending .relation, .kind-inferred.review-stale .relation { stroke-dasharray: 6 4; }
.kind-cross_db .relation { stroke-dasharray: 10 3 2 3 2 3; }
.kind-polymorphic .relation { stroke-dasharray: 2 3; }
.kind-view_source .relation { stroke: #a9b2c0; stroke-dasharray: 5 4; }
.table-tag { font-size: ${TAG_FONT.size}px; font-weight: ${TAG_FONT.weight}; fill: #5f6b7e; letter-spacing: 0.02em; }
.table.is-view > rect:last-of-type { stroke-dasharray: 5 3; }
.tenant-copy { fill: #ffffff; stroke: #c9d1dc; stroke-width: 1; }
.inset-box { fill: #f6f8fb; stroke: #d5dbe4; stroke-width: 1; }
.inset-title { font-size: 12px; font-weight: 700; fill: #56627a; }
.fact-text { font-size: ${FACT_FONT.size}px; font-weight: ${FACT_FONT.weight}; fill: #5f6b7e; }
.db-fact-pill { fill: #eef1f5; stroke: #c3cad5; stroke-width: 1; }
.db-fact { font-size: ${DB_FACT_FONT.size}px; font-weight: ${DB_FACT_FONT.weight}; fill: #3d4a5e; }
${VIEWER_STYLE}`;

function escapeXml(text) {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

const camel = (name) => name.replace(/_(.)/g, (_, c) => c.toUpperCase());

const nodeRect = (n) => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h });

function labelText(view, link) {
  if (link.kind === VIEW_SOURCE) return null;
  if (view === OVERVIEW) return link.kind === 'cross_db' ? `${link.count} · cross-DB` : String(link.count);
  return link.kind === 'cross_db' ? 'cross-DB' : null;
}

// Labels go where they read as part of their own line and cover nothing
// else. Candidates, in order of preference:
//   1. on a horizontal stretch clear of the end markers (the first and last
//      STUB px of the line), longest stretch first, centre first, then
//      sliding outwards one label step at a time;
//   2. the same stretches lifted just above the line, clear of the markers'
//      spread (used when a short line has no free stretch);
//   3. on a vertical segment, middle first.
// The first candidate that overlaps no placed label and no other line wins;
// failing all, the first candidate. Route points keep MARGIN + GRID from
// foreign boxes, more than half a label's height, so a label on its line
// stays clear of them.
const LABEL_LIFT = 8;
const LABEL_STEP = 2 * GRID;

function labelSize(text) {
  return { w: Math.ceil(measureText(text, EDGE_LABEL_FONT)) + 2 * EDGE_LABEL_PAD.x, h: EDGE_LABEL_FONT.size + 2 * EDGE_LABEL_PAD.y };
}

// Centre positions along [lo, hi] for a label of length `len`: middle first,
// then alternately further out.
function slide(lo, hi, len) {
  const mid = (lo + hi) / 2;
  const room = (hi - lo - len) / 2;
  if (room < 0) return [];
  const out = [mid];
  for (let d = LABEL_STEP; d <= room; d += LABEL_STEP) out.push(mid - d, mid + d);
  return out;
}

function labelCandidates(points, { w, h }) {
  const last = points.length - 2;
  const segs = points.slice(1).map((b, i) => ({ a: points[i], b, i }));
  const flat = [];
  const upright = [];
  for (const s of segs) {
    if (s.a[1] === s.b[1]) {
      let [lo, hi] = [Math.min(s.a[0], s.b[0]), Math.max(s.a[0], s.b[0])];
      const [rawLo, rawHi] = [lo, hi];
      for (const [index, p] of [[0, points[0]], [last, points[last + 1]]]) {
        if (s.i !== index) continue;
        if (p[0] === rawLo) lo = rawLo + STUB;
        else hi = rawHi - STUB;
      }
      flat.push({ y: s.a[1], lo, hi, rawLo, rawHi });
    } else {
      upright.push({ x: s.a[0], lo: Math.min(s.a[1], s.b[1]), hi: Math.max(s.a[1], s.b[1]) });
    }
  }
  flat.sort((a, b) => b.hi - b.lo - (a.hi - a.lo));
  upright.sort((a, b) => b.hi - b.lo - (a.hi - a.lo));
  const at = (cx, cy) => ({ x: cx - w / 2, y: cy - h / 2, w, h, cx, cy });
  return [
    ...flat.flatMap((f) => slide(f.lo, f.hi, w + 2 * EDGE_LABEL_PAD.x).map((cx) => at(cx, f.y))),
    ...flat.flatMap((f) => slide(f.rawLo, f.rawHi, w).map((cx) => at(cx, f.y - h / 2 - LABEL_LIFT))),
    ...upright.flatMap((u) => slide(u.lo, u.hi, h).map((cy) => at(u.x, cy))),
  ];
}

const rectsOverlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function segmentHits([[ax, ay], [bx, by]], r) {
  return Math.min(ax, bx) < r.x + r.w && Math.max(ax, bx) > r.x && Math.min(ay, by) < r.y + r.h && Math.max(ay, by) > r.y;
}

function placeLabels(relations, texts) {
  const placed = [];
  return relations.map((r, i) => {
    if (!texts[i]) return null;
    const candidates = labelCandidates(r.points, labelSize(texts[i]));
    const free = (c) =>
      !placed.some((p) => rectsOverlap(c, p)) &&
      !relations.some((o, j) => j !== i && o.points.slice(1).some((p, k) => segmentHits([o.points[k], p], c)));
    // A line too short for any candidate still gets its label, centred on its
    // first segment.
    const [[ax, ay], [bx, by]] = r.points;
    const size = labelSize(texts[i]);
    const middle = { x: (ax + bx - size.w) / 2, y: (ay + by - size.h) / 2, ...size, cx: (ax + bx) / 2, cy: (ay + by) / 2 };
    const choice = candidates.find(free) ?? candidates[0] ?? middle;
    placed.push(choice);
    return { text: texts[i], ...choice };
  });
}

// Overview boxes have no rows, so every line would meet a box at its middle
// and lines arriving from different domains would merge before the box.
// Instead the ends at one box are spread one grid step apart around the
// middle, ordered by the height of the box at the other end so they do not
// cross on arrival.
function spreadEnds(links, byId) {
  const ends = new Map();
  for (const l of links) {
    for (const [side, other] of [['from', 'to'], ['to', 'from']]) {
      const n = l[side].node;
      if (!ends.has(n)) ends.set(n, []);
      const o = byId.get(l[other].node);
      ends.get(n).push({ key: `${l.id}\u0000${side}`, order: o.y + o.h / 2 });
    }
  }
  const offsets = new Map();
  for (const [id, list] of ends) {
    const box = byId.get(id);
    list.sort((a, b) => a.order - b.order || compareStrings(a.key, b.key));
    list.forEach((e, i) => {
      const offset = box.h / 2 + (i - Math.floor((list.length - 1) / 2)) * GRID;
      offsets.set(e.key, Math.min(box.h - GRID, Math.max(GRID, offset)));
    });
  }
  return offsets;
}

// Routes from every polymorphic node to each of its targets drawn in the
// view (as a table or a stub), attached at the target's first primary key
// row: the id column points there. The viewer cannot route, so these are
// computed here and shown on click.
// ponytail: routed in a second pass that does not see the relation lines, so
// a target line may run on top of one; fold them into the main pass if that
// reads badly on real schemas.
function routePolyTargets(nodes, byId, obstacles, groups) {
  const edges = [];
  const ends = [];
  for (const n of nodes.filter((x) => x.kind === 'poly')) {
    for (const target of n.node.association.targets) {
      const t = byId.get(target);
      if (!t) continue;
      const column = t.kind === 'table' ? (t.node.table.columns.find((c) => c.pk) ?? t.node.table.columns[0]).name : null;
      edges.push({
        id: `${n.id}->${target}`,
        from: { box: nodeRect(n), y: n.y + attachOffset(n.box, null), marker: 'none' },
        to: { box: nodeRect(t), y: t.y + attachOffset(t.box, column), marker: 'none' },
      });
      ends.push({ poly: n.id, target });
    }
  }
  return routeEdges(obstacles, groups.map((g) => g.frame), edges).map((r, i) => ({ ...ends[i], points: r.points }));
}

/**
 * Everything one view draws, with absolute coordinates: nodes, group frames,
 * routed lines with their end markers and labels. Kept separate from the SVG
 * text so geometry can be tested directly.
 */
export function buildScene(model, layout, name = ALL_VIEW, diagram = buildDiagram(model), options = {}) {
  const view = resolveView(model, layout, name, diagram, options);
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const labels = view.groups.map((g) =>
    g.kind === 'cluster'
      ? { id: `label:${g.group.key}`, ...labelBox(g.frame, g.group.key) }
      : { id: `label:${g.group.id}`, ...dbLabel(g.frame, g.group.database, g.group.engine, g.group.facts).box },
  );
  const obstacles = [...view.nodes.map(nodeRect), ...labels];
  const spread = name === OVERVIEW ? spreadEnds(view.links, byId) : null;
  const end = (link, side, marker) => {
    const e = link[side];
    const n = byId.get(e.node);
    const offset = spread ? spread.get(`${link.id}\u0000${side}`) : attachOffset(n.box, e.column);
    return { box: nodeRect(n), y: n.y + offset, marker };
  };
  const markers = view.links.map((l) => (name === OVERVIEW || l.kind === VIEW_SOURCE ? { from: 'none', to: 'none' } : endMarkers(l)));
  const edges = view.links.map((l, i) => ({ id: l.id, from: end(l, 'from', markers[i].from), to: end(l, 'to', markers[i].to) }));
  const routes = routeEdges(obstacles, view.groups.map((g) => g.frame), edges);
  const labelsOf = placeLabels(routes, view.links.map((link) => labelText(name, link)));
  const relations = view.links.map((link, i) => ({ link, ...routes[i], markers: markers[i], label: labelsOf[i] }));
  const polyRoutes = routePolyTargets(view.nodes, byId, obstacles, view.groups);

  // Lines may detour outside every frame, so they count towards the canvas.
  const xs = [];
  const ys = [];
  for (const b of [...view.groups.map((g) => g.frame), ...view.nodes]) {
    xs.push(b.x, b.x + b.w);
    ys.push(b.y, b.y + b.h);
  }
  for (const [px, py] of [...relations, ...polyRoutes].flatMap((r) => r.points)) {
    xs.push(px);
    ys.push(py);
  }
  const x0 = Math.min(...xs) - CANVAS_MARGIN;
  const y0 = Math.min(...ys) - CANVAS_MARGIN;
  const x1 = Math.max(...xs) + CANVAS_MARGIN;
  const y1 = Math.max(...ys) + CANVAS_MARGIN;
  return { name, nodes: view.nodes, groups: view.groups, labels, relations, polyRoutes, bounds: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
}

function textEl(cls, x, y, fitted, anchor) {
  const tip = fitted.truncated ? `<title>${escapeXml(fitted.full)}</title>` : '';
  const a = anchor ? ` text-anchor="${anchor}"` : '';
  return `<text class="${cls}" x="${x}" y="${y}" dominant-baseline="central"${a}>${escapeXml(fitted.text)}${tip}</text>`;
}

const json = (value) => escapeXml(JSON.stringify(value));

function headerPath(x, y, w, fill) {
  return (
    `<path d="M${x} ${y + HEADER_HEIGHT}V${y + CORNER}Q${x} ${y} ${x + CORNER} ${y}H${x + w - CORNER}` +
    `Q${x + w} ${y} ${x + w} ${y + CORNER}V${y + HEADER_HEIGHT}Z" fill="${fill}"/>`
  );
}

// Each row is a group so the viewer can show the column's details on hover
// (the transparent rect makes the whole row hoverable) and fade technical
// columns in Business mode. Embedded columns are indented inside their
// entity's inset box.
function tableSvg(n, colors, technical) {
  const { x, y, w, h, box } = n;
  const rows = box.rows.map((r) => {
    const indent = EMBED_INSET * r.depth;
    return [
      `<g class="${technical.has(r.column) ? 'column technical' : 'column'}" data-column="${escapeXml(r.column)}">`,
      `<rect class="row-hit" x="${x + indent}" y="${y + r.centerY - ROW_HEIGHT / 2}" width="${w - 2 * indent}" height="${ROW_HEIGHT}"/>`,
      textEl(r.pk ? 'column-name pk' : 'column-name', x + PADDING_X + indent, y + r.centerY, r.name),
      textEl('column-type', x + w - PADDING_X - indent, y + r.centerY, r.type, 'end'),
      '</g>',
    ].join('');
  });
  const insets = box.insets.map(
    (e) =>
      `<g class="embedded" data-entity="${escapeXml(e.entity)}">` +
      `<rect class="inset-box" x="${x + EMBED_INSET}" y="${y + e.top + 1}" width="${w - 2 * EMBED_INSET}" height="${e.h - 2}" rx="4"/>` +
      `${textEl('inset-title', x + PADDING_X + EMBED_INSET, y + e.title.centerY, e.title)}</g>`,
  );
  const facts = box.facts.map((f) => textEl('fact-text', x + PADDING_X, y + f.centerY, f.text));
  const badges = box.badges.map((b) => {
    const cy = y + b.centerY;
    const ax = x + PADDING_X;
    const arrow = `<path class="badge-arrow" d="M${ax} ${cy}H${ax + BADGE_ARROW_WIDTH}M${ax + BADGE_ARROW_WIDTH - 4} ${cy - 3}L${ax + BADGE_ARROW_WIDTH} ${cy}L${ax + BADGE_ARROW_WIDTH - 4} ${cy + 3}"/>`;
    return (
      `<g class="hub-badge" data-target="${escapeXml(b.target)}" data-columns="${json(b.columns)}">` +
      `<title>${escapeXml(`${b.columns.join(', ')} → ${b.target}`)}</title>${arrow}` +
      `${textEl('badge-text', x + b.labelX, cy, b.label)}</g>`
    );
  });
  const separator = box.separatorY === null ? '' : `<path d="M${x} ${y + box.separatorY}H${x + w}" stroke="#e3e7ed"/>`;
  const tag = box.tag ? textEl('table-tag', x + w - PADDING_X, y + box.tag.centerY, box.tag, 'end') : '';
  // A table copied into every tenant schema is drawn as a small stack of
  // cards. The copies stay inside the router margin, so no line touches them.
  const copies = n.node.tenant
    ? [8, 4].map((d) => `<rect class="tenant-copy" x="${x + d}" y="${y + d}" width="${w}" height="${h}" rx="${CORNER}"/>`).join('')
    : '';
  const kind = n.node.table.kind ?? 'table';
  return [
    `<g class="table${kind === 'table' ? '' : ' is-view'}" data-id="${escapeXml(n.id)}"><title>${escapeXml(n.id)}</title>`,
    copies,
    `<rect class="table-box" x="${x}" y="${y}" width="${w}" height="${h}" rx="${CORNER}"/>`,
    headerPath(x, y, w, colors.header),
    `<path d="M${x} ${y + HEADER_HEIGHT}H${x + w}" stroke="${colors.stroke}"/>`,
    textEl('table-title', x + PADDING_X, y + box.title.centerY, box.title),
    tag,
    ...insets,
    ...rows,
    separator,
    ...facts,
    ...badges,
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${CORNER}" fill="none" stroke="#b8c2d0"/>`,
    '</g>',
  ].join('');
}

// The virtual node carries the full association as data; lines to each
// target are drawn by the embedded viewer script on click, never here.
function polySvg(n) {
  const { x, y, w, h, box } = n;
  const a = n.node.association;
  const data =
    ` data-id="${escapeXml(n.id)}" data-table="${escapeXml(a.table)}" data-name="${escapeXml(a.name)}"` +
    ` data-type-column="${escapeXml(a.type_column)}" data-id-column="${escapeXml(a.id_column)}" data-targets="${json(a.targets)}"`;
  return [
    `<g class="poly"${data}><title>${escapeXml(`${a.table}.${a.type_column} / ${a.id_column} → ${a.targets.join(', ')}`)}</title>`,
    `<rect class="poly-box" x="${x}" y="${y}" width="${w}" height="${h}" rx="${CORNER}"/>`,
    `<path d="M${x} ${y + HEADER_HEIGHT}H${x + w}" stroke="#e2d6bb"/>`,
    textEl('poly-title', x + PADDING_X, y + box.title.centerY, box.title),
    ...box.rows.map((r) => textEl('poly-target', x + PADDING_X, y + r.centerY, r.name)),
    '</g>',
  ].join('');
}

function stubSvg(n) {
  const { x, y, w, h, box } = n;
  return (
    `<g class="stub" data-id="${escapeXml(n.id)}"><title>${escapeXml(n.id)}</title>` +
    `<rect class="stub-box" x="${x}" y="${y}" width="${w}" height="${h}" rx="${CORNER}"/>` +
    `${textEl('stub-title', x + PADDING_X, y + box.title.centerY, box.title)}</g>`
  );
}

function domainSvg(n, colors) {
  const { x, y, w, h, box } = n;
  return (
    `<g class="domain" data-domain="${escapeXml(n.id)}"><title>${escapeXml(n.id)}</title>` +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${colors.header}" stroke="${colors.stroke}"/>` +
    `<text class="domain-title" x="${x + PADDING_X}" y="${y + box.title.centerY}" dominant-baseline="central" fill="${colors.label}">${escapeXml(box.title.text)}</text>` +
    `${textEl('domain-count', x + PADDING_X, y + box.count.centerY, box.count)}</g>`
  );
}

function groupSvg(g, colorOf) {
  const f = g.frame;
  if (g.kind === 'cluster') {
    const colors = colorOf(g.group.key);
    return (
      `<g class="cluster" data-cluster="${escapeXml(g.group.key)}">` +
      `<rect x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" rx="12" fill="${colors.fill}" stroke="${colors.stroke}"/>` +
      `<text class="cluster-label" x="${f.x + LABEL_OFFSET.x}" y="${f.y + LABEL_OFFSET.y}" dominant-baseline="central" fill="${colors.label}">${escapeXml(clusterLabel(g.group.key))}</text>` +
      '</g>'
    );
  }
  const l = dbLabel(f, g.group.database, g.group.engine, g.group.facts);
  const { x, y, w, h } = l.icon;
  const ry = 3;
  const icon =
    `<path class="db-icon" d="M${x} ${y + ry}V${y + h - ry}A${w / 2} ${ry} 0 0 0 ${x + w} ${y + h - ry}V${y + ry}A${w / 2} ${ry} 0 0 0 ${x} ${y + ry}Z"/>` +
    `<path class="db-icon" d="M${x} ${y + ry}A${w / 2} ${ry} 0 0 0 ${x + w} ${y + ry}" fill="none"/>`;
  return (
    `<g class="database" data-database="${escapeXml(g.group.database)}" data-engine="${escapeXml(g.group.engine)}">` +
    (g.group.facts.length > 0 ? `<title>${escapeXml(g.group.facts.join('\n'))}</title>` : '') +
    `<rect class="db-frame" x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" rx="16"/>${icon}` +
    `<text class="db-name" x="${l.name.x}" y="${l.cy}" dominant-baseline="central">${escapeXml(l.name.text)}</text>` +
    `<rect class="engine-pill" x="${l.pill.x}" y="${l.pill.y}" width="${l.pill.w}" height="${l.pill.h}" rx="9"/>` +
    `<text class="engine-name" x="${l.engine.x}" y="${l.cy}" dominant-baseline="central" text-anchor="middle">${escapeXml(l.engine.text)}</text>` +
    l.facts
      .map(
        (p) =>
          `<rect class="db-fact-pill" x="${p.pill.x}" y="${p.pill.y}" width="${p.pill.w}" height="${p.pill.h}" rx="9"/>` +
          `<text class="db-fact" x="${p.x}" y="${l.cy}" dominant-baseline="central" text-anchor="middle">${escapeXml(p.text)}</text>`,
      )
      .join('') +
    '</g>'
  );
}

const pathData = (points) => points.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px} ${py}`).join('');

function relationSvg(r) {
  const { link } = r;
  const d = pathData(r.points);
  const [first, last] = [r.points[0], r.points[r.points.length - 1]];
  const markers =
    r.markers.from === 'none'
      ? ''
      : `<g class="marker">${markerSvg(r.markers.from, first[0], first[1], r.fromSide)}${markerSvg(r.markers.to, last[0], last[1], r.toSide)}</g>`;
  const label = r.label
    ? `<g class="edge-label"><rect x="${r.label.x}" y="${r.label.y}" width="${r.label.w}" height="${r.label.h}" rx="3"/>` +
      `<text x="${r.label.cx}" y="${r.label.cy}" dominant-baseline="central" text-anchor="middle">${escapeXml(r.label.text)}</text></g>`
    : '';
  const via = link.via ? ` data-via="${escapeXml(link.via)}"` : '';
  return (
    `<g class="relation-group kind-${link.kind} review-${link.review}" data-id="${escapeXml(link.id)}"` +
    ` data-from="${escapeXml(link.from.node)}" data-to="${escapeXml(link.to.node)}" data-kind="${link.kind}" data-review="${link.review}"${via}>` +
    `<title>${escapeXml(link.via ? `${link.id} (n-n via ${link.via})` : link.id)}</title>` +
    `<path class="relation" d="${d}"/>${markers}${label}</g>`
  );
}

// Lines from a polymorphic node to each of its targets in the view, hidden
// until the viewer shows them on click.
function polyRoutesSvg(routes) {
  const byPoly = new Map();
  for (const r of routes) {
    if (!byPoly.has(r.poly)) byPoly.set(r.poly, []);
    byPoly.get(r.poly).push(r);
  }
  return [...byPoly]
    .map(
      ([poly, list]) =>
        `<g class="poly-routes" data-poly="${escapeXml(poly)}" style="display:none">` +
        list.map((r) => `<path class="poly-route" data-target="${escapeXml(r.target)}" d="${pathData(r.points)}"/>`).join('') +
        '</g>',
    )
    .join('');
}

function viewSvg(scene, colorOf, visible, technical) {
  const { x, y, w, h } = scene.bounds;
  const nodes = scene.nodes.map((n) => {
    if (n.kind === 'table') return tableSvg(n, colorOf(n.node.cluster), technical.get(n.id));
    if (n.kind === 'poly') return polySvg(n);
    if (n.kind === 'stub') return stubSvg(n);
    return domainSvg(n, colorOf(n.id));
  });
  // Hidden views are shown by the embedded viewer script; without script the
  // overview alone is what a reader sees.
  const hidden = visible ? '' : ' style="display:none"';
  return [
    `<g class="view" data-view="${escapeXml(scene.name)}" data-bounds="${x} ${y} ${w} ${h}"${hidden}>`,
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#ffffff"/>`,
    `<g class="groups">${scene.groups.map((g) => groupSvg(g, colorOf)).join('')}</g>`,
    `<g class="relations">${scene.relations.map(relationSvg).join('')}${polyRoutesSvg(scene.polyRoutes)}</g>`,
    `<g class="nodes">${nodes.join('')}</g>`,
    '</g>',
  ].join('\n');
}

// The viewer bundle is generated by scripts/bundle-viewer.js; a CDATA
// section cannot contain its own terminator.
const VIEWER_SCRIPT = viewerBundle.source;
if (VIEWER_SCRIPT.includes(']]>')) throw new Error('viewer bundle contains "]]>" and cannot sit in a CDATA section');

// JSON inside an XML element: escaping <, > and & as \u escapes keeps it
// valid JSON and leaves nothing for the XML parser to interpret.
const scriptJson = (value) => JSON.stringify(value).replace(/[<>&]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/**
 * What the viewer needs beyond the drawing: every node's details (for
 * tooltips, search and panels) and every drawn relation (for the
 * neighborhood view, which spans domains). Keys are written in a fixed
 * order and lists come from the sorted model, so the text is deterministic.
 */
export function viewerData(model, diagram, technical = technicalColumns(model)) {
  // Note fields in a fixed order; a sharing profile has already removed the
  // ones it drops.
  const notes = (o) => Object.fromEntries(['note', 'note_source', 'internal_note'].filter((f) => o[f]).map((f) => [f === 'note' ? f : camel(f), o[f]]));
  const evidenceOf = new Map([
    ...model.relations.map((r) => [relationId(r), r.evidence ?? []]),
    ...model.polymorphic.map((a) => [polyLinkId(a), a.evidence ?? []]),
  ]);
  const nodes = {};
  for (const id of [...diagram.nodes.keys()].sort(compareStrings)) {
    const n = diagram.nodes.get(id);
    if (n.kind === 'poly') {
      const a = n.association;
      nodes[id] = { kind: 'poly', cluster: n.cluster, table: a.table, name: a.name, typeColumn: a.type_column, idColumn: a.id_column, targets: a.targets };
      if (a.evidence?.length > 0) nodes[id].evidence = a.evidence;
      continue;
    }
    const t = n.table;
    nodes[id] = {
      kind: 'table',
      cluster: n.cluster,
      ...(t.kind && t.kind !== 'table' ? { tableKind: t.kind } : {}),
      ...notes(t),
      ...(n.facts.length > 0 ? { facts: n.facts } : {}),
      ...(t.sources ? { sources: t.sources } : {}),
      columns: columnEntries(t).map(({ path, column: c, entity }) => ({
        name: path,
        ...(entity ? { entity: entity.name } : {}),
        type: c.type,
        ...(c.nullable === undefined ? {} : { nullable: c.nullable }),
        ...(c.pk ? { pk: true } : {}),
        ...(c.unique ? { unique: true } : {}),
        ...(c.pii ? { pii: true } : {}),
        ...(technical.get(id).has(path) ? { technical: true } : {}),
        ...(c.enum ? { enum: c.enum } : {}),
        ...notes(c),
      })),
    };
  }
  const links = diagram.links.map((l) => ({
    id: l.id,
    from: l.from.node,
    to: l.to.node,
    cardinality: l.cardinality,
    kind: l.kind,
    review: l.review,
    ...(l.via ? { via: l.via } : {}),
    ...(evidenceOf.get(l.id)?.length > 0 ? { evidence: evidenceOf.get(l.id) } : {}),
  }));
  return { nodes, links };
}

/**
 * Static SVG holding every view; the overview is the one visible. Pass
 * `{ fitStored: true }` for a model filtered by a sharing profile (see
 * resolveView).
 */
export function renderSvg(model, layout, options = {}) {
  const diagram = buildDiagram(model);
  const scenes = viewNames(diagram).map((name) => buildScene(model, layout, name, diagram, options));
  // Indices past the palette cycle, which only happens once every tint is taken.
  const colorOf = (key) => PALETTE[layout.colors[key] % PALETTE.length];
  const technical = technicalColumns(model);
  const { x, y, w, h } = scenes.find((s) => s.name === OVERVIEW).bounds;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${x} ${y} ${w} ${h}">`,
    `<style>${STYLE}</style>`,
    ...scenes.map((s) => viewSvg(s, colorOf, s.name === OVERVIEW, technical)),
    `<script type="application/json" id="open-erd-data">${scriptJson(viewerData(model, diagram, technical))}</script>`,
    `<script><![CDATA[\n${VIEWER_SCRIPT}\n]]></script>`,
    '</svg>',
    '',
  ].join('\n');
}
