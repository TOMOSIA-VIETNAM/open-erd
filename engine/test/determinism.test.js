import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { computeLayout } from '../src/layout/index.js';
import { serializeLayout } from '../src/layout/layout-file.js';
import { applyProfile } from '../src/model/profile.js';
import { renderSvg } from '../src/render/svg/render.js';
import { buildWorkbook, serializeWorkbook } from '../src/render/xlsx/workbook.js';
import { loadWorkspace } from './helpers/shop.js';

// The patterns workspace exercises every drawn feature (two databases,
// cross-DB lines, embedded entities, views, tenant stacks, facts) while
// staying small enough for 100 renders in a few seconds.
const PATTERNS = fileURLToPath(new URL('./fixtures/workspace-patterns', import.meta.url));
const RUNS = 100;
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

test(`layout, SVG and XLSX are byte-identical over ${RUNS} runs, full and public`, async () => {
  const date = new Date('2026-01-02T03:04:05Z');
  const hashes = { layout: new Set(), full: new Set(), public: new Set(), xlsx: new Set(), publicXlsx: new Set() };
  // Loading is part of the path to output, so every run starts from the files.
  const first = await loadWorkspace(PATTERNS);
  const { layout } = await computeLayout(first);
  hashes.layout.add(sha256(serializeLayout(layout)));
  for (let i = 0; i < RUNS; i++) {
    const model = await loadWorkspace(PATTERNS);
    if (i % 10 === 0) hashes.layout.add(sha256(serializeLayout((await computeLayout(model)).layout)));
    hashes.full.add(sha256(renderSvg(model, layout)));
    hashes.public.add(sha256(renderSvg(applyProfile(model, 'public'), layout, { fitStored: true })));
    hashes.xlsx.add(sha256(await serializeWorkbook(buildWorkbook(model), { date })));
    hashes.publicXlsx.add(sha256(await serializeWorkbook(buildWorkbook(applyProfile(model, 'public')), { date })));
  }
  assert.deepEqual(Object.fromEntries(Object.entries(hashes).map(([k, v]) => [k, v.size])), { layout: 1, full: 1, public: 1, xlsx: 1, publicXlsx: 1 });
});
