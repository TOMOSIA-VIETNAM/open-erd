import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { OUTPUT, bundleViewer, serializeBundle } from '../scripts/bundle-viewer.js';
import { buildDiagram, polyNodeId } from '../src/layout/diagram.js';
import { computeLayout } from '../src/layout/index.js';
import * as columnsModule from '../src/model/columns.js';
import { HINT_OFFSET, HINT_SIZE, HINT_STEP, ICON_GUTTER, tableBox } from '../src/layout/table-box.js';

const { enumMeaning } = columnsModule;
import { buildScene, renderSvg, viewerData } from '../src/render/svg/render.js';
import { applyProfile } from '../src/model/profile.js';
import { centreOn, fitsInside, frameFocus, minimapSize, visibleRect } from '../src/render/svg/viewer/minimap.js';
import { endTransforms, radialLayout, straightLink } from '../src/render/svg/viewer/radial.js';
import { tourIndex, tourSteps } from '../src/render/svg/viewer/tour.js';
import { piiSummary } from '../src/render/svg/viewer/pii.js';
import { domainSummary } from '../src/layout/domains.js';
import { loadMulti } from './helpers/shop.js';

async function multi() {
  const model = await loadMulti();
  const { layout } = await computeLayout(model);
  return { model, layout, diagram: buildDiagram(model), svg: renderSvg(model, layout) };
}

const dataBlock = (svg) => svg.match(/<script type="application\/json" id="open-erd-data">([^<]*)<\/script>/)[1];
const scriptBlock = (svg) => svg.match(/<script><!\[CDATA\[\n([\s\S]*)\n\]\]><\/script>/)[1];

test('the committed viewer bundle is up to date and fits in a CDATA section', async () => {
  const committed = await readFile(OUTPUT, 'utf8');
  assert.equal(committed, serializeBundle(await bundleViewer()), 'run: node scripts/bundle-viewer.js');
  const { source } = JSON.parse(committed);
  assert.ok(!source.includes(']]>'));
  // Compiles as a script (not run: it needs a DOM).
  assert.doesNotThrow(() => new Function(source));
});

test('the SVG embeds the viewer and its data once, identically on every render', async () => {
  const a = await multi();
  const b = await multi();
  const { source } = JSON.parse(await readFile(OUTPUT, 'utf8'));
  assert.equal(scriptBlock(a.svg), source);
  assert.equal(a.svg.match(/<script/g).length, 2);
  assert.equal(dataBlock(a.svg), dataBlock(b.svg));
  assert.equal(a.svg, b.svg);
  // Script and data come after every view, so the static drawing is complete
  // before them and a viewer without script ignores them.
  assert.ok(a.svg.lastIndexOf('<g class="view"') < a.svg.indexOf('<script'));
  assert.doesNotMatch(dataBlock(a.svg), /[<>&]/);
});

test('embedded data holds every node, column detail and drawn relation', async () => {
  const { model, diagram, svg } = await multi();
  const data = JSON.parse(dataBlock(svg));
  assert.deepEqual(data, viewerData(model, diagram));
  assert.deepEqual(Object.keys(data.nodes).sort(), [...diagram.nodes.keys()].sort());
  assert.deepEqual(data.links.map((l) => [l.id, l.from, l.to]), diagram.links.map((l) => [l.id, l.from.node, l.to.node]));
  for (const t of model.tables.filter((x) => diagram.nodes.has(x.id))) {
    assert.deepEqual(data.nodes[t.id].columns.map((c) => c.name), t.columns.map((c) => c.name), t.id);
  }
  const orders = data.nodes['shop._.orders'];
  assert.equal(orders.note, 'One order per checkout; the basket becomes order items.');
  const status = orders.columns.find((c) => c.name === 'status');
  assert.deepEqual(Object.keys(status.enum), ['pending', 'paid', 'cancelled']);
  assert.ok(status.note);
  assert.ok(data.nodes['auth.public.users'].columns.find((c) => c.name === 'email').pii);
  const commentable = polyNodeId(model.polymorphic.find((a) => a.name === 'commentable'));
  assert.deepEqual(data.nodes[commentable].targets, ['shop._.orders', 'shop._.posts', 'shop._.products']);
});

test('Business/Technical mode is gone: no technical classes, data flags or toolbar mode', async () => {
  const { svg } = await multi();
  assert.equal(columnsModule.technicalColumns, undefined);
  assert.doesNotMatch(svg, /class="column technical"|"technical":|\.business /);
  assert.doesNotMatch(scriptBlock(svg), /'Business'|'Technical'|setBusiness/);
  assert.match(svg, /<g class="column" data-column="status">/);
});

test('key columns get a gutter icon: PK a key, a referencing column (hub and polymorphic id included) a link', async () => {
  const { model, diagram, svg } = await multi();
  const rows = (id) => Object.fromEntries(diagram.nodes.get(id).box.rows.map((r) => [r.column, r.key]));
  const orders = rows('shop._.orders');
  assert.equal(orders.id, 'pk');
  assert.equal(orders.user_id, 'fk', 'hub relation to users');
  assert.equal(orders.status, null);
  assert.equal(rows('shop._.comments').commentable_id, 'fk', 'polymorphic id column');
  assert.match(svg, /<path class="icon-pk" d="M/);
  assert.match(svg, /<path class="icon-fk" d="M/);
  // The data marks the same columns for the panel.
  const data = viewerData(model, diagram);
  assert.ok(data.nodes['shop._.orders'].columns.find((c) => c.name === 'user_id').fk);
  assert.ok(!data.nodes['shop._.orders'].columns.find((c) => c.name === 'status').fk);
});

test('polymorphic target lines are routed per view and hidden until clicked', async () => {
  const { model, layout, diagram, svg } = await multi();
  const attachable = polyNodeId(model.polymorphic.find((a) => a.name === 'attachable'));
  const scene = buildScene(model, layout, 'domain:shop/Content', diagram);
  const ids = new Set(scene.nodes.map((n) => n.id));
  const targets = model.polymorphic.find((a) => a.name === 'attachable').targets.filter((t) => ids.has(t));
  const routes = scene.polyRoutes.filter((r) => r.poly === attachable);
  assert.deepEqual(routes.map((r) => r.target), targets);
  for (const r of routes) {
    const [from, to] = [scene.nodes.find((n) => n.id === r.poly), scene.nodes.find((n) => n.id === r.target)];
    const [first, last] = [r.points[0], r.points.at(-1)];
    assert.ok(first[0] === from.x || first[0] === from.x + from.w, `${r.target}: starts on the node side`);
    assert.ok(last[0] === to.x || last[0] === to.x + to.w, `${r.target}: ends on the target side`);
  }
  // Not part of the relations, so the geometry checks on lines stay as they were.
  assert.ok(!scene.relations.some((r) => r.id.startsWith(attachable)));
  const escaped = attachable.replace(/[.]/g, '\\.');
  assert.match(svg, new RegExp(`<g class="poly-routes" data-poly="${escaped}" style="display:none">`));
});

test('viewer data: relations by pair of domains, domain notes, central table, hub relations, link optionality, polymorphic notes', async () => {
  const { model, diagram, svg } = await multi();
  const data = JSON.parse(dataBlock(svg));
  // Each pair of domains lists the relations it stands for, keyed by its id;
  // a domain with itself too (the matrix diagonal).
  assert.deepEqual(data.domainLinks['shop/Catalog<->shop/Content'], [
    { from: 'shop._.attachments', column: 'attachable_id', to: 'shop._.products', cardinality: 'n-1', kind: 'polymorphic', review: 'pending', association: 'attachable' },
    { from: 'shop._.comments', column: 'commentable_id', to: 'shop._.products', cardinality: 'n-1', kind: 'polymorphic', review: 'reviewed', association: 'commentable' },
  ]);
  assert.equal(data.domainLinks['shop/Catalog<->shop/Catalog'].length, 4);
  assert.deepEqual(Object.keys(data.domainLinks).sort(), Object.keys(data.domainLinks));
  assert.equal(data.domainNotes['auth/Identity'], 'People who sign in and the profiles and sessions that belong to them.');
  assert.equal(data.domainNotes['activity/Events'], undefined);
  assert.equal(data.mostCentral, diagram.mostCentral);
  assert.equal(data.overviewMinRelations, undefined);
  // Hub relations are listed with their referencing column; drawn links carry optional for the markers.
  assert.deepEqual(data.hubLinks.map((l) => l.id), diagram.hubLinks.map((l) => l.id));
  const created = data.hubLinks.find((l) => l.id === 'shop._.products(created_by)->auth.public.users(id)');
  assert.deepEqual([created.from, created.to, created.column, created.cardinality], ['shop._.products', 'auth.public.users', 'created_by', 'n-1']);
  for (const l of data.links) assert.equal(typeof l.optional, 'boolean', l.id);
  // Engines by database: as written (schema copy) and as the frames print them (cross-DB panels).
  assert.deepEqual(data.databases, {
    activity: { engine: 'mongodb', label: 'MongoDB' },
    auth: { engine: 'postgresql', label: 'PostgreSQL' },
    shop: { engine: 'mysql', label: 'MySQL' },
  });
  // Facts waiting for review, for the review mode entry; evidence stays out of the drawing.
  const facts = [...model.relations, ...model.polymorphic];
  assert.deepEqual(data.review, { pending: facts.filter((f) => f.review === 'pending').length, stale: facts.filter((f) => f.review === 'stale').length });
  assert.ok(data.review.pending > 0 && data.review.stale > 0, 'the multi fixture has both');
  assert.ok([...data.links, ...data.hubLinks].every((l) => l.evidence === undefined));
  assert.ok(Object.values(data.nodes).every((n) => n.evidence === undefined));
  // Indexes as declared; facts as parts with identifiers marked as code.
  assert.deepEqual(data.nodes['auth.public.users'].indexes, [
    { name: 'index_users_on_email', columns: ['email'], unique: true },
    { name: 'index_users_on_status', columns: ['status'], unique: false, using: 'btree' },
  ]);
  const commentable = data.nodes[polyNodeId(model.polymorphic.find((a) => a.name === 'commentable'))];
  assert.equal(commentable.note, 'Customers discuss a post, product or order; support staff answer in the same thread.');
  assert.equal(commentable.internalNote, 'CommentsController#create sets the type from the route.');
  assert.equal(commentable.optional, false);
  // Sharing profiles drop polymorphic notes like any other note.
  const shared = applyProfile(model, 'public').polymorphic.find((a) => a.name === 'commentable');
  assert.equal(shared.internal_note, undefined);
  assert.ok(shared.note);
  const noNotes = applyProfile({ ...model, config: { ...model.config, profiles: { bare: { drop_notes: ['note', 'internal_note'] } } } }, 'bare');
  assert.ok(noNotes.polymorphic.every((a) => a.note === undefined && a.internal_note === undefined));
});

test('neighborhood end markers turn with their straight line', () => {
  // Leaving to the right: no turn at the start, a half turn at the end.
  assert.deepEqual(endTransforms([[0, 0], [100, 0]]), ['translate(0 0) rotate(0)', 'translate(100 0) rotate(180)']);
  // Going down: a quarter turn, the far end facing up.
  assert.deepEqual(endTransforms([[10, 20], [10, 80]]), ['translate(10 20) rotate(90)', 'translate(10 80) rotate(270)']);
  const [from] = endTransforms([[0, 0], [-3, 3]]);
  assert.equal(from, 'translate(0 0) rotate(135)');
});

test('enum meanings that only restate their value are left out', () => {
  assert.equal(enumMeaning('smartsite_standard_one', 'Smartsite standard one (Template.code)'), '');
  assert.equal(enumMeaning('PAID', 'paid.'), '');
  assert.equal(enumMeaning('in-review', 'In review (Post::STATES)'), '');
  assert.equal(enumMeaning('draft', ''), '');
  assert.equal(enumMeaning('paid', 'Payment confirmed by the gateway (Invoice::STATUSES)'), 'Payment confirmed by the gateway (Invoice::STATUSES)');
  assert.equal(enumMeaning('0', 'Hidden from customers'), 'Hidden from customers');
});

test('marks after a column name: enum values and index membership, each inside the row budget', async () => {
  const columns = [
    { name: 'id', type: 'bigint', pk: true },
    { name: 'title', type: 'varchar', note: 'Shown in lists.' },
    { name: 'status', type: 'varchar', note: 'Lifecycle.', enum: { a: 'Active account', b: 'b' } },
  ];
  const plain = tableBox({ id: 'db._.posts', columns: columns.map(({ name, type, pk }) => ({ name, type, pk })) });
  const box = tableBox({ id: 'db._.posts', columns });
  // One mark fits in the gap a row keeps anyway: same size with or without.
  assert.deepEqual([box.w, box.h], [plain.w, plain.h]);
  // Every column has a note, so a note gets no mark.
  assert.deepEqual(box.rows.map((r) => r.hints.map((h) => h.kind)), [[], [], ['enum']]);
  const indexed = tableBox({ id: 'db._.posts', columns }, [], [], { indexed: new Set(['status', 'title']) });
  assert.deepEqual(indexed.rows.map((r) => r.hints.map((h) => h.kind)), [[], ['index'], ['enum', 'index']]);
  for (const b of [box, indexed]) {
    for (const r of b.rows) {
      r.hints.forEach((h, i) => assert.equal(h.x, r.name.width + HINT_OFFSET + i * HINT_STEP));
      // The last mark ends before the right-aligned type starts.
      const last = r.hints.at(-1);
      if (last) assert.ok(12 + ICON_GUTTER + last.x + HINT_SIZE / 2 < b.w - 12 - r.type.width, r.column);
    }
  }
  const { svg, model } = await multi();
  assert.match(svg, /<path class="hint-enum" d="M[^"]+h1\.2M/);
  assert.doesNotMatch(svg, /hint-note/);
  // The viewer gets enum values whose meanings say nothing as empty meanings.
  const noisy = { ...model, tables: model.tables.map((t) => (t.id === 'shop._.orders' ? { ...t, columns: t.columns.map((c) => (c.name === 'status' ? { ...c, enum: { pending: 'Pending (Order.status)', paid: 'Payment confirmed' } } : c)) } : t)) };
  const data = viewerData(noisy, buildDiagram(noisy));
  assert.deepEqual(data.nodes['shop._.orders'].columns.find((c) => c.name === 'status').enum, { pending: '', paid: 'Payment confirmed' });
});

// Deterministic sizes in the range of real boxes: 140..360 wide, 50..400 tall.
function boxes(n, seed) {
  let s = seed;
  const next = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  return Array.from({ length: n }, (_, i) => ({ id: `t${String(i).padStart(2, '0')}`, w: 140 + Math.round(next() * 22) * 10, h: 50 + Math.round(next() * 35) * 10 }));
}

const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('radial layout is deterministic and never overlaps boxes (up to 40 neighbours)', () => {
  const center = { id: 'center', w: 300, h: 320 };
  for (let n = 1; n <= 40; n++) {
    for (const split of [n, Math.ceil(n / 3)]) {
      const all = boxes(n, n * 7 + split);
      const rings = [all.slice(0, split), all.slice(split)];
      const a = radialLayout(center, rings, 40);
      assert.deepEqual(a, radialLayout(center, rings, 40));
      const placed = [center, ...all].map((b) => ({ ...b, ...a[b.id] }));
      assert.equal(Object.keys(a).length, placed.length);
      for (let i = 0; i < placed.length; i++) {
        for (let j = i + 1; j < placed.length; j++) {
          assert.ok(!overlap(placed[i], placed[j]), `n=${n} split=${split}: ${placed[i].id} overlaps ${placed[j].id}`);
        }
      }
    }
  }
  // The first node of a ring sits straight above the centre.
  const one = radialLayout({ id: 'c', w: 100, h: 100 }, [[{ id: 'a', w: 100, h: 100 }]], 40);
  assert.equal(one.a.x, one.c.x);
  assert.ok(one.a.y < one.c.y);
});

test('straight links run between box borders', () => {
  const a = { x: 0, y: 0, w: 100, h: 50 };
  const b = { x: 300, y: 200, w: 100, h: 50 };
  const [[x1, y1], [x2, y2]] = straightLink(a, b);
  assert.ok(x1 === 100 || y1 === 50, 'leaves a on its border');
  assert.ok(x2 === 300 || y2 === 200, 'enters b on its border');
  assert.deepEqual(straightLink({ x: 0, y: 0, w: 100, h: 40 }, { x: 0, y: 200, w: 100, h: 40 }), [
    [50, 40],
    [50, 200],
  ]);
});

test('minimap: sized from the view bounds, its rectangle is the part on screen, a click centres there', () => {
  const bounds = { x: -40, y: -40, w: 3600, h: 1800 };
  assert.deepEqual(minimapSize(bounds, 180, 140), { w: 180, h: 90, scale: 0.05 });
  // A tall view is capped in height.
  assert.deepEqual(minimapSize({ x: 0, y: 0, w: 1000, h: 4000 }, 180, 140), { w: 35, h: 140, scale: 0.035 });
  const viewport = { w: 1400, h: 900 };
  // At scale 0.5 shifted by (100, 144): the toolbar's 44 px are not visible area.
  const seen = visibleRect({ x: 100, y: 144, s: 0.5 }, viewport, 44);
  assert.deepEqual(seen, { x: -200, y: -200, w: 2800, h: 1712 });
  assert.equal(fitsInside(bounds, seen), false);
  assert.equal(fitsInside(bounds, visibleRect({ x: 100, y: 144, s: 0.3 }, viewport, 44)), true);
  // An open side panel narrows the visible area.
  assert.equal(visibleRect({ x: 0, y: 44, s: 1 }, viewport, 44, 464).w, 936);
  // Centring keeps the scale and puts the point in the middle of the visible area.
  const cam = centreOn({ x: 1000, y: 500 }, { x: 0, y: 0, s: 2 }, viewport, 44, 464);
  assert.equal(cam.s, 2);
  assert.deepEqual([(468 - cam.x) / 2, (44 + 428 - cam.y) / 2], [1000, 500]);
});

test('a table a view opens on: scale 1 when it fits, shrunk while readable, else its top under the toolbar', () => {
  const viewport = { w: 1400, h: 800 };
  // Fits at scale 1: centred in the area below the toolbar.
  assert.deepEqual(frameFocus({ x: 100, y: 200, w: 240, h: 300 }, viewport, 44, 0.9, 8), { s: 1, x: 700 - 220, y: 44 + 378 - 350 });
  // A little too tall: shrunk to fit with the gap above and below, still centred.
  const tall = frameFocus({ x: 0, y: 0, w: 240, h: 760 }, viewport, 44, 0.9, 8);
  assert.equal(tall.s, 740 / 760);
  assert.equal(tall.y + 760 * tall.s, 44 + 756 - 8);
  // Too tall even at the smallest readable scale: that scale, top just under the toolbar.
  assert.deepEqual(frameFocus({ x: 0, y: 100, w: 240, h: 2000 }, viewport, 44, 0.9, 8), { s: 0.9, x: 700 - 108, y: 52 - 90 });
});

test('tour: one step per domain in the overview order the matrix rows carry, central table, note or name and table count', async () => {
  const { model, diagram, svg } = await multi();
  const data = JSON.parse(dataBlock(svg));
  // The viewer reads the order from the matrix row heads (the column heads have no hit rect).
  const order = [...svg.matchAll(/<g class="mx-head" data-domain="([^"]+)"><rect class="mx-head-hit"/g)].map((m) => m[1]);
  assert.deepEqual(order, domainSummary(model, diagram).order);
  const steps = tourSteps(order, data.nodes, data.domainNotes);
  assert.deepEqual(steps.map((s) => s.cluster), order);
  for (const s of steps) assert.equal(s.central, diagram.centralOf.get(s.cluster) ?? null, s.cluster);
  const identity = steps.find((s) => s.cluster === 'auth/Identity');
  assert.equal(identity.note, 'People who sign in and the profiles and sessions that belong to them.');
  // No note: the name and table count still make a caption.
  const events = steps.find((s) => s.cluster === 'activity/Events');
  const tables = Object.values(data.nodes).filter((n) => n.kind === 'table' && n.cluster === 'activity/Events').length;
  assert.equal(events.note, null);
  assert.equal(events.title, `Events · ${tables} table${tables === 1 ? '' : 's'}`);
  assert.equal(tourSteps(['db/One'], { 'db._.t': { kind: 'table', cluster: 'db/One' } }).at(0).title, 'One · 1 table');
  // Next and Prev wrap round.
  assert.deepEqual([tourIndex(0, -1, 4), tourIndex(3, 1, 4), tourIndex(1, 1, 4)], [3, 0, 2]);
});

test('personal data summary: pii columns per domain then table, most first, ties by key, columns in model order', async () => {
  const { svg } = await multi();
  const summary = piiSummary(JSON.parse(dataBlock(svg)).nodes);
  assert.deepEqual(summary, {
    total: 4,
    tables: 4,
    domains: [
      { cluster: 'auth/Identity', count: 2, tables: [{ id: 'auth.public.user_profiles', columns: ['display_name'] }, { id: 'auth.public.users', columns: ['email'] }] },
      { cluster: 'auth/Organizations', count: 1, tables: [{ id: 'auth.public.invitations', columns: ['email'] }] },
      { cluster: 'shop/Content', count: 1, tables: [{ id: 'shop._.comments', columns: ['body'] }] },
    ],
  });
  // More columns first, whatever the key order; a table without any is left out.
  const t = (cluster, ...pii) => ({ kind: 'table', cluster, columns: [{ name: 'id' }, ...pii.map((name) => ({ name, pii: true }))] });
  const nodes = { 'a.x.one': t('a/A', 'n'), 'b.x.two': t('b/B', 'n', 'm'), 'b.x.three': t('b/B', 'p'), 'b.x.none': t('b/B'), 'a/poly': { kind: 'poly', cluster: 'a/A' } };
  assert.deepEqual(piiSummary(nodes), {
    total: 4,
    tables: 3,
    domains: [
      { cluster: 'b/B', count: 3, tables: [{ id: 'b.x.two', columns: ['n', 'm'] }, { id: 'b.x.three', columns: ['p'] }] },
      { cluster: 'a/A', count: 1, tables: [{ id: 'a.x.one', columns: ['n'] }] },
    ],
  });
  assert.deepEqual(piiSummary({}), { total: 0, tables: 0, domains: [] });
});

test('public profile: no pii flag in the embedded data, so the viewer offers no personal data map', async () => {
  const { model, layout, svg } = await multi();
  assert.match(dataBlock(svg), /"pii":true/);
  const shared = renderSvg(applyProfile(model, 'public'), layout, { fitStored: true });
  assert.doesNotMatch(dataBlock(shared), /"pii"/);
  assert.equal(piiSummary(JSON.parse(dataBlock(shared)).nodes).total, 0);
});
