import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import ExcelJS from 'exceljs';
import { readWorkspaceFiles } from '../cli.js';
import { POSSIBLE_RENAME_SIMILARITY, describeChange, diffModels, summarize, summaryLine } from '../src/diff/changes.js';
import { diffMarks, unionModel } from '../src/diff/union.js';
import { parseWorkspace } from '../src/model/load.js';
import { editFile, git, runCli, snapshotRepo } from './helpers/git-workspace.js';
import { MULTI, SHOP, loadMulti, loadWorkspace, table } from './helpers/shop.js';
import { buildDiagram } from '../src/layout/diagram.js';
import { changesSummary } from '../src/render/svg/viewer/changes.js';
import { SHOP_V2_EDITS, SHOP_V2_SUMMARY } from './helpers/shop-v2.js';
import { xlsxLinks } from './helpers/xlsx.js';

const PATTERNS = new URL('./fixtures/workspace-patterns', import.meta.url).pathname;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function shopVersions() {
  const files = await readWorkspaceFiles(SHOP);
  let text = files['model/shop.yaml'];
  for (const [search, replacement] of SHOP_V2_EDITS) text = text.replace(search, replacement);
  const parse = (f) => {
    const { model, errors } = parseWorkspace(f);
    if (errors.length > 0) throw new Error(JSON.stringify(errors));
    return model;
  };
  return { from: parse(files), to: parse({ ...files, 'model/shop.yaml': text }) };
}

const sentences = (changes) => changes.map(describeChange);
const clone = (value) => structuredClone(value);

test('diff of two shop versions: summary counts and one sentence per change', async () => {
  const { from, to } = await shopVersions();
  const { changes } = diffModels(from, to);
  assert.equal(summaryLine(summarize(changes)), SHOP_V2_SUMMARY);
  const text = sentences(changes);
  for (const expected of [
    'Table renamed from shop.public.coupons to shop.public.promo_codes',
    'Table manufacturers added in domain Catalog (possibly renamed from brands: 2 of 3 columns match)',
    'Table brands removed (possibly renamed to manufacturers: 2 of 3 columns match)',
    'Table wishlists added in domain Identity',
    'Table password_resets removed',
    'Column currency added (char(3))',
    'Column published_at removed',
    'Column renamed from body to comment',
    'Column price_cents: type changed from “integer” to “bigint”',
    'Column user_id: now NOT NULL',
    'Column order_id: no longer unique',
    'Enum status: added value “refunded” (Order money returned)',
    'Enum status: removed value “cancelled”',
    'Enum status: meaning of “paid” changed from “Payment captured” to “Payment captured by the gateway”',
    'Relation shipments.order_id → orders.id: cardinality changed from “1-1” to “n-1”',
    'Relation sessions.user_id → users.id: review state changed from “pending” to “reviewed”',
    'Relation password_resets.user_id → users.id removed',
    'Relation wishlists.user_id → users.id added (n-1, db_fk)',
    'Table products: note changed from “Sellable item shown on the storefront.” to “Sellable item shown on the storefront and in the app.”',
  ]) {
    assert.ok(text.includes(expected), `missing: ${expected}\n${text.join('\n')}`);
  }
  // The relation to the renamed table follows the rename: nothing changed.
  assert.ok(!text.some((s) => s.includes('coupon_id')), text.join('\n'));
  // The relations of the renamed column follow it the same way.
  assert.ok(!changes.some((c) => c.kind === 'column_removed' && c.column === 'body'));
});

test('changes come sorted by database, table and kind, identical on every run', async () => {
  const { from, to } = await shopVersions();
  const first = diffModels(from, to).changes;
  assert.deepEqual(diffModels(clone(from), clone(to)).changes, first);
  const tables = first.map((c) => c.table ?? '');
  assert.deepEqual(tables, [...tables].sort());
});

test('possibly renamed needs the fixed column similarity and pairs best match first, then by id', () => {
  const base = { config: {}, databases: [{ database: 'd', engine: 'postgresql' }], relations: [], polymorphic: [] };
  const old = table('d.s.clients', 'A', [['name', 'text'], ['email', 'text'], ['phone', 'text']]);
  const twinA = { ...old, id: 'd.s.customers_a' };
  const twinB = { ...old, id: 'd.s.customers_b' };
  const unlike = table('d.s.orders', 'A', [['total', 'int'], ['placed_at', 'date'], ['status', 'text']]);
  const { changes } = diffModels({ ...base, tables: [old] }, { ...base, tables: [twinB, twinA, unlike] });
  const added = changes.filter((c) => c.kind === 'table_added');
  assert.deepEqual(added.map((c) => [c.table, c.possibly?.table]), [['d.s.customers_a', 'd.s.clients'], ['d.s.customers_b', undefined], ['d.s.orders', undefined]]);
  // Only a label: the summary still counts one removed and three added tables.
  assert.equal(summaryLine(summarize(changes)), '+3 tables · −1 tables · 0 renamed · 0 columns changed · 0 relations changed');
  // {id, name} vs {id, name, email, phone, fax}: 2 of 6, below the threshold.
  const far = table('d.s.people', 'A', [['name', 'text'], ['email', 'text'], ['phone', 'text'], ['fax', 'text'], ['mobile', 'text']]);
  assert.ok(2 / 6 < POSSIBLE_RENAME_SIMILARITY);
  const small = table('d.s.people_lite', 'A', [['name', 'text']]);
  assert.equal(diffModels({ ...base, tables: [far] }, { ...base, tables: [small] }).changes.find((c) => c.kind === 'table_added').possibly, undefined);
});

test('polymorphic targets and special patterns (STI, view sources, partition) are compared', async () => {
  const multi = await loadWorkspace(MULTI);
  const poly = clone(multi);
  const association = poly.polymorphic[0];
  const dropped = association.targets.pop();
  let text = sentences(diffModels(multi, poly).changes);
  assert.deepEqual(text, [`Polymorphic «${association.name}» on ${association.table.split('.')[2]}: removed target ${dropped.split('.')[2]}`]);
  poly.polymorphic = poly.polymorphic.filter((a) => a !== association);
  text = sentences(diffModels(multi, poly).changes);
  assert.deepEqual(text, [`Polymorphic «${association.name}» on ${association.table.split('.')[2]} removed`]);

  const patterns = await loadWorkspace(PATTERNS);
  const changed = clone(patterns);
  const sti = changed.tables.find((t) => t.sti);
  sti.sti.subclasses.push('Extra');
  const view = changed.tables.find((t) => t.sources);
  view.sources = view.sources.slice(0, 1);
  const partitioned = changed.tables.find((t) => t.partition);
  partitioned.partition.interval = 'week';
  const fields = diffModels(patterns, changed).changes.filter((c) => c.kind === 'table_changed').map((c) => [c.table, c.field]);
  assert.deepEqual(
    fields.sort(),
    [[sti.id, 'sti'], [partitioned.id, 'partition'], ...(patterns.tables.find((t) => t.id === view.id).sources.length > 1 ? [[view.id, 'sources']] : [])].sort(),
  );
});

test('union model keeps removed tables, columns and relations so they can be drawn struck through', async () => {
  const { from, to } = await shopVersions();
  const result = diffModels(from, to);
  const union = unionModel(from, to, result);
  const ids = union.tables.map((t) => t.id);
  for (const id of ['shop.public.brands', 'shop.public.password_resets', 'shop.public.manufacturers', 'shop.public.promo_codes']) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes('shop.public.coupons'));
  assert.ok(union.tables.every((t) => t.renamed_from === undefined));
  assert.ok(union.tables.find((t) => t.id === 'shop.public.products').columns.some((c) => c.name === 'published_at'));
  const marks = diffMarks(union, result.changes);
  assert.equal(marks.nodes.get('shop.public.promo_codes'), 'renamed');
  assert.equal(marks.nodes.get('shop.public.brands'), 'removed');
  assert.equal(marks.columns.get('shop.public.products').get('published_at'), 'removed');
  assert.equal(marks.columns.get('shop.public.reviews').get('comment'), 'renamed');
  assert.equal(marks.nodes.get('shop/Catalog'), 'changed');
});

test('diff marks: tables near a changed line, counts, and the Changes list of the viewer', async () => {
  const { from, to } = await shopVersions();
  const result = diffModels(from, to);
  const union = unionModel(from, to, result);
  const marks = diffMarks(union, result.changes);
  // A table with sentences but no status of its own sits at the end of a
  // changed line (so do the far ends of a join table's line, tested below).
  for (const t of union.tables) {
    if (marks.nodes.has(t.id)) assert.ok(!marks.near.has(t.id), t.id);
    else if (marks.sentences.nodes.has(t.id)) assert.ok(marks.near.has(t.id), t.id);
  }
  const s = summarize(result.changes);
  assert.deepEqual(marks.counts, { tables: union.tables.filter((t) => marks.nodes.has(t.id)).length, columns: s.columnsChanged, relations: s.relationsChanged });

  const sorted = (map) => Object.fromEntries(map);
  const nodes = Object.fromEntries(union.tables.map((t) => [t.id, { kind: 'table' }]));
  const summary = changesSummary({ nodes: sorted(marks.sentences.nodes), links: sorted(marks.sentences.links), status: sorted(marks.nodes), counts: marks.counts }, nodes);
  assert.equal(summary.label, `${marks.counts.tables} tables, ${s.columnsChanged} columns, ${s.relationsChanged} relations`);
  assert.deepEqual(new Set(summary.tables.map((t) => t.id)), new Set([...marks.sentences.nodes.keys()].filter((id) => nodes[id])));
  // New and renamed first, then changed, removed, and tables only near a changed line.
  const order = ['added', 'renamed', 'changed', 'removed', undefined];
  const ranks = summary.tables.map((t) => order.indexOf(t.status));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  assert.equal(summary.tables.at(-1).status, undefined);
  assert.equal(changesSummary({ nodes: {}, links: {}, status: {}, counts: { tables: 0, columns: 0, relations: 0 } }, nodes), null);
  assert.equal(changesSummary({ nodes: {}, links: { x: ['a'] }, status: {}, counts: { tables: 0, columns: 0, relations: 1 } }, nodes).label, '1 relation');
});

test('a changed key of a join table marks the many-to-many line drawn for it', async () => {
  const from = await loadMulti();
  const to = clone(from);
  to.relations = to.relations.filter((r) => !(r.from.table === 'shop._.product_tags' && r.to.table === 'shop._.tags'));
  const result = diffModels(from, to);
  const union = unionModel(from, to, result);
  const marks = diffMarks(union, result.changes);
  const line = buildDiagram(union).links.find((l) => l.via === 'shop._.product_tags');
  assert.ok(line, 'product_tags is drawn as a many-to-many line');
  assert.equal(marks.links.get(line.id), 'changed');
  assert.ok(marks.sentences.links.get(line.id).length > 0);
  for (const end of [line.from.node, line.to.node]) assert.ok(marks.near.has(end), end);
});

// ---------------------------------------------------------------- CLI on a git workspace

let ws;
before(async () => {
  ws = await snapshotRepo(SHOP, [{ tag: 'v1.0' }, { tag: 'v2.0', edit: (dir) => editFile(dir, 'model/shop.yaml', SHOP_V2_EDITS) }]);
});
after(async () => {
  if (ws) await rm(ws, { recursive: true, force: true });
});

const viewOf = (svg, name) => {
  const start = svg.indexOf(`<g class="view" data-view="${name}"`);
  return svg.slice(start, svg.indexOf('<g class="view"', start + 1) === -1 ? svg.indexOf('<script') : svg.indexOf('<g class="view"', start + 1));
};

test('CLI diff between two tags: summary, colored SVG and Changes sheet agree', async () => {
  const { stdout } = await runCli('diff', '--workspace', ws, '--from', 'v1.0', '--to', 'v2.0');
  assert.equal(stdout.split('\n')[0], `v1.0 → v2.0: ${SHOP_V2_SUMMARY}`);
  const svg = await readFile(join(ws, 'out', 'diff.svg'), 'utf8');
  const bytes = await readFile(join(ws, 'out', 'diff.xlsx'));

  const { from, to } = await shopVersions();
  const result = diffModels(from, to);
  const marks = diffMarks(unionModel(from, to, result), result.changes);
  // Every table the diff marks is drawn with that colour in the visible
  // view of all tables, and no other table is.
  // It opens with the Changes mode on, so the static drawing fades what did not change.
  assert.match(/<svg [^>]*>/.exec(svg)[0], /class="diff-mode changes-mode"/);
  const all = viewOf(svg, 'all');
  assert.ok(!/<g class="view" data-view="all"[^>]*display:none/.test(all), 'all tables view is the visible one');
  const drawn = [...all.matchAll(/<g class="table[^"]*?(?: diff-(\w+))?" data-id="([^"]+)"/g)].filter((m) => m[1]).map((m) => [m[2], m[1]]);
  const expected = [...marks.nodes].filter(([id]) => id.split('.').length === 3 && !id.includes('«'));
  assert.deepEqual(drawn.sort(), expected.sort());
  assert.match(all, /<g class="diff-banner">[\s\S]*?Changes from v1\.0 to v2\.0[\s\S]*?\+2 tables · −2 tables · 1 renamed · 7 columns changed · 6 relations changed/);
  assert.match(all, /<g class="column[^"]* col-removed" data-column="published_at">/);
  assert.match(all, /class="relation-group[^"]* diff-removed" data-id="shop\.public\.password_resets\(user_id\)-&gt;shop\.public\.users\(id\)"/);
  // Removed tables stay where the "from" layout had them; the others where
  // the "to" layout has them.
  const position = async (tag, id) => {
    const { stdout: text } = await git(ws, 'show', `${tag}:layout.json`);
    const clusters = JSON.parse(text).views.all.clusters;
    const p = Object.values(clusters).find((members) => members[id])[id];
    return [p.x, p.y];
  };
  const drawnAt = (id) => {
    const m = new RegExp(`data-id="${id.replace(/\./g, '\\.')}"><title>[^<]*</title><rect class="table-box" x="(\\d+)" y="(\\d+)"`).exec(all);
    return [Number(m[1]), Number(m[2])];
  };
  for (const id of ['shop.public.password_resets', 'shop.public.brands']) assert.deepEqual(drawnAt(id), await position('v1.0', id), id);
  for (const id of ['shop.public.users', 'shop.public.wishlists', 'shop.public.promo_codes']) assert.deepEqual(drawnAt(id), await position('v2.0', id), id);
  // The viewer data carries the same sentences per table.
  const data = JSON.parse(/<script type="application\/json" id="open-erd-data">(.*?)<\/script>/s.exec(svg)[1]);
  assert.deepEqual(data.changes.nodes['shop.public.orders'], result.changes.filter((c) => c.table === 'shop.public.orders' || c.relation?.to.table === 'shop.public.orders').map(describeChange));

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  assert.equal(workbook.worksheets.at(-1).name, 'Changes');
  const sheet = workbook.getWorksheet('Changes');
  assert.deepEqual(sheet.getRow(1).values.slice(1), ['Database', 'Table', 'Change', 'Detail', 'Before', 'After']);
  assert.equal(sheet.rowCount - 1, result.changes.length);
  assert.equal(workbook.views[0].activeTab, workbook.worksheets.length - 1, 'the file opens on Changes');
  const links = xlsxLinks(bytes).Changes;
  result.changes.forEach((c, i) => {
    const row = i + 2;
    assert.equal(sheet.getCell(`D${row}`).text, describeChange(c));
    const target = links.get(`B${row}`);
    if (to.tables.some((t) => t.id === c.table)) {
      const [, name, at] = /^'([^']+)'!A(\d+)$/.exec(target.location);
      assert.equal(at, '1');
      assert.equal(workbook.getWorksheet(name).getCell('B1').text, c.table);
    } else {
      assert.equal(target, undefined, `${c.table} has no sheet to link to`);
    }
  });

  // Same snapshots, same bytes.
  await runCli('diff', '--workspace', ws, '--from', 'v1.0', '--to', 'v2.0');
  assert.equal(sha256(await readFile(join(ws, 'out', 'diff.svg'))), sha256(svg));
  assert.equal(sha256(await readFile(join(ws, 'out', 'diff.xlsx'))), sha256(bytes));
});

test('CLI diff: --to HEAD warns about uncommitted edits, --to WORKTREE includes them', async () => {
  const file = join(ws, 'model', 'shop.yaml');
  const text = await readFile(file, 'utf8');
  await writeFile(file, text.replace('      - { name: label, type: varchar(40) }', '      - { name: label, type: varchar(80) }'));
  try {
    const head = await runCli('diff', '--workspace', ws, '--from', 'v1.0', '--to', 'HEAD');
    assert.match(head.stderr, /uncommitted changes .* use --to WORKTREE/);
    assert.ok(!head.stdout.includes('varchar(80)'));
    const worktree = await runCli('diff', '--workspace', ws, '--from', 'v1.0', '--to', 'WORKTREE');
    assert.equal(worktree.stderr, '');
    assert.match(worktree.stdout, /Column label: type changed from “varchar\(40\)” to “varchar\(80\)”/);
  } finally {
    await git(ws, 'checkout', '--', 'model/shop.yaml');
  }
});

test('CLI diff: bad refs and --from WORKTREE are refused', async () => {
  await assert.rejects(runCli('diff', '--workspace', ws, '--from', 'WORKTREE', '--to', 'HEAD'), (e) => e.code === 1 && /--from must be a git ref/.test(e.stderr));
  await assert.rejects(runCli('diff', '--workspace', ws, '--from', 'v9', '--to', 'HEAD'), (e) => e.code === 1 && /cannot read snapshot "v9"/.test(e.stderr));
  await assert.rejects(runCli('diff', '--workspace', ws, '--from', 'v1.0'), (e) => e.code === 1 && /Missing --from or --to/.test(e.stderr));
});

test('CLI diff --profile filters both sides before diffing', async () => {
  await runCli('diff', '--workspace', ws, '--from', 'v1.0', '--to', 'v2.0', '--profile', 'public');
  const svg = await readFile(join(ws, 'out', 'diff.public.svg'), 'utf8');
  const full = await readFile(join(ws, 'out', 'diff.svg'), 'utf8');
  // password_digest is a PII column, dropped by the public profile.
  assert.ok(full.includes('password_digest'));
  assert.ok(!svg.includes('password_digest'));
  assert.ok(!svg.includes('shop-api:app/models'), 'no evidence in a public diff');
  await readFile(join(ws, 'out', 'diff.public.xlsx'));
});

test('column default, auto-increment and generated expression changes are reported', async () => {
  const from = await loadWorkspace(MULTI);
  const edit = (c) =>
    c.name === 'status' ? { ...c, default: 'paid' } : c.name === 'id' ? { ...c, auto_increment: undefined } : c.name === 'placed_at' ? { ...c, generated: 'now()' } : c;
  const to = { ...from, tables: from.tables.map((t) => (t.id === 'shop._.orders' ? { ...t, columns: t.columns.map(edit) } : t)) };
  assert.deepEqual(diffModels(from, to).changes.map(describeChange), [
    'Column id: no longer auto-increment',
    'Column placed_at: generated expression set to “now()”',
    'Column status: default changed from “pending” to “paid”',
  ]);
});
