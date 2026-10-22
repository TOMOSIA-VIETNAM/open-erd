import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readWorkspaceFiles } from '../cli.js';
import { UNASSIGNED_DOMAIN, applyFacts, needsSyncMarkdown } from '../src/model/apply-facts.js';
import { compareFacts, readFacts } from '../src/model/facts.js';
import { parseWorkspace } from '../src/model/load.js';
import { changesMarkdown, diffModels } from '../src/diff/changes.js';
import { factsFromModel } from './helpers/facts.js';
import { runCli, snapshotRepo } from './helpers/git-workspace.js';
import { MULTI } from './helpers/shop.js';

const parse = (files) => {
  const { model, errors } = parseWorkspace(files);
  assert.deepEqual(errors, []);
  return model;
};

/** workspace-multi files, each `[path, search, replacement]` applied, its model and the facts matching it. */
async function multi(edits = []) {
  const files = await readWorkspaceFiles(MULTI);
  for (const [path, search, replacement] of edits) {
    assert.ok(files[path].includes(search), `${path}: ${search}`);
    files[path] = files[path].replace(search, replacement);
  }
  const model = parse(files);
  return { files, model, facts: factsFromModel(model) };
}

const factsFile = (facts, database) => facts.find((f) => f.data.tables.some((t) => t.database === database)).data;
const factsTable = (facts, database, name) => factsFile(facts, database).tables.find((t) => t.name === name);

/** applyFacts on the facts, checking the result loads. */
function apply({ files, model }, facts) {
  const result = applyFacts(files, model, compareFacts(model, readFacts(facts)));
  const merged = { ...files, ...result.files };
  return { ...result, merged, after: parse(merged) };
}

const tableOf = (model, id) => model.tables.find((t) => t.id === id);
const relationOf = (model, from, column) => model.relations.find((r) => r.from.table === from && r.from.columns.join() === column);
const reasons = (needsSync) => needsSync.map((n) => `${n.path}: ${n.reason}`);

test('facts matching the model change nothing', async () => {
  const ws = await multi();
  const result = apply(ws, ws.facts);
  assert.deepEqual(result.files, {});
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.needsSync, []);
});

test('an added table with an index and a constraint goes in, in domain Unassigned, with a pending db_fk relation', async () => {
  const ws = await multi();
  const auth = factsFile(ws.facts, 'auth');
  auth.tables.push({
    name: 'api_keys',
    schema: 'public',
    database: 'auth',
    evidence: 'db/migrate/1_api_keys.rb',
    columns: [
      { name: 'id', type: 'bigint', pk: true, nullable: false },
      { name: 'user_id', type: 'bigint', nullable: true },
      { name: 'token', type: 'varchar(64)', nullable: false, unique: true },
    ],
    indexes: [{ name: 'index_api_keys_on_token', columns: ['token'], unique: true }],
  });
  auth.associations.push({ from: { table: 'api_keys', columns: ['user_id'] }, to: { table: 'users', columns: ['id'] }, constraint: true, evidence: 'db/migrate/1_api_keys.rb' });
  const result = apply(ws, ws.facts);
  assert.deepEqual(Object.keys(result.files), ['model/auth.yaml']);
  const table = tableOf(result.after, 'auth.public.api_keys');
  assert.equal(table.domain, UNASSIGNED_DOMAIN);
  assert.deepEqual(table.columns.map((c) => c.name), ['id', 'user_id', 'token']);
  assert.deepEqual(table.indexes, [{ name: 'index_api_keys_on_token', columns: ['token'], unique: true }]);
  assert.deepEqual(relationOf(result.after, 'auth.public.api_keys', 'user_id'), {
    from: { table: 'auth.public.api_keys', columns: ['user_id'] },
    to: { table: 'auth.public.users', columns: ['id'] },
    cardinality: 'n-1',
    optional: true,
    kind: 'db_fk',
    evidence: ['app-auth:db/migrate/1_api_keys.rb'],
    review: 'pending',
  });
  assert.deepEqual(reasons(result.needsSync), ['auth.public.api_keys: new table, put in domain Unassigned: /open-erd:sync picks its domain and writes notes']);
  // Written in the file's style: one flow map per column, index and relation.
  const text = result.files['model/auth.yaml'];
  assert.match(text, /\n {6}- \{ name: user_id, type: bigint, nullable: true \}\n/);
  assert.match(text, /\n {2}- \{ from: \{ table: auth\.public\.api_keys, columns: \[user_id\] \}, to: \{ table: auth\.public\.users, columns: \[id\] \}, cardinality: n-1, optional: true, kind: db_fk, evidence: \[.+\], review: pending \}\n/);
});

test('columns and indexes added, removed and changed; a one-line change rewrites one line', async () => {
  const ws = await multi();
  const posts = factsTable(ws.facts, 'shop', 'posts');
  posts.columns.find((c) => c.name === 'title').type = 'text';
  posts.columns.push({ name: 'published', type: 'boolean', nullable: false, default: 'false' });
  const items = factsTable(ws.facts, 'shop', 'order_items');
  items.columns = items.columns.filter((c) => c.name !== 'quantity');
  const users = factsTable(ws.facts, 'auth', 'users');
  users.columns = users.columns.filter((c) => c.name !== 'status');
  users.indexes = users.indexes.filter((i) => !i.columns.includes('status'));
  users.indexes.push({ name: 'index_users_on_created_at', columns: ['created_at'] });
  users.indexes.find((i) => i.name === 'index_users_on_email').name = 'users_email_key';
  const refunds = factsTable(ws.facts, 'shop', 'refunds');
  refunds.columns.find((c) => c.name === 'reason').nullable = true;

  const result = apply(ws, ws.facts);
  assert.deepEqual(result.needsSync, []);
  const { changes } = diffModels(ws.model, result.after);
  assert.deepEqual(changesMarkdown(changes).split('\n').filter((l) => l.startsWith('| `')), [
    '| `auth.public.users` | Table users: indexes changed from “name: index_users_on_email, columns: email, unique: yes; name: index_users_on_status, columns: status, using: btree” to “name: index_users_on_created_at, columns: created_at; name: users_email_key, columns: email, unique: yes” |',
    '| `auth.public.users` | Column status removed |',
    '| `shop._.order_items` | Column quantity removed |',
    '| `shop._.posts` | Column published added (boolean) |',
    '| `shop._.posts` | Column title: type changed from “varchar(255)” to “text” |',
    '| `shop._.refunds` | Column reason: now nullable |',
  ]);
  // Only the edited lines differ; the comment and every other line stay.
  const before = ws.files['model/shop.yaml'].split('\n');
  const after = result.files['model/shop.yaml'].split('\n');
  assert.deepEqual(after.filter((l) => !before.includes(l)), [
    '      - { name: reason, type: text, nullable: true }',
    '      - { name: title, type: text }',
    '      - { name: published, type: boolean, nullable: false, default: "false" }',
  ]);
  // (posts' old title line reads like products' title, which stays)
  assert.deepEqual(before.filter((l) => !after.includes(l)), ['      - { name: quantity, type: int }', '      - { name: reason, type: text }']);
  assert.equal(after.length, before.length);
  assert.ok(result.files['model/auth.yaml'].includes('  # Pure join table: drawn as one n-n line when collapse_join_tables is on.\n'));
});

test('a table with only an unreviewed constraint goes with it; a reviewed or code-only relation keeps it for sync', async () => {
  const pending = '{ from: { table: auth.public.role_permissions, columns: [permission_id] }, to: { table: auth.public.permissions, columns: [id] }, cardinality: n-1, optional: false, kind: db_fk, evidence: [db], review: reviewed }';
  const ws = await multi([['model/auth.yaml', pending, pending.replace('review: reviewed', 'review: pending')]]);
  const auth = factsFile(ws.facts, 'auth');
  auth.tables = auth.tables.filter((t) => t.name !== 'permissions' && t.name !== 'roles');
  auth.associations = auth.associations.filter((a) => a.to.table !== 'permissions' && a.to.table !== 'roles');
  const result = apply(ws, ws.facts);
  assert.equal(tableOf(result.after, 'auth.public.permissions'), undefined);
  assert.equal(relationOf(result.after, 'auth.public.role_permissions', 'permission_id'), undefined);
  assert.ok(tableOf(result.after, 'auth.public.roles'));
  assert.deepEqual(reasons(result.needsSync), [
    'auth.public.roles: removed from the facts but still used by relation auth.public.memberships.role_id -> auth.public.roles.id; relation auth.public.role_permissions.role_id -> auth.public.roles.id: /open-erd:sync decides',
  ]);
});

test('renames, reviewed facts, relation kinds and used columns are left for sync', async () => {
  const membership = '{ from: { table: auth.public.memberships, columns: [organization_id] }, to: { table: auth.public.organizations, columns: [id] }, cardinality: n-1, optional: false, kind: db_fk, evidence: [db], review: reviewed }';
  const invitation = '{ from: { table: auth.public.invitations, columns: [organization_id] }, to: { table: auth.public.organizations, columns: [id] }, cardinality: n-1, optional: false, kind: db_fk, evidence: [db], review: reviewed }';
  const ws = await multi([
    ['model/auth.yaml', membership, membership.replace('evidence: [db]', 'evidence: ["auth-service:db/schema.rb"]')],
    ['model/auth.yaml', invitation, invitation.replace('evidence: [db]', 'evidence: ["auth-service:db/schema.rb"]').replace('reviewed', 'pending')],
  ]);
  const auth = factsFile(ws.facts, 'auth');
  // Same columns under a new name: a possible rename, not a drop and an add.
  const profiles = auth.tables.find((t) => t.name === 'user_profiles');
  auth.tables.push({ ...structuredClone(profiles), name: 'member_profiles' });
  auth.tables = auth.tables.filter((t) => t !== profiles);
  auth.associations = auth.associations.filter((a) => !(a.from.table === 'user_profiles' || (a.from.table === 'memberships' && a.from.columns[0] === 'organization_id') || a.from.table === 'invitations'));
  // A constraint on a relation the model has as inferred.
  auth.associations.find((a) => a.from.table === 'memberships' && a.from.columns[0] === 'role_id').constraint = true;
  // A column a reviewed relation uses, and one a pending relation uses.
  auth.tables.find((t) => t.name === 'memberships').columns.find((c) => c.name === 'user_id').type = 'uuid';
  const shop = factsFile(ws.facts, 'shop');
  const payments = shop.tables.find((t) => t.name === 'payments');
  payments.columns = payments.columns.filter((c) => c.name !== 'order_id');

  const result = apply(ws, ws.facts);
  assert.deepEqual(reasons(result.needsSync), [
    'auth.public.member_profiles: possibly renamed from auth.public.user_profiles: /open-erd:sync asks',
    'auth.public.memberships.organization_id -> auth.public.organizations.id: reviewed relation no longer backed by a constraint: /open-erd:sync marks it stale',
    'auth.public.memberships.role_id -> auth.public.roles.id: kind inferred in the model, db_fk in the facts: /open-erd:sync decides',
    'auth.public.memberships.user_id: type changed on a column a reviewed relation uses: /open-erd:sync marks it stale',
    'auth.public.user_profiles: possibly renamed to auth.public.member_profiles: /open-erd:sync asks',
    'shop._.payments.order_id: removed from the facts but still used by relation shop._.payments.order_id -> shop._.orders.id: /open-erd:sync decides',
  ]);
  // The one unreviewed constraint gone from the facts is the one applied.
  assert.deepEqual(result.applied.map((d) => `${d.change} ${d.path}`), ['removed auth.public.invitations.organization_id -> auth.public.organizations.id']);
  assert.equal(relationOf(result.after, 'auth.public.invitations', 'organization_id'), undefined);
  assert.ok(relationOf(result.after, 'auth.public.memberships', 'organization_id'));
});

test('applying is deterministic and the markdown lists what sync must do', async () => {
  const run = async () => {
    const ws = await multi();
    factsTable(ws.facts, 'shop', 'posts').columns.push({ name: 'slug', type: 'varchar(80)', nullable: false, unique: true });
    factsFile(ws.facts, 'shop').tables.push({ name: 'banners', schema: null, database: 'shop', evidence: 'db/schema.sql', columns: [{ name: 'id', type: 'bigint', pk: true }] });
    return apply(ws, ws.facts);
  };
  const [a, b] = [await run(), await run()];
  assert.deepEqual(a.files, b.files);
  assert.equal(
    needsSyncMarkdown(a.needsSync),
    '**Left for `/open-erd:sync`** (1):\n\n- `shop._.banners`: new table, put in domain Unassigned: /open-erd:sync picks its domain and writes notes\n',
  );
  assert.equal(needsSyncMarkdown([]), 'Nothing left for `/open-erd:sync`.\n');
});

const hashDir = async (dir) => {
  const hash = createHash('sha256');
  for (const entry of (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)).sort()) {
    hash.update(entry).update(await readFile(entry));
  }
  return hash.digest('hex');
};

test('cli: apply-facts writes a loadable copy, leaves the workspace alone, and diff compares the two as Markdown', async () => {
  const ws = await snapshotRepo(MULTI, [{ tag: 'base' }], 'open-erd-apply-');
  const scratch = await mkdtemp(join(tmpdir(), 'open-erd-apply-out-'));
  try {
    const facts = factsFromModel(parse(await readWorkspaceFiles(ws)));
    const shop = factsFile(facts, 'shop');
    shop.tables.push({
      name: 'wishlists',
      schema: null,
      database: 'shop',
      evidence: 'db/schema.sql',
      columns: [{ name: 'id', type: 'bigint', pk: true }, { name: 'product_id', type: 'bigint', nullable: false }],
    });
    shop.associations.push({ from: { table: 'wishlists', columns: ['product_id'] }, to: { table: 'products', columns: ['id'] }, constraint: true, evidence: 'db/schema.sql' });
    const posts = shop.tables.find((t) => t.name === 'posts');
    posts.columns = posts.columns.filter((c) => c.name !== 'title');
    await mkdir(join(scratch, 'facts'));
    for (const { file, data } of facts) await writeFile(join(scratch, 'facts', file), JSON.stringify(data));

    const before = await hashDir(ws);
    const out = join(scratch, 'preview');
    const applied = await runCli('apply-facts', '--workspace', ws, '--facts', join(scratch, 'facts'), '--out', out, '--format', 'markdown');
    assert.equal(applied.stdout, '**Left for `/open-erd:sync`** (1):\n\n- `shop._.wishlists`: new table, put in domain Unassigned: /open-erd:sync picks its domain and writes notes\n\n');
    assert.match(applied.stderr, /3 change\(s\) from the extract facts applied, 1 left for \/open-erd:sync/);
    assert.equal(await hashDir(ws), before);
    assert.equal((await runCli('validate', '--workspace', out)).stdout.includes('valid'), true);
    await assert.rejects(runCli('apply-facts', '--workspace', ws, '--facts', join(scratch, 'facts'), '--out', ws), /never writes the workspace itself/);

    const diff = await runCli('diff', '--workspace', ws, '--from', 'HEAD', '--to-workspace', out, '--format', 'markdown');
    assert.equal(
      diff.stdout,
      [
        '**+1 tables · −0 tables · 0 renamed · 1 columns changed · 1 relations changed**',
        '',
        '| Table | Change |',
        '|---|---|',
        '| `shop._.posts` | Column title removed |',
        '| `shop._.wishlists` | Table wishlists added in domain Unassigned |',
        '| `shop._.wishlists` | Relation wishlists.product_id → products.id added (n-1, db_fk) |',
        '',
        '',
      ].join('\n'),
    );
    assert.match(diff.stderr, /wrote .*out\/diff\.svg and .*out\/diff\.xlsx/);
    assert.match(await readFile(join(ws, 'out', 'diff.svg'), 'utf8'), /Changes from HEAD to preview/);
    await assert.rejects(runCli('diff', '--workspace', ws, '--from', 'HEAD', '--to', 'WORKTREE', '--to-workspace', out), /one of --to or --to-workspace/);
  } finally {
    await rm(ws, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});
