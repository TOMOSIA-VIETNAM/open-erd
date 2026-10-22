import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDiagram } from '../src/layout/diagram.js';
import { layeredEdges } from '../src/layout/elk-layout.js';
import { computeLayout } from '../src/layout/index.js';
import { CENTRAL_MIN_LINKS, centralTables, centralityScores } from '../src/model/centrality.js';
import { normalizeModel } from '../src/model/load.js';
import { renderSvg } from '../src/render/svg/render.js';
import { fk, loadMulti, table } from './helpers/shop.js';

// One domain built around `hub`: `n` tables pointing at it, plus a pair
// linked only to each other.
function star(n, extra = {}) {
  const leaves = Array.from({ length: n }, (_, i) => `db._.leaf_${String(i).padStart(2, '0')}`);
  return normalizeModel({
    config: {},
    databases: [{ database: 'db', engine: 'postgresql' }],
    tables: [table('db._.hub', 'Core', []), ...leaves.map((id) => table(id, 'Core', [['hub_id', 'bigint']])), table('db._.x', 'Other', [['y_id', 'bigint']]), table('db._.y', 'Other', [])],
    relations: [...leaves.map((id) => fk(id, 'hub_id', 'db._.hub')), fk('db._.x', 'y_id', 'db._.y')],
    polymorphic: [],
    ...extra,
  });
}

test('centrality score: every relation end counts, hub relations and polymorphic owner and targets too', async () => {
  const model = await loadMulti();
  const scores = centralityScores(model);
  const expected = new Map(model.tables.map((t) => [t.id, 0]));
  const add = (id) => expected.set(id, expected.get(id) + 1);
  for (const r of model.relations) {
    add(r.from.table);
    if (r.to.table !== r.from.table) add(r.to.table);
  }
  for (const a of model.polymorphic) [a.table, ...a.targets].forEach(add);
  assert.deepEqual(scores, expected);
  // users is the hub table: every created_by points at it.
  assert.equal(Math.max(...scores.values()), scores.get('auth.public.users'));
});

test('central tables: clearly above the median and the strict top of their domain; deterministic', () => {
  const model = star(6);
  const ids = model.tables.map((t) => t.id);
  const cluster = (id) => model.tables.find((t) => t.id === id).domain;
  const result = centralTables(model, ids, cluster);
  assert.deepEqual([...result.central], ['db._.hub']);
  assert.deepEqual([...result.byCluster], [['Core', 'db._.hub']]);
  // Below CENTRAL_MIN_LINKS links nothing is central, however lopsided.
  assert.equal(centralTables(star(CENTRAL_MIN_LINKS - 1), star(CENTRAL_MIN_LINKS - 1).tables.map((t) => t.id), () => 'Core').central.size, 0);
  // Two equally strong tables of one domain are both central through the
  // schema-wide top list; the domain box names the first by id.
  const twin = star(6, {});
  const tied = normalizeModel({ ...twin, tables: [...twin.tables, table('db._.hub2', 'Core', [])], relations: [...twin.relations, ...twin.tables.filter((t) => t.id.includes('leaf')).map((t) => fk(t.id, 'id', 'db._.hub2'))] });
  const both = centralTables(tied, tied.tables.map((t) => t.id), () => 'Core');
  assert.deepEqual([...both.central].sort(), ['db._.hub', 'db._.hub2']);
  assert.equal(both.byCluster.get('Core'), 'db._.hub');
  // Same input, same answer, in any input order.
  const again = centralTables(model, [...ids].reverse(), cluster);
  assert.deepEqual([...again.central], [...result.central]);
});

test('a central table is drawn with a stronger header and a star; its domain card names it on the overview', async () => {
  const model = star(6);
  const { layout } = await computeLayout(model);
  const svg = renderSvg(model, layout);
  assert.match(svg, /<g class="table central" data-id="db\._\.hub">/);
  assert.match(svg, /<g class="table central"[^>]*>.*?<path class="icon-central"/s);
  assert.doesNotMatch(svg, /<g class="table central" data-id="db\._\.leaf/);
  assert.match(svg, /<text class="card-central"[^>]*>Central: <tspan class="fact-code">hub<\/tspan><\/text>/);
  const diagram = buildDiagram(model);
  assert.equal(diagram.centralOf.get('db/Core'), 'db._.hub');
});

test('a fresh layout puts the central table in a middle layer, with neighbours on both sides', async () => {
  const model = star(6);
  const ids = new Set(model.tables.map((t) => t.id));
  const links = model.relations.map((r) => ({ from: r.from.table, to: r.to.table }));
  const edges = layeredEdges(ids, links, new Set(['db._.hub']));
  // Without a centre every leaf would sit right of the hub; now half point at it.
  assert.equal(edges.filter(([, b]) => b === 'db._.hub').length, 3);
  assert.equal(edges.filter(([a]) => a === 'db._.hub').length, 3);
  const { layout } = await computeLayout(model);
  const boxes = layout.views['domain:db/Core'].clusters['db/Core'];
  const hub = boxes['db._.hub'];
  const leaves = Object.entries(boxes).filter(([id]) => id !== 'db._.hub').map(([, b]) => b);
  assert.ok(leaves.some((b) => b.x + b.w <= hub.x) && leaves.some((b) => b.x >= hub.x + hub.w), JSON.stringify(boxes));
});

test('--relayout places the named views from scratch; kept views stay; off-centre views are reported', async () => {
  const model = star(6);
  const { layout: fresh } = await computeLayout(model);
  // Move the hub to a corner of its domain in every view, as an old layout would have it.
  const moved = structuredClone(fresh);
  for (const name of ['all', 'domain:db/Core']) {
    const boxes = moved.views[name].clusters['db/Core'];
    const minX = Math.min(...Object.values(boxes).map((b) => b.x));
    const maxY = Math.max(...Object.values(boxes).map((b) => b.y + b.h));
    boxes['db._.hub'] = { ...boxes['db._.hub'], x: minX - 400, y: maxY + 200 };
  }
  const kept = await computeLayout(model, moved);
  assert.deepEqual(Object.keys(kept.offCentre).sort(), ['all', 'domain:db/Core']);
  assert.deepEqual(kept.layout.views['domain:db/Core'], moved.views['domain:db/Core']);
  const one = await computeLayout(model, moved, { relayout: ['domain:db/Core'] });
  assert.deepEqual(one.layout.views['domain:db/Core'], fresh.views['domain:db/Core']);
  assert.deepEqual(one.layout.views.all, moved.views.all);
  assert.deepEqual(Object.keys(one.offCentre), ['all']);
  const every = await computeLayout(model, moved, { relayout: ['*'] });
  assert.deepEqual(every.layout, fresh);
  assert.deepEqual(every.offCentre, {});
  await assert.rejects(computeLayout(model, moved, { relayout: ['domain:db/Nope'] }), /--relayout: unknown view "domain:db\/Nope"/);
});
