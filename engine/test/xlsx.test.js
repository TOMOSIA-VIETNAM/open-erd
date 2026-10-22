import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ExcelJS from 'exceljs';
import { buildWorkbook, serializeWorkbook, tableSheetNames } from '../src/render/xlsx/workbook.js';
import { zipEntries } from '../src/render/xlsx/zip.js';
import { missingRelations } from '../src/model/missing.js';
import { loadMulti, loadWorkspace } from './helpers/shop.js';
import { xlsxLinks, xlsxParts } from './helpers/xlsx.js';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
const PATTERNS = fileURLToPath(new URL('./fixtures/workspace-patterns', import.meta.url));
const DATE = new Date('2026-01-02T03:04:05Z');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function loadBack(model) {
  const bytes = await serializeWorkbook(buildWorkbook(model), { date: DATE });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  return { workbook, links: xlsxLinks(bytes), parts: xlsxParts(bytes) };
}

const rowValues = (sheet, n) => sheet.getRow(n).values.slice(1).map((v) => v?.text ?? v);

const TABLE_GRID = ['#', 'Name', 'Type', 'Nullable', 'Default', 'Generated', 'Expression', 'Primary Key', 'Auto Inc', 'Index', 'Comment'];
// workspace-multi marks some columns as personal data and has health findings, so it has PII and Health sheets.
const FIXED_TAIL = ['Relations', 'Polymorphic', 'Indexes', 'PII', 'Health', 'To review'];
const rowOf = (location) => Number(/!A(\d+)$/.exec(location)[1]);
const sheetOf = (location) => /^'([^']+)'!A\d+$/.exec(location)[1];
const browseKey = (id, domain) => [id.split('.')[0], domain, id.split('.')[2]].join(' ');

test('Overview first, then one sheet per table by database, domain and table, then the fact lists', async () => {
  const model = await loadMulti();
  const { workbook } = await loadBack(model);
  const names = workbook.worksheets.map((s) => s.name);
  assert.equal(names[0], 'Overview');
  assert.deepEqual(names.slice(-FIXED_TAIL.length), FIXED_TAIL);
  const tableSheets = workbook.worksheets.slice(1, -FIXED_TAIL.length);
  assert.equal(tableSheets.length, model.tables.length);
  const ids = tableSheets.map((s) => s.getCell('B1').text);
  const domainOf = new Map(model.tables.map((t) => [t.id, t.domain]));
  assert.deepEqual(ids, [...ids].sort((a, b) => (browseKey(a, domainOf.get(a)) < browseKey(b, domainOf.get(b)) ? -1 : 1)));
  assert.deepEqual([...ids].sort(), model.tables.map((t) => t.id).sort());
  // The Overview lists the tables in the same order, one row each.
  const overview = workbook.getWorksheet('Overview');
  assert.deepEqual(rowValues(overview, 1).slice(0, 7), ['Database', 'Schema', 'Domain', 'Table', 'Kind', 'Note', 'Columns']);
  assert.deepEqual(
    ids.map((_, i) => {
      const [db, schema, , name] = rowValues(overview, i + 2);
      return `${db}.${schema}.${name}`;
    }),
    ids,
  );
  for (const sheet of workbook.worksheets) {
    const headerRow = tableSheets.includes(sheet) ? 2 : 1;
    assert.equal(sheet.views[0].state, 'frozen', sheet.name);
    assert.equal(sheet.views[0].ySplit, headerRow, sheet.name);
    assert.ok(sheet.getRow(headerRow).font.bold, sheet.name);
    if (sheet.rowCount > headerRow) assert.ok(sheet.autoFilter, `${sheet.name} has no filter`);
  }
  for (const sheet of tableSheets) assert.deepEqual(rowValues(sheet, 2), TABLE_GRID, sheet.name);
});

test('a table sheet is its column grid; Comment holds the note, enum meanings and flags', async () => {
  const model = await loadMulti();
  const { workbook } = await loadBack(model);
  const grid = (name) => {
    const sheet = workbook.getWorksheet(name);
    return Object.fromEntries([...Array(sheet.rowCount - 2).keys()].map((i) => rowValues(sheet, i + 3)).map((r) => [r[1], Object.fromEntries(TABLE_GRID.map((h, j) => [h, r[j] ?? '']))]));
  };
  const orders = workbook.getWorksheet('orders');
  assert.equal(orders.getCell('B1').text, 'shop._.orders');
  assert.equal(orders.getCell('C1').text, 'One order per checkout; the basket becomes order items.');
  const status = grid('orders').status;
  assert.equal(status.Default, 'pending');
  assert.equal(
    status.Comment,
    ['Lifecycle of the order; only paid orders are shipped.', 'pending: Created, waiting for payment', 'paid: Payment confirmed by the gateway', 'cancelled: Cancelled by the customer or by timeout'].join('\n'),
  );
  assert.deepEqual(grid('orders').id, { '#': 1, Name: 'id', Type: 'bigint', Nullable: '', Default: '', Generated: '', Expression: '', 'Primary Key': 'yes', 'Auto Inc': 'yes', Index: '', Comment: '' });
  // The Index column names each index a column is in.
  assert.equal(grid('orders').status.Index, 'index_orders_on_user_id_and_status');
  assert.equal(grid('users').email.Index, 'index_users_on_email (unique)');
  // The Indexes sheet lists every index, linked to its table.
  const indexes = workbook.getWorksheet('Indexes');
  assert.deepEqual(rowValues(indexes, 1), ['Table', 'Index', 'Columns', 'Unique', 'Where', 'Using']);
  const rows = [...Array(indexes.rowCount - 1).keys()].map((i) => rowValues(indexes, i + 2).map((v) => v?.text ?? v ?? ''));
  assert.deepEqual(rows, [
    ['auth.public.users', 'index_users_on_email', 'email', 'yes', '', ''],
    ['auth.public.users', 'index_users_on_status', 'status', 'no', '', 'btree'],
    ['shop._.orders', 'index_orders_on_placed_at', 'placed_at', 'no', "status = 'paid'", ''],
    ['shop._.orders', 'index_orders_on_user_id_and_status', 'user_id, status', 'no', '', ''],
  ]);
  assert.deepEqual([grid('payments').amount.Generated, grid('payments').amount.Expression], ['yes', 'amount_cents / 100.0']);
  assert.equal(grid('users').email.Comment, 'Unique · Personal data (PII)');
  assert.equal(grid('users').created_at.Default, 'now()');
  assert.equal(grid('user_profiles').user_id.Nullable, 'no');
});

test('sheet names: unique ignoring case, at most 31 characters, Excel-safe, independent of input order', () => {
  const ids = [
    'auth.public.users',
    'shop._.users',
    'auth.tenant.users',
    'shop._.Overview',
    'shop._.history',
    "shop._.it's/odd:[name]?",
    `crm.a.${'x'.repeat(40)}`,
    `crm.b.${'x'.repeat(40)}`,
    `crm._.${'x'.repeat(40)}`,
    `crm._.${'x'.repeat(39)}y`,
    'shop._.orders',
  ];
  const names = tableSheetNames(ids.map((id) => ({ id })));
  assert.deepEqual(Object.fromEntries(names), {
    'auth.public.users': 'auth.public.users',
    'auth.tenant.users': 'auth.tenant.users',
    'shop._.users': 'shop.users',
    'shop._.Overview': 'shop.Overview',
    'shop._.history': 'shop.history',
    "shop._.it's/odd:[name]?": 'it_s_odd__name__',
    [`crm.a.${'x'.repeat(40)}`]: `crm.a.${'x'.repeat(25)}`,
    [`crm.b.${'x'.repeat(40)}`]: `crm.b.${'x'.repeat(25)}`,
    // Still equal once cut to 31 characters: numbered in id order.
    [`crm._.${'x'.repeat(40)}`]: `crm._.${'x'.repeat(23)}~2`,
    [`crm._.${'x'.repeat(39)}y`]: `crm._.${'x'.repeat(23)}~3`,
    'shop._.orders': 'orders',
  });
  const all = [...names.values()];
  assert.equal(new Set(all.map((n) => n.toLowerCase())).size, all.length);
  for (const n of all) assert.ok(n.length <= 31 && !/[:\\/?*[\]']/.test(n), n);
  assert.deepEqual(tableSheetNames(ids.map((id) => ({ id })).reverse()), names);
});

test('links: Overview to each table sheet and back, fact lists to table sheets', async () => {
  const base = await loadMulti();
  // A second `users` table in another database: both get qualified names.
  const model = { ...base, tables: [...base.tables, { id: 'shop._.users', domain: 'Customers', columns: [{ name: 'id', type: 'bigint', pk: true }] }] };
  const { workbook, links } = await loadBack(model);
  assert.ok(workbook.getWorksheet('auth.users') && workbook.getWorksheet('shop.users') && !workbook.getWorksheet('users'));
  const overview = workbook.getWorksheet('Overview');
  for (let r = 2; r <= model.tables.length + 1; r++) {
    const target = links.Overview.get(`D${r}`);
    assert.equal(rowOf(target.location), 1);
    const sheet = workbook.getWorksheet(sheetOf(target.location));
    const [db, schema, , name] = rowValues(overview, r);
    assert.equal(sheet.getCell('B1').text, `${db}.${schema}.${name}`);
    const back = links[sheet.name].get('A1');
    assert.equal(back.location, `'Overview'!A${r}`);
  }
  for (const [name, cols] of [['Relations', ['A', 'C']], ['Polymorphic', ['A']]]) {
    const sheet = workbook.getWorksheet(name);
    for (let r = 2; r <= sheet.rowCount; r++) {
      for (const col of cols) {
        const target = links[name].get(`${col}${r}`);
        assert.equal(rowOf(target.location), 1);
        assert.equal(workbook.getWorksheet(sheetOf(target.location)).getCell('B1').text, target.display);
      }
    }
  }
});

test('PII lists every personal data column, linked to its table sheet and its row; absent without any', async () => {
  const model = await loadMulti();
  const { workbook, links } = await loadBack(model);
  const sheet = workbook.getWorksheet('PII');
  assert.deepEqual(rowValues(sheet, 1), ['Database', 'Domain', 'Table', 'Column', 'Type', 'Note']);
  const rows = [...Array(sheet.rowCount - 1).keys()].map((i) => rowValues(sheet, i + 2).map((v) => v ?? ''));
  assert.deepEqual(rows, [
    ['auth', 'Identity', 'auth.public.user_profiles', 'display_name', 'varchar(80)', ''],
    ['auth', 'Identity', 'auth.public.users', 'email', 'varchar(255)', ''],
    ['auth', 'Organizations', 'auth.public.invitations', 'email', 'varchar(255)', ''],
    ['shop', 'Content', 'shop._.comments', 'body', 'text', 'Free text written by the customer.'],
  ]);
  for (let r = 2; r <= sheet.rowCount; r++) {
    const table = links.PII.get(`C${r}`);
    const column = links.PII.get(`D${r}`);
    const target = workbook.getWorksheet(sheetOf(table.location));
    assert.equal(target.getCell('B1').text, table.display);
    assert.equal(sheetOf(column.location), target.name);
    assert.equal(target.getCell(`B${rowOf(column.location)}`).text, column.display);
  }
  const none = { ...model, tables: model.tables.map((t) => ({ ...t, columns: t.columns.map(({ pii, ...c }) => c) })) };
  assert.equal((await loadBack(none)).workbook.getWorksheet('PII'), undefined);
});

test('links inside the workbook use location, with no relationship and no leading #', async () => {
  const { parts } = await loadBack(await loadMulti());
  const sheet = parts['xl/worksheets/sheet1.xml'];
  assert.match(sheet, /<hyperlink ref="D2" location="&apos;[^&]+&apos;!A1" display="[^"]+"\/>/);
  assert.doesNotMatch(sheet, /<hyperlink [^>]*r:id=/);
  assert.doesNotMatch(sheet, /location="#/);
  // Every relationship of the sheets was such a link, so no part is left.
  assert.deepEqual(Object.keys(parts).filter((name) => name.endsWith('.xml.rels') && name.includes('worksheets')), []);
});

test('To review lists pending and stale facts, stale first, each linked to its row', async () => {
  const loaded = await loadWorkspace(PATTERNS);
  // The fixture has no stale fact; make its last relation one.
  const last = loaded.relations.at(-1);
  const model = { ...loaded, relations: loaded.relations.map((r) => (r === last ? { ...r, review: 'stale' } : r)) };
  const { workbook, links } = await loadBack(model);
  const review = workbook.getWorksheet('To review');
  const states = [];
  for (let r = 2; r <= review.rowCount; r++) {
    const [state, kind] = rowValues(review, r);
    // Possibly missing relations come after the facts (their own test).
    if (state === 'warning') break;
    states.push(state);
    const { location } = links['To review'].get(`C${r}`);
    assert.match(location, kind === 'polymorphic' ? /^'Polymorphic'!A\d+$/ : /^'Relations'!A\d+$/);
  }
  const open = [...model.relations, ...model.polymorphic].filter((f) => f.review !== 'reviewed');
  assert.equal(states.length, open.length);
  assert.deepEqual(states, ['stale', ...Array(open.length - 1).fill('pending')]);
  assert.equal(links['To review'].get('C2').location, `'Relations'!A${model.relations.length + 1}`);
});

test('To review ends with the possibly missing relations, each linked to its column row', async () => {
  const loaded = await loadWorkspace(PATTERNS);
  // Two reference columns nothing covers, in the first table.
  const first = loaded.tables[0];
  const model = { ...loaded, tables: [{ ...first, columns: [...first.columns, { name: 'supplier_id', type: 'bigint' }, { name: 'vendorId', type: 'bigint' }] }, ...loaded.tables.slice(1)] };
  const warnings = missingRelations(model);
  assert.equal(warnings.length, 2);
  const { workbook, links } = await loadBack(model);
  const review = workbook.getWorksheet('To review');
  const start = review.rowCount - warnings.length + 1;
  const names = tableSheetNames(model.tables);
  warnings.forEach((w, i) => {
    const r = start + i;
    const [state, kind, fact] = rowValues(review, r);
    assert.deepEqual([state, kind], ['warning', 'Possibly missing relation']);
    assert.ok(String(fact.text ?? fact).startsWith(`${w.table}.${w.column}: `), String(fact.text ?? fact));
    const row = model.tables.find((t) => t.id === w.table).columns.findIndex((c) => c.name === w.column) + 3;
    assert.equal(links['To review'].get(`C${r}`).location, `'${names.get(w.table)}'!A${row}`);
  });
  const overview = workbook.getWorksheet('Overview');
  const summary = [];
  overview.getColumn(9).eachCell((cell, r) => summary.push([cell.value, overview.getCell(`J${r}`).value]));
  assert.ok(summary.some(([label, n]) => label === 'Possibly missing relations' && n === warnings.length));
  // Rendering with no warnings (a profile that drops them all) lists none.
  const none = buildWorkbook(model, { warnings: [] }).getWorksheet('To review');
  assert.equal(none.rowCount, review.rowCount - warnings.length);
});

test('serialization is byte-identical: fixed document dates and zip entry times', async () => {
  const model = await loadWorkspace(PATTERNS);
  const bytes = await serializeWorkbook(buildWorkbook(model), { date: DATE });
  assert.equal(sha256(await serializeWorkbook(buildWorkbook(await loadWorkspace(PATTERNS)), { date: DATE })), sha256(bytes));
  // The clock never reaches the file: every entry carries 1980-01-01 00:00.
  for (const e of zipEntries(bytes)) {
    assert.deepEqual([bytes.readUInt32LE(e.centralOffset + 12), bytes.readUInt32LE(e.localOffset + 10)], [0x210000, 0x210000], e.name);
  }
  const core = xlsxParts(bytes)['docProps/core.xml'];
  assert.match(core, /<dcterms:created[^>]*>2026-01-02T03:04:05Z</);
  assert.match(core, /<dcterms:modified[^>]*>2026-01-02T03:04:05Z</);
});

test('CLI: two renders write the same erd.xlsx; a workspace without its own git uses the fixed date', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'open-erd-xlsx-'));
  try {
    const run = (...args) => promisify(execFile)(process.execPath, [CLI, ...args]);
    await cp(PATTERNS, dir, { recursive: true });
    await run('layout', '--workspace', dir);
    await run('render', '--workspace', dir);
    const first = await readFile(join(dir, 'out', 'erd.xlsx'));
    await run('render', '--workspace', dir);
    assert.equal(sha256(await readFile(join(dir, 'out', 'erd.xlsx'))), sha256(first));
    assert.match(xlsxParts(first)['docProps/core.xml'], /<dcterms:created[^>]*>1980-01-01T00:00:00Z</);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
