import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildDiagram, domainLinks, domainPairs, polyNodeId } from '../src/layout/diagram.js';
import { connectionMatrix, domainSummary, strength } from '../src/layout/domains.js';
import { computeLayout } from '../src/layout/index.js';
import { serializeLayout } from '../src/layout/layout-file.js';
import { SELF_STUB } from '../src/layout/router.js';
import { POLY_VISIBLE_TARGETS } from '../src/layout/table-box.js';
import { ALL_VIEW, ALL_VIEW_MAX_TABLES, STUB_SLOT, viewNames } from '../src/layout/views.js';
import { normalizeModel } from '../src/model/load.js';
import { PALETTE } from '../src/palette.js';
import { cellFill, connectionsSvg } from '../src/render/svg/connections.js';
import { endMarkers } from '../src/render/svg/markers.js';
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

test('overview: one card per domain and no lines; the pairs of domains behind the cards', async () => {
  const { scene, svg, diagram, model } = await multi();
  const overview = scene('overview');
  assert.deepEqual(overview.relations, []);
  const counts = Object.fromEntries(domainLinks(diagram).map((l) => [l.id, [l.count, l.kind]]));
  assert.deepEqual(counts, {
    // memberships.role_id -> roles; memberships.user_id is a hub badge.
    'auth/Identity<->auth/Organizations': [1, 'domain'],
    'activity/Audit<->auth/Organizations': [1, 'cross_db'],
    'activity/Events<->shop/Catalog': [1, 'cross_db'],
    'activity/Events<->shop/Orders': [1, 'cross_db'],
    'auth/Organizations<->shop/Orders': [1, 'cross_db'],
    'shop/Catalog<->shop/Orders': [1, 'domain'],
    // commentable -> products, attachable -> products
    'shop/Catalog<->shop/Content': [2, 'domain'],
    // commentable -> orders, attachable -> orders, refunds
    'shop/Content<->shop/Orders': [3, 'domain'],
  });
  const content = domainLinks(diagram).find((l) => l.id === 'shop/Content<->shop/Orders').relations;
  assert.deepEqual(
    content.map((r) => [r.from.table, r.from.column, r.to, r.cardinality, r.association]),
    [
      ['shop._.attachments', 'attachable_id', 'shop._.orders', 'n-1', 'attachable'],
      ['shop._.attachments', 'attachable_id', 'shop._.refunds', 'n-1', 'attachable'],
      ['shop._.comments', 'commentable_id', 'shop._.orders', 'n-1', 'commentable'],
    ],
  );
  // No line, badge or number on the overview: cards only.
  const drawn = svg.slice(svg.indexOf('<g class="view" data-view="overview"'), svg.indexOf('<g class="view" data-view="all"'));
  assert.doesNotMatch(drawn, /relation-group|count-badge|card-link/);
  assert.equal((drawn.match(/<g class="domain" data-domain=/g) ?? []).length, diagram.clusters.size);
  assert.deepEqual(
    overview.groups.map((g) => [g.kind, g.group.database, g.group.engine]),
    [['db', 'activity', 'mongodb'], ['db', 'auth', 'postgresql'], ['db', 'shop', 'mysql']],
  );
  // A card: name, table count, note on at most two lines, central table,
  // related domains with a strength bar; a cross-DB one names its database.
  const orders = overview.nodes.find((n) => n.id === 'shop/Orders').box;
  assert.equal(orders.count.text, '4 tables');
  assert.equal(orders.note.lines.map((l) => l.text).join(' '), model.databases.find((d) => d.database === 'shop').domains.Orders.note);
  assert.equal(orders.central.text, 'Central: orders');
  assert.deepEqual(orders.related.map((r) => [r.key, r.count, r.segments, r.db]), [
    ['shop/Content', 3, 3, null],
    ['activity/Events', 1, 2, 'activity'],
    ['auth/Organizations', 1, 2, 'auth'],
  ]);
  assert.match(drawn, /<g class="card-related" data-domain="activity\/Events"><title>Events \(activity\): 1 relation with Orders<\/title>/);
  assert.equal(overview.nodes.find((n) => n.id === 'activity/Events').box.note, null);
  // Every card the same size, so a new note never makes layout.json stale.
  assert.equal(new Set(overview.nodes.map((n) => `${n.w}x${n.h}`)).size, 1);
});

test('domain summary: most connected first per database, related by strength, ties by name; strength scale', async () => {
  const { model, diagram } = await multi();
  const summary = domainSummary(model, diagram);
  assert.deepEqual(summary.order, ['activity/Events', 'activity/Audit', 'auth/Organizations', 'auth/Identity', 'shop/Orders', 'shop/Content', 'shop/Catalog']);
  assert.deepEqual(
    [...summary.cards.values()].map((c) => [c.key, c.connectivity, c.within]),
    [
      ['activity/Audit', 1, 0],
      ['activity/Events', 2, 1],
      ['auth/Identity', 1, 1],
      ['auth/Organizations', 3, 2],
      ['shop/Catalog', 4, 4],
      ['shop/Content', 5, 3],
      ['shop/Orders', 6, 3],
    ],
  );
  assert.deepEqual(summary.cards.get('shop/Catalog').related.map((r) => [r.key, r.count, r.crossDb]), [
    ['shop/Content', 2, false],
    ['activity/Events', 1, true],
    ['shop/Orders', 1, false],
  ]);
  assert.equal(summary.max, 3);
  // Square root of the share of the strongest pair (at least 10), 1..5.
  assert.deepEqual([0, 1, 2, 3, 5, 10, 40].map((n) => strength(n, 10)), [0, 2, 2, 3, 4, 5, 5]);
  assert.deepEqual([1, 10, 20, 40].map((n) => strength(n, 40)), [1, 3, 4, 5]);
  // Same model in another order, same summary.
  const again = domainSummary(model, buildDiagram(normalizeModel({ ...model, tables: [...model.tables].reverse(), relations: [...model.relations].reverse() })));
  assert.deepEqual(again.order, summary.order);
});

test('connections matrix: relation counts by direction, the diagonal inside one domain', async () => {
  const { model, diagram, svg } = await multi();
  const matrix = connectionMatrix(model, diagram);
  assert.deepEqual(matrix.keys, domainSummary(model, diagram).order);
  const count = (a, b) => matrix.counts.get(`${a}\u0000${b}`) ?? 0;
  // Content's comments and attachments point at orders and refunds; Orders points at none of Content.
  assert.equal(count('shop/Content', 'shop/Orders'), 3);
  assert.equal(count('shop/Orders', 'shop/Content'), 0);
  assert.equal(count('shop/Catalog', 'shop/Catalog'), 4);
  assert.equal(matrix.max, 3);
  assert.equal(matrix.maxWithin, 4);
  // Every directed count adds up to the pairs of domains.
  const total = [...matrix.counts.values()].reduce((a, b) => a + b, 0);
  assert.equal(total, domainPairs(diagram).reduce((n, p) => n + p.count, 0));
  // Drawn as a hidden view with one cell per pair of domains and a legend.
  const view = svg.slice(svg.indexOf('<g class="view" data-view="connections"'));
  assert.match(view, /^<g class="view" data-view="connections" data-bounds="[^"]+" style="display:none">/);
  assert.equal((view.match(/<rect class="mx-cell/g) ?? []).length, matrix.keys.length ** 2);
  assert.match(view, /<title>Content → Orders: 3 relations, Orders → Content: 0 relations<\/title>/);
  assert.match(view, /<title>Catalog: 4 relations inside the domain<\/title>/);
  assert.match(view, /darker = more relations/);
  const geometry = connectionsSvg(matrix, () => PALETTE[0]).geometry;
  // Rows and columns in matrix order, databases apart.
  assert.deepEqual([...geometry.rows.keys()], matrix.keys);
  assert.ok(matrix.keys.every((k, i) => i === 0 || geometry.cols.get(k) > geometry.cols.get(matrix.keys[i - 1])));
  assert.equal(geometry.dbs.map((d) => d.database).join(), 'activity,auth,shop');
  assert.equal(cellFill(0, false, matrix), cellFill(0, true, matrix));
  assert.notEqual(cellFill(3, false, matrix), cellFill(1, false, matrix));
});

test('references both ways between two domains are one pair listing both directions', async () => {
  const back = { from: { table: 'auth.public.roles', columns: ['id'] }, to: { table: 'auth.public.organizations', columns: ['id'] }, cardinality: '1-1', optional: false, kind: 'declared', evidence: ['db'], review: 'pending' };
  const { diagram } = await multi((m) => normalizeModel({ ...m, relations: [...m.relations, back] }));
  const lines = domainLinks(diagram).filter((r) => r.id.includes('auth/Identity') && r.id.includes('auth/Organizations'));
  assert.deepEqual(
    lines.map((r) => [r.id, r.count, r.relations.map((x) => `${x.from.table}->${x.to}`)]),
    [['auth/Identity<->auth/Organizations', 2, ['auth.public.memberships->auth.public.roles', 'auth.public.roles->auth.public.organizations']]],
  );
});

test('overview cards of a fresh layout: a grid in summary order, the same on every run', async () => {
  const { model, diagram, layout } = await multi();
  const order = domainSummary(model, diagram).order;
  const cards = layout.views.overview.clusters;
  for (const db of ['activity', 'auth', 'shop']) {
    const placed = Object.entries(cards[db]).sort(([, a], [, b]) => a.y - b.y || a.x - b.x).map(([k]) => k);
    assert.deepEqual(placed, order.filter((k) => k.startsWith(`${db}/`)), db);
    for (const b of Object.values(cards[db])) assert.ok(b.x % 10 === 0 && b.y % 10 === 0);
  }
  assert.deepEqual((await computeLayout(model)).layout.views.overview, layout.views.overview);
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

test('one SVG holds every view and the connections view; only the view of all tables shows without script', async () => {
  const { svg, diagram } = await multi();
  const views = [...svg.matchAll(/<g class="view" data-view="([^"]+)" data-bounds="([^"]+)"( style="display:none")?>/g)];
  assert.deepEqual(views.map((m) => m[1]), [...viewNames(diagram), 'connections']);
  for (const [, name, , hidden] of views) assert.equal(Boolean(hidden), name !== 'all', name);
  const allBounds = views.find((m) => m[1] === 'all')[2];
  assert.match(svg, new RegExp(`^<svg [^>]*viewBox="${allBounds}"`));
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
