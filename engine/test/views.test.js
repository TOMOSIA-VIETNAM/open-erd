import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildDiagram, polyNodeId } from '../src/layout/diagram.js';
import { computeLayout } from '../src/layout/index.js';
import { serializeLayout } from '../src/layout/layout-file.js';
import { SELF_STUB } from '../src/layout/router.js';
import { POLY_VISIBLE_TARGETS } from '../src/layout/table-box.js';
import { ALL_VIEW, ALL_VIEW_MAX_TABLES, STUB_SLOT, viewNames } from '../src/layout/views.js';
import { normalizeModel } from '../src/model/load.js';
import { configSchema } from '../src/model/schema.js';
import { validateNode } from '../src/model/validate.js';
import { endMarkers, overviewStrokeWidth } from '../src/render/svg/markers.js';
import { gridPlace } from '../src/layout/elk-layout.js';
import { HUB_ROUTE_LIMIT, buildScene, renderSvg } from '../src/render/svg/render.js';
import { pathLength } from './helpers/geometry.js';
import { fk, loadMulti, loadWorkspace, table } from './helpers/shop.js';

async function multi(change = (m) => m) {
  const model = change(await loadMulti());
  const { layout } = await computeLayout(model);
  const diagram = buildDiagram(model);
  const scene = (name) => buildScene(model, layout, name, diagram);
  return { model, layout, diagram, scene, svg: renderSvg(model, layout) };
}

const withConfig = (config) => (m) => ({ ...m, config: { ...m.config, ...config } });

test('relation kinds and review states carry their own classes; two line styles only', async () => {
  const { svg, scene } = await multi();
  const attr = (id) => id.replaceAll('>', '&gt;').replace(/[.()]/g, '\\$&');
  const group = (id) => svg.match(new RegExp(`<g class="relation-group ([^"]+)" data-id="${attr(id)}"`))?.[1];
  // Dashed (unconfirmed): an inference nobody reviewed, or a fact the code no
  // longer supports. Everything else solid, whatever its kind.
  assert.equal(group('shop._.payments(order_id)->shop._.orders(id)'), 'kind-inferred review-pending unconfirmed');
  assert.equal(group('shop._.refunds(payment_id)->shop._.payments(id)'), 'kind-inferred review-reviewed');
  assert.equal(group('shop._.products(brand_id)->shop._.brands(id)'), 'kind-declared review-stale unconfirmed');
  assert.equal(group('activity._.audit_logs(organization_id)->auth.public.organizations(id)'), 'kind-cross_db review-pending');
  assert.equal(group('shop._.comments(commentable_id)->«commentable»'), 'kind-polymorphic review-reviewed');
  assert.match(svg, /\.unconfirmed \.relation, \.poly-route\.unconfirmed \{ stroke-dasharray: 6 4; \}/);
  // Kind has no dash pattern of its own; review colours only in review mode.
  assert.doesNotMatch(svg, /\n\.kind-(cross_db|polymorphic|inferred)[^\n]*dasharray/);
  assert.doesNotMatch(svg, /\n\.review-(pending|stale)/);
  assert.match(svg, /\.review-mode \.review-pending :is\(\.relation, \.marker\) \{ stroke: #c27c0e; \}/);
  // Every cross-DB line, and only those, is labelled in the full view with both databases.
  for (const r of scene('all').relations) {
    assert.equal(r.label?.text ?? null, r.link.kind === 'cross_db' ? `${r.link.from.node.split('.')[0]} → ${r.link.to.node.split('.')[0]}` : null, r.id);
  }
});

test('hub relations are badges, not lines', async () => {
  const { scene, diagram, svg } = await multi();
  const all = scene('all');
  const ids = new Set(all.relations.map((r) => r.id));
  for (const id of ['shop._.orders(user_id)->auth.public.users(id)', 'shop._.products(created_by)->auth.public.users(id)', 'auth.public.user_profiles(user_id)->auth.public.users(id)']) {
    assert.ok(!ids.has(id), `${id} was routed`);
  }
  for (const r of all.relations) assert.notEqual(r.link.to.node, 'auth.public.users', r.id);
  assert.deepEqual(diagram.nodes.get('shop._.products').box.badges.map(({ target, count, columns }) => ({ target, count, columns })), [
    { target: 'auth.public.users', count: 2, columns: ['created_by', 'updated_by'] },
  ]);
  assert.equal(diagram.nodes.get('shop._.products').box.badges[0].label.text, 'users ×2');
  assert.match(svg, /<title>created_by, updated_by → auth\.public\.users<\/title>/);
});

test('a polymorphic association is one virtual node and one line; targets are data only', async () => {
  const { scene, svg, model } = await multi();
  const all = scene('all');
  const commentable = polyNodeId(model.polymorphic.find((a) => a.name === 'commentable'));
  const fromComments = all.relations.filter((r) => r.link.from.node === 'shop._.comments' || r.link.to.node === 'shop._.comments');
  assert.deepEqual(fromComments.map((r) => r.link.to.node), [commentable]);
  const attachable = all.nodes.find((n) => n.id === polyNodeId(model.polymorphic.find((a) => a.name === 'attachable')));
  assert.equal(attachable.box.rows.length, POLY_VISIBLE_TARGETS + 1);
  assert.equal(attachable.box.rows.at(-1).name.text, '+1 more');
  // All five targets are embedded for the viewer, none is drawn.
  assert.match(svg, /data-name="attachable"[^>]*data-targets="\[&quot;shop\._\.comments&quot;,&quot;shop\._\.orders&quot;,&quot;shop\._\.posts&quot;,&quot;shop\._\.products&quot;,&quot;shop\._\.refunds&quot;\]"/);
  // The virtual node sits in its owner's domain.
  const contentFrame = all.groups.find((g) => g.kind === 'cluster' && g.group.key === 'shop/Content').frame;
  assert.ok(attachable.x >= contentFrame.x && attachable.x + attachable.w <= contentFrame.x + contentFrame.w);
});

test('overview: one line per pair of domains, its width and badge from the relation count', async () => {
  const { scene, svg } = await multi();
  const overview = scene('overview');
  const counts = Object.fromEntries(overview.relations.map((r) => [r.id, [r.link.count, r.link.kind, r.badge.text]]));
  assert.deepEqual(counts, {
    // memberships.role_id -> roles; memberships.user_id is a hub badge.
    'auth/Identity<->auth/Organizations': [1, 'domain', '1'],
    'activity/Audit<->auth/Organizations': [1, 'cross_db', '1'],
    'activity/Events<->shop/Catalog': [1, 'cross_db', '1'],
    'activity/Events<->shop/Orders': [1, 'cross_db', '1'],
    'auth/Organizations<->shop/Orders': [1, 'cross_db', '1'],
    'shop/Catalog<->shop/Orders': [1, 'domain', '1'],
    // commentable -> products, attachable -> products
    'shop/Catalog<->shop/Content': [2, 'domain', '2'],
    // commentable -> orders, attachable -> orders, refunds
    'shop/Content<->shop/Orders': [3, 'domain', '3'],
  });
  // No arrowheads, no text label; orthogonal segments only (no diagonal),
  // at most two bends here; lines of one relation are weak (hidden at first).
  for (const r of overview.relations) {
    assert.equal(r.markers, undefined);
    assert.equal(r.label, undefined);
    assert.ok(r.points.slice(1).every(([x, y], i) => x === r.points[i][0] || y === r.points[i][1]), `${r.id}: diagonal segment`);
    assert.ok(r.points.length <= 4, `${r.id}: ${r.points.length - 2} bends`);
    assert.equal(r.weak, r.link.count < 2, r.id);
  }
  assert.match(svg, /<g class="relation-group overview-link kind-domain weak" data-id="shop\/Catalog&lt;-&gt;shop\/Orders"/);
  assert.match(svg, /\.overview-link\.weak \{ display: none; \}/);
  const content = overview.relations.find((r) => r.id === 'shop/Content<->shop/Orders').link.relations;
  assert.deepEqual(
    content.map((r) => [r.from.table, r.from.column, r.to, r.cardinality, r.association]),
    [
      ['shop._.attachments', 'attachable_id', 'shop._.orders', 'n-1', 'attachable'],
      ['shop._.attachments', 'attachable_id', 'shop._.refunds', 'n-1', 'attachable'],
      ['shop._.comments', 'commentable_id', 'shop._.orders', 'n-1', 'commentable'],
    ],
  );
  // Width in a few steps; cross-DB lines dashed; one neutral colour, no review classes.
  assert.deepEqual([1, 2, 3, 4, 7, 8, 40].map(overviewStrokeWidth), [1.2, 2, 2, 3, 3, 4, 4]);
  assert.match(svg, /<g class="relation-group overview-link kind-domain" data-id="shop\/Content&lt;-&gt;shop\/Orders"[^>]*>.*?style="stroke-width:2"/);
  assert.match(svg, /\.overview-link\.kind-cross_db \.relation \{ stroke-dasharray: 8 6;/);
  assert.doesNotMatch(svg.slice(svg.indexOf('<g class="view"'), svg.indexOf('<script')), /overview-link[^"]*review-/);
  assert.deepEqual(
    overview.groups.map((g) => [g.kind, g.group.database, g.group.engine]),
    [['db', 'activity', 'mongodb'], ['db', 'auth', 'postgresql'], ['db', 'shop', 'mysql']],
  );
  const catalog = overview.nodes.find((n) => n.id === 'shop/Catalog');
  assert.equal(catalog.box.count.text, '4 tables');
});

test('references both ways between two domains are one overview line listing both directions', async () => {
  const back = { from: { table: 'auth.public.roles', columns: ['id'] }, to: { table: 'auth.public.organizations', columns: ['id'] }, cardinality: '1-1', optional: false, kind: 'declared', evidence: ['db'], review: 'pending' };
  const { scene } = await multi((m) => normalizeModel({ ...m, relations: [...m.relations, back] }));
  const lines = scene('overview').relations.filter((r) => r.id.includes('auth/Identity') && r.id.includes('auth/Organizations'));
  assert.deepEqual(
    lines.map((r) => [r.id, r.link.count, r.link.relations.map((x) => `${x.from.table}->${x.to}`)]),
    [['auth/Identity<->auth/Organizations', 2, ['auth.public.memberships->auth.public.roles', 'auth.public.roles->auth.public.organizations']]],
  );
});

test('overview grid: linked domains of a fresh layout are neighbours, the same on every run', () => {
  // A chain a-b-c-d-e with heavy weights and one stray box: each link should
  // end up between grid neighbours (straight or one bend).
  const boxes = ['a', 'b', 'c', 'd', 'e', 'z'].map((id) => ({ id, w: 200, h: 60 }));
  const pairs = [
    { from: 'a', to: 'b', weight: 9 },
    { from: 'b', to: 'c', weight: 7 },
    { from: 'c', to: 'd', weight: 5 },
    { from: 'd', to: 'e', weight: 3 },
    { from: 'e', to: 'a', weight: 1 },
  ];
  const placed = gridPlace(boxes, pairs, 80, 2.5);
  assert.deepEqual(gridPlace(boxes, [...pairs].reverse(), 80, 2.5), placed);
  const cellOf = (id) => [placed.get(id).x, placed.get(id).y];
  const xs = [...new Set(boxes.map((b) => placed.get(b.id).x))].sort((p, q) => p - q);
  const ys = [...new Set(boxes.map((b) => placed.get(b.id).y))].sort((p, q) => p - q);
  const grid = (id) => [ys.indexOf(cellOf(id)[1]), xs.indexOf(cellOf(id)[0])];
  for (const { from, to } of pairs.slice(0, 4)) {
    const [[r1, c1], [r2, c2]] = [grid(from), grid(to)];
    assert.ok(Math.max(Math.abs(r1 - r2), Math.abs(c1 - c2)) === 1, `${from}-${to} are not neighbours: ${grid(from)} ${grid(to)}`);
  }
  for (const b of boxes) assert.ok(placed.get(b.id).x % 10 === 0 && placed.get(b.id).y % 10 === 0, `${b.id} off the grid`);
});

test('hub relations into a hub table are routed per view, hidden until it is selected', async () => {
  const { scene, diagram, svg } = await multi();
  const all = scene('all');
  const users = 'auth.public.users';
  assert.ok(diagram.hubLinks.length > 0);
  // Every hub relation of the full view is routed once, ending at the hub table.
  assert.deepEqual(all.hubRoutes.map((r) => r.link.id), diagram.hubLinks.filter((l) => l.from.node !== l.to.node).map((l) => l.id));
  const byId = new Map(all.nodes.map((n) => [n.id, n]));
  for (const r of all.hubRoutes) {
    const [from, to] = [byId.get(r.link.from.node), byId.get(r.link.to.node)];
    const [first, last] = [r.points[0], r.points.at(-1)];
    assert.ok(first[0] === from.x || first[0] === from.x + from.w, `${r.link.id}: starts on its table's side`);
    assert.ok(last[0] === to.x || last[0] === to.x + to.w, `${r.link.id}: ends on the hub's side`);
    assert.deepEqual(r.markers, endMarkers(r.link));
  }
  assert.match(svg, /<g class="hub-routes" data-hub="auth\.public\.users" style="display:none"><g class="hub-route kind-/);
  // Not relation lines: the drawn views stay as they were.
  assert.ok(!all.relations.some((r) => r.link.to.node === users && diagram.hubLinks.some((l) => l.id === r.id)));
  // A domain view routes only the hub relations whose two ends it draws.
  const identity = scene('domain:auth/Identity');
  const drawn = new Set(identity.nodes.map((n) => n.id));
  assert.ok(identity.hubRoutes.length > 0);
  for (const r of identity.hubRoutes) assert.ok(drawn.has(r.link.from.node) && r.link.to.node === users, r.link.id);
  assert.deepEqual(scene('overview').hubRoutes, []);
});

test('a hub fanned out to more than HUB_ROUTE_LIMIT tables in a view gets no lines there', async () => {
  const extra = Array.from({ length: HUB_ROUTE_LIMIT }, (_, i) => table(`shop._.extra_${String(i).padStart(2, '0')}`, 'Extra', [['created_by', 'bigint']]));
  const refs = extra.map((t) => fk(t.id, 'created_by', 'auth.public.users'));
  const { scene, diagram } = await multi((m) => normalizeModel({ ...m, tables: [...m.tables, ...extra], relations: [...m.relations, ...refs] }));
  const into = diagram.hubLinks.filter((l) => l.to.node === 'auth.public.users' && l.from.node !== l.to.node).length;
  assert.ok(into > HUB_ROUTE_LIMIT);
  assert.deepEqual(scene('all').hubRoutes.filter((r) => r.link.to.node === 'auth.public.users'), []);
});

// A stub sits outside its domain's frame, beside the half holding the node it
// links to and at that node's row (or below the stubs before it on that side).
// Its line therefore needs at most the frame's width and height to reach the
// row, which bounds every stub line by the frame's half perimeter; in the full
// view the same relation may cross the whole page.
test('domain views show the domain plus stubs, with short stub lines', async () => {
  const { scene, diagram } = await multi();
  const all = new Map(scene('all').relations.map((r) => [r.id, pathLength(r.points)]));
  let shorter = 0;
  for (const name of viewNames(diagram).filter((v) => v.startsWith('domain:'))) {
    const key = name.slice('domain:'.length);
    const s = scene(name);
    const inside = new Set(diagram.clusters.get(key));
    const expected = new Set(
      diagram.links
        .filter((l) => inside.has(l.from.node) !== inside.has(l.to.node))
        .map((l) => (inside.has(l.from.node) ? l.to.node : l.from.node)),
    );
    assert.deepEqual(new Set(s.nodes.filter((n) => n.kind === 'stub').map((n) => n.id)), expected, name);
    assert.deepEqual(s.nodes.filter((n) => n.kind !== 'stub').map((n) => n.id).sort(), [...inside].sort(), name);
    const frame = s.groups.find((g) => g.kind === 'cluster').frame;
    for (const r of s.relations) {
      if (inside.has(r.link.from.node) && inside.has(r.link.to.node)) continue;
      const length = pathLength(r.points);
      assert.ok(length <= frame.w + frame.h, `${name}: ${r.id} is ${length} px, frame ${frame.w}x${frame.h}`);
      if (length < all.get(r.id)) shorter += 1;
    }
    for (const n of s.nodes.filter((x) => x.kind === 'stub')) {
      const outside = n.x + n.w <= frame.x || n.x >= frame.x + frame.w || n.y + n.h <= frame.y || n.y >= frame.y + frame.h;
      assert.ok(outside, `${name}: stub ${n.id} inside the domain frame`);
    }
  }
  assert.ok(shorter > 0);
});

test('pure join tables collapse into one n-n line only when enabled', async () => {
  const off = await multi(withConfig({ collapse_join_tables: false }));
  assert.ok(off.diagram.nodes.has('auth.public.role_permissions'));
  assert.ok(!off.diagram.links.some((l) => l.via));

  const on = await multi();
  assert.ok(!on.diagram.nodes.has('auth.public.role_permissions'));
  assert.ok(!on.diagram.nodes.has('shop._.product_tags'));
  const via = Object.fromEntries(on.diagram.links.filter((l) => l.via).map((l) => [l.via, [l.from.node, l.to.node, l.cardinality, l.kind, l.review]]));
  assert.deepEqual(via, {
    'auth.public.role_permissions': ['auth.public.permissions', 'auth.public.roles', 'n-n', 'db_fk', 'reviewed'],
    // The least certain of its two keys: product_tags.tag_id is inferred, pending.
    'shop._.product_tags': ['shop._.products', 'shop._.tags', 'n-n', 'inferred', 'pending'],
  });
  for (const r of on.scene('all').relations.filter((x) => x.link.via)) assert.deepEqual(r.markers, { from: 'zeroOrMany', to: 'zeroOrMany' });
  assert.match(on.svg, /data-via="auth\.public\.role_permissions"/);
});

test('a self-reference loops out and back on one side, clear of its markers', async () => {
  const { scene } = await multi();
  const all = scene('all');
  const loop = all.relations.find((r) => r.id === 'shop._.categories(parent_id)->shop._.categories(id)');
  const box = all.nodes.find((n) => n.id === 'shop._.categories');
  assert.equal(loop.fromSide, loop.toSide);
  const edge = loop.fromSide < 0 ? box.x : box.x + box.w;
  assert.equal(loop.points.length, 4);
  assert.equal(Math.abs(loop.points[1][0] - edge), SELF_STUB);
});

test('one SVG holds every view; only the overview shows without script', async () => {
  const { svg, diagram } = await multi();
  const views = [...svg.matchAll(/<g class="view" data-view="([^"]+)" data-bounds="([^"]+)"( style="display:none")?>/g)];
  assert.deepEqual(views.map((m) => m[1]), viewNames(diagram));
  for (const [, name, , hidden] of views) assert.equal(Boolean(hidden), name !== 'overview', name);
  const overviewBounds = views.find((m) => m[1] === 'overview')[2];
  assert.match(svg, new RegExp(`^<svg [^>]*viewBox="${overviewBounds}"`));
});

test('multi-database layout and render are byte-identical across runs', async () => {
  const a = await multi();
  const b = await multi();
  assert.equal(serializeLayout(a.layout), serializeLayout(b.layout));
  assert.equal(a.svg, b.svg);
  // layout.json holds one entry per view, stubs under their own slot.
  assert.deepEqual(Object.keys(a.layout.views).sort(), viewNames(a.diagram).sort());
  assert.ok(Object.keys(a.layout.views['domain:shop/Orders'].clusters).includes(STUB_SLOT));
});

test('special patterns: view sources, facts, embedded rows, tenant stacks, database notes', async () => {
  const model = await loadWorkspace(fileURLToPath(new URL('./fixtures/workspace-patterns', import.meta.url)));
  const { layout } = await computeLayout(model);
  const diagram = buildDiagram(model);
  const all = buildScene(model, layout, 'all', diagram);
  const svg = renderSvg(model, layout);

  // A view reads its sources through muted lines without crow's feet,
  // which the overview does not count as relations.
  const sources = all.relations.filter((r) => r.link.kind === 'view_source');
  assert.deepEqual(sources.map((r) => r.id), [
    'store.public.active_customers=>store.tenant.accounts',
    'store.public.sales_by_month=>store.tenant.order_lines',
    'store.public.sales_by_month=>store.tenant.orders',
  ]);
  for (const r of sources) assert.deepEqual(r.markers, { from: 'none', to: 'none' });
  assert.ok(!buildScene(model, layout, 'overview', diagram).relations.some((r) => r.id.includes('store/Reports')));
  assert.match(svg, /<g class="table is-view" data-id="store\.public\.sales_by_month">/);
  assert.match(svg, /«materialized view»/);

  const box = (id) => diagram.nodes.get(id).box;
  assert.deepEqual(box('store.tenant.accounts').facts.map((f) => f.text.text), ['STI on type: Customer, Vendor', '× 120 tenants']);
  assert.deepEqual(box('store.tenant.usage_events').facts.map((f) => f.text.text), ['partitioned by month on occurred_at', '× 120 tenants']);
  assert.deepEqual(box('store.public._ProductToTag').facts.map((f) => f.text.text), ['unique (A, B)', 'generated by Prisma implicit many-to-many']);
  assert.equal((svg.match(/class="tenant-copy"/g) ?? []).length % 2, 0);
  // Identifiers and values in a fact are code: a tspan of their own, colour only.
  assert.deepEqual(box('store.tenant.accounts').facts[0].parts, [
    { text: 'STI on ', code: false },
    { text: 'type', code: true },
    { text: ': ', code: false },
    { text: 'Customer, Vendor', code: true },
  ]);
  assert.match(svg, /<text class="fact-text"[^>]*>STI on <tspan class="fact-code">type<\/tspan>: <tspan class="fact-code">Customer, Vendor<\/tspan><\/text>/);
  assert.match(svg, /\.fact-code \{ fill: [^;]+; \}/);
  // Database names read capitalised on frames; ids and data attributes keep them as written.
  assert.match(svg, /<text class="db-name"[^>]*>Store<\/text>/);
  assert.match(svg, /<g class="database" data-database="store"/);

  // Embedded columns are rows of the parent box; a relation from one attaches there.
  const reviews = box('docs._.reviews');
  assert.deepEqual(reviews.insets.map((e) => e.title.text), ['replies [ ]', 'shipping']);
  const author = reviews.rows.find((r) => r.column === 'replies.author');
  assert.equal(author.depth, 1);
  const line = all.relations.find((r) => r.id === 'docs._.reviews(replies.author)->docs._.profiles(_id)');
  const node = all.nodes.find((n) => n.id === 'docs._.reviews');
  assert.equal(line.points[0][1], node.y + author.centerY);

  assert.match(svg, /<text class="db-fact"[^>]*>2 replicas<\/text>/);
  assert.match(svg, /<text class="db-fact"[^>]*>schema tenant × 120 tenants<\/text>/);
  assert.match(svg, /<text class="db-fact"[^>]*>4 shards<\/text>/);
});

test('the view of all tables exists up to ALL_VIEW_MAX_TABLES tables', async () => {
  const base = await loadMulti();
  const sized = (n) =>
    buildDiagram(normalizeModel({ ...base, relations: [], polymorphic: [], tables: Array.from({ length: n }, (_, i) => table(`shop._.t${i}`, 'Bulk', [])) }));
  assert.ok(viewNames(sized(ALL_VIEW_MAX_TABLES)).includes(ALL_VIEW));
  assert.deepEqual(viewNames(sized(ALL_VIEW_MAX_TABLES + 1)), ['overview', 'domain:shop/Bulk']);
});

test('overview.min_relations: 1 shows every line, a higher value hides more; validated; deterministic', async () => {
  const counts = async (min) => {
    const { scene, svg } = await multi(withConfig(min === undefined ? {} : { overview: { min_relations: min } }));
    return { weak: scene('overview').relations.filter((r) => r.weak).map((r) => r.id), svg };
  };
  const byDefault = await counts();
  assert.equal(byDefault.weak.length, 6);
  assert.deepEqual((await counts(1)).weak, []);
  assert.deepEqual((await counts(3)).weak.length, 7);
  assert.equal((await counts()).svg, byDefault.svg);
  assert.deepEqual(validateNode({ schema_version: 1, overview: { min_relations: 2 } }, configSchema), []);
  assert.equal(validateNode({ schema_version: 1, overview: { min_relations: 0 } }, configSchema).length, 1);
  assert.equal(validateNode({ schema_version: 1, overview: { min_lines: 2 } }, configSchema).length, 1);
});
