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
// Overview card of a domain. Every card of a schema has the same size
// whatever it says, so editing a note never moves a card or makes
// layout.json stale. A schema without any domain note leaves the note band
// out of every card (NOTE_BAND shorter); a card without a note in a schema
// with some moves its central table and related domains up, so the free
// space is at the bottom rather than a gap in the middle.
export const CARD_TITLE_FONT = { size: 15, weight: 700 };
export const CARD_TEXT_FONT = { size: 12, weight: 400 };
export const CARD_LABEL_FONT = { size: 11, weight: 700 };
export const CARD_DB_FONT = { size: 9, weight: 700 };
export const CARD = {
  w: 300,
  h: 200,
  // Colour bar along the left edge; text starts after it.
  accent: 5,
  padX: 18,
  titleY: 24,
  noteY: [48, 65],
  centralY: 90,
  dividerY: 106,
  relatedLabelY: 121,
  relatedY: [141, 160, 179],
  // Strength bar at the right end of a related row.
  segment: { w: 9, h: 6, gap: 2 },
  // Space kept between a related name (with its db tag) and the bar.
  barGap: 10,
  dbGap: 5,
  // Small colour square before a related domain's name.
  swatch: 14,
  // Height of the two note lines.
  noteBand: 40,
};
// A polymorphic node lists this many targets at most; the rest collapse into
// one "+N more" row (all targets stay in the node's data for the viewer).
export const POLY_VISIBLE_TARGETS = 4;
export const PADDING_X = 12;
// Minimum space between a column name and its right-aligned type.
const NAME_TYPE_GAP = 16;
const MIN_WIDTH = 140;
const MAX_WIDTH = 360;
// Marks right after a column name: a small list icon for a column with enum
// values (its tooltip lists them), a bolt for a column in an index. Every
// column has a note, so a note gets no mark. The first mark sits inside the
// NAME_TYPE_GAP the row keeps anyway; each further one widens the row by
// HINT_STEP.
export const HINT_OFFSET = 7;
export const HINT_SIZE = 8;
export const HINT_STEP = 12;
// Left gutter of every row and of the header: a key icon for a primary key
// column, a link icon for a column referencing another table, the table (or,
// for a central table, star) icon in the header. Always reserved, so names
// line up whether or not a row has an icon.
export const ICON_GUTTER = 15;
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
 *   facts       one muted line per special pattern (STI, partition, ...),
 *               each as parts { text, code } (see tableFacts);
 *   badges      one line per hub target (`→ users ×2`), then one per hub
 *               association (`«created_by» → users | admins`).
 * Facts and badges sit below one separator. Layout uses `w`/`h`; the
 * renderer uses the same object, so the box always fits the text it draws.
 * Offsets are relative to the box's top-left corner. Every row is ROW_HEIGHT
 * tall, so each column's attachment point stays on the layout grid.
 */
export function tableBox(table, badges = [], facts = [], { fk = new Set(), indexed = new Set(), central = false } = {}) {
  // The cluster frame already names the domain and the database; the full id
  // goes into the tooltip.
  const label = table.id.split('.')[2];
  const tagText = TAGS[table.kind];
  const tagWidth = tagText ? measureText(tagText, TAG_FONT) + TAG_GAP : 0;
  const titleWidth = ICON_GUTTER + measureText(label, TITLE_FONT);
  const hintsOf = (c, path) => [c.enum && Object.keys(c.enum).length > 0 ? 'enum' : null, indexed.has(path) ? 'index' : null].filter(Boolean);
  const hintsWidth = (hints) => Math.max(0, hints.length - 1) * HINT_STEP;
  const columnWidth = (c, path) =>
    ICON_GUTTER + measureText(c.name, c.pk ? PK_FONT : COLUMN_FONT) + hintsWidth(hintsOf(c, path)) + NAME_TYPE_GAP + measureText(c.type, TYPE_FONT);
  const entityTitle = (e) => `${e.name}${e.array ? ' [ ]' : ''}`;
  const embedded = table.embedded ?? [];
  let natural = titleWidth + tagWidth + 2 * PADDING_X;
  for (const c of table.columns) natural = Math.max(natural, columnWidth(c, c.name) + 2 * PADDING_X);
  for (const e of embedded) {
    natural = Math.max(natural, measureText(entityTitle(e), COLUMN_FONT) + 2 * (PADDING_X + EMBED_INSET));
    for (const c of e.columns) natural = Math.max(natural, columnWidth(c, `${e.name}.${c.name}`) + 2 * (PADDING_X + EMBED_INSET));
  }
  const factStrings = facts.map((parts) => parts.map((p) => p.text).join(''));
  for (const f of factStrings) natural = Math.max(natural, measureText(f, FACT_FONT) + 2 * PADDING_X);
  const badgeText = (b) => (b.association ? b.targets.map((t) => t.split('.')[2]).join(' | ') : `${b.target.split('.')[2]} ×${b.count}`);
  const badgeName = (b) => (b.association ? `«${b.association}»` : '');
  // A hub association's name goes before the arrow, its targets after it.
  const nameRoom = (b) => (b.association ? measureText(badgeName(b), BADGE_FONT) + BADGE_ARROW_GAP : 0);
  for (const b of badges) {
    natural = Math.max(natural, nameRoom(b) + BADGE_ARROW_WIDTH + BADGE_ARROW_GAP + measureText(badgeText(b), BADGE_FONT) + 2 * PADDING_X);
  }
  const w = Math.min(MAX_WIDTH, ceilToGrid(Math.max(MIN_WIDTH, natural)));
  const inner = w - 2 * PADDING_X;
  let slot = 0;
  const centerOf = () => HEADER_HEIGHT + ROW_HEIGHT * slot++ + ROW_HEIGHT / 2;
  const columnRow = (c, path, depth) => {
    const hints = hintsOf(c, path);
    const room = inner - 2 * EMBED_INSET * depth - ICON_GUTTER - hintsWidth(hints);
    const nameFont = c.pk ? PK_FONT : COLUMN_FONT;
    const type = fit(c.type, Math.min(measureText(c.type, TYPE_FONT), Math.max(room * TYPE_SHARE, room - NAME_TYPE_GAP - measureText(c.name, nameFont))), TYPE_FONT);
    const name = fit(c.name, room - NAME_TYPE_GAP - type.width, nameFont);
    return {
      column: path,
      pk: c.pk === true,
      key: c.pk ? 'pk' : fk.has(path) ? 'fk' : null,
      depth,
      name,
      type,
      // x of each mark's centre, relative to the start of the name.
      hints: hints.map((kind, i) => ({ kind, x: name.width + HINT_OFFSET + i * HINT_STEP })),
      centerY: centerOf(),
    };
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
  const factRows = facts.map((parts, i) => ({ text: fit(factStrings[i], inner, FACT_FONT), parts, centerY: footerTop + ROW_HEIGHT * i + ROW_HEIGHT / 2 }));
  const badgeTop = footerTop + ROW_HEIGHT * facts.length;
  const badgeRows = badges.map((b, i) => {
    // The name keeps at most half the line; the targets are cut first.
    const name = b.association ? fit(badgeName(b), inner / 2, BADGE_FONT) : null;
    const arrowX = PADDING_X + (name ? name.width + BADGE_ARROW_GAP : 0);
    const labelX = arrowX + BADGE_ARROW_WIDTH + BADGE_ARROW_GAP;
    return {
      ...b,
      ...(name ? { name } : {}),
      arrowX,
      label: fit(badgeText(b), inner - (labelX - PADDING_X), BADGE_FONT),
      labelX,
      centerY: badgeTop + ROW_HEIGHT * i + ROW_HEIGHT / 2,
    };
  });
  return {
    kind: 'table',
    w,
    h: badgeTop + ROW_HEIGHT * badges.length + BOTTOM_PADDING,
    central,
    title: { ...fit(label, inner - tagWidth - ICON_GUTTER, TITLE_FONT), centerY: HEADER_HEIGHT / 2 },
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

// A group stub lists this many tables at most; the rest collapse into one
// "+N more" row (the full list is in its tooltip).
const GROUP_VISIBLE_TABLES = 8;
export const GROUP_DB_FONT = { size: 10, weight: 700 };
const GROUP_DB_GAP = 8;

/**
 * Box standing for several tables of one other domain in a domain view:
 * the domain's name (and its database, `db`, when that differs) over one
 * row per table.
 */
export function groupBox(domain, tableIds, db = null) {
  const names = tableIds.map((t) => t.split('.')[2]);
  const lines = names.length > GROUP_VISIBLE_TABLES ? [...names.slice(0, GROUP_VISIBLE_TABLES), `+${names.length - GROUP_VISIBLE_TABLES} more`] : names;
  const dbWidth = db ? Math.ceil(measureText(db, GROUP_DB_FONT)) + 10 + GROUP_DB_GAP : 0;
  const box = rowsBox('group', domain, TITLE_FONT, lines, COLUMN_FONT);
  const w = Math.min(MAX_WIDTH, ceilToGrid(Math.max(box.w, measureText(domain, TITLE_FONT) + dbWidth + 2 * PADDING_X)));
  const inner = w - 2 * PADDING_X;
  return {
    ...box,
    w,
    title: { ...fit(domain, inner - dbWidth, TITLE_FONT), centerY: box.title.centerY },
    rows: box.rows.map((r, i) => ({ ...r, name: fit(lines[i], inner, COLUMN_FONT), table: i < GROUP_VISIBLE_TABLES ? tableIds[i] : null })),
    db,
  };
}

/** Muted name-only box for a table outside the domain shown by a domain view. */
export function stubBox(table) {
  return rowsBox('stub', table.id.split('.')[2], MUTED_TITLE_FONT, [], COLUMN_FONT);
}

/**
 * `text` on at most two lines of `width` px: words go on the first line
 * while they fit (a first word wider than the line, as in CJK text without
 * spaces, is cut by characters), the rest on the second, cut with an
 * ellipsis when too long. Returns the fitted lines.
 */
function wrapTwoLines(text, width, font) {
  const clean = text.trim().replace(/\s+/g, ' ');
  const words = clean.split(' ');
  let first = '';
  let used = 0;
  for (const word of words) {
    const next = first ? `${first} ${word}` : word;
    if (measureText(next, font) > width) break;
    first = next;
    used += 1;
  }
  if (used === words.length) return [{ text: first, truncated: false }];
  if (!first) {
    for (const ch of clean) {
      if (measureText(first + ch, font) > width) break;
      first += ch;
    }
    return [{ text: first, truncated: false }, truncate(clean.slice(first.length).trim(), width, font)];
  }
  return [{ text: first, truncated: false }, truncate(words.slice(used).join(' '), width, font)];
}

const barWidth = (segments) => segments * CARD.segment.w + (segments - 1) * CARD.segment.gap;

/**
 * Overview card of one domain (an entry of domainSummary): name, table
 * count, business note on two lines, central table, and the domains it is
 * most related to, each with `segments` of a strength bar filled. Cross-DB
 * related domains carry their database as a small tag. Fixed size (CARD).
 */
export function domainCard(card, { related, segments, total, withNotes = true }) {
  const up = card.note ? 0 : CARD.noteBand;
  const inner = CARD.w - CARD.padX - CARD.padX;
  const countText = `${card.tables} ${card.tables === 1 ? 'table' : 'tables'}`;
  const countWidth = Math.ceil(measureText(countText, CARD_TEXT_FONT));
  const centralText = card.central ? `Central: ${card.central.split('.')[2]}` : null;
  const rowRoom = inner - CARD.swatch - barWidth(total) - CARD.barGap;
  return {
    kind: 'domain',
    w: CARD.w,
    h: withNotes ? CARD.h : CARD.h - CARD.noteBand,
    layout: { dividerY: CARD.dividerY - up, relatedLabelY: CARD.relatedLabelY - up, relatedY: CARD.relatedY.map((y) => y - up) },
    title: { ...fit(card.name, inner - countWidth - 12, CARD_TITLE_FONT), centerY: CARD.titleY },
    count: { ...fit(countText, countWidth, CARD_TEXT_FONT), centerY: CARD.titleY },
    note: card.note ? { full: card.note, lines: wrapTwoLines(card.note, inner, CARD_TEXT_FONT).map((l, i) => ({ ...l, centerY: CARD.noteY[i] })) } : null,
    central: centralText ? { ...fit(centralText, inner - ICON_GUTTER, CARD_TEXT_FONT), centerY: CARD.centralY - up } : null,
    related: related.map((r, i) => {
      const db = r.crossDb ? r.key.split('/')[0] : null;
      const dbWidth = db ? Math.ceil(measureText(db, CARD_DB_FONT)) + 8 + CARD.dbGap : 0;
      return {
        key: r.key,
        count: r.count,
        segments: segments[i],
        name: fit(r.key.slice(r.key.indexOf('/') + 1), rowRoom - dbWidth, CARD_TEXT_FONT),
        db,
        centerY: CARD.relatedY[i] - up,
      };
    }),
  };
}

/** Vertical offset of the row holding `column`, where relation lines attach. */
function rowCenter(box, column) {
  return box.rows.find((r) => r.column === column).centerY;
}

/**
 * Where a line attaches on a box side: the column's row for tables, the
 * header of a polymorphic node (it stands for the whole association), of a
 * group stub (it stands for several tables) and of a table when the line
 * names no column (a view's line to its sources), the
 * middle of stubs and domain boxes.
 */
export function attachOffset(box, column) {
  if (box.kind === 'table' && column !== null) return rowCenter(box, column);
  // The header centre (15 px) is off the grid; one grid step lower still
  // lands inside the header.
  if (box.kind === 'poly' || box.kind === 'table' || box.kind === 'group') return roundToGrid(HEADER_HEIGHT / 2);
  return box.h / 2;
}
