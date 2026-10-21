import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aggregate, checkEvidence, mapPrefixes, scoreModels } from './score.mjs';

const rel = (from, fc, to, tc, extra = {}) => ({
  from: { table: from, columns: fc }, to: { table: to, columns: tc }, cardinality: 'n-1', optional: false, kind: 'declared', evidence: [], ...extra,
});
const table = (id, extra = {}) => ({ id, domain: 'D', columns: [{ name: 'id', type: 'bigint', pk: true }], ...extra });

const expected = {
  tables: [
    table('shop.public.orders', { note: 'One order.', columns: [{ name: 'status', type: 'int', enum: { 0: 'a', 1: 'b' } }] }),
    table('shop.public.users'),
    table('shop.public.comments'),
    table('shop.public.events', { embedded: [{ name: 'tiers', columns: [{ name: 'kind', type: 'string', enum: { vip: 'x' } }] }] }),
  ],
  relations: [
    rel('shop.public.orders', ['user_id'], 'shop.public.users', ['id']),
    rel('shop.public.comments', ['user_id'], 'shop.public.users', ['id'], { optional: true }),
  ],
  polymorphic: [{ name: 'commentable', table: 'shop.public.comments', targets: ['shop.public.orders', 'shop.public.users'] }],
};

test('identical models score 1.0 everywhere', () => {
  const s = scoreModels(expected, expected);
  for (const m of ['tables', 'relations', 'polymorphic', 'enums']) assert.equal(s[m].f1, 1, m);
  for (const m of ['cardinality', 'optional', 'kind', 'notes']) assert.equal(s[m].accuracy, 1, m);
  assert.deepEqual(s.prefixes, {});
});

test('database name and schema segment are aliased by table overlap', () => {
  const produced = structuredClone(expected);
  const ren = (id) => id.replace('shop.public.', 'shop_app._.');
  for (const t of produced.tables) t.id = ren(t.id);
  for (const r of produced.relations) { r.from.table = ren(r.from.table); r.to.table = ren(r.to.table); }
  for (const p of produced.polymorphic) { p.table = ren(p.table); p.targets = p.targets.map(ren); }
  const s = scoreModels(expected, produced);
  assert.deepEqual(s.prefixes, { 'shop_app._': 'shop.public' });
  assert.equal(s.relations.f1, 1);
  assert.equal(s.polymorphic.recall, 1);
});

test('prefix mapping is one-to-one: a second schema of the same db stays unmatched', () => {
  const m = mapPrefixes(['b.public.plans', 'b.tenant.invoices', 'b.tenant.lines'], ['b.public.plans', 'b.public.invoices', 'b.public.lines']);
  assert.deepEqual([...m], [['b.public', 'b.tenant']]);
});

test('missing, extra and wrong attributes are counted and listed', () => {
  const produced = structuredClone(expected);
  produced.tables = produced.tables.filter((t) => t.id !== 'shop.public.users');
  produced.tables[0].note = '  ';
  produced.tables[0].columns[0].enum = { 0: 'a', 2: 'c' };
  produced.relations[0].cardinality = '1-1';
  produced.relations[1].to.columns = ['uuid'];
  produced.relations.push(rel('shop.public.orders', ['coupon_id'], 'shop.public.coupons', ['id']));
  produced.polymorphic[0].targets = ['shop.public.orders'];
  const s = scoreModels(expected, produced);

  assert.deepEqual(s.tables.missing, ['shop.public.users']);
  assert.equal(s.tables.recall, 3 / 4);
  assert.equal(s.tables.precision, 1);
  assert.deepEqual([s.relations.tp, s.relations.fp, s.relations.fn], [1, 2, 1]);
  assert.equal(s.cardinality.total, 1);
  assert.equal(s.cardinality.accuracy, 0);
  assert.equal(s.polymorphic.recall, 0);
  assert.deepEqual(s.enums.missing, ['shop.public.orders.status=1']);
  assert.deepEqual(s.enums.extra, ['shop.public.orders.status=2']);
  assert.deepEqual(s.notes.wrong, ['shop.public.orders']);
});

test('embedded enum values are keyed by entity path', () => {
  const produced = structuredClone(expected);
  produced.tables[3].embedded = [];
  const s = scoreModels(expected, produced);
  assert.deepEqual(s.enums.missing, ['shop.public.events.tiers.kind=vip']);
});

test('empty sets give null ratios, not 0 or 1', () => {
  const s = scoreModels({ tables: [], relations: [], polymorphic: [] }, { tables: [], relations: [], polymorphic: [] });
  assert.equal(s.polymorphic.recall, null);
  assert.equal(s.polymorphic.precision, null);
});

test('aggregate takes the median run per case and sums counts', () => {
  const run = (c, tp, fn) => ({
    case: c,
    tables: { tp, fp: 0, fn, f1: tp / (tp + fn) },
    relations: { tp, fp: 0, fn, f1: tp / (tp + fn) },
    polymorphic: { tp: 1, fp: 0, fn: 0, f1: 1 },
    enums: { tp: 1, fp: 0, fn: 0, f1: 1 },
    cardinality: { correct: 1, total: 1, accuracy: 1 },
    optional: { correct: 1, total: 1, accuracy: 1 },
    kind: { correct: 1, total: 1, accuracy: 1 },
    notes: { correct: 0, total: 0, accuracy: null },
  });
  const agg = aggregate([run('a', 10, 0), run('a', 5, 5), run('a', 8, 2), run('b', 9, 1)]);
  assert.equal(agg.cases[0].relations.tp, 8);
  assert.equal(agg.total.relations.tp, 17);
  assert.equal(agg.total.relations.fn, 3);
  assert.equal(agg.total.relations.recall, 17 / 20);
  assert.equal(agg.checks.find((c) => c.metric === 'relations' && c.field === 'recall').pass, false);
  assert.equal(agg.pass, false);
});

test('evidence checker resolves repo, file, optional line and symbol', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-erd-score-'));
  fs.mkdirSync(path.join(dir, 'app'));
  fs.writeFileSync(path.join(dir, 'app/order.rb'), 'class Order\nend\n');
  const model = {
    relations: [{ evidence: ['api:app/order.rb#Order', 'api:app/order.rb:1#Order', 'db', 'api:app/order.rb#Missing', 'web:x.rb#X', 'api:nope.rb#Order', 'bogus'] }],
    polymorphic: [],
  };
  const { count, problems } = checkEvidence(model, { api: dir });
  assert.equal(count, 6);
  assert.deepEqual(problems, [
    'api:app/order.rb#Missing: symbol not found',
    'web:x.rb#X: unknown repo',
    'api:nope.rb#Order: missing file',
    'bogus: malformed',
  ]);
});
