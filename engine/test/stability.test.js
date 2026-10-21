import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLUSTER_GAP, frameAround } from '../src/layout/clusters.js';
import { GRID } from '../src/layout/table-box.js';
import { PALETTE } from '../src/palette.js';
import { computeLayout, formatReport } from '../src/layout/index.js';
import { normalizeModel } from '../src/model/load.js';
import { serializeLayout } from '../src/layout/layout-file.js';
import { axisOrder } from '../src/layout/stability.js';
import { buildDiagram } from '../src/layout/diagram.js';
import { STUB_SLOT, viewNames } from '../src/layout/views.js';
import { buildScene } from '../src/render/svg/render.js';
import { changeModel, fk, loadMulti, loadShop, table } from './helpers/shop.js';

const clustersOf = (layout) => layout.views.all.clusters;

// Rules 1 and 2: every pair ordered on an axis before keeps that order. Corner
// order (top-left x/y) is checked too for nodes, so alignment never flips
// either. A group's corner is wherever its current members start, so after
// a removal it may legitimately pass a neighbour's corner; groups are only
// held to the extent order.
function assertOrderKept(before, after, label, { corners = true } = {}) {
  const ids = Object.keys(before).filter((id) => after[id]);
  for (const a of ids) {
    for (const b of ids) {
      if (a >= b) continue;
      for (const axis of ['x', 'y']) {
        const was = axisOrder(before[a], before[b], axis);
        if (was !== 0) assert.equal(axisOrder(after[a], after[b], axis), was, `${label}: ${a} / ${b} on ${axis}`);
        if (corners) assert.equal(Math.sign(after[a][axis] - after[b][axis]), Math.sign(before[a][axis] - before[b][axis]), `${label}: corner ${a} / ${b} on ${axis}`);
      }
    }
  }
}

function frames(layout) {
  return Object.fromEntries(Object.entries(clustersOf(layout)).map(([k, nodes]) => [k, frameAround(Object.values(nodes))]));
}

function sameMembers(a, b) {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.join() === kb.join() && ka.every((id) => a[id].w === b[id].w && a[id].h === b[id].h);
}

function bbox(boxes) {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
}

// Outer groups of a view as boxes around their nodes: database frames (the
// database is the prefix of a slot key, or the slot key itself in the
// overview). Rule 1 applies to them as it does to clusters.
function databases(view) {
  const byDb = new Map();
  for (const [slot, nodes] of Object.entries(view.clusters)) {
    const db = slot.split('/')[0];
    if (!byDb.has(db)) byDb.set(db, []);
    byDb.get(db).push(...Object.values(nodes));
  }
  return Object.fromEntries([...byDb].map(([db, nodes]) => [db, bbox(nodes)]));
}

// Checks the three stability rules on every view of `after` against
// `before`, plus that the new layout renders and is a fixed point.
async function assertStableLayouts(before, after, next) {
  for (const [name, view] of Object.entries(after.views)) {
    const old = before.views[name]?.clusters;
    if (!old) continue;
    const now = view.clusters;
    // Rule 1: groups keep their relative order (clusters, and the databases
    // around them).
    const slotBoxes = (clusters) => Object.fromEntries(Object.entries(clusters).filter(([k]) => k !== STUB_SLOT).map(([k, n]) => [k, bbox(Object.values(n))]));
    assertOrderKept(slotBoxes(old), slotBoxes(now), `${name} groups`, { corners: false });
    if (name === 'all') assertOrderKept(databases(before.views.all), databases(view), 'all databases', { corners: false });
    for (const key of Object.keys(old).filter((k) => now[k])) {
      // Rule 2: nodes inside a group keep their relative order.
      assertOrderKept(old[key], now[key], `${name} ${key}`);
      // Rule 3: a group without changes only translates. Stubs are not a
      // group: each one sits beside the domain on its own, so stubs on the
      // two sides move apart when the domain grows.
      if (key !== STUB_SLOT && sameMembers(old[key], now[key])) {
        const deltas = new Set(Object.keys(old[key]).map((id) => `${now[key][id].x - old[key][id].x},${now[key][id].y - old[key][id].y}`));
        assert.equal(deltas.size, 1, `${name} ${key} was rearranged`);
      }
    }
  }
  // Valid result: every view places every node without overlap and routes.
  const diagram = buildDiagram(next);
  for (const name of viewNames(diagram)) buildScene(next, after, name, diagram);
  // Running layout again on the same model moves nothing.
  const again = await computeLayout(next, after);
  assert.equal(serializeLayout(again.layout), serializeLayout(after));
  for (const r of Object.values(again.report)) {
    assert.deepEqual([r.added.length, r.removed.length, r.translated.length, r.moved.length], [0, 0, 0, 0]);
  }
}

async function assertStable(change, load = loadShop) {
  const model = await load();
  const { layout: before } = await computeLayout(model);
  const next = changeModel(model, change);
  const { layout: after, report } = await computeLayout(next, before);
  await assertStableLayouts(before, after, next);
  return { before, after, report: report.all, reports: report };
}

test('add one table to a domain', async () => {
  const { report, before, after } = await assertStable({
    add: [table('shop.public.order_notes', 'Sales', [['order_id', 'bigint'], ['body', 'text']])],
    relations: [fk('shop.public.order_notes', 'order_id', 'shop.public.orders')],
  });
  assert.deepEqual(report.added, ['shop.public.order_notes']);
  // Placed in its own cluster's frame.
  const sales = frameAround(Object.values(clustersOf(after)['shop/Sales']));
  const note = clustersOf(after)['shop/Sales']['shop.public.order_notes'];
  assert.ok(note.x >= sales.x && note.x + note.w <= sales.x + sales.w);
  assert.ok(Object.keys(clustersOf(before)['shop/Sales']).length + 1 === Object.keys(clustersOf(after)['shop/Sales']).length);
});

test('add three tables to one domain', async () => {
  const { report } = await assertStable({
    add: [
      table('shop.public.warehouses', 'Catalog', [['name', 'varchar(80)']]),
      table('shop.public.stock_levels', 'Catalog', [['variant_id', 'bigint'], ['warehouse_id', 'bigint'], ['on_hand', 'integer']]),
      table('shop.public.price_history', 'Catalog', [['variant_id', 'bigint'], ['price_cents', 'integer'], ['valid_from', 'timestamp with time zone']]),
    ],
    relations: [
      fk('shop.public.stock_levels', 'variant_id', 'shop.public.product_variants'),
      fk('shop.public.stock_levels', 'warehouse_id', 'shop.public.warehouses'),
      fk('shop.public.price_history', 'variant_id', 'shop.public.product_variants'),
    ],
  });
  assert.equal(report.added.length, 3);
});

test('remove a table', async () => {
  const { report } = await assertStable({ remove: ['shop.public.coupons'] });
  assert.deepEqual(report.removed, ['shop.public.coupons']);
  assert.deepEqual(report.moved, []);
});

test('add a new domain', async () => {
  const { report, after } = await assertStable({
    add: [
      table('shop.public.campaigns', 'Marketing', [['name', 'varchar(80)'], ['starts_at', 'date']]),
      table('shop.public.campaign_products', 'Marketing', [['campaign_id', 'bigint'], ['product_id', 'bigint']]),
    ],
    relations: [
      fk('shop.public.campaign_products', 'campaign_id', 'shop.public.campaigns'),
      fk('shop.public.campaign_products', 'product_id', 'shop.public.products'),
    ],
  });
  assert.equal(report.added.length, 2);
  assert.ok(clustersOf(after)['shop/Marketing']);
  // Old clusters are untouched inside, so nothing is reported as moved within.
  assert.deepEqual(report.moved, []);
});

test('a table that grows pushes its neighbours instead of overlapping them', async () => {
  const model = await loadShop();
  const grown = model.tables.map((t) =>
    t.id === 'shop.public.products'
      ? { ...t, columns: [...t.columns, ...Array.from({ length: 8 }, (_, i) => ({ name: `extra_attribute_${i}`, type: 'varchar(255)' }))] }
      : t,
  );
  const { layout: before } = await computeLayout(model);
  const next = { ...model, tables: grown };
  const { layout: after } = await computeLayout(next, before);
  await assertStableLayouts(before, after, next);
});

// Free space between two frames along the axis they are separated on, and
// whether they face each other (overlap on the other axis).
function facing(a, b) {
  for (const [axis, other] of [['x', 'y'], ['y', 'x']]) {
    const order = axisOrder(a, b, axis);
    if (order === 0 || axisOrder(a, b, other) !== 0) continue;
    const size = axis === 'x' ? 'w' : 'h';
    const [first, second] = order < 0 ? [a, b] : [b, a];
    return second[axis] - (first[axis] + first[size]);
  }
  return Infinity;
}

for (const [domain, target, column, anchor] of [
  ['Marketing', 'shop.public.products', 'product_id', 'shop/Catalog'],
  ['Support', 'shop.public.users', 'user_id', 'shop/Identity'],
]) {
  test(`a new domain lands next to the cluster it relates to most (${domain} -> ${anchor})`, async () => {
    const id = `shop.public.${domain.toLowerCase()}_items`;
    const { after } = await assertStable({
      add: [table(id, domain, [[column, 'bigint'], ['note', 'text']])],
      relations: [fk(id, column, target)],
    });
    const all = frames(after);
    const mine = all[`shop/${domain}`];
    const gaps = Object.entries(all)
      .filter(([k]) => k !== `shop/${domain}`)
      .map(([k, f]) => [k, facing(mine, f)])
      .sort((a, b) => a[1] - b[1]);
    assert.equal(gaps[0][0], anchor, JSON.stringify(gaps));
    assert.ok(gaps[0][1] <= CLUSTER_GAP + GRID, `gap ${gaps[0][1]}`);
  });
}

test('cluster colours are distinct, persisted, and never change when domains come and go', async () => {
  const model = await loadShop();
  const { layout: before } = await computeLayout(model);
  const indices = Object.values(before.colors);
  assert.equal(new Set(indices).size, indices.length);
  assert.equal(indices.length, 3);

  const grown = changeModel(model, { add: [table('shop.public.campaigns', 'Marketing', [['name', 'text']])] });
  const { layout: added } = await computeLayout(grown, before);
  for (const [k, v] of Object.entries(before.colors)) assert.equal(added.colors[k], v);
  assert.ok(!indices.includes(added.colors['shop/Marketing']));

  // A removed domain keeps its colour, so it is not handed to the next new one.
  const shrunk = changeModel(grown, { remove: ['shop.public.campaigns'] });
  const { layout: removed } = await computeLayout(shrunk, added);
  assert.equal(removed.colors['shop/Marketing'], added.colors['shop/Marketing']);
});

test('colours cycle to the least used index once the palette is exhausted', async () => {
  const model = await loadShop();
  const { layout } = await computeLayout(model);
  // Indices 0 and 1 are held twice, every other index once.
  const colors = Object.fromEntries(PALETTE.map((_, i) => [`old/${i}`, i]));
  Object.assign(colors, { 'old/again0': 0, 'old/again1': 1 });
  const { layout: next } = await computeLayout(model, { ...layout, colors });
  // New clusters in name order take the lowest of the least used indices.
  assert.deepEqual([next.colors['shop/Catalog'], next.colors['shop/Identity'], next.colors['shop/Sales']], [2, 3, 4]);
});

// Multi-database fixture: the same rules hold in the overview and in every
// domain view, at the database level too.
test('multi: add a table to a domain', async () => {
  const { reports } = await assertStable(
    {
      add: [table('shop._.coupons', 'Orders', [['code', 'varchar(32)']])],
      relations: [{ ...fk('shop._.orders', 'status', 'shop._.coupons'), kind: 'inferred', review: 'pending', evidence: ['shop-api:x.rb'] }],
    },
    loadMulti,
  );
  assert.deepEqual(reports.all.added, ['shop._.coupons']);
  assert.deepEqual(reports['domain:shop/Orders'].added, ['shop._.coupons']);
  // The overview box only grows its count text; nothing else changes there.
  assert.deepEqual(reports.overview.added, []);
});

test('multi: add a domain', async () => {
  const { reports, after } = await assertStable(
    {
      add: [table('auth.public.api_keys', 'Security', [['organization_id', 'bigint']])],
      relations: [fk('auth.public.api_keys', 'organization_id', 'auth.public.organizations')],
    },
    loadMulti,
  );
  assert.deepEqual(reports.overview.added, ['auth/Security']);
  assert.ok(after.views['domain:auth/Security']);
  // The new domain view shows organizations as a stub next to it.
  assert.deepEqual(Object.keys(after.views['domain:auth/Security'].clusters[STUB_SLOT]), ['auth.public.organizations']);
});

test('multi: add a database', async () => {
  const { reports, after } = await assertStable(
    {
      databases: [{ database: 'search', engine: 'elasticsearch', file: 'model/search.yaml' }],
      add: [table('search._.product_docs', 'Search', [['product_id', 'long']])],
      relations: [{ ...fk('search._.product_docs', 'product_id', 'shop._.products'), kind: 'cross_db' }],
    },
    loadMulti,
  );
  assert.deepEqual(reports.all.added, ['search._.product_docs']);
  assert.deepEqual(reports.overview.added, ['search/Search']);
  assert.ok(after.views.overview.clusters.search);
});

test('multi: removing a domain drops its view from layout.json', async () => {
  const model = await loadMulti();
  const { layout: before } = await computeLayout(model);
  const next = changeModel(model, { remove: ['activity._.audit_logs'] });
  const { layout: after } = await computeLayout(next, before);
  assert.ok(before.views['domain:activity/Audit']);
  assert.equal(after.views['domain:activity/Audit'], undefined);
  await assertStableLayouts(before, after, next);
});

// Renames confirmed by the user (`renamed_from`): the new id takes over the
// old one's place in every view instead of being removed and added.
function renameTables(model, rename) {
  const to = (id) => rename(id) ?? id;
  const end = (e) => ({ ...e, table: to(e.table) });
  return normalizeModel({
    ...model,
    tables: model.tables.map((t) => (rename(t.id) ? { ...t, id: rename(t.id), renamed_from: t.id } : t)),
    relations: model.relations.map((r) => ({ ...r, from: end(r.from), to: end(r.to) })),
    polymorphic: model.polymorphic.map((a) => ({ ...a, table: to(a.table), targets: a.targets.map(to) })),
    config: { ...model.config, hub: model.config.hub && { ...model.config.hub, tables: (model.config.hub.tables ?? []).map(to) } },
  });
}

function positions(layout, rename = (id) => id) {
  const out = {};
  for (const [view, body] of Object.entries(layout.views)) {
    for (const [slot, nodes] of Object.entries(body.clusters)) {
      for (const [id, n] of Object.entries(nodes)) out[`${view} ${slot} ${rename(id)}`] = `${n.x},${n.y},${n.w},${n.h}`;
    }
  }
  return out;
}

test('a renamed table keeps its position in every view', async () => {
  const model = await loadShop();
  const { layout: before } = await computeLayout(model);
  const renamed = renameTables(model, (id) => (id === 'shop.public.orders' ? 'shop.public.purchases' : null));
  const { layout: after, report } = await computeLayout(renamed, before);
  // Boxes are sized from their name, so only the renamed one may change size.
  const strip = (p) => Object.fromEntries(Object.entries(p).filter(([k]) => !k.endsWith('purchases')));
  assert.deepEqual(strip(positions(after)), strip(positions(before, (id) => (id === 'shop.public.orders' ? 'shop.public.purchases' : id))));
  const [x, y] = positions(before)['all shop/Sales shop.public.orders'].split(',');
  assert.match(positions(after)['all shop/Sales shop.public.purchases'], new RegExp(`^${x},${y},`));
  for (const r of Object.values(report)) assert.deepEqual([r.added, r.removed], [[], []]);
  assert.deepEqual(report.all.renamed, [['shop.public.orders', 'shop.public.purchases']]);
  assert.match(formatReport(report), /^  renamed    shop\.public\.orders -> shop\.public\.purchases$/m);
});

test('renaming a database carries its clusters, domain views and colours', async () => {
  const model = await loadMulti();
  const { layout: before } = await computeLayout(model);
  const move = (id) => (id.startsWith('activity.') ? `telemetry.${id.slice('activity.'.length)}` : null);
  const renamed = renameTables(
    { ...model, databases: model.databases.map((d) => (d.database === 'activity' ? { ...d, database: 'telemetry' } : d)) },
    move,
  );
  const { layout: after, report } = await computeLayout(renamed, before);
  const key = (k) => k.replace(/activity(?=[/.:])/g, 'telemetry').replace(/^overview activity /, 'overview telemetry ');
  const expected = Object.fromEntries(Object.entries(positions(before)).map(([k, v]) => [key(k), v]));
  assert.deepEqual(positions(after), expected);
  for (const domain of ['Audit', 'Events']) assert.equal(after.colors[`telemetry/${domain}`], before.colors[`activity/${domain}`]);
  for (const r of Object.values(report)) assert.deepEqual([r.added, r.removed], [[], []]);
});

// A schema above ALL_VIEW_MAX_TABLES has no view of all tables in
// layout.json; renames are then found through the domain views.
test('renames carry over from a layout without the view of all tables', async () => {
  const model = await loadMulti();
  const { layout: full } = await computeLayout(model);
  const { all, ...views } = full.views;
  const before = { ...full, views };
  const move = (id) => (id.startsWith('activity.') ? `telemetry.${id.slice('activity.'.length)}` : null);
  const renamed = renameTables(
    { ...model, databases: model.databases.map((d) => (d.database === 'activity' ? { ...d, database: 'telemetry' } : d)) },
    move,
  );
  const { layout: after, report } = await computeLayout(renamed, before);
  const key = (k) => k.replace(/activity(?=[/.:])/g, 'telemetry').replace(/^overview activity /, 'overview telemetry ');
  const expected = Object.fromEntries(Object.entries(positions(before)).map(([k, v]) => [key(k), v]));
  const withoutAll = (p) => Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith('all ')));
  assert.deepEqual(withoutAll(positions(after)), expected);
  for (const domain of ['Audit', 'Events']) assert.equal(after.colors[`telemetry/${domain}`], before.colors[`activity/${domain}`]);
  assert.ok(report['domain:telemetry/Audit'].renamed.length > 0);
  assert.deepEqual([report['domain:telemetry/Audit'].added, report['domain:telemetry/Audit'].removed], [[], []]);
});

test('a table renamed into another domain is placed there as new', async () => {
  const model = await loadShop();
  const { layout: before } = await computeLayout(model);
  const renamed = renameTables(model, (id) => (id === 'shop.public.orders' ? 'shop.public.purchases' : null));
  renamed.tables = renamed.tables.map((t) => (t.id === 'shop.public.purchases' ? { ...t, domain: 'Catalog' } : t));
  const { report } = await computeLayout(renamed, before);
  assert.deepEqual(report.all.added, ['shop.public.purchases']);
  assert.deepEqual(report.all.removed, ['shop.public.orders']);
  assert.deepEqual(report.all.renamed, []);
});
