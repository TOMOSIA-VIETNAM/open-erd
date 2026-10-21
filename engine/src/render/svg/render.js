import { DB_LABEL_FONT, ENGINE_FONT, LABEL_FONT, LABEL_OFFSET, clusterLabel, dbLabel, labelBox } from '../../layout/clusters.js';
import { buildDiagram } from '../../layout/diagram.js';
import { resolveView } from '../../layout/index.js';
import { STUB, routeEdges } from '../../layout/router.js';
import { GRID, BADGE_ARROW_WIDTH, BADGE_FONT, DOMAIN_COUNT_FONT, DOMAIN_TITLE_FONT, HEADER_HEIGHT, PADDING_X, attachOffset } from '../../layout/table-box.js';
import { ALL_VIEW, OVERVIEW, viewNames } from '../../layout/views.js';
import { compareStrings } from '../../model/load.js';
import { measureText } from '../../text/measure.js';
import { FONT_FAMILY, TEXT_STYLE_CSS, fontFaceCss } from '../../text/font.js';
import { PALETTE } from '../../palette.js';
import { endMarkers, markerSvg } from './markers.js';

const CANVAS_MARGIN = 40;
const CORNER = 6;
const EDGE_LABEL_FONT = { size: 10, weight: 700 };
const EDGE_LABEL_PAD = { x: 4, y: 3 };

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
.kind-polymorphic .relation { stroke-dasharray: 2 3; }`;

function escapeXml(text) {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

const nodeRect = (n) => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h });

function labelText(view, link) {
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

/**
 * Everything one view draws, with absolute coordinates: nodes, group frames,
 * routed lines with their end markers and labels. Kept separate from the SVG
 * text so geometry can be tested directly.
 */
export function buildScene(model, layout, name = ALL_VIEW, diagram = buildDiagram(model)) {
  const view = resolveView(model, layout, name, diagram);
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const labels = view.groups.map((g) =>
    g.kind === 'cluster'
      ? { id: `label:${g.group.key}`, ...labelBox(g.frame, g.group.key) }
      : { id: `label:${g.group.id}`, ...dbLabel(g.frame, g.group.database, g.group.engine).box },
  );
  const obstacles = [...view.nodes.map(nodeRect), ...labels];
  const spread = name === OVERVIEW ? spreadEnds(view.links, byId) : null;
  const end = (link, side, marker) => {
    const e = link[side];
    const n = byId.get(e.node);
    const offset = spread ? spread.get(`${link.id}\u0000${side}`) : attachOffset(n.box, e.column);
    return { box: nodeRect(n), y: n.y + offset, marker };
  };
  const markers = view.links.map((l) => (name === OVERVIEW ? { from: 'none', to: 'none' } : endMarkers(l)));
  const edges = view.links.map((l, i) => ({ id: l.id, from: end(l, 'from', markers[i].from), to: end(l, 'to', markers[i].to) }));
  const routes = routeEdges(obstacles, view.groups.map((g) => g.frame), edges);
  const labelsOf = placeLabels(routes, view.links.map((link) => labelText(name, link)));
  const relations = view.links.map((link, i) => ({ link, ...routes[i], markers: markers[i], label: labelsOf[i] }));

  // Lines may detour outside every frame, so they count towards the canvas.
  const xs = [];
  const ys = [];
  for (const b of [...view.groups.map((g) => g.frame), ...view.nodes]) {
    xs.push(b.x, b.x + b.w);
    ys.push(b.y, b.y + b.h);
  }
  for (const [px, py] of relations.flatMap((r) => r.points)) {
    xs.push(px);
    ys.push(py);
  }
  const x0 = Math.min(...xs) - CANVAS_MARGIN;
  const y0 = Math.min(...ys) - CANVAS_MARGIN;
  const x1 = Math.max(...xs) + CANVAS_MARGIN;
  const y1 = Math.max(...ys) + CANVAS_MARGIN;
  return { name, nodes: view.nodes, groups: view.groups, labels, relations, bounds: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
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

function tableSvg(n, colors) {
  const { x, y, w, h, box } = n;
  const rows = box.rows.map((r) =>
    [
      textEl(r.pk ? 'column-name pk' : 'column-name', x + PADDING_X, y + r.centerY, r.name),
      textEl('column-type', x + w - PADDING_X, y + r.centerY, r.type, 'end'),
    ].join(''),
  );
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
  return [
    `<g class="table" data-id="${escapeXml(n.id)}"><title>${escapeXml(n.id)}</title>`,
    `<rect class="table-box" x="${x}" y="${y}" width="${w}" height="${h}" rx="${CORNER}"/>`,
    headerPath(x, y, w, colors.header),
    `<path d="M${x} ${y + HEADER_HEIGHT}H${x + w}" stroke="${colors.stroke}"/>`,
    textEl('table-title', x + PADDING_X, y + box.title.centerY, box.title),
    ...rows,
    separator,
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
  const l = dbLabel(f, g.group.database, g.group.engine);
  const { x, y, w, h } = l.icon;
  const ry = 3;
  const icon =
    `<path class="db-icon" d="M${x} ${y + ry}V${y + h - ry}A${w / 2} ${ry} 0 0 0 ${x + w} ${y + h - ry}V${y + ry}A${w / 2} ${ry} 0 0 0 ${x} ${y + ry}Z"/>` +
    `<path class="db-icon" d="M${x} ${y + ry}A${w / 2} ${ry} 0 0 0 ${x + w} ${y + ry}" fill="none"/>`;
  return (
    `<g class="database" data-database="${escapeXml(g.group.database)}" data-engine="${escapeXml(g.group.engine)}">` +
    `<rect class="db-frame" x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" rx="16"/>${icon}` +
    `<text class="db-name" x="${l.name.x}" y="${l.cy}" dominant-baseline="central">${escapeXml(l.name.text)}</text>` +
    `<rect class="engine-pill" x="${l.pill.x}" y="${l.pill.y}" width="${l.pill.w}" height="${l.pill.h}" rx="9"/>` +
    `<text class="engine-name" x="${l.engine.x}" y="${l.cy}" dominant-baseline="central" text-anchor="middle">${escapeXml(l.engine.text)}</text>` +
    '</g>'
  );
}

function relationSvg(r) {
  const { link } = r;
  const d = r.points.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px} ${py}`).join('');
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

function viewSvg(scene, colorOf, visible) {
  const { x, y, w, h } = scene.bounds;
  const nodes = scene.nodes.map((n) => {
    if (n.kind === 'table') return tableSvg(n, colorOf(n.node.cluster));
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
    `<g class="relations">${scene.relations.map(relationSvg).join('')}</g>`,
    `<g class="nodes">${nodes.join('')}</g>`,
    '</g>',
  ].join('\n');
}

/** Static SVG holding every view; the overview is the one visible. */
export function renderSvg(model, layout) {
  const diagram = buildDiagram(model);
  const scenes = viewNames(diagram).map((name) => buildScene(model, layout, name, diagram));
  // Indices past the palette cycle, which only happens once every tint is taken.
  const colorOf = (key) => PALETTE[layout.colors[key] % PALETTE.length];
  const { x, y, w, h } = scenes.find((s) => s.name === OVERVIEW).bounds;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${x} ${y} ${w} ${h}">`,
    `<style>${STYLE}</style>`,
    ...scenes.map((s) => viewSvg(s, colorOf, s.name === OVERVIEW)),
    '</svg>',
    '',
  ].join('\n');
}
