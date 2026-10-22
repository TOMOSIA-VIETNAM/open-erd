import { clusterLabel, engineName } from '../../layout/clusters.js';
import { VIEW_SOURCE, buildDiagram } from '../../layout/diagram.js';
import { COLUMN_FONT, HEADER_HEIGHT, PADDING_X, PK_FONT, ROW_HEIGHT, TYPE_FONT } from '../../layout/table-box.js';
import { ALL_VIEW, DOMAIN_VIEW_PREFIX, OVERVIEW, hasAllView, viewNames } from '../../layout/views.js';
import { columnEntries, enumMeaning } from '../../model/columns.js';
import { PALETTE } from '../../palette.js';
import { measureText, truncate } from '../../text/measure.js';
import { buildScene } from '../svg/render.js';

// draw.io export: one page per view, drawn from the same scenes as the SVG
// (positions from layout.json, routes from the router), so both files show
// the same diagram. Tables are draw.io table shapes with one row per column,
// and every relation is a connector attached to the rows of its columns, so
// a reader can drag tables in draw.io and the lines follow.

// draw.io styles want hex colours; the palette is written as hsl().
function hslToHex(text) {
  const [h, s, l] = text.match(/[\d.]+/g).map(Number);
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const channel = (n) => {
    const k = (n + h / 30) % 12;
    const v = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}
const COLORS = PALETTE.map((p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, hslToHex(v)])));

// Same meaning as the SVG: colour carries the review state, dash pattern the
// kind (inferred dashed until reviewed, cross_db dash-dot-dot, polymorphic
// dotted, a view's line to its sources muted).
const REVIEW_COLOR = { reviewed: '#6b778a', pending: '#c27c0e', stale: '#c53030' };
const REVIEW_TEXT = { reviewed: '#4f5b6e', pending: '#9a6208', stale: '#a61f1f' };
const VIEW_SOURCE_COLOR = '#a9b2c0';
function dashPattern(link) {
  if (link.kind === VIEW_SOURCE) return '5 4';
  if (link.kind === 'cross_db') return '10 3 2 3 2 3';
  if (link.kind === 'polymorphic') return '2 3';
  if (link.kind === 'inferred' && link.review !== 'reviewed') return '6 4';
  return null;
}

// Crow's foot ends, matching markers.js: `many` is one-or-more (crow plus
// bar), which draw.io calls ERoneToMany.
const ER_ARROWS = { one: 'ERmandOne', zeroOrOne: 'ERzeroToOne', many: 'ERoneToMany', zeroOrMany: 'ERzeroToMany', none: 'none' };

const escapeXml = (text) =>
  String(text).replace(/[&<>"\n]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\n': '&#10;' })[c]);
const escapeHtml = (text) => String(text).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const style = (entries) =>
  Object.entries(entries)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join(';');

/** Page name shown on the draw.io tab of view `name`. */
export function pageName(name) {
  if (name === OVERVIEW) return 'Overview';
  if (name === ALL_VIEW) return 'All tables';
  const key = name.slice(DOMAIN_VIEW_PREFIX.length);
  return `${clusterLabel(key)} (${key.split('/')[0]})`;
}

/**
 * One cell. A cell with a tooltip is wrapped in <object>, which is where
 * draw.io keeps custom attributes; the id and label then live on the object.
 */
function cell({ id, value = '', tooltip, styles, parent, vertex = true, geometry, source, target }) {
  const kind = vertex ? 'vertex="1"' : 'edge="1"';
  const ends = `${source ? ` source="${escapeXml(source)}"` : ''}${target ? ` target="${escapeXml(target)}"` : ''}`;
  const inner = `<mxCell style="${escapeXml(style(styles))}" ${kind} parent="${escapeXml(parent)}"${ends}>${geometry}</mxCell>`;
  if (tooltip) return `<object id="${escapeXml(id)}" label="${escapeXml(value)}" tooltip="${escapeXml(tooltip)}">${inner}</object>`;
  return inner.replace('<mxCell ', `<mxCell id="${escapeXml(id)}" value="${escapeXml(value)}" `);
}

const box = (x, y, w, h) => `<mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/>`;

// Note fields a sharing profile has not dropped, business note first.
const notes = (o) => ['note', 'note_source', 'internal_note'].map((f) => o[f]).filter(Boolean);

// What a column's tooltip says: its type and flags, its note, the meaning
// of each enum value.
function columnTooltip(path, c) {
  const flags = [
    c.pk && 'primary key',
    c.nullable === true && 'nullable',
    c.nullable === false && 'not null',
    c.unique && 'unique',
    c.auto_increment && 'auto increment',
    c.default !== undefined && `default ${c.default}`,
    c.generated !== undefined && `generated as ${c.generated}`,
    c.pii && 'PII',
  ].filter(Boolean);
  const lines = [`${path}: ${c.type}${flags.length > 0 ? ` (${flags.join(', ')})` : ''}`];
  lines.push(...notes(c));
  for (const [value, meaning] of Object.entries(c.enum ?? {})) {
    const text = enumMeaning(value, meaning);
    lines.push(text ? `${value}: ${text}` : value);
  }
  return lines.join('\n');
}

const ROW_STYLE = {
  shape: 'tableRow',
  horizontal: 0,
  startSize: 0,
  swimlaneHead: 0,
  swimlaneBody: 0,
  top: 0,
  left: 0,
  bottom: 0,
  right: 0,
  collapsible: 0,
  dropTarget: 0,
  points: '[[0,0.5],[1,0.5]]',
  portConstraint: 'eastwest',
};
// Texts come fitted to the box by the layout (cut with an ellipsis, the full
// text in the tooltip), so the inner padding is kept small.
const CELL_STYLE = {
  shape: 'partialRectangle',
  connectable: 0,
  fillColor: 'none',
  top: 0,
  left: 0,
  bottom: 0,
  right: 0,
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  html: 0,
  // draw.io adds 2 px around every label unless told otherwise.
  spacing: 0,
  fontSize: 12,
  fontColor: '#2a3546',
  align: 'left',
  spacingLeft: PADDING_X - 2,
  spacingRight: 4,
};

/**
 * A table (or a polymorphic node) as a draw.io table shape: the header holds
 * the title, each entry of `rows` becomes a tableRow with one cell per text
 * (a single text spans both columns). Rows are ROW_HEIGHT tall from the
 * header down, the same slots the layout gave the columns, so a row's middle
 * is where the router attached the line.
 */
function tableCells({ id, parent, x, y, w, title, tooltip, header, stroke, dashed, titleColor }, rows, typeWidth) {
  const h = HEADER_HEIGHT + ROW_HEIGHT * rows.length;
  const out = [
    cell({
      id,
      value: title,
      tooltip,
      parent,
      geometry: box(x, y, w, h),
      styles: {
        shape: 'table',
        startSize: HEADER_HEIGHT,
        container: 1,
        collapsible: 0,
        childLayout: 'tableLayout',
        fixedRows: 1,
        rowLines: 0,
        columnLines: 0,
        resizeLast: 1,
        html: 0,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        align: 'left',
        spacingLeft: PADDING_X - 2,
        fontStyle: 1,
        fontSize: 13,
        fontColor: titleColor,
        fillColor: header,
        swimlaneFillColor: '#ffffff',
        strokeColor: stroke,
        dashed: dashed ? 1 : null,
        dashPattern: dashed ?? null,
        fixDash: dashed ? 1 : null,
      },
    }),
  ];
  rows.forEach((r, i) => {
    // Rows without a column (entity titles, facts, badges) are numbered
    // after a '#', which keeps them apart from real column names.
    const rowId = r.id ?? `${id}|#${i}`;
    out.push(
      cell({
        id: rowId,
        tooltip: r.tooltip,
        parent: id,
        geometry: box(0, HEADER_HEIGHT + ROW_HEIGHT * i, w, ROW_HEIGHT),
        styles: { ...ROW_STYLE, fillColor: r.fill ?? 'none', strokeColor: 'inherit' },
      }),
    );
    const span = r.type === undefined;
    const nameWidth = span ? w : w - typeWidth;
    out.push(
      cell({
        id: `${rowId}|name`,
        value: r.name,
        parent: rowId,
        geometry: box(0, 0, nameWidth, ROW_HEIGHT),
        styles: { ...CELL_STYLE, ...(span ? { colspan: 2 } : {}), ...r.nameStyle },
      }),
    );
    if (!span) {
      out.push(
        cell({
          id: `${rowId}|type`,
          value: r.type,
          parent: rowId,
          geometry: box(nameWidth, 0, typeWidth, ROW_HEIGHT),
          styles: { ...CELL_STYLE, align: 'right', spacingLeft: 2, spacingRight: PADDING_X - 2, fontColor: '#7a8597' },
        }),
      );
    }
  });
  return { cells: out, h };
}

// Ids are built from model ids, so the same model always gives the same
// file and a cell keeps its id across renders.
const nodeId = (id) => `n|${id}`;
const rowId = (table, column) => `n|${table}|${column}`;
const groupId = (group) => `g|${group.id}`;
const edgeId = (link) => `e|${link.id}`;

function tableNode(n, parent, x, y, colors) {
  const t = n.node.table;
  const b = n.box;
  const columns = new Map(columnEntries(t).map((e) => [e.path, e]));
  // Columns and embedded entity titles in slot order, then facts and badges.
  const slots = [
    ...b.rows.map((r) => ({ y: r.centerY, row: r })),
    ...b.insets.map((e) => ({ y: e.title.centerY, inset: e })),
  ].sort((p, q) => p.y - q.y);
  // A draw.io table has one width per column for all rows, while the layout
  // fitted each row on its own. The name column gets the widest name, the
  // type column the rest; when both cannot fit, the box is shared in
  // proportion. Texts are then cut to their cell (with an ellipsis; the full
  // text is in the tooltip).
  const NAME_PAD = PADDING_X - 2 + 4;
  const TYPE_PAD = PADDING_X - 2 + 2;
  const indent = (r) => 12 * r.depth;
  const nameFont = (r) => (r.pk ? PK_FONT : COLUMN_FONT);
  const nameNeed = Math.max(0, ...b.rows.map((r) => Math.ceil(measureText(r.name.full, nameFont(r)) + indent(r)) + NAME_PAD));
  const typeNeed = Math.max(0, ...b.rows.map((r) => Math.ceil(measureText(r.type.full, TYPE_FONT)) + TYPE_PAD));
  const typeWidth = nameNeed + typeNeed <= n.w ? n.w - nameNeed : Math.round((n.w * typeNeed) / (nameNeed + typeNeed));
  const insetFill = '#f6f8fb';
  const rows = slots.map(({ row, inset }) => {
    if (inset) return { name: inset.title.full, type: '', fill: insetFill, nameStyle: { fontStyle: 1, fontColor: '#56627a' } };
    const { column } = columns.get(row.column);
    return {
      id: rowId(t.id, row.column),
      name: truncate(row.name.full, n.w - typeWidth - NAME_PAD - indent(row), nameFont(row)).text,
      type: truncate(row.type.full, typeWidth - TYPE_PAD, TYPE_FONT).text,
      tooltip: columnTooltip(row.column, column),
      fill: row.depth > 0 ? insetFill : undefined,
      nameStyle: { fontStyle: row.pk ? 1 : 0, spacingLeft: PADDING_X - 2 + indent(row) },
    };
  });
  for (const f of b.facts) rows.push({ name: f.text.full, nameStyle: { fontSize: 11, fontColor: '#5f6b7e' } });
  for (const badge of b.badges) {
    rows.push({ name: `→ ${badge.label.full}`, tooltip: `${badge.columns.join(', ')} → ${badge.target}`, nameStyle: { fontSize: 11, fontColor: '#56627a' } });
  }
  const kind = t.kind ?? 'table';
  const tag = b.tag ? ` ${b.tag.text}` : '';
  const tooltip = [t.id + (kind === 'table' ? '' : ` (${kind.replace('_', ' ')})`), ...notes(t), ...n.node.facts].filter(Boolean).join('\n');
  return tableCells(
    { id: nodeId(n.id), parent, x, y, w: n.w, title: b.title.text + tag, tooltip, header: colors.header, stroke: '#b8c2d0', dashed: kind === 'table' ? null : '5 3', titleColor: '#172033' },
    rows,
    typeWidth,
  );
}

function polyNode(n, parent, x, y) {
  const a = n.node.association;
  const rows = n.box.rows.map((r) => ({ name: r.name.full, nameStyle: { fontColor: '#4a4236' } }));
  const tooltip = [`${a.table}.${a.type_column} / ${a.id_column} → ${a.targets.join(', ')}`, ...notes(a)].filter(Boolean).join('\n');
  return tableCells(
    { id: nodeId(n.id), parent, x, y, w: n.w, title: n.box.title.full, tooltip, header: '#fffdf7', stroke: '#a08a5c', dashed: '4 3', titleColor: '#6b5428' },
    rows,
    0,
  );
}

const shapeCommon = { rounded: 1, absoluteArcSize: 1, html: 0, whiteSpace: 'nowrap', overflow: 'hidden', align: 'left', spacingLeft: PADDING_X - 2 };

// Returns { cells, h }: the XML of the node and the height it is drawn at.
function nodeCells(n, parent, x, y, colorOf) {
  if (n.kind === 'table') return tableNode(n, parent, x, y, colorOf(n.node.cluster));
  if (n.kind === 'poly') return polyNode(n, parent, x, y);
  if (n.kind === 'stub') {
    const cells = [
      cell({
        id: nodeId(n.id),
        value: n.box.title.full,
        tooltip: n.id,
        parent,
        geometry: box(x, y, n.w, n.h),
        styles: { ...shapeCommon, arcSize: 12, dashed: 1, dashPattern: '3 3', fixDash: 1, fillColor: '#f3f5f8', strokeColor: '#c3cad5', fontColor: '#8a94a6', fontSize: 12 },
      }),
    ];
    return { cells, h: n.h };
  }
  // Overview domain box: name over table count.
  const c = colorOf(n.id);
  const value = `<b style="font-size:14px;color:${c.label}">${escapeHtml(n.box.title.full)}</b><br><span style="color:#5f6b7e">${escapeHtml(n.box.count.full)}</span>`;
  const cells = [
    cell({
      id: nodeId(n.id),
      value,
      tooltip: n.id,
      parent,
      geometry: box(x, y, n.w, n.h),
      styles: { ...shapeCommon, html: 1, arcSize: 20, fillColor: c.header, strokeColor: c.stroke, fontSize: 12 },
    }),
  ];
  return { cells, h: n.h };
}

function groupCell(g, parent, x, y, colorOf) {
  const { w, h } = g.frame;
  const frame = { ...shapeCommon, container: 1, collapsible: 0, verticalAlign: 'top', fontStyle: 1, spacingLeft: 14 };
  if (g.kind === 'cluster') {
    const c = colorOf(g.group.key);
    return cell({
      id: groupId(g.group),
      value: clusterLabel(g.group.key),
      parent,
      geometry: box(x, y, w, h),
      styles: { ...frame, arcSize: 24, spacingTop: 14, fontSize: 14, fillColor: c.fill, strokeColor: c.stroke, fontColor: c.label },
    });
  }
  const { database, engine, facts } = g.group;
  return cell({
    id: groupId(g.group),
    value: [`${database} · ${engineName(engine)}`, ...facts].join('  ·  '),
    tooltip: facts.length > 0 ? facts.join('\n') : null,
    parent,
    geometry: box(x, y, w, h),
    styles: { ...frame, arcSize: 32, spacingTop: 20, fontSize: 15, fillColor: '#fbfcfd', strokeColor: '#94a0b2', fontColor: '#1f2a3d' },
  });
}

// End of a connector: the column's row when the line names a column of a
// drawn table, else the node itself at the height the router attached it.
function endpoint(link, side, point, byId, heights) {
  const n = byId.get(link[side].node);
  const x = point[0] === n.x ? 0 : 1;
  if (n.kind === 'table' && link[side].column !== null) return { id: rowId(n.id, link[side].column), x, y: 0.5 };
  return { id: nodeId(n.id), x, y: Math.round(((point[1] - n.y) / heights.get(n.id)) * 1e4) / 1e4 };
}

// draw.io places an edge label by its position along the line (x from -1 at
// the source to 1 at the target) plus an offset. The SVG already chose a
// spot clear of other labels and lines; the label goes to the same spot: the
// nearest point of the route, then the remaining offset.
function labelAnchor(points, label) {
  const segments = points.slice(1).map((b, i) => ({ a: points[i], b, len: Math.abs(b[0] - points[i][0]) + Math.abs(b[1] - points[i][1]) }));
  const total = segments.reduce((n, seg) => n + seg.len, 0);
  let best = null;
  let walked = 0;
  for (const { a, b, len } of segments) {
    const clamp = (v, p, q) => Math.min(Math.max(v, Math.min(p, q)), Math.max(p, q));
    const px = clamp(label.cx, a[0], b[0]);
    const py = clamp(label.cy, a[1], b[1]);
    const dist = Math.abs(px - label.cx) + Math.abs(py - label.cy);
    if (!best || dist < best.dist) best = { dist, along: walked + Math.abs(px - a[0]) + Math.abs(py - a[1]), px, py };
    walked += len;
  }
  return { x: total === 0 ? 0 : Math.round(((2 * best.along) / total - 1) * 1e4) / 1e4, dx: label.cx - best.px, dy: label.cy - best.py };
}
const labelGeometry = (points, label) => (label ? ` x="${labelAnchor(points, label).x}"` : '');
function labelOffset(points, label) {
  if (!label) return '';
  const { dx, dy } = labelAnchor(points, label);
  return dx === 0 && dy === 0 ? '' : `<mxPoint x="${dx}" y="${dy}" as="offset"/>`;
}

// `r` is a routed line: { link, points, markers, label? }. Lines on a
// hidden layer pass that layer as `parent` and their own id and style.
function edgeCell(r, overview, byId, heights, origin, { id = edgeId(r.link), parent = '1', extra = {} } = {}) {
  const { link, points } = r;
  const source = endpoint(link, 'from', points[0], byId, heights);
  const target = endpoint(link, 'to', points.at(-1), byId, heights);
  const color = link.kind === VIEW_SOURCE ? VIEW_SOURCE_COLOR : REVIEW_COLOR[link.review];
  const dash = overview ? (link.kind === 'cross_db' ? '10 3 2 3 2 3' : null) : dashPattern(link);
  const arrows = overview ? { startArrow: 'none', endArrow: 'block', endFill: 1 } : { startArrow: ER_ARROWS[r.markers.from], endArrow: ER_ARROWS[r.markers.to], startFill: 0, endFill: 0 };
  const waypoints = points
    .slice(1, -1)
    .map(([px, py]) => `<mxPoint x="${px - origin.x}" y="${py - origin.y}"/>`)
    .join('');
  const tooltip = link.via ? `${link.id} (n-n via ${link.via})` : link.id;
  return cell({
    id,
    value: r.label?.text ?? '',
    tooltip,
    parent,
    vertex: false,
    source: source.id,
    target: target.id,
    geometry: `<mxGeometry${labelGeometry(points, r.label)} relative="1" as="geometry"><Array as="points">${waypoints}</Array>${labelOffset(points, r.label)}</mxGeometry>`,
    styles: {
      edgeStyle: 'orthogonalEdgeStyle',
      rounded: 0,
      orthogonalLoop: 1,
      html: 0,
      strokeColor: color,
      strokeWidth: 1.4,
      fontSize: 10,
      fontStyle: 1,
      fontColor: REVIEW_TEXT[link.review] ?? REVIEW_TEXT.reviewed,
      labelBackgroundColor: '#ffffff',
      dashed: dash ? 1 : 0,
      dashPattern: dash,
      fixDash: dash ? 1 : null,
      ...arrows,
      startSize: 10,
      endSize: 10,
      exitX: source.x,
      exitY: source.y,
      exitPerimeter: 0,
      entryX: target.x,
      entryY: target.y,
      entryPerimeter: 0,
      ...extra,
    },
  });
}

// Lines the SVG draws only on demand (a click on a hub table or on a
// polymorphic node). draw.io has no click, so each kind goes on its own
// layer, hidden until the reader turns it on in the Layers panel.
export const HUB_LAYER = { id: 'layer-hub-links', name: 'Hub links' };
export const POLY_LAYER = { id: 'layer-polymorphic-targets', name: 'Polymorphic targets' };

function hiddenLayers(scene, byId, heights, origin) {
  const layer = ({ id, name }, edges) => (edges.length === 0 ? [] : [`<mxCell id="${id}" value="${escapeXml(name)}" parent="0" visible="0"/>`, ...edges]);
  const hub = scene.hubRoutes.map((r) => edgeCell(r, false, byId, heights, origin, { id: `hub|${r.link.id}`, parent: HUB_LAYER.id }));
  // A polymorphic line runs from the node's header to the target's first
  // primary key column (the one the id column holds), as in the SVG.
  const poly = scene.polyRoutes.map((r) => {
    const t = byId.get(r.target);
    const column = t.kind === 'table' ? (t.node.table.columns.find((c) => c.pk) ?? t.node.table.columns[0]).name : null;
    const link = { id: `${r.poly}->${r.target}`, from: { node: r.poly, column: null }, to: { node: r.target, column }, review: 'reviewed' };
    return edgeCell({ link, points: r.points, markers: { from: 'none', to: 'none' } }, false, byId, heights, origin, {
      id: `poly|${link.id}`,
      parent: POLY_LAYER.id,
      extra: { strokeColor: '#a07a2c', strokeWidth: 1.8, dashed: 1, dashPattern: '2 3', fixDash: 1 },
    });
  });
  return [...layer(HUB_LAYER, hub), ...layer(POLY_LAYER, poly)];
}

function pageXml(scene, colorOf) {
  const origin = { x: scene.bounds.x, y: scene.bounds.y };
  // Each cell sits inside the innermost frame around it (database, then
  // domain), with coordinates relative to that frame, so a frame dragged in
  // draw.io carries its tables along.
  const parentOf = new Map();
  for (const g of scene.groups) {
    for (const child of g.group.children) parentOf.set(child.children ? groupId(child) : nodeId(child.id), g);
  }
  const place = (id, abs) => {
    const p = parentOf.get(id);
    const base = p ? p.frame : origin;
    return { parent: p ? groupId(p.group) : '1', x: abs.x - base.x, y: abs.y - base.y };
  };
  const cells = [];
  for (const g of scene.groups) {
    const at = place(groupId(g.group), g.frame);
    cells.push(groupCell(g, at.parent, at.x, at.y, colorOf));
  }
  const heights = new Map();
  for (const n of scene.nodes) {
    const at = place(nodeId(n.id), n);
    // A table cell is shorter than its layout box (no bottom padding), so
    // header attachments are placed by the cell's own height.
    const drawn = nodeCells(n, at.parent, at.x, at.y, colorOf);
    heights.set(n.id, drawn.h);
    cells.push(...drawn.cells);
  }
  const byId = new Map(scene.nodes.map((n) => [n.id, n]));
  for (const r of scene.relations) cells.push(edgeCell(r, scene.name === OVERVIEW, byId, heights, origin));
  const layers = hiddenLayers(scene, byId, heights, origin);
  const { w, h } = scene.bounds;
  return [
    `  <diagram id="${escapeXml(scene.name)}" name="${escapeXml(pageName(scene.name))}">`,
    `    <mxGraphModel dx="0" dy="0" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" pageWidth="${w}" pageHeight="${h}" math="0" shadow="0">`,
    '      <root>',
    '        <mxCell id="0"/>',
    '        <mxCell id="1" parent="0"/>',
    ...cells.map((c) => `        ${c}`),
    ...layers.map((c) => `        ${c}`),
    '      </root>',
    '    </mxGraphModel>',
    '  </diagram>',
  ].join('\n');
}

/**
 * The .drawio file of every view: Overview, each domain, then All tables
 * when the diagram has that view. Plain (uncompressed) XML with no
 * timestamps, so the same model and layout always give the same bytes.
 * Options are those of renderSvg's scenes (`fitStored` for a profile).
 */
export function renderDrawio(model, layout, options = {}) {
  const diagram = buildDiagram(model);
  const colorOf = (key) => COLORS[layout.colors[key] % COLORS.length];
  const names = viewNames(diagram).filter((n) => n !== ALL_VIEW);
  if (hasAllView(diagram)) names.push(ALL_VIEW);
  const pages = names.map((name) => pageXml(buildScene(model, layout, name, diagram, options), colorOf));
  return ['<mxfile host="open-erd" compressed="false">', ...pages, '</mxfile>', ''].join('\n');
}
