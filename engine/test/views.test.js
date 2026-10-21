import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDiagram, polyNodeId } from '../src/layout/diagram.js';
import { computeLayout } from '../src/layout/index.js';
import { serializeLayout } from '../src/layout/layout-file.js';
import { SELF_STUB } from '../src/layout/router.js';
import { POLY_VISIBLE_TARGETS } from '../src/layout/table-box.js';
import { STUB_SLOT, viewNames } from '../src/layout/views.js';
import { buildScene, renderSvg } from '../src/render/svg/render.js';
import { pathLength } from './helpers/geometry.js';
import { loadMulti } from './helpers/shop.js';

async function multi(change = (m) => m) {
  const model = change(await loadMulti());
  const { layout } = await computeLayout(model);
  const diagram = buildDiagram(model);
  const scene = (name) => buildScene(model, layout, name, diagram);
  return { model, layout, diagram, scene, svg: renderSvg(model, layout) };
}

const withConfig = (config) => (m) => ({ ...m, config: { ...m.config, ...config } });

test('relation kinds and review states carry their own classes and styles', async () => {
  const { svg, scene } = await multi();
  const attr = (id) => id.replaceAll('>', '&gt;').replace(/[.()]/g, '\\$&');
  const group = (id) => svg.match(new RegExp(`<g class="relation-group ([^"]+)" data-id="${attr(id)}"`))?.[1];
  assert.equal(group('shop._.payments(order_id)->shop._.orders(id)'), 'kind-inferred review-pending');
  assert.equal(group('shop._.refunds(payment_id)->shop._.payments(id)'), 'kind-inferred review-reviewed');
  assert.equal(group('shop._.products(brand_id)->shop._.brands(id)'), 'kind-declared review-stale');
  assert.equal(group('activity._.audit_logs(organization_id)->auth.public.organizations(id)'), 'kind-cross_db review-pending');
  assert.equal(group('shop._.comments(commentable_id)->«commentable»'), 'kind-polymorphic review-reviewed');
  // Inferred is dashed only while unreviewed; a reviewed inferred line is solid.
  assert.match(svg, /\.kind-inferred\.review-pending \.relation, \.kind-inferred\.review-stale \.relation \{ stroke-dasharray: 6 4; \}/);
  assert.doesNotMatch(svg, /\.kind-inferred \.relation/);
  assert.match(svg, /\.kind-cross_db \.relation \{ stroke-dasharray: 10 3 2 3 2 3; \}/);
  // Every cross-DB line, and only those, is labelled in the full view.
  for (const r of scene('all').relations) assert.equal(r.label?.text ?? null, r.link.kind === 'cross_db' ? 'cross-DB' : null, r.id);
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

test('overview aggregates relations per pair of domains', async () => {
  const { scene } = await multi();
  const overview = scene('overview');
  const counts = Object.fromEntries(overview.relations.map((r) => [r.id, [r.link.count, r.link.kind, r.label.text]]));
  assert.deepEqual(counts, {
    // memberships.role_id -> roles; memberships.user_id is a hub badge.
    'auth/Identity<->auth/Organizations': [1, 'domain', '1'],
    'activity/Audit<->auth/Organizations': [1, 'cross_db', '1 · cross-DB'],
    'activity/Events<->shop/Catalog': [1, 'cross_db', '1 · cross-DB'],
    'activity/Events<->shop/Orders': [1, 'cross_db', '1 · cross-DB'],
    'auth/Organizations<->shop/Orders': [1, 'cross_db', '1 · cross-DB'],
    'shop/Catalog<->shop/Orders': [1, 'domain', '1'],
    // commentable -> products, attachable -> products
    'shop/Catalog<->shop/Content': [2, 'domain', '2'],
    // commentable -> orders, attachable -> orders, refunds
    'shop/Content<->shop/Orders': [3, 'domain', '3'],
  });
  assert.deepEqual(
    overview.groups.map((g) => [g.kind, g.group.database, g.group.engine]),
    [['db', 'activity', 'mongodb'], ['db', 'auth', 'postgresql'], ['db', 'shop', 'mysql']],
  );
  const catalog = overview.nodes.find((n) => n.id === 'shop/Catalog');
  assert.equal(catalog.box.count.text, '4 tables');
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
