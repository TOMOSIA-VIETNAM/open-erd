import { clusterLabel, engineName } from '../../layout/clusters.js';
import { VIEW_SOURCE, buildDiagram, keyColumns } from '../../layout/diagram.js';
import { EMBED_INSET, HEADER_HEIGHT, HINT_OFFSET, ICON_GUTTER, PADDING_X, ROW_HEIGHT } from '../../layout/table-box.js';
import { ALL_VIEW, DOMAIN_VIEW_PREFIX, OVERVIEW, hasAllView, viewNames } from '../../layout/views.js';
import { STRENGTH_SEGMENTS } from '../../layout/domains.js';
import { ICON_PAINT, UNCONFIRMED_DASH, enumIconSvg, indexIconSvg, isConfirmed, keyIconSvg, linkIconSvg, starIconSvg, tableIconSvg } from '../svg/markers.js';
import { dbDisplayName } from '../../display-name.js';
import { columnEntries, enumMeaning } from '../../model/columns.js';
import { PALETTE } from '../../palette.js';
import { FONT_FAMILY, TEXT_STYLE_CSS } from '../../text/font.js';
import { buildScene } from '../svg/render.js';

// draw.io export: the overview and the view of all tables, drawn from the
// same scenes as the SVG (positions from layout.json, routes from the
// router), so both files show the same diagram. Tables are draw.io table
// shapes with one row per column, and every relation is a connector attached
// to the rows of its columns, so a reader can drag tables in draw.io and the
// lines follow.
//
// Details the drawing has no room for (a table's note and indexes, a
// column's type, default, references, enum meanings) are custom properties
// of the cell, read in draw.io with Edit Data (Cmd/Ctrl+M or right-click,
// Edit Data). No cell has a tooltip: draw.io draws an (i) icon on such a
// cell, over the lines, and a click on it opens the tooltip editor.
// draw.io also draws an icon beside every cell with a `note` property, so
// only a table carries one (its whole description as HTML, see tableNote);
// a column's note is the property `description`.
//
// A domain card on the Overview links to the page that shows its tables. A
// table's header links to the same table in the interactive SVG only when
// the SVG is hosted somewhere (`svgUrl`): draw.io resolves a relative link
// against its own site and cannot open a local file.
//
// Texts are drawn in the font the layout measured them with (FONT_FAMILY,
// loaded by draw.io from FONT_SOURCE), so they fit the boxes as in the SVG.

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

// Same line styles as the SVG: one neutral colour, dashed when not confirmed
// (see isConfirmed); a view's line to its sources muted. draw.io has no
// review mode, so review colours are left out.
const LINE_COLOR = '#6b778a';
const LABEL_COLOR = '#4f5b6e';
const VIEW_SOURCE_COLOR = '#a9b2c0';
function dashPattern(link) {
  if (link.kind === VIEW_SOURCE) return '5 4';
  return isConfirmed(link.kind, link.review) ? null : UNCONFIRMED_DASH;
}

// Crow's foot ends, matching markers.js: `many` is one-or-more (crow plus
// bar), which draw.io calls ERoneToMany.
const ER_ARROWS = { one: 'ERmandOne', zeroOrOne: 'ERzeroToOne', many: 'ERoneToMany', zeroOrMany: 'ERzeroToMany', none: 'none' };

const FONT_SOURCE = `https://fonts.googleapis.com/css2?family=${FONT_FAMILY}:wght@400;700`;
const FONT_STYLE = { fontFamily: FONT_FAMILY, fontSource: encodeURIComponent(FONT_SOURCE) };

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
 * One cell. A cell with custom properties (`data`, empty values left out) or
 * a `link` is wrapped in <UserObject>, which is where draw.io keeps them;
 * the id and label then live on the UserObject.
 */
function cell({ id, value = '', data = {}, link, styles, parent, vertex = true, geometry, source, target }) {
  const kind = vertex ? 'vertex="1"' : 'edge="1"';
  const ends = `${source ? ` source="${escapeXml(source)}"` : ''}${target ? ` target="${escapeXml(target)}"` : ''}`;
  // Every cell with a text gets the font; cells without one stay short.
  const all = value === '' ? styles : { ...styles, ...FONT_STYLE };
  const inner = `<mxCell style="${escapeXml(style(all))}" ${kind} parent="${escapeXml(parent)}"${ends}>${geometry}</mxCell>`;
  const props = Object.entries({ link, ...data }).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (props.length > 0) {
    return `<UserObject id="${escapeXml(id)}" label="${escapeXml(value)}"${props.map(([k, v]) => ` ${k}="${escapeXml(v)}"`).join('')}>${inner}</UserObject>`;
  }
  return inner.replace('<mxCell ', `<mxCell id="${escapeXml(id)}" value="${escapeXml(value)}" `);
}

const box = (x, y, w, h) => `<mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/>`;

// The SVG's icons (same glyphs, from markers.js) as 12 px images in HTML
// labels. Each glyph is drawn in a 14 px square around its centre; the key
// reaches further left than right, so it sits 2 px right of the middle.
const ICON_SIZE = 12;
const ICON_GAP = ICON_GUTTER - ICON_SIZE;
const GLYPHS = { pk: [keyIconSvg, 2], fk: [linkIconSvg, 0], enum: [enumIconSvg, 0], index: [indexIconSvg, 0], table: [tableIconSvg, 0], central: [starIconSvg, 0] };
const ICON_IMG = Object.fromEntries(
  Object.entries(GLYPHS).map(([kind, [draw, dx]]) => {
    const paint = (cls) => Object.entries(ICON_PAINT[cls]).map(([k, v]) => ` ${k}="${v}"`).join('');
    const glyph = draw(7 + dx, 7).replace(/ class="([^"]+)"/, (_, cls) => paint(cls));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14">${glyph}</svg>`;
    return [kind, `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`];
  }),
);
// An icon in the left gutter (ICON_GUTTER wide, as in the SVG, so names line
// up whether or not a row has one), or the marks after a name, centred where
// the SVG draws them (HINT_OFFSET after the name, then one every icon width),
// inside the gap the layout keeps between name and type.
const gutterIcon = (kind) =>
  kind
    ? `<img src="${ICON_IMG[kind]}" width="${ICON_SIZE}" height="${ICON_SIZE}" style="vertical-align:middle;margin-right:${ICON_GAP}px">`
    : `<span style="display:inline-block;width:${ICON_GUTTER}px"></span>`;
const hintIcons = (kinds) =>
  kinds
    .map((kind, i) => `<img src="${ICON_IMG[kind]}" width="${ICON_SIZE}" height="${ICON_SIZE}" style="vertical-align:middle${i === 0 ? `;margin-left:${HINT_OFFSET - ICON_SIZE / 2}px` : ''}">`)
    .join('');

const yesNo = (value) => (value ? 'yes' : 'no');
const lines = (list) => list.join('\n');

// Edit Data properties of a table's header.
function tableData(t, central) {
  const index = (i) => `${i.name ? `${i.name}: ` : ''}${i.columns.join(', ')}${i.unique ? ' unique' : ''}${i.where ? ` where ${i.where}` : ''}`;
  return { table: t.id, domain: t.domain, description: t.note, central: yesNo(central), indexes: lines((t.indexes ?? []).map(index)) };
}

// Edit Data properties of a column (on its name cell). `references` lists what the
// column points at (table.column), one per line.
function columnData(path, c, references) {
  return {
    column: path,
    type: c.type,
    nullable: c.nullable === undefined ? undefined : yesNo(c.nullable),
    default: c.default,
    primary_key: yesNo(c.pk),
    references: lines(references ?? []),
    enum: lines(
      Object.entries(c.enum ?? {}).map(([value, meaning]) => {
        const text = enumMeaning(value, meaning);
        return text ? `${value} — ${text}` : value;
      }),
    ),
    description: c.note,
    pii: yesNo(c.pii),
  };
}

// Relations by table, as text: `column` what each column references, by
// `<table id>|<column path>` (the other end of every relation it starts, the
// targets of a polymorphic id column); `out` and `in` one line per relation
// a table starts or receives, for its note.
function relationsOf(model) {
  const column = new Map();
  const out = new Map();
  const into = new Map();
  const add = (map, key, text) => map.set(key, [...(map.get(key) ?? []), text]);
  for (const r of model.relations) {
    r.from.columns.forEach((c, i) => add(column, `${r.from.table}|${c}`, `${r.to.table}.${r.to.columns[i]}`));
    add(out, r.from.table, `${r.from.columns.join(', ')} → ${r.to.table}.${r.to.columns.join(', ')}`);
    add(into, r.to.table, `${r.from.table}.${r.from.columns.join(', ')} → ${r.to.columns.join(', ')}`);
  }
  for (const a of model.polymorphic) {
    for (const target of a.targets) {
      add(column, `${a.table}|${a.id_column}`, `${target} (polymorphic)`);
      add(into, target, `${a.table}.${a.id_column} (polymorphic «${a.name}»)`);
    }
    add(out, a.table, `${a.id_column} → ${a.targets.join(', ')} (polymorphic «${a.name}»)`);
  }
  return { column, out, in: into };
}

// Marks before a column name in a table's note: text in the colour of the
// matching icon.
const NOTE_MARKS = [
  ['pk', 'PK', ICON_PAINT['icon-pk'].stroke],
  ['fk', 'FK', ICON_PAINT['icon-fk'].stroke],
  ['index', 'IX', ICON_PAINT['icon-index'].fill],
  ['enum', 'ENUM', ICON_PAINT['hint-enum'].stroke],
  ['pii', 'PII', '#c53030'],
];

/**
 * draw.io note of a table (Edit Note; its icon sits by the table's corner):
 * what the SVG's table panel shows, as HTML. Description and team-only
 * note, the columns (marks, type, nullable, default, comment), indexes and
 * the relations the table starts and receives. Built from the model the
 * render was given, so a profile's filtering applies to it.
 */
function tableNote(t, keys, relations) {
  const muted = (text) => `<span style="color:#8a94a6">${escapeHtml(text)}</span>`;
  const head = (text) => `<p style="margin:8px 0 2px"><b>${text}</b></p>`;
  const list = (items) => items.map((i) => `${escapeHtml(i)}<br>`).join('');
  // Layout by attributes on the table and rows, not a style per cell: a
  // large schema has thousands of cells.
  const columns = columnEntries(t).map(({ path, column: c }) => {
    const has = { pk: c.pk, fk: keys.fk.has(path), index: keys.indexed.has(path), enum: Object.keys(c.enum ?? {}).length > 0, pii: c.pii };
    const marks = NOTE_MARKS.filter(([key]) => has[key])
      .map(([, text, color]) => `<span style="color:${color};font-size:9px;font-weight:bold">${text}</span> `)
      .join('');
    const enumLines = Object.entries(c.enum ?? {}).map(([value, meaning]) => (enumMeaning(value, meaning) ? `${value} — ${enumMeaning(value, meaning)}` : value));
    const comment = [...(c.note ? [escapeHtml(c.note)] : []), ...enumLines.map(escapeHtml), ...(c.internal_note ? [muted(c.internal_note)] : [])].join('<br>');
    const nullable = c.nullable === undefined ? '' : yesNo(c.nullable);
    // Only the comment wraps; the note box is narrow.
    return `<tr valign="top"><td nowrap>${marks}${c.pk ? `<b>${escapeHtml(path)}</b>` : escapeHtml(path)}</td><td nowrap>${escapeHtml(c.type)}</td><td nowrap>${nullable}</td><td nowrap>${escapeHtml(c.default ?? '')}</td><td>${comment}</td></tr>`;
  });
  const th = (text) => `<th>${text}</th>`;
  const index = (i) => `${i.name ? `${i.name}: ` : ''}${i.columns.join(', ')}${i.unique ? ' (unique)' : ''}${i.where ? ` where ${i.where}` : ''}`;
  return [
    `<p style="margin:0 0 4px"><b>${escapeHtml(t.id)}</b></p>`,
    t.note ? `<p style="margin:0 0 2px">${escapeHtml(t.note)}</p>` : '',
    t.internal_note ? `<p style="margin:0 0 2px">${muted(t.internal_note)}</p>` : '',
    `<table cellpadding="2" style="border-collapse:collapse;width:100%;overflow-wrap:anywhere;font-size:11px;margin-top:6px"><tr align="left" style="color:#7a8597;white-space:nowrap">${['Column', 'Type', 'Null', 'Default', 'Comment'].map(th).join('')}</tr>${columns.join('')}</table>`,
    t.indexes?.length ? head('Indexes') + list(t.indexes.map(index)) : '',
    relations.out.get(t.id) ? head('References') + list(relations.out.get(t.id)) : '',
    relations.in.get(t.id) ? head('Referenced by') + list(relations.in.get(t.id)) : '',
  ].join('');
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
// One text per row, spanning the row: a column's name and type sit in one
// HTML label (name left, type right), so each row is fitted on its own as
// the layout fitted it. Texts come fitted by the layout (cut with an
// ellipsis only when even the widest box cannot hold them), so the inner
// padding is kept small. Callers escape their text.
const CELL_STYLE = {
  shape: 'partialRectangle',
  connectable: 0,
  fillColor: 'none',
  top: 0,
  left: 0,
  bottom: 0,
  right: 0,
  overflow: 'hidden',
  // With wrap, draw.io gives an HTML label the cell's width, which the
  // name/type layout needs; the label itself never wraps (see rowHtml).
  whiteSpace: 'wrap',
  html: 1,
  // draw.io adds 2 px around every label unless told otherwise.
  spacing: 0,
  fontSize: 12,
  fontColor: '#2a3546',
  align: 'left',
  spacingLeft: PADDING_X - 2,
  spacingRight: PADDING_X - 2,
};

// HTML of a text in measured glyph widths: the layout sums glyph advances,
// so kerning and ligatures are turned off as in the SVG.
const measured = (html) => `<span style="${TEXT_STYLE_CSS}">${html}</span>`;

// A column row: gutter icon, name and marks on the left, type on the right,
// in `width` px (draw.io sizes an HTML label to its content, so the width is
// set). The name gives way first if the label is still too narrow.
function rowHtml(row, width) {
  const name = gutterIcon(row.key) + (row.pk ? `<b>${escapeHtml(row.name.text)}</b>` : escapeHtml(row.name.text)) + hintIcons(row.hints.map((h) => h.kind));
  return (
    `<div style="display:flex;align-items:center;width:${width}px;white-space:nowrap;${TEXT_STYLE_CSS}">` +
    `<span style="flex:1 1 auto;min-width:0;overflow:hidden">${name}</span>` +
    `<span style="flex:none;padding-left:4px;color:#7a8597">${escapeHtml(row.type.text)}</span></div>`
  );
}

/**
 * A table (or a polymorphic node) as a draw.io table shape: the header holds
 * the title (HTML), each entry of `rows` ({ id?, label, data?, fill?, style? })
 * becomes a tableRow with one text cell. Rows are ROW_HEIGHT tall from the
 * header down, the same slots the layout gave the columns, so a row's middle
 * is where the router attached the line.
 */
function tableCells({ id, parent, x, y, w, title, header, stroke, strokeWidth, dashed, titleColor, data, link }, rows) {
  const h = HEADER_HEIGHT + ROW_HEIGHT * rows.length;
  const out = [
    cell({
      id,
      value: measured(title),
      data,
      link,
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
        html: 1,
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
        strokeWidth: strokeWidth ?? null,
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
        parent: id,
        geometry: box(0, HEADER_HEIGHT + ROW_HEIGHT * i, w, ROW_HEIGHT),
        styles: { ...ROW_STYLE, fillColor: r.fill ?? 'none', strokeColor: 'inherit' },
      }),
      cell({
        id: `${rowId}|name`,
        value: r.label,
        // On the text, not the row: in draw.io a click selects the table,
        // the next click the text under the mouse, so this is the cell a
        // reader has selected when opening Edit Data.
        data: r.data,
        parent: rowId,
        geometry: box(0, 0, w, ROW_HEIGHT),
        styles: { ...CELL_STYLE, ...r.style },
      }),
    );
  });
  return { cells: out, h };
}

// Ids are built from model ids, so the same model always gives the same
// file and a cell keeps its id across renders.
const nodeId = (id) => `n|${id}`;
const rowId = (table, column) => `n|${table}|${column}`;
const groupId = (group) => `g|${group.id}`;
const edgeId = (link) => `e|${link.id}`;

function tableNode(n, parent, x, y, ctx) {
  const colors = ctx.colorOf(n.node.cluster);
  const t = n.node.table;
  const b = n.box;
  const columns = new Map(columnEntries(t).map((e) => [e.path, e]));
  // Columns and embedded entity titles in slot order, then facts and badges.
  const slots = [
    ...b.rows.map((r) => ({ y: r.centerY, row: r })),
    ...b.insets.map((e) => ({ y: e.title.centerY, inset: e })),
  ].sort((p, q) => p.y - q.y);
  const insetFill = '#f6f8fb';
  // Embedded columns are indented inside their entity's inset, as in the SVG.
  const pad = (depth) => PADDING_X - 2 + EMBED_INSET * depth;
  const inset = (depth) => ({ spacingLeft: pad(depth), spacingRight: pad(depth) });
  const rows = slots.map(({ row, inset: entity }) => {
    if (entity) return { label: measured(escapeHtml(entity.title.text)), fill: insetFill, style: { fontStyle: 1, fontColor: '#56627a', ...inset(1) } };
    const { column } = columns.get(row.column);
    return {
      id: rowId(t.id, row.column),
      label: rowHtml(row, n.w - 2 * pad(row.depth)),
      data: columnData(row.column, column, ctx.relations.column.get(`${t.id}|${row.column}`)),
      fill: row.depth > 0 ? insetFill : undefined,
      style: inset(row.depth),
    };
  });
  for (const f of b.facts) rows.push({ label: measured(escapeHtml(f.text.text)), style: { fontSize: 11, fontColor: '#5f6b7e' } });
  for (const badge of b.badges) rows.push({ label: measured(escapeHtml(`→ ${badge.label.text}`)), style: { fontSize: 11, fontColor: '#56627a' } });
  const kind = t.kind ?? 'table';
  const tag = b.tag ? ` ${b.tag.text}` : '';
  return tableCells(
    // As in the SVG: a table icon before the name, a star, stronger header
    // and thicker border for a central table.
    {
      id: nodeId(n.id),
      parent,
      x,
      y,
      w: n.w,
      title: gutterIcon(b.central ? 'central' : 'table') + escapeHtml(b.title.text + tag),
      header: b.central ? colors.central : colors.header,
      stroke: b.central ? colors.centralStroke : '#b8c2d0',
      strokeWidth: b.central ? 2 : null,
      dashed: kind === 'table' ? null : '5 3',
      titleColor: '#172033',
      data: { ...tableData(t, b.central), note: tableNote(t, ctx.keys.get(t.id), ctx.relations) },
      link: ctx.svgUrl ? `${ctx.svgUrl}#table=${encodeURIComponent(t.id)}` : undefined,
    },
    rows,
  );
}

function polyNode(n, parent, x, y) {
  const rows = n.box.rows.map((r) => ({ label: measured(escapeHtml(r.name.text)), style: { fontColor: '#4a4236' } }));
  return tableCells(
    { id: nodeId(n.id), parent, x, y, w: n.w, title: escapeHtml(n.box.title.text), header: '#fffdf7', stroke: '#a08a5c', dashed: '4 3', titleColor: '#6b5428' },
    rows,
  );
}

const shapeCommon = { rounded: 1, absoluteArcSize: 1, html: 0, whiteSpace: 'nowrap', overflow: 'hidden', align: 'left', spacingLeft: PADDING_X - 2 };

// Returns { cells, h }: the XML of the node and the height it is drawn at.
// `ctx` is the page context of pageXml.
function nodeCells(n, parent, x, y, ctx) {
  const { colorOf } = ctx;
  if (n.kind === 'table') return tableNode(n, parent, x, y, ctx);
  if (n.kind === 'poly') return polyNode(n, parent, x, y);
  if (n.kind === 'stub') {
    const cells = [
      cell({
        id: nodeId(n.id),
        value: n.box.title.full,
        parent,
        geometry: box(x, y, n.w, n.h),
        styles: { ...shapeCommon, arcSize: 12, dashed: 1, dashPattern: '3 3', fixDash: 1, fillColor: '#f3f5f8', strokeColor: '#c3cad5', fontColor: '#8a94a6', fontSize: 12 },
      }),
    ];
    return { cells, h: n.h };
  }
  // Tables of one other domain, as in the SVG's group stub: the domain's
  // name (and database) over the table names.
  if (n.kind === 'group') {
    const c = colorOf(n.group.key);
    const head = `<b style="color:${c.label}">${escapeHtml(n.box.title.full)}</b>${n.box.db ? ` <span style="font-size:10px;color:#56627a">${escapeHtml(n.box.db)}</span>` : ''}`;
    const rows = n.box.rows.map((r) => `<span style="color:#56627a">${escapeHtml(r.name.full)}</span>`);
    const cells = [
      cell({
        id: nodeId(n.id),
        value: [head, ...rows].join('<br>'),
        data: { tables: lines(n.group.tables) },
        link: ctx.pageLink(DOMAIN_VIEW_PREFIX + n.group.key),
        parent,
        geometry: box(x, y, n.w, n.h),
        styles: { ...shapeCommon, html: 1, verticalAlign: 'top', spacingTop: 6, arcSize: 12, dashed: 1, dashPattern: '3 3', fixDash: 1, fillColor: '#f7f8fa', strokeColor: '#c3cad5', fontSize: 12 },
      }),
    ];
    return { cells, h: n.h };
  }
  // Overview card, as in the SVG: name and table count, note, central
  // table, then the most related domains with a strength bar of filled and
  // empty squares; an accent bar in the domain's colour on its left edge.
  const c = colorOf(n.id);
  const b = n.box;
  const bar = (filled) => `<span style="color:#5d7fb8">${'■'.repeat(filled)}</span><span style="color:#d5dbe4">${'■'.repeat(STRENGTH_SEGMENTS - filled)}</span>`;
  const related = b.related.map((r) => {
    const label = colorOf(r.key).label;
    return `<span style="color:${label}">${escapeHtml(r.name.full)}</span>${r.db ? ` <span style="font-size:9px;color:#56627a">${escapeHtml(r.db)}</span>` : ''} ${bar(r.segments)}`;
  });
  const text = [
    `<b style="font-size:15px;color:${c.label}">${escapeHtml(b.title.full)}</b> <span style="color:#7a8597">· ${escapeHtml(b.count.full)}</span>`,
    b.note ? `<span style="color:#3d4a5e">${escapeHtml(b.note.full)}</span>` : null,
    b.central ? `<span style="color:#56627a">${escapeHtml(b.central.full)}</span>` : null,
    `<span style="font-size:11px;color:#8a94a6"><b>Related domains</b></span>`,
    ...(related.length > 0 ? related : ['<span style="color:#9aa4b5">No relations with other domains</span>']),
  ].filter(Boolean);
  const cells = [
    cell({
      id: nodeId(n.id),
      value: text.join('<br>'),
      // The page that shows this domain's tables.
      link: ctx.pageLink(ALL_VIEW) ?? ctx.pageLink(DOMAIN_VIEW_PREFIX + n.id),
      parent,
      geometry: box(x, y, n.w, n.h),
      styles: { ...shapeCommon, html: 1, whiteSpace: 'wrap', verticalAlign: 'top', spacingTop: 8, spacingLeft: 16, arcSize: 20, fillColor: '#ffffff', strokeColor: '#cfd6e0', fontSize: 12 },
    }),
    cell({
      id: `${nodeId(n.id)}|accent`,
      parent: nodeId(n.id),
      geometry: box(4, 12, 4, n.h - 24),
      styles: { rounded: 1, arcSize: 50, fillColor: c.label, strokeColor: 'none', movable: 0, resizable: 0, editable: 0 },
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
    value: [`${dbDisplayName(database)} · ${engineName(engine)}`, ...facts].join('  ·  '),
    parent,
    geometry: box(x, y, w, h),
    styles: { ...frame, arcSize: 32, spacingTop: 20, fontSize: 15, fillColor: '#fbfcfd', strokeColor: '#94a0b2', fontColor: '#1f2a3d' },
  });
}

// End of a connector: the column's row when the line names a column of a
// drawn table, else the node itself at the point where the line meets it
// (any side on the overview), as fractions of the node's drawn size.
function endpoint(link, side, point, byId, heights) {
  const n = byId.get(link[side].node);
  const fraction = (v) => Math.round(v * 1e4) / 1e4;
  const x = fraction((point[0] - n.x) / n.w);
  if (n.kind === 'table' && link[side].column !== null) return { id: rowId(n.id, link[side].column), x, y: 0.5 };
  return { id: nodeId(n.id), x, y: fraction((point[1] - n.y) / heights.get(n.id)) };
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
const waypointsOf = (points, origin) =>
  points
    .slice(1, -1)
    .map(([px, py]) => `<mxPoint x="${px - origin.x}" y="${py - origin.y}"/>`)
    .join('');
function labelOffset(points, label) {
  if (!label) return '';
  const { dx, dy } = labelAnchor(points, label);
  return dx === 0 && dy === 0 ? '' : `<mxPoint x="${dx}" y="${dy}" as="offset"/>`;
}

// `r` is a routed line: { link, points, markers, label? }. Lines on a
// hidden layer pass that layer as `parent` and their own id and style.
function edgeCell(r, byId, heights, origin, { id = edgeId(r.link), parent = '1', extra = {} } = {}) {
  const { link, points } = r;
  const source = endpoint(link, 'from', points[0], byId, heights);
  const target = endpoint(link, 'to', points.at(-1), byId, heights);
  const dash = dashPattern(link);
  return cell({
    id,
    value: r.label?.text ?? '',
    parent,
    vertex: false,
    source: source.id,
    target: target.id,
    geometry: `<mxGeometry${labelGeometry(points, r.label)} relative="1" as="geometry"><Array as="points">${waypointsOf(points, origin)}</Array>${labelOffset(points, r.label)}</mxGeometry>`,
    styles: {
      edgeStyle: 'orthogonalEdgeStyle',
      rounded: 0,
      orthogonalLoop: 1,
      html: 0,
      strokeColor: link.kind === VIEW_SOURCE ? VIEW_SOURCE_COLOR : LINE_COLOR,
      strokeWidth: 1.4,
      fontSize: 10,
      fontStyle: 1,
      fontColor: LABEL_COLOR,
      labelBackgroundColor: '#ffffff',
      dashed: dash ? 1 : 0,
      dashPattern: dash,
      fixDash: dash ? 1 : null,
      startArrow: ER_ARROWS[r.markers.from],
      endArrow: ER_ARROWS[r.markers.to],
      startFill: 0,
      endFill: 0,
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
  const hub = scene.hubRoutes.map((r) => edgeCell(r, byId, heights, origin, { id: `hub|${r.link.id}`, parent: HUB_LAYER.id }));
  // A polymorphic line runs from the node's header to the target's first
  // primary key column (the one the id column holds), as in the SVG.
  const poly = scene.polyRoutes.map((r) => {
    const t = byId.get(r.target);
    const column = t.kind === 'table' ? (t.node.table.columns.find((c) => c.pk) ?? t.node.table.columns[0]).name : null;
    const review = byId.get(r.poly).node.association.review;
    const link = { id: `${r.poly}->${r.target}`, from: { node: r.poly, column: null }, to: { node: r.target, column }, kind: 'polymorphic', review };
    return edgeCell({ link, points: r.points, markers: { from: 'none', to: 'none' } }, byId, heights, origin, { id: `poly|${link.id}`, parent: POLY_LAYER.id });
  });
  return [...layer(HUB_LAYER, hub), ...layer(POLY_LAYER, poly)];
}

function pageXml(scene, ctx) {
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
    cells.push(groupCell(g, at.parent, at.x, at.y, ctx.colorOf));
  }
  const heights = new Map();
  for (const n of scene.nodes) {
    const at = place(nodeId(n.id), n);
    // A table cell is shorter than its layout box (no bottom padding), so
    // header attachments are placed by the cell's own height.
    const drawn = nodeCells(n, at.parent, at.x, at.y, ctx);
    heights.set(n.id, drawn.h);
    cells.push(...drawn.cells);
  }
  const byId = new Map(scene.nodes.map((n) => [n.id, n]));
  // The overview has no lines (its scene draws cards only).
  for (const r of scene.relations) cells.push(edgeCell(r, byId, heights, origin));
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
 * The .drawio file: two pages, Overview and All tables (with the hub and
 * polymorphic layers). A schema too large for the view of all tables (see
 * ALL_VIEW_MAX_TABLES) has no such page; it gets one page per domain
 * instead, so every table is still in the file. Plain (uncompressed) XML
 * with no timestamps, so the same model and layout always give the same
 * bytes. Options are those of renderSvg's scenes (`fitStored` for a profile),
 * plus `svgUrl`: where the SVG of this render is hosted, which table headers
 * link to (no links when left out).
 */
export function renderDrawio(model, layout, { svgUrl, ...options } = {}) {
  const diagram = buildDiagram(model);
  const names = hasAllView(diagram) ? [OVERVIEW, ALL_VIEW] : viewNames(diagram).filter((n) => n !== ALL_VIEW);
  // A page's id is its view name, so links to a page stay valid across renders.
  const ctx = {
    colorOf: (key) => COLORS[layout.colors[key] % COLORS.length],
    relations: relationsOf(model),
    keys: keyColumns(model),
    svgUrl,
    pageLink: (name) => (names.includes(name) ? `data:page/id,${name}` : null),
  };
  const pages = names.map((name) => pageXml(buildScene(model, layout, name, diagram, options), ctx));
  return ['<mxfile host="open-erd" compressed="false">', ...pages, '</mxfile>', ''].join('\n');
}
