import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readWorkspaceFiles } from '../cli.js';
import { buildDiagram } from '../src/layout/diagram.js';
import { computeLayout } from '../src/layout/index.js';
import { parseWorkspace } from '../src/model/load.js';
import { applyProfile } from '../src/model/profile.js';
import { openingView, renderSvg } from '../src/render/svg/render.js';
import { CANVAS_LIMITS, PIXEL_RATIO, canvasScale, exportBaseName } from '../src/render/svg/viewer/download.js';
import { MULTI, loadMulti } from './helpers/shop.js';

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
});

test('the viewer data names the project: one database, else the one source, else erd', async () => {
  const model = await loadMulti();
  const { layout } = await computeLayout(model);
  const project = (m) => JSON.parse(renderSvg(m, layout).match(/id="open-erd-data">([^<]*)</)[1]).project;
  assert.equal(project(model), 'erd');
  assert.equal(project({ ...model, config: { ...model.config, sources: [{ name: 'shop-api' }] } }), 'shop-api');
});

test('default_view: the view drawn visible without script, overview when the render lacks it', async () => {
  const model = await loadMulti();
  const { layout } = await computeLayout(model);
  assert.deepEqual(visibleView(renderSvg(model, layout)), ['overview']);
  assert.deepEqual(visibleView(renderSvg(withView(model, 'all'), layout)), ['all']);
  const domain = `domain:${[...buildDiagram(model).clusters.keys()][0]}`;
  assert.deepEqual(visibleView(renderSvg(withView(model, domain), layout)), [domain]);
  // A profile hiding every table of that domain: the overview, flagged.
  const tables = model.tables.filter((t) => `domain:${t.id.split('.')[0]}/${t.domain}` === domain).map((t) => t.id);
  const hidden = withView({ ...model, config: { ...model.config, hidden: { tables } } }, domain);
  const shown = applyProfile(hidden, 'public');
  assert.deepEqual(openingView(shown), { view: 'overview', fallback: true });
  assert.deepEqual(visibleView(renderSvg(shown, layout, { fitStored: true })), ['overview']);
  assert.deepEqual(openingView(withView(model, domain)), { view: domain, fallback: false });
});

test('default_view must be overview, all or the domain of a table', async () => {
  const errorsWith = async (line) => {
    const files = await readWorkspaceFiles(MULTI);
    files['open-erd.yaml'] += `${line}\n`;
    return parseWorkspace(files).errors.map((e) => `${e.path}: ${e.message}`);
  };
  assert.deepEqual(await errorsWith('default_view: all'), []);
  assert.deepEqual(await errorsWith('default_view: "domain:shop/Nope"'), ['default_view: no domain "shop/Nope" (expected domain:<db>/<domain> of a table)']);
  assert.match((await errorsWith('default_view: tables'))[0], /^default_view: invalid value/);
});
