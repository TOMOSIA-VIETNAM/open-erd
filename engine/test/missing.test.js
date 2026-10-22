import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readWorkspaceFiles } from '../cli.js';
import { computeLayout } from '../src/layout/index.js';
import { parseWorkspace } from '../src/model/load.js';
import { missingRelations, warningsFor } from '../src/model/missing.js';
import { applyProfile } from '../src/model/profile.js';
import { renderSvg } from '../src/render/svg/render.js';
import { MULTI, fk, loadMulti } from './helpers/shop.js';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

// The multi fixture covers every reference column; these add the gaps.
function withColumns(model, tableId, columns, extra = {}) {
  return {
    ...model,
    ...extra,
    tables: model.tables.map((t) => (t.id === tableId ? { ...t, columns: [...t.columns, ...columns.map(([name, more]) => ({ name, type: 'bigint', ...more }))] } : t)),
  };
}
const brief = (warnings) => warnings.map((w) => [w.kind, w.table, w.column ?? null]);

test('the multi fixture links every reference column and every table', async () => {
  assert.deepEqual(missingRelations(await loadMulti()), []);
});

test('reference columns no relation covers: snake, camel and array names; keys and covered columns are not', async () => {
  const model = withColumns(await loadMulti(), 'shop._.orders', [['supplier_id'], ['warehouseId'], ['tag_ids'], ['paid'], ['uuid']]);
  assert.deepEqual(brief(missingRelations(model)), [
    ['column', 'shop._.orders', 'supplier_id'],
    ['column', 'shop._.orders', 'warehouseId'],
    ['column', 'shop._.orders', 'tag_ids'],
  ]);
  // organization_id points at a hub table: a badge, still a relation.
  assert.ok(model.relations.some((r) => r.from.table === 'shop._.orders' && r.from.columns.includes('organization_id')));
});

test('a type column beside an uncovered id column is one polymorphic warning naming both', async () => {
  const model = withColumns(await loadMulti(), 'shop._.payments', [['payable_type', { type: 'varchar' }], ['payable_id']]);
  const [w, ...rest] = missingRelations(model);
  assert.deepEqual(rest, []);
  assert.deepEqual([w.kind, w.table, w.column, w.typeColumn], ['polymorphic', 'shop._.payments', 'payable_id', 'payable_type']);
});

test('a table nothing connects to is reported; a hub reference or view source connects', async () => {
  const multi = await loadMulti();
  const lonely = { id: 'shop._.settings', domain: 'Catalog', columns: [{ name: 'id', type: 'bigint', pk: true }, { name: 'value', type: 'text' }] };
  const model = { ...multi, tables: [...multi.tables, lonely] };
  assert.deepEqual(brief(missingRelations(model)), [['table', 'shop._.settings', null]]);
  // created_by is a hub column: drawn as a badge, still a relation.
  const audited = { ...model, tables: [...multi.tables, { ...lonely, columns: [...lonely.columns, { name: 'created_by', type: 'bigint' }] }], relations: [...model.relations, fk('shop._.settings', 'created_by', 'auth.public.users')] };
  assert.deepEqual(missingRelations(audited), []);
  const read = { ...model, tables: [...model.tables, { id: 'shop._.settings_view', domain: 'Catalog', kind: 'view', sources: ['shop._.settings'], columns: [{ name: 'owner_id', type: 'bigint' }] }] };
  // The view connects the table, and a view's columns are never reported.
  assert.deepEqual(missingRelations(read), []);
});

test('ignore_missing silences listed columns and tables, and must name existing ones', async () => {
  const multi = await loadMulti();
  const lonely = { id: 'shop._.settings', domain: 'Catalog', columns: [{ name: 'id', type: 'bigint', pk: true }] };
  const model = withColumns({ ...multi, tables: [...multi.tables, lonely] }, 'shop._.orders', [['stripe_customer_id'], ['supplier_id']], {});
  const ignored = { ...model, config: { ...model.config, ignore_missing: { columns: ['shop._.orders.stripe_customer_id'], tables: ['shop._.settings'] } } };
  assert.deepEqual(brief(missingRelations(ignored)), [['column', 'shop._.orders', 'supplier_id']]);

  const files = await readWorkspaceFiles(MULTI);
  files['open-erd.yaml'] += 'ignore_missing:\n  columns: [shop._.orders.nope_id]\n  tables: [shop._.nope]\n';
  const { errors } = parseWorkspace(files);
  assert.deepEqual(
    errors.map((e) => e.path),
    ['ignore_missing.tables[0]', 'ignore_missing.columns[0]'],
  );
});

test('embedded reference paths are checked like columns', async () => {
  const multi = await loadMulti();
  const events = multi.tables.find((t) => t.id === 'activity._.events');
  const model = { ...multi, tables: multi.tables.map((t) => (t === events ? { ...t, embedded: [{ name: 'meta', columns: [{ name: 'device_id', type: 'string' }] }] } : t)) };
  assert.deepEqual(brief(missingRelations(model)), [['column', 'activity._.events', 'meta.device_id']]);
});

test('profiles: warnings come from the full model and never name what the profile drops', async () => {
  const multi = await loadMulti();
  const model = withColumns(multi, 'shop._.orders', [['supplier_id'], ['contact_id', { pii: true }]], {
    config: { ...multi.config, hidden: { tables: ['auth.public.user_profiles'] } },
  });
  const all = missingRelations(model);
  assert.deepEqual(brief(all), [['column', 'shop._.orders', 'supplier_id'], ['column', 'shop._.orders', 'contact_id']]);
  // On the filtered model the hidden table's neighbours would look unlinked.
  assert.ok(missingRelations(applyProfile(model, 'public')).length > 0);
  const shown = applyProfile(model, 'public');
  // Narrowed to the profile: the pii column is gone, supplier_id is left.
  assert.deepEqual(brief(warningsFor(all, shown)), [['column', 'shop._.orders', 'supplier_id']]);
  const { layout } = await computeLayout(model);
  const svg = renderSvg(shown, layout, { fitStored: true, warnings: warningsFor(all, shown) });
  assert.doesNotMatch(svg, /contact_id/);
  assert.match(svg, /data-column="supplier_id"><rect class="row-hit"[^>]*\/><path class="col-warn"/);
  const data = JSON.parse(svg.match(/id="open-erd-data">([^<]*)</)[1]);
  assert.match(data.nodes['shop._.orders'].columns.find((c) => c.name === 'supplier_id').warning, /looks like a reference/);
});

test('CLI validate prints the warnings and still exits 0', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'open-erd-missing-'));
  try {
    await cp(MULTI, dir, { recursive: true });
    const file = join(dir, 'model', 'shop.yaml');
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.replace('      - { name: order_id, type: bigint, nullable: false }\n', '      - { name: order_id, type: bigint, nullable: false }\n      - { name: courier_id, type: bigint }\n'));
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, 'validate', '--workspace', dir]);
    assert.match(stderr, /^warning: possibly missing relation: shop\._\.\w+\.courier_id: looks like a reference/m);
    assert.match(stdout, /valid.*1 possibly missing relation/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
