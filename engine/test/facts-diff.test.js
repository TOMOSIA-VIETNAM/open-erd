import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { describeFactsChange, diffFacts, factsDiffSummary } from '../src/model/facts-diff.js';
import { git, runCli } from './helpers/git-workspace.js';

// One facts file in the shape model.md documents.
const facts = () => ({
  source: 'billing-api',
  database: 'billing',
  stack: ['rails'],
  tables: [
    {
      name: 'invoices',
      schema: null,
      database: 'billing',
      evidence: ['db/schema.rb#invoices'],
      columns: [
        { name: 'id', type: 'bigint', pk: true, nullable: false, unique: false, auto_increment: true },
        { name: 'status', type: 'string', nullable: false, unique: false, default: 'draft' },
        { name: 'payer_id', type: 'bigint', nullable: true, unique: false },
      ],
      indexes: [{ name: 'index_invoices_on_status', columns: ['status'], unique: false }],
    },
    {
      name: 'parties',
      schema: null,
      database: 'billing',
      evidence: ['db/schema.rb#parties'],
      columns: [{ name: 'id', type: 'bigint', pk: true, nullable: false, unique: false, auto_increment: true }],
      indexes: [],
    },
  ],
  associations: [
    { from: { database: 'billing', table: 'invoices', columns: ['payer_id'] }, to: { database: 'billing', table: 'parties', columns: ['id'] }, constraint: false, evidence: ['app/models/invoice.rb#Invoice'] },
  ],
  polymorphic: [{ table: 'invoices', name: 'attachable', type_column: 'attachable_type', id_column: 'attachable_id', targets: ['parties'], evidence: ['app/models/invoice.rb#Invoice'] }],
  enums: [{ table: 'invoices', column: 'status', values: { draft: 'draft', paid: 'paid' }, evidence: 'app/models/invoice.rb#Invoice' }],
  hints: [{ table: 'invoices', column: 'payer_id', text: 'set in BillingJob#perform', evidence: 'app/jobs/billing_job.rb#perform' }],
});

const one = (data) => [{ file: 'billing-api.json', data }];
const lines = (from, to) => {
  const { changes, errors } = diffFacts(from, to);
  assert.deepEqual(errors, []);
  return changes.map(describeFactsChange);
};
const edited = (edit) => {
  const data = facts();
  edit(data);
  return data;
};

test('identical facts give no changes', () => {
  assert.deepEqual(lines(one(facts()), one(facts())), []);
  assert.equal(factsDiffSummary([]), 'no changes');
});

test('the older facts shapes read the same as the documented one', () => {
  // `unique: [[...]]` on the table, evidence as a string, `database` only on
  // the file: the same structure as `indexes`, a list and per-table database.
  const older = edited((d) => {
    for (const t of d.tables) {
      delete t.database;
      t.evidence = t.evidence[0];
    }
    d.tables[1].unique = [['id']];
    d.associations[0].evidence = d.associations[0].evidence[0];
    delete d.associations[0].from.database;
    delete d.associations[0].to.database;
  });
  const newer = edited((d) => {
    d.tables[1].indexes = [{ columns: ['id'], unique: true }];
  });
  assert.deepEqual(lines(one(older), one(newer)), []);
  assert.deepEqual(lines(one(newer), one(older)), []);
});

test('tables, columns and indexes added, removed and changed', () => {
  const after = edited((d) => {
    const [invoices] = d.tables;
    invoices.columns[1].type = 'text';
    invoices.columns[1].nullable = true;
    delete invoices.columns[1].default;
    invoices.columns[2].unique = true;
    invoices.columns.push({ name: 'total', type: 'numeric', nullable: false, generated: 'subtotal + tax' });
    invoices.columns[0].auto_increment = false;
    invoices.indexes[0].name = 'invoices_status_idx';
    invoices.indexes.push({ columns: ['payer_id', 'status'], unique: true, where: 'payer_id IS NOT NULL' });
    d.tables[1] = { name: 'payments', schema: null, evidence: 'db/schema.rb#payments', columns: [{ name: 'id', type: 'uuid', pk: true }], indexes: [{ columns: ['id'] }] };
    d.associations = [];
  });
  assert.deepEqual(lines(one(facts()), one(after)), [
    'removed table billing.parties (1 column(s))',
    'added table billing.payments (1 column(s), 1 index(es))',
    'changed column billing.invoices.id: auto_increment true → false',
    'changed column billing.invoices.payer_id: unique false → true',
    'changed column billing.invoices.status: default "draft" → (none)',
    'changed column billing.invoices.status: nullable false → true',
    'changed column billing.invoices.status: type "string" → "text"',
    'added column billing.invoices.total (numeric)',
    'added index billing.invoices index (payer_id, status) unique where payer_id IS NOT NULL',
    'changed index billing.invoices index (status): name "index_invoices_on_status" → "invoices_status_idx"',
    'removed association billing.invoices.payer_id -> billing.parties.id',
  ]);
  // A generated column changing its expression.
  const generated = (expr) => edited((d) => d.tables[0].columns.push({ name: 'total', type: 'numeric', generated: expr }));
  assert.deepEqual(lines(one(generated('a + b')), one(generated('a + b + c'))), ['changed column billing.invoices.total: generated "a + b" → "a + b + c"']);
});

test('associations, polymorphic associations, enums, hints and other keys', () => {
  const after = edited((d) => {
    d.associations[0].constraint = true;
    // A second entry for the same association (another macro) adds evidence.
    d.associations.push({ ...structuredClone(d.associations[0]), constraint: false, evidence: ['app/models/party.rb#Party'] });
    d.associations.push({ from: { table: 'parties', columns: ['id'] }, to: { table: 'invoices', columns: ['payer_id'] }, evidence: [] });
    d.polymorphic[0].targets = ['invoices', 'parties'];
    d.polymorphic.push({ table: 'parties', name: 'owner', type_column: 'owner_type', id_column: 'owner_id', targets: [], evidence: [] });
    d.enums[0].values = { draft: 'draft', void: 'void' };
    d.hints = [{ table: 'invoices', column: 'payer_id', text: 'set in SettlementJob#perform', evidence: 'app/jobs/settlement_job.rb#perform' }];
    d.sti = [{ table: 'parties', subclasses: ['Person'] }];
    d.stack = ['rails', 'mongoid'];
  });
  assert.deepEqual(lines(one(facts()), one(after)), [
    'changed association billing.invoices.payer_id -> billing.parties.id: constraint false → true',
    'changed association billing.invoices.payer_id -> billing.parties.id: evidence ["billing-api:app/models/invoice.rb#Invoice"] → ["billing-api:app/models/invoice.rb#Invoice","billing-api:app/models/party.rb#Party"]',
    'added association billing.parties.id -> billing.invoices.payer_id',
    'changed polymorphic billing.invoices attachable: targets ["parties"] → ["invoices","parties"]',
    'added polymorphic billing.parties owner',
    'changed enum billing.invoices.status: values.paid "paid" → (none)',
    'changed enum billing.invoices.status: values.void (none) → "void"',
    'removed hint billing.invoices.payer_id: set in BillingJob#perform',
    'added hint billing.invoices.payer_id: set in SettlementJob#perform',
    'changed billing-api.json: stack (not compared field by field; see the file)',
    'added billing-api.json: sti',
  ]);
});

test('a facts file added or removed lists its file and tables, not their columns', () => {
  const second = { file: 'shop-api.json', data: { source: 'shop-api', database: 'shop', tables: [{ name: 'orders', columns: [{ name: 'id', type: 'bigint', pk: true }] }] } };
  const added = lines(one(facts()), [...one(facts()), second]);
  assert.deepEqual(added, ['added file shop-api.json', 'added table shop.orders (1 column(s))']);
  assert.deepEqual(lines([...one(facts()), second], one(facts())), ['removed file shop-api.json', 'removed table shop.orders (1 column(s))']);
  // The first run: nothing committed yet.
  assert.equal(diffFacts([], one(facts())).changes.filter((c) => c.scope === 'column').length, 0);
});

test('the result does not depend on the order of files, tables or entries', () => {
  const second = { file: 'shop-api.json', data: { source: 'shop-api', database: 'shop', tables: [{ name: 'orders', columns: [{ name: 'id', type: 'bigint' }] }] } };
  const after = edited((d) => {
    d.tables[0].columns[1].type = 'text';
    d.enums[0].values.void = 'void';
    d.hints = [];
  });
  const reversed = edited((d) => {
    d.tables[0].columns[1].type = 'text';
    d.enums[0].values = { void: 'void', paid: 'paid', draft: 'draft' };
    d.hints = [];
    d.tables.reverse();
    d.tables.forEach((t) => t.columns.reverse());
    d.tables.forEach((t) => t.indexes.reverse());
  });
  const a = diffFacts(one(facts()), [...one(after), second]);
  const b = diffFacts(one(facts()), [second, ...one(reversed)]);
  assert.deepEqual(a, b);
  assert.deepEqual(diffFacts(one(facts()), [...one(after), second]), a);
});

test('entries the diff cannot place are errors, with the side they come from', () => {
  const bad = edited((d) => d.enums.push({ column: 'x' }));
  assert.deepEqual(
    diffFacts(one(bad), one(facts())).errors.map((e) => `${e.side} ${e.path}`),
    ['from enums[1]'],
  );
  assert.deepEqual(diffFacts(one(facts()), one({ tables: 'x' })).errors.map((e) => `${e.side} ${e.path}`), ['to tables']);
});

test('facts-diff compares a git ref with the facts files on disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'open-erd-facts-diff-'));
  try {
    await git(dir, 'init', '-q');
    await writeFile(join(dir, 'README'), 'workspace\n');
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-q', '-m', 'no facts yet');
    await mkdir(join(dir, 'extract', 'facts'), { recursive: true });
    const file = join(dir, 'extract', 'facts', 'billing-api.json');
    await writeFile(file, JSON.stringify(facts()));

    // Nothing committed under extract/facts at HEAD: everything is new.
    const first = await runCli('facts-diff', '--workspace', dir);
    assert.match(first.stdout, /^extract\/facts: HEAD → working copy: 8 added, 0 removed, 0 changed$/m);
    assert.match(first.stdout, /^  added file billing-api\.json$/m);

    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-q', '-m', 'facts');
    assert.match((await runCli('facts-diff', '--workspace', dir)).stdout, /HEAD → working copy: no changes/);

    await writeFile(file, JSON.stringify(edited((d) => (d.tables[0].columns[1].type = 'text'))));
    const text = await runCli('facts-diff', '--workspace', dir, '--from', 'HEAD');
    assert.equal(text.stdout, 'extract/facts: HEAD → working copy: 0 added, 0 removed, 1 changed\n  changed column billing.invoices.status: type "string" → "text"\n');
    const json = JSON.parse((await runCli('facts-diff', '--workspace', dir, '--format', 'json')).stdout);
    assert.deepEqual(json, { from: 'HEAD', to: 'working copy', changes: [{ change: 'changed', scope: 'column', path: 'billing.invoices.status', field: 'type', before: 'string', after: 'text' }] });

    // HEAD~1 had no facts file: the file and its tables are added.
    assert.match((await runCli('facts-diff', '--workspace', dir, '--from', 'HEAD~1')).stdout, /^  added table billing\.invoices \(3 column\(s\), 1 index\(es\)\)$/m);

    await assert.rejects(runCli('facts-diff', '--workspace', dir, '--format', 'markdown'), (e) => e.code === 1 && /--format must be one of text, json/.test(e.stderr));
    await assert.rejects(runCli('facts-diff', '--workspace', dir, '--from', 'no-such-ref'), (e) => e.code === 1 && /cannot read extract\/facts at "no-such-ref"/.test(e.stderr));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
