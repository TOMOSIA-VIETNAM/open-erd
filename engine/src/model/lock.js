import { stringify } from 'yaml';
import { columnEntries } from './columns.js';
import { compareStrings, parseYaml } from './load.js';
import { LOCKED_FILE, SCHEMA_VERSION, lockedFileSchema } from './schema.js';
import { joinPath, validateNode } from './validate.js';

// Locked facts: what a reviewer confirmed, so a later sync (possibly by
// another model) cannot silently change or drop it. A locked fact passes
// `validate` while the model still has it unchanged and `review: reviewed`,
// or has it marked `review: stale` (the code moved; a human decides later).
// A confirmed rename (`renamed_from`) is followed, not reported.

const RELATION_ATTRIBUTES = ['cardinality', 'optional', 'kind'];
const POLYMORPHIC_ATTRIBUTES = ['type_column', 'id_column', 'optional', 'targets'];

/** `{ locked, errors }` for the text of tests/locked.yaml. */
export function parseLocked(text) {
  const errors = [];
  const data = parseYaml(LOCKED_FILE, text, errors);
  if (data === undefined) return { locked: null, errors };
  for (const e of validateNode(data, lockedFileSchema)) errors.push({ file: LOCKED_FILE, ...e });
  return { locked: errors.length > 0 ? null : data, errors };
}

// Old id -> current id for tables, and per current table old column path ->
// current path, from the renamed_from fields the user confirmed. `table` and
// `column` map one name; `relation` and `polymorphic` a whole fact.
export function renames(model) {
  const tables = new Map(model.tables.filter((t) => t.renamed_from).map((t) => [t.renamed_from, t.id]));
  const columns = new Map(
    model.tables.map((t) => [
      t.id,
      new Map(
        columnEntries(t)
          .filter(({ column }) => column.renamed_from)
          .map(({ path, column, entity }) => [entity ? `${entity.name}.${column.renamed_from}` : column.renamed_from, path]),
      ),
    ]),
  );
  const table = (id) => tables.get(id) ?? id;
  const column = (tableId, path) => columns.get(table(tableId))?.get(path) ?? path;
  return {
    table,
    column,
    relation: (r) => {
      const end = (e) => ({ table: table(e.table), columns: e.columns.map((c) => column(e.table, c)) });
      return { ...r, from: end(r.from), to: end(r.to) };
    },
    polymorphic: (a) => ({
      ...a,
      table: table(a.table),
      type_column: column(a.table, a.type_column),
      id_column: column(a.table, a.id_column),
      targets: a.targets.map(table).sort(compareStrings),
    }),
  };
}

const endText = (end) => `${end.table}.${end.columns.join(', ')}`;
const KINDS = {
  relations: {
    key: (r) => `${endText(r.from)}\u0000${endText(r.to)}`,
    describe: (r) => `relation ${endText(r.from)} → ${endText(r.to)}`,
    attributes: RELATION_ATTRIBUTES,
    entry: (r) => ({ from: r.from, to: r.to, cardinality: r.cardinality, optional: r.optional, kind: r.kind }),
  },
  polymorphic: {
    key: (a) => `${a.table}\u0000${a.name}`,
    describe: (a) => `polymorphic ${a.table} «${a.name}»`,
    attributes: POLYMORPHIC_ATTRIBUTES,
    entry: (a) => ({ table: a.table, name: a.name, type_column: a.type_column, id_column: a.id_column, optional: a.optional, targets: a.targets }),
  },
};

const show = (value) => (Array.isArray(value) ? value.join(', ') : String(value));
const same = (a, b) => show(a) === show(b);

// Each locked entry with the model facts it refers to and what differs.
function match(model, locked) {
  const follow = renames(model);
  const results = [];
  for (const [section, kind] of Object.entries(KINDS)) {
    const facts = new Map();
    for (const fact of section === 'relations' ? model.relations : model.polymorphic) {
      const key = kind.key(fact);
      facts.set(key, [...(facts.get(key) ?? []), fact]);
    }
    (locked?.[section] ?? []).forEach((raw, i) => {
      const entry = section === 'relations' ? follow.relation(raw) : follow.polymorphic(raw);
      const candidates = facts.get(kind.key(entry)) ?? [];
      const differences = (fact) => [
        ...kind.attributes.filter((a) => !same(entry[a], fact[a])).map((a) => `${a} ${show(entry[a])} → ${show(fact[a])}`),
        ...(fact.review === 'reviewed' ? [] : [`review reviewed → ${fact.review}`]),
      ];
      const stale = candidates.some((f) => f.review === 'stale');
      const unchanged = candidates.some((f) => differences(f).length === 0);
      results.push({ section, path: joinPath(section, i), kind, entry, candidates, stale, unchanged, differences });
    });
  }
  return results;
}

/**
 * Locked facts the model breaks, as `{ file, path, message }` (path into
 * tests/locked.yaml), one per fact, in file order.
 */
export function checkLocked(model, locked) {
  const errors = [];
  for (const m of match(model, locked)) {
    if (m.stale || m.unchanged) continue;
    const what = m.kind.describe(m.entry);
    const problem =
      m.candidates.length === 0 ? 'missing from the model' : `changed: ${m.differences(m.candidates[0]).join('; ')}`;
    errors.push({
      file: LOCKED_FILE,
      path: m.path,
      message: `${what} was reviewed and is ${problem}. Restore it, or set review: stale when the code no longer supports it; change or delete it only after the user confirms, then remove this entry and run lock`,
    });
  }
  return errors;
}

/**
 * Contents of tests/locked.yaml for `model`: every `review: reviewed` fact,
 * plus the entries of `previous` whose fact is now `stale`, so a stale fact
 * stays protected until the user decides on it. Throws when the model breaks
 * `previous`: locking must never accept an unconfirmed change.
 */
export function lockFacts(model, previous) {
  const errors = checkLocked(model, previous);
  if (errors.length > 0) throw new Error(errors.map((e) => `${e.file}: ${e.path}: ${e.message}`).join('\n'));
  const kept = match(model, previous).filter((m) => m.stale);
  const locked = { schema_version: SCHEMA_VERSION };
  for (const [section, kind] of Object.entries(KINDS)) {
    const facts = section === 'relations' ? model.relations : model.polymorphic;
    const entries = new Map();
    for (const f of facts.filter((fact) => fact.review === 'reviewed')) entries.set(kind.key(f), kind.entry(f));
    for (const m of kept.filter((k) => k.section === section)) {
      if (!entries.has(kind.key(m.entry))) entries.set(kind.key(m.entry), kind.entry(m.entry));
    }
    locked[section] = [...entries.keys()].sort(compareStrings).map((key) => entries.get(key));
  }
  return locked;
}

export function serializeLocked(locked) {
  return (
    '# Reviewed facts checked by `open-erd validate`. Written by `open-erd lock`;\n' +
    '# remove an entry by hand only after the user confirmed changing or deleting that fact.\n' +
    stringify(locked)
  );
}
