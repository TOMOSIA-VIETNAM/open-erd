// Verification eval: a fixture's expected model with wrong facts slipped in,
// to measure whether the verification step (the `verify` command, then the
// verifier agent of skills/_shared/rules.md "Verification") catches them.
//
// Injected, each picked deterministically (first in id order):
//   column-type     a column's type changed            structural: `verify` must report it
//   db_fk-target    a db_fk relation pointed elsewhere structural: `verify` must report it
//   relation-target a declared / inferred relation pointed elsewhere   AI-written: the verifier
//   table-note      a table note replaced by a wrong one                AI-written: the verifier
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from './score.mjs';

const YAML = createRequire(path.join(ROOT, 'engine/package.json'))('yaml');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export const WRONG_NOTE = 'Archived rows kept only for legal retention; the application never reads or writes them.';
export const WRONG_TYPE = 'xml';

/** `{ 'model/<file>.yaml': data }` of a fixture's expected workspace. */
export function readExpected(caseName) {
  const dir = path.join(ROOT, 'fixtures', caseName, 'expected');
  return Object.fromEntries(
    fs.readdirSync(path.join(dir, 'model')).filter((f) => f.endsWith('.yaml')).sort()
      .map((f) => [`model/${f}`, YAML.parse(fs.readFileSync(path.join(dir, 'model', f), 'utf8'))]),
  );
}

const endText = (e) => `${e.table}.${e.columns.join(', ')}`;
export const relationText = (r) => `${endText(r.from)} -> ${endText(r.to)}`;

/**
 * A copy of `files` (from readExpected) with the wrong facts above, and the
 * list of what was injected: `{ id, layer: 'structural' | 'ai', fact, table,
 * column?, relation?, expected, injected }`. A fixture without a fitting
 * fact skips that injection.
 */
export function injectWrongFacts(files) {
  const copy = structuredClone(files);
  const injected = [];
  const tables = Object.values(copy).flatMap((d) => d.tables ?? []).sort((a, b) => cmp(a.id, b.id));
  const relations = Object.values(copy).flatMap((d) => d.relations ?? []).sort((a, b) => cmp(relationText(a), relationText(b)));

  const typed = tables.find((t) => t.columns.some((c) => !c.pk));
  if (typed) {
    const column = typed.columns.find((c) => !c.pk);
    injected.push({ id: 'column-type', layer: 'structural', fact: `${typed.id}.${column.name}.type`, table: typed.id, column: column.name, expected: column.type, injected: WRONG_TYPE });
    column.type = WRONG_TYPE;
  }
  // Another table of the same database with the same key column, so the
  // wrong relation still validates.
  const retarget = (id, kinds, layer) => {
    const r = relations.find((x) => kinds.includes(x.kind) && x.to.columns.length === 1);
    if (!r) return;
    const db = r.to.table.split('.')[0];
    const other = tables.find((t) => t.id !== r.to.table && t.id !== r.from.table && t.id.startsWith(`${db}.`) && t.columns.some((c) => c.name === r.to.columns[0]));
    if (!other) return;
    injected.push({ id, layer, fact: `relation ${relationText(r)}`, table: r.from.table, relation: { from: r.from, to: r.to }, expected: r.to.table, injected: other.id });
    r.to = { ...r.to, table: other.id };
  };
  retarget('db_fk-target', ['db_fk'], 'structural');
  retarget('relation-target', ['declared', 'inferred'], 'ai');
  const noted = tables.find((t) => t.note && t.note !== WRONG_NOTE);
  if (noted) {
    injected.push({ id: 'table-note', layer: 'ai', fact: `${noted.id}.note`, table: noted.id, expected: noted.note, injected: WRONG_NOTE });
    noted.note = WRONG_NOTE;
  }
  return { files: copy, injected };
}

/** `{ path: YAML text }` of `files`, for the engine's parseWorkspace or for writing out. */
export const toTexts = (files) => Object.fromEntries(Object.entries(files).map(([p, d]) => [p, YAML.stringify(d)]));

/** The current value of an injected fact in a workspace's model files. */
function currentValue(files, item) {
  const tables = Object.values(files).flatMap((d) => d.tables ?? []);
  if (item.id === 'column-type') return tables.find((t) => t.id === item.table)?.columns.find((c) => c.name === item.column)?.type;
  if (item.id === 'table-note') return tables.find((t) => t.id === item.table)?.note;
  const from = endText(item.relation.from);
  const r = Object.values(files).flatMap((d) => d.relations ?? []).find((x) => endText(x.from) === from);
  return r?.to.table;
}

/**
 * Score of a verification run on workspace `ws` (model files and
 * tests/verification.yaml as the run left them) for the `injected` list:
 * an injected fact is caught when the model no longer holds the injected
 * value. `falseAlarms`: record entries judged wrong or fixed that name no
 * injected fact.
 */
export function scoreVerify(ws, injected) {
  const files = Object.fromEntries(
    fs.readdirSync(path.join(ws, 'model')).filter((f) => f.endsWith('.yaml')).sort()
      .map((f) => [`model/${f}`, YAML.parse(fs.readFileSync(path.join(ws, 'model', f), 'utf8'))]),
  );
  const recordFile = path.join(ws, 'tests', 'verification.yaml');
  const record = fs.existsSync(recordFile) ? YAML.parse(fs.readFileSync(recordFile, 'utf8')) : { facts: [] };
  const items = injected.map((item) => {
    const now = currentValue(files, item);
    return { id: item.id, layer: item.layer, caught: now !== item.injected, restored: now === item.expected, now };
  });
  const names = injected.map((i) => [i.table, i.column].filter(Boolean).join('.'));
  const flagged = (record.facts ?? []).filter((f) => f.result === 'wrong' || f.result === 'fixed');
  const falseAlarms = flagged.filter((f) => !names.some((n) => String(f.fact).includes(n))).map((f) => f.fact);
  const count = (result) => (record.facts ?? []).filter((f) => f.result === result).length;
  return {
    items,
    caught: items.filter((i) => i.caught).length,
    total: items.length,
    falseAlarms,
    record: { present: fs.existsSync(recordFile), confirmed: count('confirmed'), fixed: count('fixed'), wrong: count('wrong'), unverifiable: count('unverifiable') },
  };
}
