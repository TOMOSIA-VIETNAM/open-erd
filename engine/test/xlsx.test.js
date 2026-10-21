import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ExcelJS from 'exceljs';
import { buildWorkbook, serializeWorkbook } from '../src/render/xlsx/workbook.js';
import { zipEntries } from '../src/render/xlsx/zip.js';
import { loadMulti, loadWorkspace } from './helpers/shop.js';
import { xlsxParts } from './helpers/xlsx.js';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
const PATTERNS = fileURLToPath(new URL('./fixtures/workspace-patterns', import.meta.url));
const DATE = new Date('2026-01-02T03:04:05Z');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function loadBack(model) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await serializeWorkbook(buildWorkbook(model), { date: DATE }));
  return workbook;
}

const rowValues = (sheet, n) => sheet.getRow(n).values.slice(1).map((v) => v?.text ?? v);

test('sheets come in reading order with a frozen, filterable header', async () => {
  const workbook = await loadBack(await loadMulti());
  assert.deepEqual(
    workbook.worksheets.map((s) => s.name),
    ['Overview', 'Tables', 'Columns', 'Relations', 'Enums', 'Polymorphic', 'To review'],
  );
  for (const sheet of workbook.worksheets) {
    assert.equal(sheet.views[0].state, 'frozen', sheet.name);
    assert.equal(sheet.views[0].ySplit, 1, sheet.name);
    assert.ok(sheet.getRow(1).font.bold, sheet.name);
    if (sheet.rowCount > 1) assert.ok(sheet.autoFilter, `${sheet.name} has no filter`);
  }
});

test('table names link to their Tables row; Tables links to the first column row', async () => {
  const model = await loadMulti();
  const workbook = await loadBack(model);
  const tables = workbook.getWorksheet('Tables');
  const rowOf = (ref) => Number(/!A(\d+)$/.exec(ref)[1]);
  const idAt = (row) => rowValues(tables, row).slice(0, 2).join('.') + '.' + rowValues(tables, row)[3];
  const relations = workbook.getWorksheet('Relations');
  for (let r = 2; r <= relations.rowCount; r++) {
    for (const col of [1, 3]) {
      const cell = relations.getRow(r).getCell(col);
      assert.match(cell.hyperlink, /^#'Tables'!A\d+$/);
      assert.equal(idAt(rowOf(cell.hyperlink)), cell.text);
    }
  }
  const columns = workbook.getWorksheet('Columns');
  for (let r = 2; r <= tables.rowCount; r++) {
    const target = rowOf(tables.getRow(r).getCell(4).hyperlink);
    assert.equal(columns.getRow(target).getCell(2).text, idAt(r));
  }
  // Excel jumps inside the workbook for a target starting with '#'.
  const rels = xlsxParts(await serializeWorkbook(buildWorkbook(model), { date: DATE }))['xl/worksheets/_rels/sheet4.xml.rels'];
  assert.match(rels, /Target="#&apos;Tables&apos;!A\d+" TargetMode="External"/);
});

test('To review lists pending and stale facts, stale first, each linked to its row', async () => {
  const loaded = await loadWorkspace(PATTERNS);
  // The fixture has no stale fact; make its last relation one.
  const last = loaded.relations.at(-1);
  const model = { ...loaded, relations: loaded.relations.map((r) => (r === last ? { ...r, review: 'stale' } : r)) };
  const workbook = await loadBack(model);
  const review = workbook.getWorksheet('To review');
  const states = [];
  for (let r = 2; r <= review.rowCount; r++) {
    const [state, kind] = rowValues(review, r);
    states.push(state);
    const link = review.getRow(r).getCell(3).hyperlink;
    assert.match(link, kind === 'polymorphic' ? /^#'Polymorphic'!A\d+$/ : /^#'Relations'!A\d+$/);
  }
  const open = [...model.relations, ...model.polymorphic].filter((f) => f.review !== 'reviewed');
  assert.equal(states.length, open.length);
  assert.deepEqual(states, ['stale', ...Array(open.length - 1).fill('pending')]);
  assert.equal(review.getRow(2).getCell(3).hyperlink, `#'Relations'!A${model.relations.length + 1}`);
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
  const run = (...args) => promisify(execFile)(process.execPath, [CLI, ...args]);
  await cp(PATTERNS, dir, { recursive: true });
  await run('layout', '--workspace', dir);
  await run('render', '--workspace', dir);
  const first = await readFile(join(dir, 'out', 'erd.xlsx'));
  await run('render', '--workspace', dir);
  assert.equal(sha256(await readFile(join(dir, 'out', 'erd.xlsx'))), sha256(first));
  assert.match(xlsxParts(first)['docProps/core.xml'], /<dcterms:created[^>]*>1980-01-01T00:00:00Z</);
});
