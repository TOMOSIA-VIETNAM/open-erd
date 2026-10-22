import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { OUTPUT, bundleViewer, serializeBundle } from '../scripts/bundle-viewer.js';
import { buildDiagram, polyNodeId } from '../src/layout/diagram.js';
import { computeLayout } from '../src/layout/index.js';
import { technicalColumns } from '../src/model/columns.js';
import { buildScene, renderSvg, viewerData } from '../src/render/svg/render.js';
import { radialLayout, straightLink } from '../src/render/svg/viewer/radial.js';
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
  assert.ok(status.note && !status.technical);
  assert.ok(data.nodes['auth.public.users'].columns.find((c) => c.name === 'email').pii);
  const commentable = polyNodeId(model.polymorphic.find((a) => a.name === 'commentable'));
  assert.deepEqual(data.nodes[commentable].targets, ['shop._.orders', 'shop._.posts', 'shop._.products']);
});

test('technical columns: keys and timestamps, unless documented', async () => {
  const { model, svg } = await multi();
  const technical = technicalColumns(model);
  // pk, foreign key, hub key, timestamp; status has an enum, title is plain data.
  assert.deepEqual([...technical.get('shop._.orders')], ['id', 'user_id', 'organization_id', 'placed_at']);
  assert.deepEqual([...technical.get('shop._.products')], ['id', 'category_id', 'brand_id', 'created_by', 'updated_by']);
  assert.deepEqual([...technical.get('shop._.comments')].sort(), ['commentable_id', 'commentable_type', 'created_by', 'id']);
  assert.match(svg, /<g class="column technical" data-column="placed_at">/);
  // Every column has a note, so a note does not make a key or timestamp a business column.
  const noted = { ...model, tables: model.tables.map((t) => ({ ...t, columns: t.columns.map((c) => ({ ...c, note: 'Documented.' })) })) };
  assert.deepEqual([...technicalColumns(noted).get('shop._.orders')], ['id', 'user_id', 'organization_id', 'placed_at']);
  assert.match(svg, /<g class="column" data-column="status">/);
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
