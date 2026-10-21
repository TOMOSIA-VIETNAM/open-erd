import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { generateWorkspace } from '../scripts/gen-large.js';
import { buildDiagram } from '../src/layout/diagram.js';
import { computeLayout } from '../src/layout/index.js';
import { ALL_VIEW, ALL_VIEW_MAX_TABLES, viewNames } from '../src/layout/views.js';
import { buildScene, renderSvg } from '../src/render/svg/render.js';
import { buildWorkbook, serializeWorkbook } from '../src/render/xlsx/workbook.js';
import { assertSceneGeometry } from './helpers/geometry.js';
import { loadWorkspace } from './helpers/shop.js';

// Synthetic workspaces from scripts/gen-large.js, generated into a temporary
// folder. The 150-table one runs with every `npm test`; the 1000-table and
// schema-per-tenant ones take longer and run with `npm run test:large`.
// Time limits are the targets for an Apple M1 and leave headroom on faster
// machines; each test prints what it measured.
const LARGE = process.env.OPEN_ERD_LARGE === '1';
const root = await mkdtemp(join(tmpdir(), 'open-erd-scale-'));
after(() => rm(root, { recursive: true, force: true }));

async function measure(preset) {
  const dir = join(root, preset);
  await generateWorkspace(preset, dir);
  const model = await loadWorkspace(dir);
  const t0 = performance.now();
  const { layout } = await computeLayout(model);
  const t1 = performance.now();
  const svg = renderSvg(model, layout);
  const t2 = performance.now();
  const xlsx = await serializeWorkbook(buildWorkbook(model), { date: new Date('1980-01-01T00:00:00Z') });
  const result = { model, layout, svg, layoutMs: t1 - t0, renderMs: t2 - t1, svgBytes: Buffer.byteLength(svg), xlsxBytes: xlsx.length };
  console.log(
    `${preset}: ${model.tables.length} tables, ${model.relations.length} relations; layout ${Math.round(result.layoutMs)} ms, ` +
      `render ${Math.round(result.renderMs)} ms, erd.svg ${(result.svgBytes / 1e6).toFixed(2)} MB, erd.xlsx ${(result.xlsxBytes / 1e6).toFixed(2)} MB`,
  );
  return result;
}

// Every view: no line through a box, no text outside its box.
function assertAllViews({ model, layout }) {
  const diagram = buildDiagram(model);
  const names = viewNames(diagram);
  for (const name of names) assertSceneGeometry(buildScene(model, layout, name, diagram));
  return names;
}

test('150 tables: render under 10 s, erd.svg under 5 MB, every view clear', async () => {
  const run = await measure('150');
  assert.equal(run.model.tables.length, 150);
  assert.ok(run.renderMs < 10000, `render took ${run.renderMs} ms`);
  assert.ok(run.svgBytes < 5e6, `erd.svg is ${run.svgBytes} bytes`);
  assert.ok(assertAllViews(run).includes(ALL_VIEW));
});

test('1000 tables over 3 databases: layout and render under 60 s, no view of all tables', { skip: !LARGE && 'run with npm run test:large' }, async () => {
  const run = await measure('1000');
  assert.equal(run.model.tables.length, 1000);
  assert.ok(run.layoutMs + run.renderMs < 60000, `layout + render took ${run.layoutMs + run.renderMs} ms`);
  assert.ok(run.model.tables.length > ALL_VIEW_MAX_TABLES);
  assert.equal(run.layout.views[ALL_VIEW], undefined);
  assert.doesNotMatch(run.svg, /data-view="all"/);
  const names = assertAllViews(run);
  assert.equal(names.length, 1 + 40);
});

test('schema-per-tenant with 500 tenants: drawn once as a stack, noted on the frame', { skip: !LARGE && 'run with npm run test:large' }, async () => {
  const run = await measure('tenant');
  assert.ok(run.renderMs < 10000, `render took ${run.renderMs} ms`);
  assert.match(run.svg, /schema tenant × 500 tenants/);
  assert.match(run.svg, /× 500 tenants/);
  assert.match(run.svg, /class="tenant-copy"/);
  assertAllViews(run);
});
