import ExcelJS from 'exceljs';
import { columnEntries } from '../../model/columns.js';
import { compareStrings } from '../../model/load.js';
import { KIND_TRUST, REVIEW_TRUST, databaseFacts, tableFacts } from '../../layout/diagram.js';
import { FULL_WIDTH } from '../../text/measure.js';
import { changeLabel, describeChange, showValue } from '../../diff/changes.js';
import { rebuildZip } from './zip.js';

// The spreadsheet twin of the diagram: one row per fact, for readers who
// filter and sort instead of looking at a picture, and the checklist a
// reviewer works through. Every sheet goes through addSheet, so header
// style, frozen header, filter and widths can never differ between sheets.

const HEADER_FILL = 'FF334155';
const GROUP_FILL = 'FFE2E8F0';
const MIN_WIDTH = 8;
const MAX_WIDTH = 60;

const yesNo = (value) => (value === undefined ? '' : value ? 'yes' : 'no');
const flag = (value) => (value ? 'yes' : '');
const lines = (list) => (list ?? []).join('\n');
const tableName = (id) => id.split('.')[2];
const endText = (end) => `${end.table}.${end.columns.join(', ')}`;

/**
 * A cell that jumps to `row` of `sheet` when clicked. exceljs writes every
 * hyperlink as an external relationship; serializeWorkbook turns these
 * (target starting with '#', text carried as tooltip) into in-workbook links.
 */
export const link = (text, sheet, row) => ({ text, hyperlink: `#'${sheet}'!A${row}`, tooltip: text });

const cellText = (cell) => String(cell?.text ?? cell ?? '');

// Excel column width is in characters of the default font; a CJK
// character takes two.
const textWidth = (line) => [...line].reduce((n, ch) => n + (FULL_WIDTH.test(ch) ? 2 : 1), 0);

function widthOf(header, rows, index) {
  const longest = Math.max(textWidth(header), ...rows.map((r) => Math.max(...cellText(r[index]).split('\n').map(textWidth))));
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, longest + 2));
}

/**
 * Appends a sheet: `columns` are `{ header, wrap? }`, `rows` arrays of
 * strings, numbers or link() cells; `groupRows` (row indexes into `rows`)
 * are drawn as bold section rows. Header row frozen and filterable.
 */
export function addSheet(workbook, name, columns, rows, { groupRows = [] } = {}) {
  const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = columns.map((c, i) => ({ header: c.header, width: widthOf(c.header, rows, i) }));
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
  header.alignment = { vertical: 'middle' };
  for (const values of rows) sheet.addRow(values.map((v) => v ?? ''));
  columns.forEach((c, i) => {
    if (c.wrap) sheet.getColumn(i + 1).alignment = { wrapText: true, vertical: 'top' };
  });
  for (const r of groupRows) {
    const row = sheet.getRow(r + 2);
    row.font = { bold: true };
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GROUP_FILL } };
  }
  for (let r = 2; r <= rows.length + 1; r++) {
    sheet.getRow(r).eachCell((cell) => {
      if (cell.hyperlink) cell.font = { ...(cell.font ?? {}), color: { argb: 'FF1D4ED8' }, underline: true };
    });
  }
  if (rows.length > 0) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return sheet;
}

// The untranslated original and the team-only note. Sharing profiles drop
// both by default, which leaves these columns empty in a shared file.
const NOTE_COLUMNS = [{ header: 'Original note', wrap: true }, { header: 'Internal note', wrap: true }];
const extraNotes = (item) => [item.note_source ?? '', item.internal_note ?? ''];

const SHEETS = {
  overview: 'Overview',
  tables: 'Tables',
  columns: 'Columns',
  relations: 'Relations',
  enums: 'Enums',
  polymorphic: 'Polymorphic',
  review: 'To review',
  changes: 'Changes',
};

// Row of each table on the Tables sheet: one row per table, in model order.
const tableRows = (model) => new Map(model.tables.map((t, i) => [t.id, i + 2]));

function tenancyOf(model) {
  const byKey = new Map(model.databases.flatMap((db) => (db.tenant_schemas ?? []).map((t) => [`${db.database}.${t.schema}`, t])));
  return (t) => byKey.get(t.id.split('.').slice(0, 2).join('.')) ?? null;
}

function tableFlags(t, tenancy) {
  return [
    ...(t.sources ? [`reads ${t.sources.join(', ')}`] : []),
    ...tableFacts(t, tenancy),
    ...(t.embedded ?? []).map((e) => `embedded ${e.name}${e.array ? '[]' : ''}`),
    ...(t.renamed_from ? [`renamed from ${t.renamed_from}`] : []),
  ];
}

// Least certain first: stale before pending, then inferred before
// cross-DB, declared and database constraints, then by table.
function reviewQueue(model) {
  const items = [
    ...model.relations.map((r, i) => ({ fact: r, sheet: SHEETS.relations, row: i + 2, kind: r.kind, table: r.from.table })),
    ...model.polymorphic.map((a, i) => ({ fact: a, sheet: SHEETS.polymorphic, row: i + 2, kind: 'polymorphic', table: a.table })),
  ].filter((item) => item.fact.review !== 'reviewed');
  const kindRank = (kind) => (kind === 'polymorphic' ? -1 : KIND_TRUST.indexOf(kind));
  return items.sort(
    (a, b) =>
      REVIEW_TRUST.indexOf(b.fact.review) - REVIEW_TRUST.indexOf(a.fact.review) ||
      kindRank(b.kind) - kindRank(a.kind) ||
      compareStrings(a.table, b.table) ||
      a.row - b.row,
  );
}

function describe(item) {
  const f = item.fact;
  if (item.kind === 'polymorphic') return `${f.table}.${f.type_column} + ${f.id_column} → «${f.name}»: ${f.targets.join(', ')}`;
  return `${endText(f.from)} → ${endText(f.to)} (${f.cardinality}${f.optional ? ', optional' : ''})`;
}

/**
 * Workbook of `model` (already filtered by a sharing profile, if any), with
 * sheets in reading order. More sheets can be appended with addSheet before
 * serializeWorkbook.
 */
export function buildWorkbook(model) {
  const workbook = new ExcelJS.Workbook();
  const tenancy = tenancyOf(model);
  const tableRow = tableRows(model);
  const tableLink = (id) => link(id, SHEETS.tables, tableRow.get(id));

  // Overview: databases, their domains and tables as an indented list, with
  // the counts that tell a reader how big the system is.
  const overview = [];
  const groupRows = [];
  for (const db of model.databases) {
    const tables = model.tables.filter((t) => t.id.split('.')[0] === db.database);
    groupRows.push(overview.length);
    overview.push([db.database, db.engine, '', '', tables.length, databaseFacts(db).join('\n')]);
    for (const domain of [...new Set(tables.map((t) => t.domain))].sort(compareStrings)) {
      const inDomain = tables.filter((t) => t.domain === domain);
      overview.push(['', '', domain, '', inDomain.length, '']);
      for (const t of inDomain) overview.push(['', '', '', link(tableName(t.id), SHEETS.tables, tableRow.get(t.id)), '', t.note ?? '']);
    }
  }
  const queue = reviewQueue(model);
  const count = (review) => queue.filter((item) => item.fact.review === review).length;
  const summary = [
    ['Databases', model.databases.length],
    ['Domains', new Set(model.tables.map((t) => `${t.id.split('.')[0]}\u0000${t.domain}`)).size],
    ['Tables', model.tables.length],
    ['Columns', model.tables.reduce((n, t) => n + columnEntries(t).length, 0)],
    ['Relations', model.relations.length],
    ['Polymorphic associations', model.polymorphic.length],
    ['Pending review', count('pending')],
    ['Stale (code changed)', count('stale')],
  ];
  const sheet = addSheet(
    workbook,
    SHEETS.overview,
    [{ header: 'Database' }, { header: 'Engine' }, { header: 'Domain' }, { header: 'Table' }, { header: 'Tables' }, { header: 'Note', wrap: true }],
    overview,
    { groupRows },
  );
  // Summary sits beside the list so the list keeps the frozen header and filter.
  sheet.getColumn(8).width = Math.max(...summary.map(([label]) => label.length)) + 2;
  sheet.getCell('H1').value = 'Summary';
  sheet.getCell('I1').value = 'Count';
  summary.forEach(([label, n], i) => {
    sheet.getCell(`H${i + 2}`).value = label;
    sheet.getCell(`I${i + 2}`).value = n;
  });
  sheet.getCell(`H${summary.length + 2}`).value = link('Open the review checklist', SHEETS.review, 1);
  sheet.getCell(`H${summary.length + 2}`).font = { color: { argb: 'FF1D4ED8' }, underline: true };

  const columnRows = [];
  const firstColumnRow = new Map();
  for (const t of model.tables) {
    firstColumnRow.set(t.id, columnRows.length + 2);
    for (const { path, column: c } of columnEntries(t)) {
      const enumText = Object.entries(c.enum ?? {}).map(([value, meaning]) => `${value}: ${meaning}`);
      columnRows.push([t.id.split('.')[0], tableLink(t.id), path, c.type, yesNo(c.nullable), flag(c.pk), flag(c.unique), lines(enumText), c.note ?? '', ...extraNotes(c), flag(c.pii)]);
    }
  }

  addSheet(
    workbook,
    SHEETS.tables,
    [{ header: 'Database' }, { header: 'Schema' }, { header: 'Domain' }, { header: 'Table' }, { header: 'Kind' }, { header: 'Note', wrap: true }, ...NOTE_COLUMNS, { header: 'Columns' }, { header: 'Flags', wrap: true }],
    model.tables.map((t) => {
      const [db, schema, name] = t.id.split('.');
      return [db, schema, t.domain, link(name, SHEETS.columns, firstColumnRow.get(t.id)), t.kind ?? 'table', t.note ?? '', ...extraNotes(t), columnEntries(t).length, lines(tableFlags(t, tenancy(t)))];
    }),
  );

  addSheet(
    workbook,
    SHEETS.columns,
    [{ header: 'Database' }, { header: 'Table' }, { header: 'Column' }, { header: 'Type' }, { header: 'Nullable' }, { header: 'PK' }, { header: 'Unique' }, { header: 'Enum values', wrap: true }, { header: 'Note', wrap: true }, ...NOTE_COLUMNS, { header: 'PII' }],
    columnRows,
  );

  addSheet(
    workbook,
    SHEETS.relations,
    [{ header: 'From' }, { header: 'From columns' }, { header: 'To' }, { header: 'To columns' }, { header: 'Cardinality' }, { header: 'Optional' }, { header: 'Kind' }, { header: 'Review' }, { header: 'Evidence', wrap: true }],
    model.relations.map((r) => [tableLink(r.from.table), r.from.columns.join(', '), tableLink(r.to.table), r.to.columns.join(', '), r.cardinality, yesNo(r.optional), r.kind, r.review, lines(r.evidence)]),
  );

  addSheet(
    workbook,
    SHEETS.enums,
    [{ header: 'Table' }, { header: 'Column' }, { header: 'Value' }, { header: 'Meaning', wrap: true }],
    model.tables.flatMap((t) =>
      columnEntries(t).flatMap(({ path, column: c }) => Object.entries(c.enum ?? {}).map(([value, meaning]) => [tableLink(t.id), path, value, meaning])),
    ),
  );

  addSheet(
    workbook,
    SHEETS.polymorphic,
    [{ header: 'Table' }, { header: 'Association' }, { header: 'Type column' }, { header: 'Id column' }, { header: 'Optional' }, { header: 'Targets', wrap: true }, { header: 'Review' }, { header: 'Evidence', wrap: true }],
    model.polymorphic.map((a) => [tableLink(a.table), a.name, a.type_column, a.id_column, yesNo(a.optional), lines(a.targets), a.review, lines(a.evidence)]),
  );

  addSheet(
    workbook,
    SHEETS.review,
    [{ header: 'Review' }, { header: 'Kind' }, { header: 'Fact' }, { header: 'Evidence', wrap: true }],
    queue.map((item) => [item.fact.review, item.kind, link(describe(item), item.sheet, item.row), lines(item.fact.evidence)]),
  );
  return workbook;
}

/**
 * Appends the Changes sheet of a diff to the workbook of the "to" side
 * (`model`, as passed to buildWorkbook), one row per change in diff order,
 * and opens the file on it. A table still present links to its Tables row;
 * a removed table has no row to link to.
 */
export function addChangesSheet(workbook, model, changes) {
  const tableRow = tableRows(model);
  const tableCell = (id) => (id === null ? '' : tableRow.has(id) ? link(id, SHEETS.tables, tableRow.get(id)) : id);
  addSheet(
    workbook,
    SHEETS.changes,
    [{ header: 'Database' }, { header: 'Table' }, { header: 'Change' }, { header: 'Detail', wrap: true }, { header: 'Before', wrap: true }, { header: 'After', wrap: true }],
    changes.map((c) => [c.database, tableCell(c.table), changeLabel(c.kind), describeChange(c), showValue(c.before), showValue(c.after)]),
  );
  workbook.views = [{ activeTab: workbook.worksheets.length - 1 }];
}

/**
 * The .xlsx bytes. `date` becomes the document's created/modified time; the
 * caller derives it from something stable (never the clock) so the same
 * workspace always gives the same bytes.
 */
export async function serializeWorkbook(workbook, { date }) {
  workbook.creator = 'open-erd';
  workbook.lastModifiedBy = 'open-erd';
  workbook.created = date;
  workbook.modified = date;
  return rebuildZip(Buffer.from(await workbook.xlsx.writeBuffer()), internalLinks);
}

const SHEET_PART = /^xl\/worksheets\/(sheet\d+\.xml)$/;
const SHEET_RELS_PART = /^xl\/worksheets\/_rels\/(sheet\d+\.xml)\.rels$/;
const RELATIONSHIP = /<Relationship ([^>]*?)\/>/g;
const HYPERLINK = /<hyperlink ([^>]*?)\/>/g;
const attributes = (text) => Object.fromEntries([...text.matchAll(/([\w:]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const isInternal = (rel) => rel.TargetMode === 'External' && rel.Target.startsWith('#');

// Internal hyperlinks of a sheet's relationships part, by relationship id.
function internalTargets(relsXml) {
  const targets = new Map();
  for (const m of (relsXml ?? '').matchAll(RELATIONSHIP)) {
    const rel = attributes(m[1]);
    if (isInternal(rel)) targets.set(rel.Id, rel.Target.slice(1));
  }
  return targets;
}

/**
 * zip rewrite turning exceljs's links to a cell of this workbook into the
 * form OOXML defines for them: `<hyperlink ref location display/>` with no
 * relationship. Excel follows exceljs's external "#Sheet!A1" form, but
 * Numbers and LibreOffice treat it as a broken URL. A relationships part
 * left without entries is dropped.
 */
function internalLinks(name, read) {
  const sheet = SHEET_PART.exec(name);
  if (sheet) {
    const targets = internalTargets(read(`xl/worksheets/_rels/${sheet[1]}.rels`));
    if (targets.size === 0) return undefined;
    return read(name).replace(HYPERLINK, (whole, attrs) => {
      const a = attributes(attrs);
      const target = targets.get(a['r:id']);
      if (target === undefined) return whole;
      return `<hyperlink ref="${a.ref}" location="${target}"${a.tooltip === undefined ? '' : ` display="${a.tooltip}"`}/>`;
    });
  }
  if (SHEET_RELS_PART.test(name)) {
    const xml = read(name);
    if (internalTargets(xml).size === 0) return undefined;
    const kept = xml.replace(RELATIONSHIP, (whole, attrs) => (isInternal(attributes(attrs)) ? '' : whole));
    return kept.includes('<Relationship ') ? kept : null;
  }
  return undefined;
}
