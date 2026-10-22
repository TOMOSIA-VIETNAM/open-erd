import assert from 'node:assert/strict';
import { test } from 'node:test';
import ExcelJS from 'exceljs';
import { stringify } from 'yaml';
import { readWorkspaceFiles } from '../cli.js';
import { healthFindings, healthFor, healthSummary } from '../src/model/health.js';
import { parseWorkspace } from '../src/model/load.js';
import { applyProfile } from '../src/model/profile.js';
import { buildWorkbook, serializeWorkbook } from '../src/render/xlsx/workbook.js';
import { renderSvg } from '../src/render/svg/render.js';
import { computeLayout } from '../src/layout/index.js';
import { MULTI, loadMulti } from './helpers/shop.js';
import { xlsxLinks } from './helpers/xlsx.js';

// A small model on one database: `app` with the engine asked for. Tables
// get an `id` primary key plus the columns listed.
const t = (name, columns = [], more = {}) => ({
  id: `app.public.${name}`,
  domain: 'Main',
  columns: [{ name: 'id', type: 'bigint', pk: true }, ...columns.map((c) => (typeof c === 'string' ? { name: c, type: 'bigint' } : c))],
  ...more,
});
const rel = (from, columns, to, kind = 'declared', toColumns = ['id']) => ({
  from: { table: `app.public.${from}`, columns },
  to: { table: `app.public.${to}`, columns: toColumns },
  cardinality: 'n-1',
  optional: false,
  kind,
  evidence: ['db'],
  review: 'reviewed',
});
const model = ({ engine = 'postgresql', tables, relations = [], polymorphic = [], config = {} }) => ({
  config,
  databases: [{ database: 'app', engine }],
  tables,
  relations,
  polymorphic,
});
const brief = (findings) => findings.map((f) => [f.rule, f.table.split('.')[2], (f.columns ?? []).join(',')]);
const of = (rule, findings) => findings.filter((f) => f.rule === rule);
// Every table indexed somewhere, so the index rules run.
const marker = t('marker', ['code'], { indexes: [{ name: 'marker_code', columns: ['code'] }] });

test('the multi fixture: declared relations without constraint, unindexed references, polymorphic pairs', async () => {
  assert.deepEqual(brief(healthFindings(await loadMulti())), [
    ['missing_fk', 'invitations', 'created_by'],
    ['unindexed_fk', 'invitations', 'created_by'],
    ['unindexed_fk', 'invitations', 'organization_id'],
    ['unindexed_fk', 'memberships', 'organization_id'],
    ['unindexed_fk', 'memberships', 'user_id'],
    ['missing_fk', 'organizations', 'created_by'],
    ['unindexed_fk', 'organizations', 'created_by'],
    ['unindexed_fk', 'role_permissions', 'permission_id'],
    ['unindexed_fk', 'role_permissions', 'role_id'],
    ['unindexed_fk', 'user_profiles', 'user_id'],
    ['polymorphic_unindexed', 'attachments', 'attachable_type,attachable_id'],
    ['polymorphic_unindexed', 'comments', 'commentable_type,commentable_id'],
    ['unindexed_fk', 'comments', 'created_by'],
    ['unindexed_fk', 'orders', 'organization_id'],
    ['unindexed_fk', 'posts', 'created_by'],
    ['missing_fk', 'products', 'brand_id'],
    ['unindexed_fk', 'products', 'brand_id'],
    ['unindexed_fk', 'products', 'created_by'],
    ['unindexed_fk', 'products', 'updated_by'],
  ]);
});

test('missing_fk: a declared relation without db_fk; skipped for db_fk twins, MongoDB, views, partitions, polymorphic and non-unique targets', () => {
  const base = { tables: [t('users'), t('orders', ['user_id']), marker], relations: [rel('orders', ['user_id'], 'users')] };
  const found = of('missing_fk', healthFindings(model(base)));
  assert.deepEqual(brief(found), [['missing_fk', 'orders', 'user_id']]);
  assert.equal(found[0].severity, 'medium');
  assert.match(found[0].message, /references app\.public\.users in code only/);
  assert.deepEqual(found[0].related, { table: 'app.public.users', columns: ['id'] });
  // A db_fk on the same columns: the constraint exists.
  assert.deepEqual(of('missing_fk', healthFindings(model({ ...base, relations: [...base.relations, rel('orders', ['user_id'], 'users', 'db_fk')] }))), []);
  // Not a SQL database.
  assert.deepEqual(of('missing_fk', healthFindings(model({ ...base, engine: 'mongodb' }))), []);
  assert.deepEqual(of('missing_fk', healthFindings(model({ ...base, engine: 'dynamodb' }))), []);
  // An end is a view or partitioned.
  assert.deepEqual(of('missing_fk', healthFindings(model({ ...base, tables: [t('users', [], { kind: 'view', sources: ['app.public.orders'] }), t('orders', ['user_id']), marker] }))), []);
  assert.deepEqual(of('missing_fk', healthFindings(model({ ...base, tables: [t('users'), t('orders', ['user_id'], { partition: { method: 'range', columns: ['id'] } }), marker] }))), []);
  // The column belongs to a polymorphic association.
  const poly = { name: 'owner', table: 'app.public.orders', type_column: 'owner_type', id_column: 'user_id', optional: false, targets: ['app.public.users'], evidence: ['db'], review: 'reviewed' };
  assert.deepEqual(of('missing_fk', healthFindings(model({ ...base, tables: [t('users'), t('orders', ['user_id', 'owner_type']), marker], polymorphic: [poly] }))), []);
  // The target columns are neither a key nor unique: no constraint can point at them.
  assert.deepEqual(of('missing_fk', healthFindings(model({ ...base, tables: [t('users', ['code']), t('orders', ['user_code']), marker], relations: [rel('orders', ['user_code'], 'users', 'declared', ['code'])] }))), []);
  const unique = [t('users', [{ name: 'code', type: 'text', unique: true }]), t('orders', ['user_code']), marker];
  assert.equal(of('missing_fk', healthFindings(model({ ...base, tables: unique, relations: [rel('orders', ['user_code'], 'users', 'declared', ['code'])] }))).length, 1);
});

test('unindexed_fk: covered by a leading index, the primary key or a unique column; skipped for inferred, views and databases without index data', () => {
  const tables = (orders) => [t('users'), orders, marker];
  const relations = [rel('orders', ['user_id'], 'users', 'db_fk')];
  const find = (orders, more = {}) => brief(of('unindexed_fk', healthFindings(model({ tables: tables(orders), relations, ...more }))));
  assert.deepEqual(find(t('orders', ['user_id'])), [['unindexed_fk', 'orders', 'user_id']]);
  // A composite index starting with the column covers it; one with it second does not.
  assert.deepEqual(find(t('orders', ['user_id', 'state'], { indexes: [{ columns: ['user_id', 'state'] }] })), []);
  assert.deepEqual(find(t('orders', ['user_id', 'state'], { indexes: [{ columns: ['state', 'user_id'] }] })), [['unindexed_fk', 'orders', 'user_id']]);
  // The primary key and a unique column are indexes too.
  assert.deepEqual(find({ ...t('orders', []), columns: [{ name: 'user_id', type: 'bigint', pk: true }] }), []);
  assert.deepEqual(find(t('orders', [{ name: 'user_id', type: 'bigint', unique: true }])), []);
  // An inferred relation is a guess; a view cannot be indexed.
  assert.deepEqual(brief(of('unindexed_fk', healthFindings(model({ tables: tables(t('orders', ['user_id'])), relations: [rel('orders', ['user_id'], 'users', 'inferred')] })))), []);
  assert.deepEqual(find(t('orders', ['user_id'], { kind: 'view', sources: ['app.public.users'] })), []);
  // No index recorded anywhere in the database: nothing is known.
  assert.deepEqual(brief(of('unindexed_fk', healthFindings(model({ tables: [t('users'), t('orders', ['user_id'])], relations })))), []);
  // MySQL indexes a constraint's columns itself; a declared relation still counts.
  assert.deepEqual(find(t('orders', ['user_id']), { engine: 'mysql' }), []);
  const declared = healthFindings(model({ engine: 'mysql', tables: tables(t('orders', ['user_id'])), relations: [rel('orders', ['user_id'], 'users')] }));
  assert.deepEqual(brief(of('unindexed_fk', declared)), [['unindexed_fk', 'orders', 'user_id']]);
  // Several relations from the same columns give one finding.
  const twice = healthFindings(model({ tables: [t('users'), t('accounts'), t('orders', ['user_id']), marker], relations: [...relations, rel('orders', ['user_id'], 'accounts', 'db_fk')] }));
  assert.equal(of('unindexed_fk', twice).length, 1);
  assert.match(of('unindexed_fk', twice)[0].message, /references app\.public\.accounts/);
});

test('polymorphic_unindexed: the type and id pair must lead an index, in either order', () => {
  const poly = { name: 'subject', table: 'app.public.comments', type_column: 'subject_type', id_column: 'subject_id', optional: false, targets: ['app.public.posts'], evidence: ['db'], review: 'reviewed' };
  const find = (indexes) => brief(of('polymorphic_unindexed', healthFindings(model({ tables: [t('posts'), t('comments', ['subject_type', 'subject_id'], indexes ? { indexes } : {}), marker], polymorphic: [poly] }))));
  assert.deepEqual(find(), [['polymorphic_unindexed', 'comments', 'subject_type,subject_id']]);
  assert.deepEqual(find([{ columns: ['subject_type', 'subject_id'] }]), []);
  assert.deepEqual(find([{ columns: ['subject_id', 'subject_type', 'id'] }]), []);
  // Only one of the pair leading is not enough.
  assert.deepEqual(find([{ columns: ['subject_id'] }]), [['polymorphic_unindexed', 'comments', 'subject_type,subject_id']]);
});

test('orphan_table: a table nothing connects to; not a hub table, an ignore_missing table or a view', () => {
  const tables = [t('users'), t('orders', ['user_id']), t('settings')];
  const relations = [rel('orders', ['user_id'], 'users', 'db_fk')];
  assert.deepEqual(brief(of('orphan_table', healthFindings(model({ tables, relations })))), [['orphan_table', 'settings', '']]);
  assert.equal(healthFindings(model({ tables, relations }))[0].severity, 'low');
  assert.deepEqual(of('orphan_table', healthFindings(model({ tables, relations, config: { hub: { tables: ['app.public.settings'] } } }))), []);
  assert.deepEqual(of('orphan_table', healthFindings(model({ tables, relations, config: { ignore_missing: { tables: ['app.public.settings'] } } }))), []);
  assert.deepEqual(of('orphan_table', healthFindings(model({ tables: [...tables.slice(0, 2), t('settings', [], { kind: 'view' })], relations }))), []);
});

test('redundant_index: a prefix of another index, or a duplicate; uniqueness, method and predicate respected', () => {
  const find = (indexes) => brief(healthFindings(model({ tables: [t('orders', ['a', 'b'], { indexes })] })).filter((f) => f.rule === 'redundant_index'));
  assert.deepEqual(find([{ name: 'ab', columns: ['a', 'b'] }, { name: 'a', columns: ['a'] }]), [['redundant_index', 'orders', 'a']]);
  // A unique index enforces something the longer one does not.
  assert.deepEqual(find([{ name: 'ab', columns: ['a', 'b'] }, { name: 'a', columns: ['a'], unique: true }]), []);
  // Same columns: the plain one goes when the other is unique; of two alike, the second.
  assert.deepEqual(find([{ name: 'a_plain', columns: ['a'] }, { name: 'a_unique', columns: ['a'], unique: true }]), [['redundant_index', 'orders', 'a']]);
  const dup = healthFindings(model({ tables: [t('orders', ['a'], { indexes: [{ name: 'x1', columns: ['a'] }, { name: 'x2', columns: ['a'] }] })] }));
  assert.match(of('redundant_index', dup)[0].message, /^Index x2 duplicates index x1/);
  // Order matters: (b, a) does not cover (a).
  assert.deepEqual(find([{ name: 'ba', columns: ['b', 'a'] }, { name: 'a', columns: ['a'] }]), []);
  // A different access method or predicate serves other queries.
  assert.deepEqual(find([{ name: 'ab', columns: ['a', 'b'], using: 'gin' }, { name: 'a', columns: ['a'] }]), []);
  assert.deepEqual(find([{ name: 'ab', columns: ['a', 'b'], where: 'deleted_at IS NULL' }, { name: 'a', columns: ['a'] }]), []);
  assert.deepEqual(find([{ name: 'ab', columns: ['a', 'b'], where: 'x' }, { name: 'a', columns: ['a'], where: 'x' }]), [['redundant_index', 'orders', 'a']]);
  // btree written out or left out is the same method.
  assert.deepEqual(find([{ name: 'ab', columns: ['a', 'b'], using: 'btree' }, { name: 'a', columns: ['a'] }]), [['redundant_index', 'orders', 'a']]);
});

test('reference SQL per engine: quoting, schema, ALTER TABLE, CREATE INDEX, DROP INDEX; SQLite gets no constraint SQL', () => {
  const tables = [t('users'), t('orders', ['user_id'], { indexes: [{ name: 'by_id_user', columns: ['id', 'user_id'] }, { name: 'by_id', columns: ['id'] }] })];
  const relations = [rel('orders', ['user_id'], 'users')];
  const sqlOf = (engine) => Object.fromEntries(healthFindings(model({ engine, tables, relations })).map((f) => [f.rule, f.sql ?? null]));
  assert.deepEqual(sqlOf('postgresql'), {
    missing_fk: 'ALTER TABLE "public"."orders" ADD CONSTRAINT "fk_orders_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id");',
    unindexed_fk: 'CREATE INDEX "idx_orders_user_id" ON "public"."orders" ("user_id");',
    redundant_index: 'DROP INDEX "public"."by_id";',
  });
  assert.deepEqual(sqlOf('mysql'), {
    missing_fk: 'ALTER TABLE `public`.`orders` ADD CONSTRAINT `fk_orders_user_id` FOREIGN KEY (`user_id`) REFERENCES `public`.`users` (`id`);',
    unindexed_fk: 'CREATE INDEX `idx_orders_user_id` ON `public`.`orders` (`user_id`);',
    redundant_index: 'DROP INDEX `by_id` ON `public`.`orders`;',
  });
  assert.deepEqual(sqlOf('mariadb'), sqlOf('mysql'));
  assert.deepEqual(sqlOf('sqlserver'), {
    missing_fk: 'ALTER TABLE "public"."orders" ADD CONSTRAINT "fk_orders_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id");',
    unindexed_fk: 'CREATE INDEX "idx_orders_user_id" ON "public"."orders" ("user_id");',
    redundant_index: 'DROP INDEX "by_id" ON "public"."orders";',
  });
  assert.deepEqual(sqlOf('oracle').redundant_index, 'DROP INDEX "public"."by_id";');
  assert.deepEqual(sqlOf('sqlite'), {
    missing_fk: null,
    unindexed_fk: 'CREATE INDEX "idx_orders_user_id" ON "public"."orders" ("user_id");',
    redundant_index: 'DROP INDEX "by_id";',
  });
  assert.match(healthFindings(model({ engine: 'sqlite', tables, relations }))[0].suggestion, /SQLite cannot add a constraint/);
  // A schemaless id is not qualified; an unnamed index cannot be dropped by name.
  const bare = of('redundant_index', healthFindings(model({ tables: [{ ...t('orders', ['a']), id: 'app._.orders', indexes: [{ columns: ['a', 'id'] }, { columns: ['a'] }] }] })));
  assert.equal(bare[0].sql, undefined);
  assert.equal(bare[0].message, 'Index (a) is a prefix of index (a, id), which serves the same lookups.');
});

test('MongoDB gets a mongosh line for indexes, no SQL; an unknown engine gets words only', () => {
  const tables = [{ ...t('events', ['actor_id']), id: 'app._.events', indexes: [{ name: 'by_kind', columns: ['kind'] }, { name: 'by_kind_at', columns: ['kind', 'at'] }] }, { ...t('actors'), id: 'app._.actors' }];
  const relations = [{ ...rel('events', ['actor_id'], 'actors'), from: { table: 'app._.events', columns: ['actor_id'] }, to: { table: 'app._.actors', columns: ['id'] } }];
  const mongo = healthFindings(model({ engine: 'mongodb', tables, relations }));
  assert.deepEqual(
    mongo.map((f) => [f.rule, f.sql]),
    [
      ['unindexed_fk', 'db.getCollection("events").createIndex({ "actor_id": 1 })'],
      ['redundant_index', 'db.getCollection("events").dropIndex("by_kind")'],
    ],
  );
  assert.deepEqual(healthFindings(model({ engine: 'cassandra', tables, relations })).map((f) => [f.rule, f.sql]), [
    ['unindexed_fk', undefined],
    ['redundant_index', undefined],
  ]);
});

test('health.ignore silences a rule on a table, or only the findings on one column', () => {
  const tables = [t('users'), t('orders', ['user_id', 'shop_id']), t('shops'), marker];
  const relations = [rel('orders', ['user_id'], 'users', 'db_fk'), rel('orders', ['shop_id'], 'shops', 'db_fk')];
  const find = (ignore) => brief(of('unindexed_fk', healthFindings(model({ tables, relations, config: { health: { ignore } } }))));
  assert.deepEqual(find([]), [['unindexed_fk', 'orders', 'shop_id'], ['unindexed_fk', 'orders', 'user_id']]);
  assert.deepEqual(find(['unindexed_fk:app.public.orders']), []);
  assert.deepEqual(find(['unindexed_fk:app.public.orders.user_id']), [['unindexed_fk', 'orders', 'shop_id']]);
  // Another rule or table leaves it alone.
  assert.deepEqual(find(['missing_fk:app.public.orders', 'unindexed_fk:app.public.users']).length, 2);
});

test('health.ignore is validated: rule, entry shape, table and column', async () => {
  const files = await readWorkspaceFiles(MULTI);
  const errorsOf = (ignore) => parseWorkspace({ ...files, 'open-erd.yaml': `${files['open-erd.yaml']}\n${stringify({ health: { ignore } })}` }).errors.map((e) => `${e.path}: ${e.message}`);
  assert.deepEqual(errorsOf(['unindexed_fk:shop._.products.brand_id', 'orphan_table:shop._.tags']), []);
  assert.deepEqual(errorsOf(['unused_index:shop._.products']), ['health.ignore[0]: unknown rule "unused_index" (known: missing_fk, unindexed_fk, polymorphic_unindexed, orphan_table, redundant_index)']);
  assert.deepEqual(errorsOf(['shop._.products']), ['health.ignore[0]: invalid value "shop._.products", expected <rule>:<table id>[.<column>]']);
  assert.deepEqual(errorsOf(['missing_fk:shop._.nope']), ['health.ignore[0]: unknown table "shop._.nope"']);
  assert.deepEqual(errorsOf(['missing_fk:shop._.products.nope']), ['health.ignore[0]: unknown column "nope" in shop._.products']);
  assert.deepEqual(errorsOf(['orphan_table:shop._.tags.label']), ['health.ignore[0]: orphan_table is about a whole table; leave out the column']);
  // Applied on load: the ignored finding is gone.
  const { model: ignored } = parseWorkspace({ ...files, 'open-erd.yaml': `${files['open-erd.yaml']}\n${stringify({ health: { ignore: ['missing_fk:shop._.products'] } })}` });
  assert.ok(!healthFindings(ignored).some((f) => f.rule === 'missing_fk' && f.table === 'shop._.products'));
});

test('order: medium first, then table, rule and columns; the same model gives the same list', async () => {
  const multi = await loadMulti();
  const lonely = { id: 'auth.public.audit', domain: 'Identity', columns: [{ name: 'id', type: 'bigint', pk: true }] };
  const shuffled = { ...multi, tables: [lonely, ...[...multi.tables].reverse()], relations: [...multi.relations].reverse(), polymorphic: [...multi.polymorphic].reverse() };
  const findings = healthFindings(shuffled);
  assert.deepEqual(findings, healthFindings({ ...multi, tables: [...multi.tables, lonely] }));
  assert.deepEqual(findings.at(-1).rule, 'orphan_table');
  assert.ok(findings.slice(0, -1).every((f) => f.severity === 'medium'));
  assert.equal(healthSummary(findings), `${findings.length} health findings (${findings.length - 1} medium, 1 low)`);
  assert.equal(healthSummary([]), null);
});

test('a profile keeps only findings whose tables and columns it still shows, message and SQL included', async () => {
  const multi = await loadMulti();
  const config = { ...multi.config, profiles: { partner: { hide: { tables: ['auth.public.users'], columns: ['shop._.products.brand_id'] } } } };
  const full = healthFindings({ ...multi, config });
  const shown = applyProfile({ ...multi, config }, 'partner');
  const kept = healthFor(full, shown);
  // Findings pointing at the hidden users table, or on the hidden column, are gone.
  assert.ok(full.some((f) => f.related?.table === 'auth.public.users'));
  assert.ok(!kept.some((f) => JSON.stringify(f).includes('auth.public.users') || JSON.stringify(f).includes('"users"')));
  assert.ok(!kept.some((f) => (f.columns ?? []).includes('brand_id') && f.table === 'shop._.products'));
  // The rest stays as found on the full model.
  assert.ok(kept.length > 0 && kept.every((f) => full.includes(f)));
  const { layout } = await computeLayout({ ...multi, config });
  const svg = renderSvg(shown, layout, { fitStored: true, health: kept });
  const data = JSON.parse(/<script type="application\/json" id="open-erd-data">([\s\S]*?)<\/script>/.exec(svg)[1]);
  assert.deepEqual(data.health, kept.map(({ related, ...f }) => f));
  assert.doesNotMatch(JSON.stringify(data.health), /brand_id|"users"|auth\.public\.users/);
});

test('viewer data and workbook: a Health list and sheet with findings, none without', async () => {
  const multi = await loadMulti();
  const { layout } = await computeLayout(multi);
  const dataOf = (svg) => JSON.parse(/<script type="application\/json" id="open-erd-data">([\s\S]*?)<\/script>/.exec(svg)[1]);
  assert.equal(dataOf(renderSvg(multi, layout)).health.length, healthFindings(multi).length);
  assert.equal(dataOf(renderSvg(multi, layout, { health: [] })).health, undefined);

  const load = async (health) => {
    const bytes = await serializeWorkbook(buildWorkbook(multi, health ? { health } : {}), { date: new Date('2026-01-02T03:04:05Z') });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    return Object.assign(workbook.getWorksheet('Health') ?? {}, { links: xlsxLinks(bytes) });
  };
  const sheet = await load();
  const row = (n) => sheet.getRow(n).values.slice(1).map((v) => v?.text ?? v);
  assert.deepEqual(row(1), ['Severity', 'Rule', 'Database', 'Table', 'Column(s)', 'Finding', 'Suggestion', 'SQL']);
  assert.deepEqual(row(2).slice(0, 5), ['medium', 'missing_fk', 'auth', 'auth.public.invitations', 'created_by']);
  assert.equal(sheet.links.Health.get('D2').location, "'invitations'!A1");
  assert.equal(sheet.rowCount, healthFindings(multi).length + 1);
  assert.equal((await load([])).name, undefined);
});
