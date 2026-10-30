import { compareStrings } from './load.js';
import { COLUMN_FIELDS, indexPath, isObject, readFacts, value } from './facts.js';

// What changed between two sets of extract facts files (extract/facts/*.json
// at a git ref, and the files on disk): the code changes a sync applies to
// the model, named by table, column, index and association instead of by
// JSON position. Tables, columns, indexes and associations are read through
// readFacts, so the shapes model.md accepts for the same structure (older
// `unique: [[a, b]]`, evidence as a string or a list, `database` on the file
// or the table) compare equal. `polymorphic`, `enums` and `hints` are
// free-form: every field but their identity is compared. Any other top-level
// key is reported as changed as a whole.

const SCOPES = ['file', 'table', 'column', 'index', 'association', 'polymorphic', 'enum', 'hint', 'other'];
const COLUMN_DIFF_FIELDS = [...COLUMN_FIELDS, 'generated'];
// Identity fields of the free-form sections; everything else is compared.
const FREE_FORM = {
  polymorphic: { scope: 'polymorphic', identity: ['database', 'table', 'name'], path: (t, e) => `${t} ${e.name ?? '?'}` },
  enums: { scope: 'enum', identity: ['database', 'table', 'column'], path: (t, e) => `${t}.${e.column ?? '?'}` },
  hints: { scope: 'hint', identity: ['database', 'table', 'column', 'text'], path: (t, e) => `${t}${e.column ? `.${e.column}` : ''}: ${e.text ?? ''}` },
};
const KNOWN_KEYS = new Set(['source', 'database', 'tables', 'associations', ...Object.keys(FREE_FORM)]);

/** JSON with object keys sorted, so equal values give equal text. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObject(v)) {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort(compareStrings);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

const tableLabel = (database, schema, name) => [database, schema, name].filter((x) => x !== null && x !== undefined).join('.');
const sorted = (list) => [...new Set(list)].sort(compareStrings);

/**
 * One side as entries `key -> { scope, path, parent?, fields }`, fields as
 * canonical JSON text (absent = undefined). Returns `{ entries, errors }`.
 */
function entriesOf(files) {
  const facts = readFacts(files);
  const errors = [...facts.errors];
  const entries = new Map();
  // The first entry for a key wins (files are read in name order).
  const add = (scope, path, fields, parent, detail) => {
    const key = `${scope}\u0000${path}`;
    if (!entries.has(key)) entries.set(key, { scope, path, parent, fields, detail });
  };

  for (const { file } of files) add('file', file, {});
  for (const t of facts.tables) {
    const table = tableLabel(t.database, t.schema, t.name);
    const size = `${t.columns.length} column(s)${t.indexes.length > 0 ? `, ${t.indexes.length} index(es)` : ''}`;
    add('table', table, { evidence: canonical(sorted(t.evidence)) }, undefined, size);
    for (const c of t.columns) {
      const fields = {};
      for (const f of COLUMN_DIFF_FIELDS) {
        const v = f === 'generated' ? (c.generated == null ? undefined : String(c.generated)) : value(f, c[f]);
        if (v !== undefined) fields[f] = canonical(v);
      }
      const flags = ['pk', 'nullable', 'unique', 'auto_increment'].filter((f) => c[f] === true);
      const detail = [c.type, ...flags, ...(fields.default ? [`default ${fields.default}`] : [])].join(', ');
      add('column', `${table}.${c.name}`, fields, `table\u0000${table}`, detail);
    }
    for (const i of t.indexes) add('index', `${table} index ${indexPath(i)}`, i.name ? { name: canonical(i.name) } : {}, `table\u0000${table}`);
  }

  // Several entries for one association (one per macro) are one: constraint
  // when any has it, evidence of all.
  const associations = new Map();
  for (const a of facts.associations) {
    const end = (e) => `${tableLabel(e.database, null, e.table)}.${e.columns.join(', ')}`;
    const path = `${end(a.from)} -> ${end(a.to)}`;
    const known = associations.get(path) ?? { constraint: false, evidence: [] };
    associations.set(path, { constraint: known.constraint || a.constraint, evidence: [...known.evidence, ...a.evidence] });
  }
  for (const [path, a] of associations) add('association', path, { constraint: canonical(a.constraint), evidence: canonical(sorted(a.evidence)) });

  for (const { file, data } of files) {
    if (!isObject(data)) continue;
    const databaseOf = new Map((Array.isArray(data.tables) ? data.tables : []).filter(isObject).map((t) => [t.name, t.database ?? data.database ?? null]));
    for (const [section, { scope, identity, path }] of Object.entries(FREE_FORM)) {
      (Array.isArray(data[section]) ? data[section] : []).forEach((e, i) => {
        if (!isObject(e) || typeof e.table !== 'string') {
          errors.push({ file, path: `${section}[${i}]`, message: 'needs a table' });
          return;
        }
        const table = tableLabel(e.database ?? databaseOf.get(e.table) ?? data.database ?? null, null, e.table);
        const fields = {};
        for (const [k, v] of Object.entries(e)) {
          if (identity.includes(k) || v === undefined) continue;
          // One level of an object (enum values) is compared key by key.
          if (isObject(v)) for (const [kk, vv] of Object.entries(v)) fields[`${k}.${kk}`] = canonical(vv);
          else fields[k] = canonical(v);
        }
        add(scope, path(table, e), fields);
      });
    }
    for (const key of Object.keys(data).filter((k) => !KNOWN_KEYS.has(k))) add('other', `${file}: ${key}`, { value: canonical(data[key]) });
  }
  return { entries, errors };
}

/**
 * Changes from facts files `from` to facts files `to` (both `[{ file, data
 * }]`, data parsed JSON), sorted by scope, path and field:
 *   { change: 'added' | 'removed' | 'changed', scope, path,
 *     field?, before?, after?,   changed: the field and its JSON text on each side
 *     detail? }                  added/removed table or column: a short summary
 *                                (column and index counts; type and flags)
 * The columns and indexes of an added or removed table are not listed
 * separately. Returns `{ changes, errors }`; errors are readFacts errors
 * (and free-form entries without a table) of either side, with `side`.
 */
export function diffFacts(from, to) {
  const before = entriesOf(from);
  const after = entriesOf(to);
  const errors = [...before.errors.map((e) => ({ ...e, side: 'from' })), ...after.errors.map((e) => ({ ...e, side: 'to' }))];
  const changes = [];
  for (const [key, e] of after.entries) {
    if (!before.entries.has(key)) changes.push({ change: 'added', key, parent: e.parent, scope: e.scope, path: e.path, ...(e.detail ? { detail: e.detail } : {}) });
  }
  for (const [key, e] of before.entries) {
    const other = after.entries.get(key);
    if (!other) {
      changes.push({ change: 'removed', key, parent: e.parent, scope: e.scope, path: e.path, ...(e.detail ? { detail: e.detail } : {}) });
      continue;
    }
    for (const field of sorted([...Object.keys(e.fields), ...Object.keys(other.fields)])) {
      if (e.fields[field] !== other.fields[field]) changes.push({ change: 'changed', scope: e.scope, path: e.path, field, before: e.fields[field], after: other.fields[field] });
    }
  }
  const whole = new Set(changes.filter((c) => c.scope === 'table').map((c) => c.key));
  const result = changes
    .filter((c) => !whole.has(c.parent))
    .map(({ key, parent, ...c }) => c)
    .sort((a, b) => compareStrings(sortKey(a), sortKey(b)));
  return { changes: result, errors };
}

const sortKey = (c) => [String(SCOPES.indexOf(c.scope)).padStart(2, '0'), c.path, c.field ?? '', c.change].join('\u0000');

const show = (text) => (text === undefined ? '(none)' : text);

/** One plain line per change. */
export function describeFactsChange(c) {
  if (c.change === 'changed') {
    if (c.scope === 'other') return `changed ${c.path} (not compared field by field; see the file)`;
    return `changed ${c.scope} ${c.path}: ${c.field} ${show(c.before)} → ${show(c.after)}`;
  }
  if (c.scope === 'other') return `${c.change} ${c.path}`;
  return `${c.change} ${c.scope} ${c.path}${c.detail ? ` (${c.detail})` : ''}`;
}

/** Counts per change kind, as `2 added, 1 removed, 3 changed` (or `no changes`). */
export function factsDiffSummary(changes) {
  const count = (kind) => changes.filter((c) => c.change === kind).length;
  return changes.length === 0 ? 'no changes' : ['added', 'removed', 'changed'].map((k) => `${count(k)} ${k}`).join(', ');
}
