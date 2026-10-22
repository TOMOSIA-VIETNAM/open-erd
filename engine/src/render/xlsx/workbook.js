import ExcelJS from 'exceljs';
import { columnEntries, enumMeaning } from '../../model/columns.js';
import { compareStrings } from '../../model/load.js';
import { KIND_TRUST, REVIEW_TRUST, databaseFacts, tableFacts } from '../../layout/diagram.js';
import { FULL_WIDTH } from '../../text/measure.js';
import { changeLabel, describeChange, showValue } from '../../diff/changes.js';
import { rebuildZip } from './zip.js';

// The spreadsheet twin of the diagram, laid out like a database client:
// an Overview listing every table, then one sheet per table with its column
// grid, then the relation lists and the checklist a reviewer works through.
// Every sheet goes through addSheet, so header style, frozen header, filter
// and widths can never differ between sheets.

const HEADER_FILL = 'FF334155';
const LINK_FONT = { color: { argb: 'FF1D4ED8' }, underline: true };
const MIN_WIDTH = 6;
const MAX_WIDTH = 60;

const yesNo = (value) => (value === undefined ? '' : value ? 'yes' : 'no');
const flag = (value) => (value ? 'yes' : '');
const lines = (list) => (list ?? []).join('\n');
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
 * strings, numbers or link() cells. `title` (cells, optional) is a line
 * above the header, e.g. what the sheet describes and a link back; it does
 * not count for column widths. Header row frozen and filterable.
 */
export function addSheet(workbook, name, columns, rows, { title } = {}) {
  const headerRow = title ? 2 : 1;
  const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: headerRow }] });
  sheet.columns = columns.map((c, i) => ({ width: widthOf(c.header, rows, i) }));
  if (title) {
    const row = sheet.getRow(1);
    row.values = title;
    row.font = { bold: true };
  }
  const header = sheet.getRow(headerRow);
  header.values = columns.map((c) => c.header);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
  header.alignment = { vertical: 'middle' };
  for (const values of rows) sheet.addRow(values.map((v) => v ?? ''));
  columns.forEach((c, i) => {
    if (c.wrap) {
      for (let r = headerRow + 1; r <= headerRow + rows.length; r++) sheet.getCell(r, i + 1).alignment = { wrapText: true, vertical: 'top' };
    }
  });
  sheet.eachRow((row, r) => {
    if (r === headerRow) return;
    row.eachCell((cell) => {
      if (cell.hyperlink) cell.font = { ...(cell.font ?? {}), ...LINK_FONT };
    });
  });
  if (rows.length > 0) sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow, column: columns.length } };
  return sheet;
}

const SHEETS = {
  overview: 'Overview',
  relations: 'Relations',
  polymorphic: 'Polymorphic',
  review: 'To review',
  changes: 'Changes',
};

// Excel's sheet name rules: at most 31 characters, none of : \ / ? * [ ],
// unique ignoring case, and "History" is reserved. Apostrophes are replaced
// too, because link targets quote the sheet name with them.
const SHEET_NAME_MAX = 31;
const RESERVED_SHEET_NAMES = [...Object.values(SHEETS), 'History'];
const safeSheetName = (text) => text.replace(/[:\\/?*[\]']/g, '_').slice(0, SHEET_NAME_MAX) || '_';

/**
 * Sheet name of every table, by id. A table is named after itself when that
 * name is unique in the workbook; tables sharing a name (same table in two
 * databases or schemas) all get `<db>.<table>`, then `<db>.<schema>.<table>`.
 * Names still equal after cutting to 31 characters get `~2`, `~3`, ... in
 * table order. Depends only on the set of ids, never on input order.
 */
export function tableSheetNames(tables) {
  const levels = (id) => {
    const [db, schema, name] = id.split('.');
    return [name, `${db}.${name}`, id].map(safeSheetName);
  };
  const taken = new Set(RESERVED_SHEET_NAMES.map((n) => n.toLowerCase()));
  const names = new Map();
  let open = tables.map((t) => t.id).sort(compareStrings);
  for (let level = 0; level < 3 && open.length > 0; level++) {
    const count = new Map();
    for (const id of open) {
      const key = levels(id)[level].toLowerCase();
      count.set(key, (count.get(key) ?? 0) + 1);
    }
    const unique = (id) => count.get(levels(id)[level].toLowerCase()) === 1 && !taken.has(levels(id)[level].toLowerCase());
    for (const id of open.filter(unique)) names.set(id, levels(id)[level]);
    for (const name of names.values()) taken.add(name.toLowerCase());
    open = open.filter((id) => !names.has(id));
  }
  for (const id of open) {
    const base = levels(id)[2];
    let n = 2;
    while (taken.has(`${base.slice(0, SHEET_NAME_MAX - `~${n}`.length)}~${n}`.toLowerCase())) n++;
    const name = `${base.slice(0, SHEET_NAME_MAX - `~${n}`.length)}~${n}`;
    names.set(id, name);
    taken.add(name.toLowerCase());
  }
  return names;
}

// Order of the per-table sheets and of the Overview rows: as a reader browses
// the diagram, database, then domain, then table.
const browseKey = (t) => {
  const [db, , name] = t.id.split('.');
  return [db, t.domain, name, t.id].join('\u0000');
};
const browseOrder = (tables) => [...tables].sort((a, b) => compareStrings(browseKey(a), browseKey(b)));

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

// Everything a reader may want to know about a column beyond the grid's own
// columns, one item per line: its note, the meaning of each enum value, the
// untranslated and the team-only note (both dropped by sharing profiles
// unless kept), and the flags the grid has no column for.
function columnComment(c) {
  return [
    c.note,
    ...Object.entries(c.enum ?? {}).map(([value, meaning]) => (enumMeaning(value, meaning) ? `${value}: ${meaning}` : value)),
    c.note_source && `Original note: ${c.note_source}`,
    c.internal_note && `Internal note: ${c.internal_note}`,
    c.renamed_from && `Renamed from ${c.renamed_from}`,
    [c.unique && 'Unique', c.pii && 'Personal data (PII)'].filter(Boolean).join(' · '),
  ]
    .filter(Boolean)
    .join('\n');
}

// The grid of one table, column for column what a database client shows.
const GRID = [
  { header: '#' },
  { header: 'Name' },
  { header: 'Type' },
  { header: 'Nullable' },
  { header: 'Default', wrap: true },
  { header: 'Generated' },
  { header: 'Expression', wrap: true },
  { header: 'Primary Key' },
  { header: 'Auto Inc' },
  { header: 'Comment', wrap: true },
];

const gridRows = (t) =>
  columnEntries(t).map(({ path, column: c }, i) => [
    i + 1,
    path,
    c.type,
    yesNo(c.nullable),
    c.default ?? '',
    flag(c.generated),
    c.generated ?? '',
    flag(c.pk),
    flag(c.auto_increment),
    columnComment(c),
  ]);

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

// Link to a table's own sheet; a table not in `names` (removed, in a diff)
// stays plain text.
const tableLinker = (names) => (id) => (names.has(id) ? link(id, names.get(id), 1) : id);

/**
 * Workbook of `model` (already filtered by a sharing profile, if any), with
 * sheets in reading order: Overview, one sheet per table, Relations,
 * Polymorphic, To review. More sheets can be appended with addSheet before
 * serializeWorkbook.
 */
export function buildWorkbook(model) {
  const workbook = new ExcelJS.Workbook();
  const tenancy = tenancyOf(model);
  const tables = browseOrder(model.tables);
  const names = tableSheetNames(model.tables);
  const tableLink = tableLinker(names);
  const overviewRow = new Map(tables.map((t, i) => [t.id, i + 2]));

  // Overview: one row per table, with the counts that tell a reader how big
  // the system is and what each database runs on.
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
    ...model.databases.map((db) => [`Database ${db.database}`, [db.engine, ...databaseFacts(db)].join(' · ')]),
  ];
  const sheet = addSheet(
    workbook,
    SHEETS.overview,
    [{ header: 'Database' }, { header: 'Schema' }, { header: 'Domain' }, { header: 'Table' }, { header: 'Kind' }, { header: 'Note', wrap: true }, { header: 'Columns' }],
    tables.map((t) => {
      const [db, schema, name] = t.id.split('.');
      return [db, schema, t.domain, link(name, names.get(t.id), 1), t.kind ?? 'table', t.note ?? '', columnEntries(t).length];
    }),
  );
  // Summary sits beside the list so the list keeps the frozen header and filter.
  sheet.getColumn(9).width = Math.max(...summary.map(([label]) => label.length)) + 2;
  sheet.getColumn(10).width = Math.min(MAX_WIDTH, Math.max(...summary.map(([, v]) => String(v).length)) + 2);
  sheet.getCell('I1').value = 'Summary';
  sheet.getCell('J1').value = 'Value';
  summary.forEach(([label, n], i) => {
    sheet.getCell(`I${i + 2}`).value = label;
    sheet.getCell(`J${i + 2}`).value = n;
  });
  const reviewCell = sheet.getCell(`I${summary.length + 2}`);
  reviewCell.value = link('Open the review checklist', SHEETS.review, 1);
  reviewCell.font = LINK_FONT;

  // One sheet per table. The title line names the table, says what it is
  // and links back to its Overview row.
  for (const t of tables) {
    const about = [t.note, t.note_source && `Original note: ${t.note_source}`, t.internal_note && `Internal note: ${t.internal_note}`, ...tableFlags(t, tenancy(t))];
    addSheet(workbook, names.get(t.id), GRID, gridRows(t), {
      title: [link('← Overview', SHEETS.overview, overviewRow.get(t.id)), t.id, about.filter(Boolean).join(' · ')],
    });
  }

  addSheet(
    workbook,
    SHEETS.relations,
    [{ header: 'From' }, { header: 'From columns' }, { header: 'To' }, { header: 'To columns' }, { header: 'Cardinality' }, { header: 'Optional' }, { header: 'Kind' }, { header: 'Review' }, { header: 'Evidence', wrap: true }],
    model.relations.map((r) => [tableLink(r.from.table), r.from.columns.join(', '), tableLink(r.to.table), r.to.columns.join(', '), r.cardinality, yesNo(r.optional), r.kind, r.review, lines(r.evidence)]),
  );

  addSheet(
    workbook,
    SHEETS.polymorphic,
    [{ header: 'Table' }, { header: 'Association' }, { header: 'Type column' }, { header: 'Id column' }, { header: 'Optional' }, { header: 'Targets', wrap: true }, { header: 'Note', wrap: true }, { header: 'Review' }, { header: 'Evidence', wrap: true }],
    model.polymorphic.map((a) => [
      tableLink(a.table),
      a.name,
      a.type_column,
      a.id_column,
      yesNo(a.optional),
      lines(a.targets),
      lines([a.note, a.internal_note && `Internal note: ${a.internal_note}`].filter(Boolean)),
      a.review,
      lines(a.evidence),
    ]),
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
 * and opens the file on it. A table still present links to its sheet; a
 * removed table has none to link to.
 */
export function addChangesSheet(workbook, model, changes) {
  const tableLink = tableLinker(tableSheetNames(model.tables));
  addSheet(
    workbook,
    SHEETS.changes,
    [{ header: 'Database' }, { header: 'Table' }, { header: 'Change' }, { header: 'Detail', wrap: true }, { header: 'Before', wrap: true }, { header: 'After', wrap: true }],
    changes.map((c) => [c.database, c.table === null ? '' : tableLink(c.table), changeLabel(c.kind), describeChange(c), showValue(c.before), showValue(c.after)]),
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
