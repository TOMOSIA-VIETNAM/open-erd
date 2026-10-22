import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readWorkspaceFiles } from '../cli.js';
import { formatError, normalizeModel, parseWorkspace } from '../src/model/load.js';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const CONFIG = 'schema_version: 1\n';
const modelFile = (body) => `schema_version: 1\ndatabase: shop\nengine: mysql\n${body}`;
const ORDERS = `
  - id: shop._.orders
    domain: Sales
    columns:
      - { name: id, type: bigint, pk: true }
      - { name: cart_id, type: bigint }
  - id: shop._.carts
    domain: Sales
    columns:
      - { name: id, type: bigint, pk: true }
`;

function messages(files) {
  return parseWorkspace(files).errors.map(formatError);
}

test('valid fixture loads and normalizes deterministically', async () => {
  const { model, errors } = parseWorkspace(await readWorkspaceFiles(fixture('workspace-valid')));
  assert.deepEqual(errors, []);
  assert.deepEqual(model.databases.map((d) => d.database), ['auth', 'billing']);
  assert.deepEqual(model.tables.map((t) => t.id), ['auth._.users', 'billing.public.invoices', 'billing.public.payments']);
  assert.deepEqual(
    model.relations.map((r) => `${r.from.table}->${r.to.table}`),
    ['billing.public.invoices->auth._.users', 'billing.public.payments->billing.public.invoices'],
  );
  assert.deepEqual(model.relations[0].evidence, [
    'billing-api:src/models/invoice.ts#Invoice',
    'billing-api:src/services/user-client.ts#fetchUser',
  ]);
  assert.deepEqual(model.config.hub.columns, ['created_by', 'tenant_id']);
  assert.deepEqual(model.config.sources.map((s) => s.name), ['auth-service', 'billing-api']);
  // Authored column and enum order is preserved.
  const invoices = model.tables[1];
  assert.deepEqual(invoices.columns.map((c) => c.name), ['id', 'user_id', 'status']);
  assert.deepEqual(Object.keys(invoices.columns[2].enum), ['draft', 'paid']);
});

test('normalize is order independent', async () => {
  const { model } = parseWorkspace(await readWorkspaceFiles(fixture('workspace-valid')));
  const shuffled = {
    ...model,
    databases: [...model.databases].reverse(),
    tables: [...model.tables].reverse(),
    relations: model.relations.map((r) => ({ ...r, evidence: [...r.evidence].reverse() })).reverse(),
  };
  assert.equal(JSON.stringify(normalizeModel(shuffled)), JSON.stringify(model));
});

test('invalid fixture reports every error with file and YAML path', async () => {
  const errors = parseWorkspace(await readWorkspaceFiles(fixture('workspace-invalid'))).errors.map(formatError);
  assert.deepEqual(errors, [
    'model/shop.yaml: schema_version: is required',
    'model/shop.yaml: tables[0].id: invalid value "shop.orders", expected <db>.<schema>.<table>, use _ as schema for schemaless engines, no dots inside a segment',
    'model/shop.yaml: tables[1].id: invalid value "shop._.line.items", expected <db>.<schema>.<table>, use _ as schema for schemaless engines, no dots inside a segment',
    'model/shop.yaml: tables[2].columns[1].enum: must be mapping, got array',
    'model/shop.yaml: relations[0].cardinality: must be one of 1-1 | 1-n | n-1 | n-n, got "many-to-one"',
    'model/shop.yaml: relations[0].review: must be one of pending | reviewed | stale, got "maybe"',
    // Cross-file checks run after every file is parsed.
    'open-erd.yaml: hub.tables[0]: unknown table "auth._.ghosts"',
  ]);
});

test('missing config and unsupported schema_version are errors', () => {
  assert.deepEqual(messages({}), ['open-erd.yaml: (root): file not found']);
  assert.deepEqual(messages({ 'open-erd.yaml': 'schema_version: 2\n' }), [
    'open-erd.yaml: schema_version: must be one of 1, got 2',
  ]);
});

test('relations must reference known tables and columns', () => {
  const relation = (from, to, fromCols = '[cart_id]', toCols = '[id]') => `
  - from: { table: ${from}, columns: ${fromCols} }
    to: { table: ${to}, columns: ${toCols} }
    cardinality: n-1
    optional: true
    kind: inferred
    evidence: ["shop-api:app/models/order.rb#Order"]
    review: pending
`;
  const files = {
    'open-erd.yaml': CONFIG,
    'model/shop.yaml': modelFile(
      `tables:${ORDERS}relations:` +
        relation('shop._.orders', 'shop._.ghosts') +
        relation('shop._.orders', 'shop._.carts', '[cart_ref]') +
        relation('shop._.orders', 'shop._.carts', '[id, cart_id]'),
    ),
  };
  assert.deepEqual(messages(files), [
    'model/shop.yaml: relations[0].to.table: unknown table "shop._.ghosts"',
    'model/shop.yaml: relations[1].from.columns[0]: unknown column "cart_ref" in shop._.orders',
    'model/shop.yaml: relations[2].to.columns: must have the same number of columns as from.columns',
  ]);
});

test('cross-db relations to unknown tables are errors', () => {
  const files = {
    'open-erd.yaml': CONFIG,
    'model/shop.yaml': modelFile(`tables:${ORDERS}`),
    'model/cross-db.yaml': `schema_version: 1
relations:
  - from: { table: shop._.orders, columns: [cart_id] }
    to: { table: auth._.users, columns: [id] }
    cardinality: n-1
    optional: true
    kind: cross_db
    evidence: [db]
    review: pending
`,
  };
  assert.deepEqual(messages(files), ['model/cross-db.yaml: relations[0].to.table: unknown table "auth._.users"']);
});

test('table ids must match the database, be unique, and columns unique', () => {
  const files = {
    'open-erd.yaml': CONFIG,
    'model/shop.yaml': modelFile(`tables:${ORDERS}
  - id: shop._.carts
    domain: Sales
    columns:
      - { name: id, type: bigint }
      - { name: id, type: bigint }
  - id: other._.carts
    domain: Sales
    columns:
      - { name: id, type: bigint }
`),
  };
  assert.deepEqual(messages(files), [
    'model/shop.yaml: tables[2].id: duplicate table id "shop._.carts"',
    'model/shop.yaml: tables[2].columns[1].name: duplicate column "id"',
    'model/shop.yaml: tables[3].id: table id must start with "shop.", got "other._.carts"',
  ]);
});

test('unknown fields, wrong types, bad evidence and YAML syntax are reported', () => {
  const files = {
    'open-erd.yaml': 'schema_version: 1\nlayout_engine: dot\n',
    'model/shop.yaml': modelFile(`tables:
  - id: shop._.orders
    domain: Sales
    columns:
      - { name: id, type: bigint, pk: "yes", colour: red }
      - name: state
        type: int
        enum: { 0: Open, 1: }
relations:
  - from: { table: shop._.orders, columns: [id] }
    to: { table: shop._.orders, columns: [id] }
    cardinality: 1-1
    optional: false
    kind: declared
    evidence: ["just a guess"]
    review: pending
`),
    'model/broken.yaml': 'tables: [\n',
  };
  const [config, broken, ...shop] = messages(files);
  assert.equal(config, 'open-erd.yaml: layout_engine: unknown field');
  assert.match(broken, /^model\/broken\.yaml: line 2: /);
  assert.deepEqual(shop, [
    'model/shop.yaml: tables[0].columns[0].pk: must be boolean, got string',
    'model/shop.yaml: tables[0].columns[0].colour: unknown field',
    'model/shop.yaml: tables[0].columns[1].enum["1"]: must be string, got null',
    'model/shop.yaml: relations[0].evidence[0]: invalid value "just a guess", expected db or <repo>:<path>[#<symbol>]',
  ]);
});

test('polymorphic associations must reference known tables and columns', () => {
  const association = (name, type, id, targets) => `
  - name: ${name}
    table: shop._.orders
    type_column: ${type}
    id_column: ${id}
    optional: true
    targets: ${targets}
    evidence: ["shop-api:app/models/order.rb#Order"]
    review: pending
`;
  const files = {
    'open-erd.yaml': `${CONFIG}collapse_join_tables: true\n`,
    'model/shop.yaml': modelFile(
      `tables:${ORDERS}polymorphic:` +
        association('source', 'cart_id', 'id', '[shop._.carts]') +
        association('source', 'kind', 'cart_id', '[shop._.carts, shop._.ghosts, shop._.carts]'),
    ),
  };
  assert.deepEqual(messages(files), [
    'model/shop.yaml: polymorphic[1].type_column: unknown column "kind" in shop._.orders',
    'model/shop.yaml: polymorphic[1].name: duplicate association "source" on shop._.orders',
    'model/shop.yaml: polymorphic[1].targets[1]: unknown table "shop._.ghosts"',
    'model/shop.yaml: polymorphic[1].targets[2]: duplicate target "shop._.carts"',
  ]);
});

test('a relation of kind polymorphic is rejected: associations have their own list', () => {
  const files = {
    'open-erd.yaml': CONFIG,
    'model/shop.yaml': modelFile(`tables:${ORDERS}relations:
  - from: { table: shop._.orders, columns: [cart_id] }
    to: { table: shop._.carts, columns: [id] }
    cardinality: n-1
    optional: true
    kind: polymorphic
    evidence: [db]
    review: pending
`),
  };
  assert.deepEqual(messages(files), [
    'model/shop.yaml: relations[0].kind: must be one of db_fk | declared | inferred | cross_db, got "polymorphic"',
  ]);
});

test('special pattern fields must reference known columns and tables', () => {
  const messages = (model) => parseWorkspace({ 'open-erd.yaml': 'schema_version: 1\n', 'model/a.yaml': `schema_version: 1\ndatabase: a\nengine: postgresql\n${model}` }).errors.map((e) => `${e.path}: ${e.message}`);
  const t = (id, extra = '') => `  - id: ${id}\n    domain: D\n${extra}    columns: [{ name: id, type: int }, { name: kind, type: text }]\n`;
  assert.deepEqual(messages(`tables:\n${t('a.tenant.t')}tenant_schemas: [{ schema: tenant, count: 0 }]\n`), [
    'tenant_schemas[0].count: must be at least 1, got 0',
  ]);
  assert.deepEqual(
    messages(
      'tables:\n' +
        t('a.public.t', '    sti: { column: type, subclasses: [A] }\n    partition: { method: range, columns: [at] }\n    unique: [[id, nope]]\n') +
        t('a.public.v', '    kind: view\n    sources: [a.public.v, a.public.ghost]\n') +
        t('a.public.w', '    sources: [a.public.t]\n') +
        t('a.public.e', '    embedded:\n      - { name: kind, columns: [{ name: x, type: int }, { name: x, type: int }] }\n') +
        'tenant_schemas: [{ schema: tenant }]\n',
    ),
    [
      'tables[3].embedded[0].name: "kind" is already a column or embedded entity',
      'tables[3].embedded[0].columns[1].name: duplicate column "x"',
      'tables[0].sti.column: unknown column "type" in a.public.t',
      'tables[0].partition.columns[0]: unknown column "at" in a.public.t',
      'tables[0].unique[0][1]: unknown column "nope" in a.public.t',
      'tables[1].sources[0]: a view cannot read from itself',
      'tables[1].sources[1]: unknown table "a.public.ghost"',
      'tables[2].sources: only a view or materialized_view has sources',
      'tenant_schemas[0].schema: no table of a is in schema "tenant"',
    ],
  );
});

test('relations address embedded columns as <entity>.<column>', () => {
  const files = {
    'open-erd.yaml': 'schema_version: 1\n',
    'model/d.yaml': `schema_version: 1
database: d
engine: mongodb
tables:
  - { id: d._.users, domain: D, columns: [{ name: _id, type: ObjectId, pk: true }] }
  - id: d._.orders
    domain: D
    columns: [{ name: _id, type: ObjectId, pk: true }]
    embedded: [{ name: items, array: true, columns: [{ name: buyer, type: ObjectId }] }]
relations:
  - { from: { table: d._.orders, columns: [items.buyer] }, to: { table: d._.users, columns: [_id] }, cardinality: n-1, optional: true, kind: declared, evidence: ["api:src/order.js#Order"], review: pending }
  - { from: { table: d._.orders, columns: [items.seller] }, to: { table: d._.users, columns: [_id] }, cardinality: n-1, optional: true, kind: declared, evidence: ["api:src/order.js#Order"], review: pending }
`,
  };
  assert.deepEqual(parseWorkspace(files).errors.map((e) => `${e.path}: ${e.message}`), ['relations[1].from.columns[0]: unknown column "items.seller" in d._.orders']);
});

test('columns carry default, auto_increment and generated, typed', () => {
  const body = (columns) => modelFile(`tables:\n  - id: shop._.orders\n    domain: Sales\n    columns:\n${columns}`);
  const ok = body(
    [
      '      - { name: id, type: bigint, pk: true, auto_increment: true }',
      '      - { name: status, type: varchar, default: pending }',
      '      - { name: total, type: numeric, generated: "price * qty" }',
    ].join('\n'),
  );
  assert.deepEqual(messages({ 'open-erd.yaml': CONFIG, 'model/shop.yaml': ok }), []);
  const bad = body(
    [
      '      - { name: id, type: bigint, auto_increment: "yes" }',
      '      - { name: qty, type: int, default: 0 }',
      '      - { name: total, type: numeric, generated: true, defaults: "0" }',
    ].join('\n'),
  );
  assert.deepEqual(messages({ 'open-erd.yaml': CONFIG, 'model/shop.yaml': bad }), [
    'model/shop.yaml: tables[0].columns[0].auto_increment: must be boolean, got string',
    'model/shop.yaml: tables[0].columns[1].default: must be string, got number',
    'model/shop.yaml: tables[0].columns[2].generated: must be string, got boolean',
    'model/shop.yaml: tables[0].columns[2].defaults: unknown field',
  ]);
});
