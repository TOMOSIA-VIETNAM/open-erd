import { measureText, truncate } from '../text/measure.js';

// Every coordinate and size in a layout is a multiple of GRID px. The router
// works on the same grid, so a router cell is always fully inside or fully
// outside a table box.
export const GRID = 10;

export const TITLE_FONT = { size: 13, weight: 700 };
export const COLUMN_FONT = { size: 12, weight: 400 };
export const PK_FONT = { size: 12, weight: 700 };
export const TYPE_FONT = { size: 12, weight: 400 };

export const HEADER_HEIGHT = 30;
export const ROW_HEIGHT = 20;
const BOTTOM_PADDING = 10;
export const BADGE_FONT = { size: 11, weight: 400 };
// The arrow in front of a hub badge is drawn as a path: the embedded Inter
// subset has no arrow glyph, and a fallback font would render at a width the
// metrics cannot predict.
export const BADGE_ARROW_WIDTH = 10;
const BADGE_ARROW_GAP = 5;
export const MUTED_TITLE_FONT = { size: 12, weight: 400 };
export const DOMAIN_TITLE_FONT = { size: 14, weight: 700 };
export const DOMAIN_COUNT_FONT = { size: 12, weight: 400 };
const DOMAIN_BOX_HEIGHT = 60;
// A polymorphic node lists this many targets at most; the rest collapse into
// one "+N more" row (all targets stay in the node's data for the viewer).
export const POLY_VISIBLE_TARGETS = 4;
export const PADDING_X = 12;
// Minimum space between a column name and its right-aligned type.
const NAME_TYPE_GAP = 16;
const MIN_WIDTH = 140;
const MAX_WIDTH = 360;
// A long type (e.g. `timestamp with time zone`) is cut before the name is.
const TYPE_SHARE = 0.4;

export function ceilToGrid(value) {
  return Math.ceil(value / GRID) * GRID;
}

export function roundToGrid(value) {
  return Math.round(value / GRID) * GRID;
}

function fit(text, maxWidth, font) {
  const result = truncate(text, maxWidth, font);
  return { ...result, full: text, width: measureText(result.text, font) };
}

export const FACT_FONT = { size: 11, weight: 400 };
export const TAG_FONT = { size: 10, weight: 700 };
// Embedded entities are drawn as an inset box this far inside the table's
// border; their rows are indented by the same amount on both sides.
export const EMBED_INSET = 6;
const TAG_GAP = 8;
const TAGS = { view: '«view»', materialized_view: '«materialized view»' };

/**
 * Size and text content of a table box, top to bottom:
 *   header      table name, plus a «view» tag right-aligned for views;
 *   rows        its columns, then each embedded entity as an inset with a
 *               title row and its own (indented, depth 1) column rows;
 *   facts       one muted line per special pattern (STI, partition, ...);
 *   badges      one line per hub target.
 * Facts and badges sit below one separator. Layout uses `w`/`h`; the
 * renderer uses the same object, so the box always fits the text it draws.
 * Offsets are relative to the box's top-left corner. Every row is ROW_HEIGHT
 * tall, so each column's attachment point stays on the layout grid.
 */
export function tableBox(table, badges = [], facts = []) {
  // The cluster frame already names the domain and the database; the full id
  // goes into the tooltip.
  const label = table.id.split('.')[2];
  const tagText = TAGS[table.kind];
  const tagWidth = tagText ? measureText(tagText, TAG_FONT) + TAG_GAP : 0;
  const titleWidth = measureText(label, TITLE_FONT);
  const columnWidth = (c) => measureText(c.name, c.pk ? PK_FONT : COLUMN_FONT) + NAME_TYPE_GAP + measureText(c.type, TYPE_FONT);
  const entityTitle = (e) => `${e.name}${e.array ? ' [ ]' : ''}`;
  const embedded = table.embedded ?? [];
  let natural = titleWidth + tagWidth + 2 * PADDING_X;
  for (const c of table.columns) natural = Math.max(natural, columnWidth(c) + 2 * PADDING_X);
  for (const e of embedded) {
    natural = Math.max(natural, measureText(entityTitle(e), COLUMN_FONT) + 2 * (PADDING_X + EMBED_INSET));
    for (const c of e.columns) natural = Math.max(natural, columnWidth(c) + 2 * (PADDING_X + EMBED_INSET));
  }
  for (const f of facts) natural = Math.max(natural, measureText(f, FACT_FONT) + 2 * PADDING_X);
  const badgeText = (b) => `${b.target.split('.')[2]} ×${b.count}`;
  for (const b of badges) {
    natural = Math.max(natural, BADGE_ARROW_WIDTH + BADGE_ARROW_GAP + measureText(badgeText(b), BADGE_FONT) + 2 * PADDING_X);
  }
  const w = Math.min(MAX_WIDTH, ceilToGrid(Math.max(MIN_WIDTH, natural)));
  const inner = w - 2 * PADDING_X;
  let slot = 0;
  const centerOf = () => HEADER_HEIGHT + ROW_HEIGHT * slot++ + ROW_HEIGHT / 2;
  const columnRow = (c, path, depth) => {
    const room = inner - 2 * EMBED_INSET * depth;
    const nameFont = c.pk ? PK_FONT : COLUMN_FONT;
    const type = fit(c.type, Math.min(measureText(c.type, TYPE_FONT), Math.max(room * TYPE_SHARE, room - NAME_TYPE_GAP - measureText(c.name, nameFont))), TYPE_FONT);
    const name = fit(c.name, room - NAME_TYPE_GAP - type.width, nameFont);
    return { column: path, pk: c.pk === true, depth, name, type, centerY: centerOf() };
  };
  const rows = table.columns.map((c) => columnRow(c, c.name, 0));
  const insets = embedded.map((e) => {
    const top = HEADER_HEIGHT + ROW_HEIGHT * slot;
    const title = { ...fit(entityTitle(e), inner - 2 * EMBED_INSET, COLUMN_FONT), centerY: centerOf() };
    rows.push(...e.columns.map((c) => columnRow(c, `${e.name}.${c.name}`, 1)));
    return { entity: e.name, top, h: HEADER_HEIGHT + ROW_HEIGHT * slot - top, title };
  });
  const columnsEnd = HEADER_HEIGHT + ROW_HEIGHT * slot;
  const footer = facts.length + badges.length > 0;
  const footerTop = columnsEnd + (footer ? BOTTOM_PADDING / 2 : 0);
  const factRows = facts.map((f, i) => ({ text: fit(f, inner, FACT_FONT), centerY: footerTop + ROW_HEIGHT * i + ROW_HEIGHT / 2 }));
  const badgeTop = footerTop + ROW_HEIGHT * facts.length;
  const badgeRows = badges.map((b, i) => ({
    ...b,
    label: fit(badgeText(b), inner - BADGE_ARROW_WIDTH - BADGE_ARROW_GAP, BADGE_FONT),
    labelX: PADDING_X + BADGE_ARROW_WIDTH + BADGE_ARROW_GAP,
    centerY: badgeTop + ROW_HEIGHT * i + ROW_HEIGHT / 2,
  }));
  return {
    kind: 'table',
    w,
    h: badgeTop + ROW_HEIGHT * badges.length + BOTTOM_PADDING,
    title: { ...fit(label, inner - tagWidth, TITLE_FONT), centerY: HEADER_HEIGHT / 2 },
    tag: tagText ? { ...fit(tagText, tagWidth - TAG_GAP, TAG_FONT), centerY: HEADER_HEIGHT / 2 } : null,
    rows,
    insets,
    separatorY: footer ? footerTop : null,
    facts: factRows,
    badges: badgeRows,
  };
}

function rowsBox(kind, titleText, titleFont, lines, lineFont) {
  let natural = measureText(titleText, titleFont) + 2 * PADDING_X;
  for (const l of lines) natural = Math.max(natural, measureText(l, lineFont) + 2 * PADDING_X);
  const w = Math.min(MAX_WIDTH, ceilToGrid(Math.max(MIN_WIDTH, natural)));
  const inner = w - 2 * PADDING_X;
  return {
    kind,
    w,
    // Line ends must sit on the layout grid, so a box without rows is one grid
    // step taller than a header and attaches (and centres its title) at 20 px.
    h: lines.length === 0 ? HEADER_HEIGHT + GRID : HEADER_HEIGHT + ROW_HEIGHT * lines.length + BOTTOM_PADDING,
    title: { ...fit(titleText, inner, titleFont), centerY: lines.length === 0 ? (HEADER_HEIGHT + GRID) / 2 : HEADER_HEIGHT / 2 },
    rows: lines.map((l, i) => ({ name: fit(l, inner, lineFont), centerY: HEADER_HEIGHT + ROW_HEIGHT * i + ROW_HEIGHT / 2 })),
  };
}

/** Virtual node of a polymorphic association: «name» over its target tables. */
export function polyBox(association) {
  const names = association.targets.map((t) => t.split('.')[2]);
  const lines =
    names.length > POLY_VISIBLE_TARGETS ? [...names.slice(0, POLY_VISIBLE_TARGETS), `+${names.length - POLY_VISIBLE_TARGETS} more`] : names;
  return rowsBox('poly', `«${association.name}»`, TITLE_FONT, lines, COLUMN_FONT);
}

/** Muted name-only box for a table outside the domain shown by a domain view. */
export function stubBox(table) {
  return rowsBox('stub', table.id.split('.')[2], MUTED_TITLE_FONT, [], COLUMN_FONT);
}

/** Overview box of one domain: its name and table count. */
export function domainBox(label, count) {
  const countText = `${count} ${count === 1 ? 'table' : 'tables'}`;
  const w = Math.min(MAX_WIDTH, ceilToGrid(Math.max(MIN_WIDTH, measureText(label, DOMAIN_TITLE_FONT) + 2 * PADDING_X, measureText(countText, DOMAIN_COUNT_FONT) + 2 * PADDING_X)));
  const inner = w - 2 * PADDING_X;
  return {
    kind: 'domain',
    w,
    h: DOMAIN_BOX_HEIGHT,
    title: { ...fit(label, inner, DOMAIN_TITLE_FONT), centerY: 22 },
    count: { ...fit(countText, inner, DOMAIN_COUNT_FONT), centerY: 42 },
  };
}

/** Vertical offset of the row holding `column`, where relation lines attach. */
export function rowCenter(box, column) {
  return box.rows.find((r) => r.column === column).centerY;
}

/**
 * Where a line attaches on a box side: the column's row for tables, the
 * header of a polymorphic node (it stands for the whole association) and of
 * a table when the line names no column (a view's line to its sources), the
 * middle of stubs and domain boxes.
 */
export function attachOffset(box, column) {
  if (box.kind === 'table' && column !== null) return rowCenter(box, column);
  // The header centre (15 px) is off the grid; one grid step lower still
  // lands inside the header.
  if (box.kind === 'poly' || box.kind === 'table') return roundToGrid(HEADER_HEIGHT / 2);
  return box.h / 2;
}
