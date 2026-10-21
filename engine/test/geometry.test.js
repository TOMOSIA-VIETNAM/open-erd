import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildDiagram } from '../src/layout/diagram.js';
import { computeLayout } from '../src/layout/index.js';
import { viewNames } from '../src/layout/views.js';
import { applyProfile } from '../src/model/profile.js';
import { buildScene } from '../src/render/svg/render.js';
import { assertSceneGeometry } from './helpers/geometry.js';
import { loadWorkspace } from './helpers/shop.js';

// Every workspace in the repo: the engine's own test workspaces and the
// expected models of the extraction fixtures (which must also stay valid).
const ENGINE = fileURLToPath(new URL('./fixtures/', import.meta.url));
const EXTRACTION = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const workspaces = [
  ...(await readdir(ENGINE)).filter((n) => n.startsWith('workspace-') && n !== 'workspace-invalid').map((n) => [n, join(ENGINE, n)]),
  ...(await readdir(EXTRACTION, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => [`fixtures/${d.name}`, join(EXTRACTION, d.name, 'expected')]),
].sort(([a], [b]) => (a < b ? -1 : 1));

test('every repo workspace is covered', () => {
  assert.ok(workspaces.length >= 9, workspaces.map(([n]) => n).join(', '));
});

for (const [name, dir] of workspaces) {
  test(`${name}: every view keeps lines clear of boxes and labels, and text inside boxes`, async () => {
    const model = await loadWorkspace(dir);
    const { layout } = await computeLayout(model);
    const diagram = buildDiagram(model);
    const names = viewNames(diagram);
    assert.deepEqual(names.slice(0, 2), ['overview', 'all']);
    for (const view of names) assertSceneGeometry(buildScene(model, layout, view, diagram));
    // A public render draws a filtered model at the full layout's positions.
    const shared = applyProfile(model, 'public');
    const sharedDiagram = buildDiagram(shared);
    for (const view of viewNames(sharedDiagram)) assertSceneGeometry(buildScene(shared, layout, view, sharedDiagram, { fitStored: true }));
  });
}
