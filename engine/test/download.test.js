import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readWorkspaceFiles } from '../cli.js';
import { buildDiagram } from '../src/layout/diagram.js';
import { computeLayout } from '../src/layout/index.js';
import { parseWorkspace } from '../src/model/load.js';
import { applyProfile } from '../src/model/profile.js';
import { openingView, renderSvg } from '../src/render/svg/render.js';
import { CANVAS_LIMITS, PIXEL_RATIO, canvasScale, exportBaseName } from '../src/render/svg/viewer/download.js';
import { ALL_VIEW_MAX_TABLES } from '../src/layout/views.js';
import { MULTI, loadMulti, table } from './helpers/shop.js';

const visibleView = (svg) => [...svg.matchAll(/<g class="view" data-view="([^"]+)" data-bounds="[^"]+"( style="display:none")?>/g)].filter((m) => !m[2]).map((m) => m[1]);
const withView = (model, view) => ({ ...model, config: { ...model.config, default_view: view } });

test('canvas scale: twice the size when it fits, else the largest that fits each browser', () => {
  assert.deepEqual(canvasScale(1000, 800, CANVAS_LIMITS.webkit), { scale: PIXEL_RATIO, width: 2000, height: 1600, downscaled: false });
  // 6000 x 4000 at 2x is 96M px: fine in Chrome, over Safari's area.
  assert.equal(canvasScale(6000, 4000, CANVAS_LIMITS.other).downscaled, false);
  const safari = canvasScale(6000, 4000, CANVAS_LIMITS.webkit);
  assert.ok(safari.downscaled && safari.width * safari.height <= CANVAS_LIMITS.webkit.area);
  // A very long strip hits the side limit before the area limit.
  const strip = canvasScale(40000, 100, CANVAS_LIMITS.other);
  assert.ok(strip.downscaled && strip.width <= CANVAS_LIMITS.other.side);
});

test('download names: <db-or-project>-<view>, lower case, safe characters only', () => {
  assert.equal(exportBaseName('shop', 'overview'), 'shop-overview');
  assert.equal(exportBaseName('shop', 'all'), 'shop-all-tables');
  assert.equal(exportBaseName('erd', 'domain:shop/Orders & Payments'), 'shop-orders-payments');
  assert.equal(exportBaseName('erd', 'domain:shop/受注 管理'), 'shop-受注-管理');
  assert.equal(exportBaseName('erd', 'neighborhood', 'shop._.orders'), 'shop-orders-related');
  assert.equal(exportBaseName('erd', 'neighborhood', 'shop._.comments«commentable»'), 'shop-comments-commentable-related');
  assert.equal(exportBaseName('../x', 'overview'), 'x-overview');
  assert.equal(exportBaseName('shop', 'join-path', 'orders-to-users'), 'shop-join-orders-to-users');
  assert.equal(exportBaseName('erd', 'impact', 'shop._.orders'), 'shop-orders-impact');
  assert.equal(exportBaseName('erd', 'impact', 'auth.public.users.id'), 'auth-users-id-impact');
});

test('the viewer data names the project: one database, else the one source, else erd', async () => {
  const model = await loadMulti();
  const { layout } = await computeLayout(model);
  const project = (m) => JSON.parse(renderSvg(m, layout).match(/id="open-erd-data">([^<]*)</)[1]).project;
  assert.equal(project(model), 'erd');
  assert.equal(project({ ...model, config: { ...model.config, sources: [{ name: 'shop-api' }] } }), 'shop-api');
});

test('default_view: all tables unless configured; the overview when the render lacks the view', async () => {
  const model = await loadMulti();
  const { layout } = await computeLayout(model);
  assert.deepEqual(openingView(model), { view: 'all', fallback: false });
  assert.deepEqual(visibleView(renderSvg(model, layout)), ['all']);
  for (const view of ['overview', 'connections']) assert.deepEqual(visibleView(renderSvg(withView(model, view), layout)), [view]);
  const domain = `domain:${[...buildDiagram(model).clusters.keys()][0]}`;
  assert.deepEqual(visibleView(renderSvg(withView(model, domain), layout)), [domain]);
  // The connections view without script: the matrix sized as the file.
  const matrix = renderSvg(withView(model, 'connections'), layout);
  const bounds = /<g class="view" data-view="connections" data-bounds="([^"]+)">/.exec(matrix)[1];
  assert.match(matrix, new RegExp(`^<svg [^>]*viewBox="${bounds}"`));
  // A profile hiding every table of that domain: the overview, flagged.
  const tables = model.tables.filter((t) => `domain:${t.id.split('.')[0]}/${t.domain}` === domain).map((t) => t.id);
  const hidden = withView({ ...model, config: { ...model.config, hidden: { tables } } }, domain);
  const shown = applyProfile(hidden, 'public');
  assert.deepEqual(openingView(shown), { view: 'overview', fallback: true });
  assert.deepEqual(visibleView(renderSvg(shown, layout, { fitStored: true })), ['overview']);
  assert.deepEqual(openingView(withView(model, domain)), { view: domain, fallback: false });
  // Too many tables for the view of all tables: the overview, without a
  // warning when nothing was configured, with one when `all` was.
  const big = { ...model, tables: Array.from({ length: ALL_VIEW_MAX_TABLES + 1 }, (_, i) => table(`shop._.t${i}`, 'Bulk', [])), relations: [], polymorphic: [] };
  assert.deepEqual(openingView(big), { view: 'overview', fallback: false });
  assert.deepEqual(openingView(withView(big, 'all')), { view: 'overview', fallback: true });
});

test('default_view must be all, overview, connections or the domain of a table', async () => {
  const errorsWith = async (line) => {
    const files = await readWorkspaceFiles(MULTI);
    files['open-erd.yaml'] += `${line}\n`;
    return parseWorkspace(files).errors.map((e) => `${e.path}: ${e.message}`);
  };
  assert.deepEqual(await errorsWith('default_view: all'), []);
  assert.deepEqual(await errorsWith('default_view: connections'), []);
  assert.deepEqual(await errorsWith('default_view: "domain:shop/Nope"'), ['default_view: no domain "shop/Nope" (expected domain:<db>/<domain> of a table)']);
  assert.match((await errorsWith('default_view: tables'))[0], /^default_view: invalid value/);
});
