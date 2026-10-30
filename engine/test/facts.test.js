import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compareFacts, describeDelta, readFacts } from '../src/model/facts.js';
import { parseWorkspace } from '../src/model/load.js';
import { readWorkspaceFiles } from '../cli.js';
import { factsFromModel } from './helpers/facts.js';
import { loadMulti, loadWorkspace } from './helpers/shop.js';

const PATTERNS = fileURLToPath(new URL('./fixtures/workspace-patterns', import.meta.url));
const loadPatterns = () => loadWorkspace(PATTERNS);

const compare = (model, files) => compareFacts(model, readFacts(files));
const lines = (deltas) => deltas.map(describeDelta);
// Edits the facts table `name` of the first file listing it.
function editTable(files, name, edit) {
  const copy = structuredClone(files);
  const table = copy.flatMap((f) => f.data.tables).find((t) => t.name === name);
  edit(table, copy);
  return copy;
}
const withTable = (model, id, edit) => ({ ...model, tables: model.tables.map((t) => (t.id === id ? edit(structuredClone(t)) : t)) });

test('a model compares clean against the facts of its own structure', async () => {
  const multi = await loadMulti();
  assert.deepEqual(lines(compare(multi, factsFromModel(multi))), []);
  // Views and framework tables the facts do not list are left alone, with
  // the constraints of those tables; embedded entities are not columns.
  const patterns = await loadPatterns();
  const files = factsFromModel(patterns, { keep: (t) => !t.generated_by && (t.kind ?? 'table') === 'table' });
  assert.deepEqual(lines(compare(patterns, files)), []);
});

test('tables and columns added, removed and changed', async () => {
  const model = await loadMulti();
  let files = factsFromModel(model);
  const [first, second] = files[0].data.tables;
  files = editTable(files, first.name, (t, all) => {
    t.columns[1].type = 'text';
    t.columns[1].nullable = !t.columns[1].nullable;
    t.columns[1].default = 'x';
    t.columns.push({ name: 'added_col', type: 'int', nullable: true });
    t.columns.splice(2, 1);
    all[0].data.tables.push({ name: 'brand_new', schema: first.schema, database: first.database, columns: [{ name: 'id', type: 'bigint', pk: true }] });
    all[0].data.tables = all[0].data.tables.filter((x) => x.name !== second.name);
  });
  const deltas = compare(model, files);
  const idOf = (t) => `${t.database}.${t.schema ?? '_'}.${t.name}`;
  const byPath = (path) => deltas.filter((d) => d.path === path).map((d) => [d.change, d.scope, d.field].filter(Boolean).join(' '));
  assert.deepEqual(byPath(idOf({ ...first, name: 'brand_new' })), ['added table']);
  assert.deepEqual(byPath(idOf(second)), ['removed table']);
  assert.deepEqual(byPath(`${idOf(first)}.${first.columns[1].name}`), ['changed column default', 'changed column nullable', 'changed column type']);
  assert.deepEqual(byPath(`${idOf(first)}.added_col`), ['added column']);
  assert.deepEqual(byPath(`${idOf(first)}.${first.columns[2].name}`), ['removed column']);
  // Added entries carry what applying them needs, in model form.
  const added = deltas.find((d) => d.path === `${idOf(first)}.added_col`);
  assert.deepEqual(added.after, { name: 'added_col', type: 'int', nullable: true });
  assert.deepEqual(added.evidence, [`${files[0].data.source}:schema#${first.name}`]);
  const typeChange = deltas.find((d) => d.field === 'type');
  assert.equal(typeChange.after, 'text');
  assert.equal(typeChange.before, first.columns[1].type);
});

test('indexes: added, removed, renamed', async () => {
  const model = await loadMulti();
  const table = model.tables.find((t) => (t.indexes ?? []).length > 0);
  const name = table.id.split('.')[2];
  const files = editTable(factsFromModel(model), name, (t) => {
    t.indexes[0].name = 'renamed_index';
    t.indexes.push({ columns: [t.columns[0].name, t.columns[1].name], unique: true });
  });
  const removedOnly = withTable(model, table.id, (t) => ({ ...t, indexes: [...t.indexes, { columns: [t.columns[1].name], using: 'gin' }] }));
  const kinds = compare(removedOnly, files).map((d) => `${d.change} ${d.scope}${d.field ? ` ${d.field}` : ''}`).sort();
  assert.deepEqual(kinds, ['added index', 'changed index name', 'removed index']);
});

test('constraint-backed relations: added, kind changed, removed; other associations only decide kind', async () => {
  const model = await loadPatterns();
  const fk = model.relations.find((r) => r.kind === 'db_fk' && r.from.table === 'store.tenant.accounts');
  const declared = model.relations.find((r) => r.kind === 'declared' && r.from.table.startsWith('store.'));
  const path = (r) => `${r.from.table}.${r.from.columns.join(', ')} -> ${r.to.table}.${r.to.columns.join(', ')}`;
  const files = factsFromModel(model, { keep: (t) => !t.generated_by && (t.kind ?? 'table') === 'table' });
  const assoc = (f, r) => f.data.associations.find((a) => a.from.table === r.from.table.split('.')[2] && a.from.columns.join() === r.from.columns.join());
  // The constraint is gone but the association stays: declared now.
  const dropped = structuredClone(files);
  dropped.forEach((f) => { const a = assoc(f, fk); if (a) a.constraint = false; });
  assert.deepEqual(compare(model, dropped).map((d) => [d.change, d.path, d.before, d.after]), [['changed', path(fk), 'db_fk', 'declared']]);
  // Gone from the code: removed.
  const gone = structuredClone(files);
  gone.forEach((f) => { f.data.associations = f.data.associations.filter((a) => a !== assoc(f, fk)); });
  assert.deepEqual(compare(model, gone).map((d) => [d.change, d.path]), [['removed', path(fk)]]);
  // A declared relation that now has a constraint.
  const constrained = structuredClone(files);
  constrained.forEach((f) => { const a = assoc(f, declared); if (a) a.constraint = true; });
  assert.deepEqual(compare(model, constrained).map((d) => [d.change, d.field, d.before, d.after]), [['changed', 'kind', 'declared', 'db_fk']]);
  // A wrong target in the model: the facts' relation is added, the model's removed.
  const wrong = { ...model, relations: model.relations.map((r) => (r === fk ? { ...r, to: { ...r.to, table: r.from.table } } : r)) };
  const deltas = compare(wrong, files);
  assert.deepEqual(deltas.map((d) => d.change).sort(), ['added', 'removed']);
  assert.deepEqual(deltas.find((d) => d.change === 'added').after.to, fk.to);
});

test('schema null maps to the one model table of that name; ambiguity is reported', async () => {
  const model = await loadPatterns();
  const files = factsFromModel(model, { keep: (t) => !t.generated_by && (t.kind ?? 'table') === 'table' });
  for (const t of files.flatMap((f) => f.data.tables)) t.schema = null;
  assert.deepEqual(lines(compare(model, files)), []);
  // Same name in two schemas of one database.
  const twin = withTable(model, 'store.public.tags', (t) => t);
  twin.tables = [...twin.tables, { ...model.tables.find((t) => t.id === 'store.public.tags'), id: 'store.tenant.tags' }];
  const deltas = compare(twin, files);
  assert.equal(deltas[0].change, 'error');
  assert.match(describeDelta(deltas[0]), /matches several model tables \(store\.public\.tags, store\.tenant\.tags\)/);
  // The ambiguous name does not make either table look removed.
  assert.deepEqual(deltas.filter((d) => d.change === 'removed'), []);
  // A new table goes in the schema its database's tables share.
  const docs = factsFromModel(model).filter((f) => f.data.source === 'app-docs');
  docs[0].data.tables.push({ name: 'notes', schema: null, database: 'docs', columns: [{ name: '_id', type: 'ObjectId', pk: true }] });
  assert.ok(compare(model, docs).some((d) => d.change === 'added' && d.path === 'docs._.notes'));
});

test('not_in_model silences a facts table and is rejected for a modelled one', async () => {
  const model = await loadMulti();
  const files = factsFromModel(model);
  const schema = model.tables[0].id.split('.')[1];
  files[0].data.tables.push({ name: 'schema_migrations', schema: schema === '_' ? null : schema, database: files[0].data.tables[0].database, columns: [{ name: 'version', type: 'string' }] });
  const extra = `${files[0].data.tables[0].database}.${schema}.schema_migrations`;
  assert.deepEqual(compare(model, files).map((d) => d.path), [extra]);
  const quiet = { ...model, config: { ...model.config, not_in_model: [extra] } };
  assert.deepEqual(compare(quiet, files), []);

  const ws = await readWorkspaceFiles(fileURLToPath(new URL('./fixtures/workspace-multi', import.meta.url)));
  ws['open-erd.yaml'] += `not_in_model: [${model.tables[0].id}]\n`;
  const { errors } = parseWorkspace(ws);
  assert.deepEqual(errors.map((e) => e.path), ['not_in_model[0]']);
});

test('facts under a renamed table name follow renamed_from', async () => {
  const model = await loadMulti();
  const t = model.tables.find((x) => x.id.split('.')[1] !== '_');
  const [db, schema, name] = t.id.split('.');
  const renamed = withTable(model, t.id, (x) => ({ ...x, renamed_from: `${db}.${schema}.old_${name}` }));
  const files = editTable(factsFromModel(model), name, (x) => { x.name = `old_${name}`; });
  for (const f of files) for (const a of f.data.associations) for (const end of [a.from, a.to]) if (end.table === name) end.table = `old_${name}`;
  assert.deepEqual(lines(compare(renamed, files)), []);
});

test('a field is compared only when the facts file reports it; pk uniqueness is ignored', async () => {
  const model = await loadMulti();
  const files = factsFromModel(model);
  for (const f of files) for (const t of f.data.tables) for (const c of t.columns) { delete c.default; delete c.auto_increment; if (c.pk) c.unique = !c.unique; }
  for (const f of files) for (const t of f.data.tables) delete t.indexes;
  assert.deepEqual(lines(compare(model, files)), []);
});

test('the result is the same whatever the order of the facts', async () => {
  const model = await loadMulti();
  const files = editTable(factsFromModel(model), model.tables[0].id.split('.')[2], (t) => { t.columns.reverse(); t.columns[0].type = 'changed'; t.columns.push({ name: 'z', type: 'int' }); });
  const shuffled = structuredClone(files).reverse();
  for (const f of shuffled) { f.data.tables.reverse(); f.data.associations.reverse(); }
  const a = compare(model, files);
  assert.ok(a.length > 0);
  assert.deepEqual(compare(model, shuffled), a);
});

test('readFacts accepts evidence as a string or a list and reports a malformed table', () => {
  const facts = readFacts([
    { file: 'a.json', data: { source: 'api', database: 'db', tables: [{ name: 't', schema: null, evidence: ['x.rb#T', 'y.rb#T'], columns: [{ name: 'id', type: 'int' }] }], associations: [] } },
    { file: 'b.json', data: { tables: [{ name: 'u' }] } },
    { file: 'c.json', data: { nope: true } },
  ]);
  assert.deepEqual(facts.tables[0].evidence, ['api:x.rb#T', 'api:y.rb#T']);
  assert.equal(facts.tables[0].database, 'db');
  assert.deepEqual(facts.errors.map((e) => `${e.file}: ${e.path}`), ['b.json: tables[0]', 'c.json: tables']);
});

test('a stale fact and the tables and columns it uses are not reported', async () => {
  const model = await loadPatterns();
  const fk = model.relations.find((r) => r.kind === 'db_fk' && r.from.table === 'store.tenant.accounts');
  const files = factsFromModel(model, { keep: (t) => !t.generated_by && (t.kind ?? 'table') === 'table' && t.id !== fk.to.table });
  for (const f of files) f.data.associations = f.data.associations.filter((a) => !(a.from.table === 'accounts' && a.from.columns[0] === fk.from.columns[0]));
  // The relation to a table the facts lost is covered by that table's delta.
  assert.deepEqual(compare(model, files).map((d) => `${d.change} ${d.path}`), [`removed ${fk.to.table}`]);
  const stale = { ...model, relations: model.relations.map((r) => (r === fk ? { ...r, review: 'stale' } : r)) };
  assert.deepEqual(compare(stale, files), []);
  // Both tables still there, the constraint gone from the code.
  const kept = factsFromModel(model, { keep: (t) => !t.generated_by && (t.kind ?? 'table') === 'table' });
  for (const f of kept) f.data.associations = f.data.associations.filter((a) => !(a.from.table === 'accounts' && a.from.columns[0] === fk.from.columns[0]));
  assert.equal(compare(model, kept).length, 1);
  assert.deepEqual(compare(stale, kept), []);
});

test('a relation on an association end that matches several tables is not reported removed', async () => {
  const model = await loadPatterns();
  const base = model.tables.find((t) => t.id === 'store.public.tags');
  const twin = { ...model, tables: [...model.tables, { ...base, id: 'store.tenant.tags' }] };
  twin.relations = [...model.relations, { from: { table: 'store.public.products', columns: ['id'] }, to: { table: 'store.tenant.tags', columns: ['id'] }, cardinality: 'n-1', optional: false, kind: 'db_fk', evidence: [], review: 'reviewed' }];
  // Both tables are listed with their schema; an association names only the table, so `tags` is ambiguous.
  const files = factsFromModel(twin, { keep: (t) => !t.generated_by && (t.kind ?? 'table') === 'table' });
  const removed = compare(twin, files).filter((d) => d.change === 'removed');
  assert.deepEqual(removed.map((d) => d.path), []);
});

test('a renamed_from naming a live table does not make the facts follow it', async () => {
  const model = await loadMulti();
  const [a, b] = model.tables.filter((x) => x.id.split('.')[1] !== '_');
  const stale = withTable(model, a.id, (x) => ({ ...x, renamed_from: b.id }));
  const removed = compare(stale, factsFromModel(model)).filter((d) => d.change === 'removed' && d.scope === 'table');
  assert.deepEqual(removed, []);
});
