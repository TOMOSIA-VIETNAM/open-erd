import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { computeLayout } from '../src/layout/index.js';
import { serializeLayout } from '../src/layout/layout-file.js';
import { buildDiagram } from '../src/layout/diagram.js';
import { viewNames } from '../src/layout/views.js';
import { endMarkers } from '../src/render/svg/markers.js';
import { buildScene, renderSvg } from '../src/render/svg/render.js';
import { SHOP, loadMulti, loadShop } from './helpers/shop.js';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

async function scenes(model) {
  const { layout } = await computeLayout(model);
  const diagram = buildDiagram(model);
  return { layout, scenes: viewNames(diagram).map((name) => buildScene(model, layout, name, diagram)) };
}

for (const [fixture, load] of [
  ['shop', loadShop],
  ['multi', loadMulti],
]) {
  // A row has two sides, so it can keep two different markers apart; a row
  // whose ends need three or more markers shares a point by necessity.
  test(`${fixture}: ends sharing an attachment point draw the same marker`, async () => {
    const { scenes: all } = await scenes(await load());
    // Overview lines carry no end markers.
    for (const scene of all.filter((x) => x.name !== 'overview')) {
      const at = new Map();
      const perRow = new Map();
      for (const r of scene.relations) {
        for (const [p, marker, node] of [[r.points[0], r.markers.from, r.link.from.node], [r.points.at(-1), r.markers.to, r.link.to.node]]) {
          const key = p.join(',');
          if (!at.has(key)) at.set(key, { markers: new Set(), row: `${node}@${p[1]}` });
          at.get(key).markers.add(marker);
          if (!perRow.has(`${node}@${p[1]}`)) perRow.set(`${node}@${p[1]}`, new Set());
          perRow.get(`${node}@${p[1]}`).add(marker);
        }
      }
      for (const [key, { markers, row }] of at) {
        if (perRow.get(row).size <= 2) assert.equal(markers.size, 1, `${scene.name} ${key}: ${[...markers]}`);
      }
    }
  });
}

test('the shop fixture has enough tables and lines to exercise the router', async () => {
  const model = await loadShop();
  const { layout } = await computeLayout(model);
  const scene = buildScene(model, layout);
  assert.ok(scene.nodes.length >= 20 && scene.relations.length >= 20);
});

test('long names are truncated with the full text kept', async () => {
  const model = await loadShop();
  const long = 'x'.repeat(80);
  model.tables[0] = { ...model.tables[0], columns: [...model.tables[0].columns, { name: long, type: 'timestamp with time zone' }] };
  const { layout } = await computeLayout(model);
  const t = buildScene(model, layout).nodes.find((x) => x.id === model.tables[0].id);
  const row = t.box.rows.at(-1);
  assert.equal(row.name.truncated, true);
  assert.equal(row.name.full, long);
  assert.match(renderSvg(model, layout), new RegExp(`<title>${long}</title>`));
});

test("crow's foot markers follow cardinality and optional", () => {
  assert.deepEqual(endMarkers({ cardinality: 'n-1', optional: false }), { from: 'zeroOrMany', to: 'one' });
  assert.deepEqual(endMarkers({ cardinality: 'n-1', optional: true }), { from: 'zeroOrMany', to: 'zeroOrOne' });
  assert.deepEqual(endMarkers({ cardinality: '1-1', optional: false }), { from: 'zeroOrOne', to: 'one' });
  assert.deepEqual(endMarkers({ cardinality: 'n-n', optional: false }), { from: 'zeroOrMany', to: 'many' });
  assert.deepEqual(endMarkers({ cardinality: 'n-n', optional: true }), { from: 'zeroOrMany', to: 'zeroOrMany' });
});

test('layout from scratch and render are byte-identical across runs', async () => {
  const model = await loadShop();
  const a = serializeLayout((await computeLayout(model)).layout);
  const b = serializeLayout((await computeLayout(await loadShop())).layout);
  assert.equal(a, b);
  const layout = JSON.parse(a);
  assert.equal(renderSvg(model, layout), renderSvg(await loadShop(), JSON.parse(b)));
});

// Fresh layouts pack domains towards a 16:9 page. With only three domains the
// packer can choose between few arrangements (one row is about 3:1, two rows
// about 1.2:1), so the bound rules out a single row or column rather than
// demanding 16:9 exactly.
// The bound includes the database frame around the domains (80 px wider and
// 110 px taller than the domains alone).
test('fresh layout keeps the page compact', async () => {
  const model = await loadShop();
  const { layout } = await computeLayout(model);
  const scene = buildScene(model, layout);
  const ratio = scene.bounds.w / scene.bounds.h;
  assert.ok(ratio >= 1 && ratio <= 2, `aspect ${ratio}`);
  assert.ok(scene.bounds.w * scene.bounds.h < 4.6e6, `area ${scene.bounds.w}x${scene.bounds.h}`);
});

test('20 tables: layout + render under 2 s', async () => {
  const start = performance.now();
  const model = await loadShop();
  const { layout } = await computeLayout(model);
  renderSvg(model, layout);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 2000, `${elapsed} ms`);
});

async function run(...args) {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, ...args]);
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

test('CLI: layout writes layout.json, render reads it without writing it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'open-erd-'));
  try {
    await cp(SHOP, dir, { recursive: true });
    const missing = await run('render', '--workspace', dir);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /layout\.json not found/);

    const first = await run('layout', '--workspace', dir);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /^view all\n(?:  .*\n)*20 added, 0 removed/);
    const layoutPath = join(dir, 'layout.json');
    const before = await readFile(layoutPath, 'utf8');
    const second = await run('layout', '--workspace', dir);
    assert.match(second.stdout, /^view all\n0 added, 0 removed, 0 group\(s\) translated, 0 node\(s\) moved/m);
    assert.doesNotMatch(second.stdout, /^[1-9]\d* added|, [1-9]\d* removed/m);
    assert.equal(await readFile(layoutPath, 'utf8'), before);

    const mtime = (await stat(layoutPath)).mtimeMs;
    const rendered = await run('render', '--workspace', dir);
    assert.equal(rendered.code, 0, rendered.stderr);
    assert.match(await readFile(join(dir, 'out', 'erd.svg'), 'utf8'), /^<svg /);
    assert.equal((await stat(layoutPath)).mtimeMs, mtime);

    // A table without coordinates is an error, not a silent re-layout.
    const layout = JSON.parse(before);
    delete layout.views.all.clusters['shop/Sales']['shop.public.orders'];
    await writeFile(layoutPath, JSON.stringify(layout));
    const stale = await run('render', '--workspace', dir);
    assert.equal(stale.code, 1);
    assert.match(stale.stderr, /no position for shop\.public\.orders/);

    // A size recorded before the model changed is also an error.
    const resized = JSON.parse(before);
    resized.views.all.clusters['shop/Sales']['shop.public.orders'].w += 10;
    await writeFile(layoutPath, JSON.stringify(resized));
    const outdated = await run('render', '--workspace', dir);
    assert.equal(outdated.code, 1);
    assert.match(outdated.stderr, /shop\.public\.orders is \d+x\d+ but was laid out as/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a previous layout with overlapping boxes is separated, not kept as is', async () => {
  const model = await loadShop();
  const { layout } = await computeLayout(model);
  const sales = layout.views.all.clusters['shop/Sales'];
  const [first, second] = Object.keys(sales);
  // Both boxes keep their size, so the group looks unchanged except for the
  // collision (what merging two snapshots can produce).
  const overlapping = structuredClone(layout);
  overlapping.views.all.clusters['shop/Sales'][second] = { ...sales[second], x: sales[first].x, y: sales[first].y };
  const { layout: fixed } = await computeLayout(model, overlapping);
  const boxes = Object.values(fixed.views.all.clusters).flatMap((members) => Object.values(members));
  const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  assert.ok(boxes.every((a, i) => boxes.slice(i + 1).every((b) => !hit(a, b))));
  assert.doesNotThrow(() => renderSvg(model, fixed));
});
