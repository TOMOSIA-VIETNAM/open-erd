import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { checkLocked, lockFacts, parseLocked, serializeLocked } from '../src/model/lock.js';
import { loadMulti } from './helpers/shop.js';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
const MULTI = fileURLToPath(new URL('./fixtures/workspace-multi', import.meta.url));

// workspace-multi has reviewed relations and a reviewed polymorphic
// association (shop._.comments «commentable»).
const COMMENTABLE = (a) => a.table === 'shop._.comments' && a.name === 'commentable';

async function lockedModel() {
  const model = await loadMulti();
  const reviewed = model.relations.find((r) => r.review === 'reviewed');
  const describe = `relation ${reviewed.from.table}.${reviewed.from.columns.join(', ')} → ${reviewed.to.table}.${reviewed.to.columns.join(', ')}`;
  return { model, locked: lockFacts(model), reviewed, describe };
}

const withRelation = (model, target, change) => ({
  ...model,
  relations: change === null ? model.relations.filter((r) => r !== target) : model.relations.map((r) => (r === target ? { ...r, ...change } : r)),
});
const messages = (model, locked) => checkLocked(model, locked).map((e) => `${e.path}: ${e.message}`);

test('a regenerated lock passes and survives a write/read round trip', async () => {
  const { model, locked } = await lockedModel();
  assert.equal(locked.relations.length, model.relations.filter((r) => r.review === 'reviewed').length);
  assert.equal(locked.polymorphic.length, model.polymorphic.filter((a) => a.review === 'reviewed').length);
  assert.ok(locked.relations.length > 0 && locked.polymorphic.length > 0);
  const { locked: reread, errors } = parseLocked(serializeLocked(locked));
  assert.deepEqual(errors, []);
  assert.deepEqual(reread, locked);
  assert.deepEqual(checkLocked(model, reread), []);
  assert.equal(serializeLocked(lockFacts(await loadMulti())), serializeLocked(locked));
});

test('a missing locked fact fails, naming the fact', async () => {
  const { model, locked, reviewed, describe } = await lockedModel();
  const errors = messages(withRelation(model, reviewed, null), locked);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].startsWith('relations['), errors[0]);
  assert.ok(errors[0].includes(`${describe} was reviewed and is missing from the model`), errors[0]);
  const noPoly = { ...model, polymorphic: model.polymorphic.filter((a) => !COMMENTABLE(a)) };
  assert.match(messages(noPoly, locked)[0], /^polymorphic\[0\]: polymorphic shop\._\.comments «commentable» was reviewed and is missing/);
});

test('a changed locked fact fails, listing each change', async () => {
  const { model, locked, reviewed, describe } = await lockedModel();
  const optional = !reviewed.optional;
  const errors = messages(withRelation(model, reviewed, { cardinality: '1-1', optional }), locked);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes(`${describe} was reviewed and is changed: cardinality n-1 → 1-1; optional ${!optional} → ${optional}`), errors[0]);
  // Demoting to pending is a change too: nobody confirmed it.
  assert.match(messages(withRelation(model, reviewed, { review: 'pending' }), locked)[0], /changed: review reviewed → pending/);
  const fewerTargets = { ...model, polymorphic: model.polymorphic.map((a) => (COMMENTABLE(a) ? { ...a, targets: a.targets.slice(1) } : a)) };
  assert.match(messages(fewerTargets, locked)[0], /changed: targets shop\._\.orders, shop\._\.posts, shop\._\.products → shop\._\.posts, shop\._\.products/);
});

test('a stale fact passes, and a regenerated lock keeps protecting it', async () => {
  const { model, locked, reviewed } = await lockedModel();
  const stale = withRelation(model, reviewed, { cardinality: '1-1', review: 'stale' });
  assert.deepEqual(checkLocked(stale, locked), []);
  const relocked = lockFacts(stale, locked);
  assert.equal(relocked.relations.length, locked.relations.length);
  assert.deepEqual(checkLocked(stale, relocked), []);
  // Deleting the stale fact still needs the user: the entry is still there.
  assert.equal(checkLocked(withRelation(stale, stale.relations.find((r) => r.review === 'stale'), null), relocked).length, 1);
});

test('lock refuses to accept an unconfirmed change', async () => {
  const { model, locked, reviewed } = await lockedModel();
  assert.throws(() => lockFacts(withRelation(model, reviewed, { cardinality: '1-1' }), locked), /cardinality n-1 → 1-1/);
});

test('a confirmed rename (renamed_from) is followed', async () => {
  const { model, locked, reviewed } = await lockedModel();
  const oldId = reviewed.from.table;
  const newId = `${oldId}_v2`;
  const column = reviewed.from.columns[0];
  const rename = (id) => (id === oldId ? newId : id);
  const renamed = {
    ...model,
    tables: model.tables.map((t) =>
      t.id === oldId
        ? { ...t, id: newId, renamed_from: oldId, columns: t.columns.map((c) => (c.name === column ? { ...c, name: `${column}_new`, renamed_from: column } : c)) }
        : t,
    ),
    relations: model.relations.map((r) => {
      const end = (e) => ({ table: rename(e.table), columns: e.table === oldId ? e.columns.map((c) => (c === column ? `${column}_new` : c)) : e.columns });
      return { ...r, from: end(r.from), to: end(r.to) };
    }),
    polymorphic: model.polymorphic.map((a) => ({ ...a, table: rename(a.table), targets: a.targets.map(rename).sort() })),
  };
  assert.deepEqual(checkLocked(renamed, locked), []);
});

test('lock file is validated like the model', () => {
  const { errors } = parseLocked('schema_version: 1\nrelations:\n  - { from: { table: a._.t, columns: [x] }, to: { table: a._.u, columns: [id] }, cardinality: many, optional: false, kind: db_fk, review: reviewed }\n');
  assert.deepEqual(
    errors.map((e) => `${e.file}: ${e.path}: ${e.message}`),
    [
      'tests/locked.yaml: relations[0].cardinality: must be one of 1-1 | 1-n | n-1 | n-n, got "many"',
      'tests/locked.yaml: relations[0].review: unknown field',
    ],
  );
});

test('CLI: lock writes tests/locked.yaml, validate then fails on a removed reviewed fact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'open-erd-lock-'));
  const run = (...args) => promisify(execFile)(process.execPath, [CLI, ...args]);
  await cp(MULTI, dir, { recursive: true });
  const { stdout } = await run('lock', '--workspace', dir);
  assert.match(stdout, /tests\/locked\.yaml: \d+ relation\(s\), 1 polymorphic association\(s\)/);
  assert.match((await run('validate', '--workspace', dir)).stdout, /valid, \d+ locked relation\(s\) and 1 polymorphic association\(s\) intact/);

  const file = join(dir, 'model', 'shop.yaml');
  const text = await readFile(file, 'utf8');
  await writeFile(file, text.replace(/\n {4}review: reviewed\n/, '\n    review: stale\n'));
  // Marked stale: still passes.
  assert.match((await run('validate', '--workspace', dir)).stdout, /: valid, /);

  await writeFile(file, text.replace(/\npolymorphic:\n(?: {2}- [^\n]*\n(?: {4}[^\n]*\n)*)+/, '\n'));
  await assert.rejects(run('validate', '--workspace', dir), (e) => {
    assert.equal(e.code, 1);
    assert.match(e.stderr, /^tests\/locked\.yaml: polymorphic\[0\]: polymorphic shop\._\.comments «commentable» was reviewed and is missing from the model/m);
    assert.match(e.stderr, /1 locked fact\(s\) changed or missing/);
    return true;
  });
  await assert.rejects(run('lock', '--workspace', dir), (e) => e.code === 1 && /«commentable» was reviewed and is missing/.test(e.stderr));
});
