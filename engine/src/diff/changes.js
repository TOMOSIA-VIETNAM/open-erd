import { columnEntries } from '../model/columns.js';
import { compareStrings } from '../model/load.js';
import { NOTE_FIELDS } from '../model/schema.js';

// Semantic diff of two normalized models ("from" = the older snapshot, "to"
// = the newer one). Tables are matched by id, then by a confirmed rename
// (`renamed_from` on the "to" side); columns inside a matched table the same
// way. Relations and polymorphic associations are compared after mapping the
// "from" side's ids onto the "to" side, so a rename alone never shows as a
// removed and an added relation.
//
// A change is a plain object `{ kind, database, table, ... }`; `table` is the
// id on the "to" side (the "from" id for something removed). describeChange
// is the only place that turns one into words.

// Share of column names two tables must have in common (Jaccard index of
// their column sets) before an unexplained removed + added pair is labelled
// "possibly renamed". The label never merges them: they still count as one
// table removed and one added, since only the user can confirm a rename.
export const POSSIBLE_RENAME_SIMILARITY = 0.6;

const TABLE_FIELDS = ['domain', 'kind', ...NOTE_FIELDS, 'sources', 'sti', 'partition', 'unique', 'generated_by'];
const COLUMN_FIELDS = ['type', 'nullable', 'pk', 'unique', 'pii', ...NOTE_FIELDS];
const ENTITY_FIELDS = ['array', 'note', 'internal_note'];
const DATABASE_FIELDS = ['engine', 'tenant_schemas', 'topology'];
const RELATION_FIELDS = ['cardinality', 'optional', 'kind', 'review'];
const POLYMORPHIC_FIELDS = ['type_column', 'id_column', 'optional', 'review'];

// Kinds in the order a reader goes through one table's changes.
export const CHANGE_KINDS = [
  'database_added',
  'database_removed',
  'database_changed',
  'table_added',
  'table_removed',
  'table_renamed',
  'table_changed',
  'entity_added',
  'entity_removed',
  'entity_changed',
  'column_added',
  'column_removed',
  'column_renamed',
  'column_changed',
  'enum_value_added',
  'enum_value_removed',
  'enum_meaning_changed',
  'relation_added',
  'relation_removed',
  'relation_changed',
  'polymorphic_added',
  'polymorphic_removed',
  'polymorphic_changed',
  'polymorphic_target_added',
  'polymorphic_target_removed',
];

// Canonical text of a field value, used both to compare and to show it.
// Objects keep their authored key order: every key is a fixed schema field.
export function showValue(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) return value.map(showValue).join(Array.isArray(value[0]) ? '; ' : ', ');
  if (typeof value === 'object') return Object.entries(value).map(([k, v]) => `${k}: ${showValue(v)}`).join(', ');
  return String(value);
}

const differs = (a, b) => showValue(a) !== showValue(b);
const nameOf = (id) => id.split('.')[2];
const dbOf = (id) => id.split('.')[0];
const endText = (end, tableName = nameOf) => `${tableName(end.table)}.${end.columns.join(', ')}`;
export const relationText = (r) => `${endText(r.from)} → ${endText(r.to)}`;
const relationKey = (r) => `${r.from.table}(${r.from.columns.join(',')})\u0000${r.to.table}(${r.to.columns.join(',')})`;

function fieldChanges(before, after, fields, base) {
  return fields
    .filter((f) => differs(before[f], after[f]))
    .map((field) => ({ ...base, field, before: before[field], after: after[field] }));
}

// Pairs "to" items with "from" items: by own key first, then by
// `renamed_from` when that old key is present on the "from" side and gone
// from the "to" side. Returns [[from, to]] plus the unmatched of each side.
function matchByName(fromItems, toItems, key, renamedKey) {
  const fromByKey = new Map(fromItems.map((x) => [key(x), x]));
  const toKeys = new Set(toItems.map(key));
  const used = new Set();
  const pairs = [];
  const added = [];
  const deferred = [];
  for (const t of toItems) {
    if (fromByKey.has(key(t))) {
      pairs.push({ from: fromByKey.get(key(t)), to: t, renamed: false });
      used.add(key(t));
    } else deferred.push(t);
  }
  for (const t of deferred) {
    const old = renamedKey(t);
    if (old !== undefined && fromByKey.has(old) && !toKeys.has(old) && !used.has(old)) {
      pairs.push({ from: fromByKey.get(old), to: t, renamed: true });
      used.add(old);
    } else added.push(t);
  }
  return { pairs, added, removed: fromItems.filter((x) => !used.has(key(x))) };
}

// Removed and added tables that look like one renamed table: column-name
// Jaccard index at least POSSIBLE_RENAME_SIMILARITY, best score first, ties
// broken by the added id then the removed id, each table used once.
function possibleRenames(removed, added) {
  const names = (t) => new Set(columnEntries(t).map((e) => e.path));
  const candidates = [];
  for (const a of added) {
    const an = names(a);
    for (const r of removed) {
      const rn = names(r);
      const shared = [...an].filter((n) => rn.has(n)).length;
      const score = shared / (an.size + rn.size - shared);
      if (score >= POSSIBLE_RENAME_SIMILARITY) candidates.push({ added: a.id, removed: r.id, shared, total: new Set([...an, ...rn]).size, score });
    }
  }
  candidates.sort((x, y) => y.score - x.score || compareStrings(x.added, y.added) || compareStrings(x.removed, y.removed));
  const taken = new Set();
  const result = [];
  for (const c of candidates) {
    if (taken.has(c.added) || taken.has(c.removed)) continue;
    taken.add(c.added).add(c.removed);
    result.push(c);
  }
  return result;
}

function enumChanges(before, after, base) {
  const a = before.enum ?? {};
  const b = after.enum ?? {};
  const out = [];
  for (const value of Object.keys(b)) {
    if (!(value in a)) out.push({ ...base, kind: 'enum_value_added', value, after: b[value] });
    else if (a[value] !== b[value]) out.push({ ...base, kind: 'enum_meaning_changed', value, before: a[value], after: b[value] });
  }
  for (const value of Object.keys(a)) if (!(value in b)) out.push({ ...base, kind: 'enum_value_removed', value, before: a[value] });
  return out;
}

// Changes inside one table present on both sides; also returns the column
// path map (old path -> new path) the relation mapping needs.
function tableChanges(from, to, base) {
  const changes = fieldChanges(from, to, TABLE_FIELDS, { ...base, kind: 'table_changed' });
  const entities = matchByName(from.embedded ?? [], to.embedded ?? [], (e) => e.name, () => undefined);
  for (const e of entities.added) changes.push({ ...base, kind: 'entity_added', column: e.name });
  for (const e of entities.removed) changes.push({ ...base, kind: 'entity_removed', column: e.name });
  for (const { from: a, to: b } of entities.pairs) changes.push(...fieldChanges(a, b, ENTITY_FIELDS, { ...base, kind: 'entity_changed', column: a.name }));

  const columns = new Map();
  const entries = (t) => columnEntries(t).map((e) => ({ ...e, old: e.column.renamed_from === undefined ? undefined : e.entity ? `${e.entity.name}.${e.column.renamed_from}` : e.column.renamed_from }));
  const cols = matchByName(entries(from), entries(to), (e) => e.path, (e) => e.old);
  // Columns of an embedded entity that came or went whole are covered by
  // the entity change.
  const goneEntity = new Set(entities.removed.map((e) => e.name));
  const newEntity = new Set(entities.added.map((e) => e.name));
  for (const e of cols.added) if (!newEntity.has(e.entity?.name)) changes.push({ ...base, kind: 'column_added', column: e.path, after: e.column.type });
  for (const e of cols.removed) if (!goneEntity.has(e.entity?.name)) changes.push({ ...base, kind: 'column_removed', column: e.path, before: e.column.type });
  for (const { from: a, to: b, renamed } of cols.pairs) {
    columns.set(a.path, b.path);
    const at = { ...base, column: b.path };
    if (renamed) changes.push({ ...at, kind: 'column_renamed', before: a.path, after: b.path });
    changes.push(...fieldChanges(a.column, b.column, COLUMN_FIELDS, { ...at, kind: 'column_changed' }));
    changes.push(...enumChanges(a.column, b.column, at));
  }
  return { changes, columns };
}

function compareChanges(a, b) {
  return (
    compareStrings(a.database, b.database) ||
    compareStrings(a.table ?? '', b.table ?? '') ||
    CHANGE_KINDS.indexOf(a.kind) - CHANGE_KINDS.indexOf(b.kind) ||
    compareStrings(a.subject ?? '', b.subject ?? '') ||
    compareStrings(a.column ?? '', b.column ?? '') ||
    compareStrings(a.value ?? '', b.value ?? '') ||
    compareStrings(a.field ?? '', b.field ?? '')
  );
}

/**
 * Changes from model `from` to model `to`, sorted (database, table, kind,
 * subject). Also returns how "from" ids map onto "to" ids, which the diff
 * diagram needs to merge both sides:
 *   tables   Map old table id -> new id, for every table on both sides
 *   columns  Map new table id -> Map old column path -> new path
 */
export function diffModels(from, to) {
  const changes = [];
  const dbs = matchByName(from.databases, to.databases, (d) => d.database, () => undefined);
  for (const d of dbs.added) changes.push({ kind: 'database_added', database: d.database, table: null, after: d.engine });
  for (const d of dbs.removed) changes.push({ kind: 'database_removed', database: d.database, table: null, before: d.engine });
  for (const { from: a, to: b } of dbs.pairs) changes.push(...fieldChanges(a, b, DATABASE_FIELDS, { kind: 'database_changed', database: a.database, table: null }));

  const tables = matchByName(from.tables, to.tables, (t) => t.id, (t) => t.renamed_from);
  const tableMap = new Map();
  const columnMap = new Map();
  for (const { from: a, to: b, renamed } of tables.pairs) {
    tableMap.set(a.id, b.id);
    const base = { database: dbOf(b.id), table: b.id };
    if (renamed) changes.push({ ...base, kind: 'table_renamed', before: a.id, after: b.id });
    const inner = tableChanges(a, b, base);
    changes.push(...inner.changes);
    columnMap.set(b.id, inner.columns);
  }
  const guesses = possibleRenames(tables.removed, tables.added);
  const guessFor = (id, side) => guesses.find((g) => g[side] === id);
  for (const t of tables.added) {
    const g = guessFor(t.id, 'added');
    changes.push({ kind: 'table_added', database: dbOf(t.id), table: t.id, after: t.domain, ...(g ? { possibly: { table: g.removed, shared: g.shared, total: g.total } } : {}) });
  }
  for (const t of tables.removed) {
    const g = guessFor(t.id, 'removed');
    changes.push({ kind: 'table_removed', database: dbOf(t.id), table: t.id, before: t.domain, ...(g ? { possibly: { table: g.added, shared: g.shared, total: g.total } } : {}) });
  }

  const table = (id) => tableMap.get(id) ?? id;
  const column = (tableId, path) => columnMap.get(table(tableId))?.get(path) ?? path;
  const end = (e) => ({ table: table(e.table), columns: e.columns.map((c) => column(e.table, c)) });
  const mapped = (r) => ({ ...r, from: end(r.from), to: end(r.to) });

  const rels = matchByName(from.relations.map(mapped), to.relations, relationKey, () => undefined);
  const relBase = (r) => ({ database: dbOf(r.from.table), table: r.from.table, subject: relationText(r), relation: r });
  for (const r of rels.added) changes.push({ ...relBase(r), kind: 'relation_added' });
  for (const r of rels.removed) changes.push({ ...relBase(r), kind: 'relation_removed' });
  for (const { from: a, to: b } of rels.pairs) changes.push(...fieldChanges(a, b, RELATION_FIELDS, { ...relBase(b), kind: 'relation_changed' }));

  const polyMapped = (a) => ({
    ...a,
    table: table(a.table),
    type_column: column(a.table, a.type_column),
    id_column: column(a.table, a.id_column),
    targets: a.targets.map(table).sort(compareStrings),
  });
  const polys = matchByName(from.polymorphic.map(polyMapped), to.polymorphic, (a) => `${a.table}\u0000${a.name}`, () => undefined);
  const polyBase = (a) => ({ database: dbOf(a.table), table: a.table, subject: `«${a.name}»`, association: a });
  for (const a of polys.added) changes.push({ ...polyBase(a), kind: 'polymorphic_added' });
  for (const a of polys.removed) changes.push({ ...polyBase(a), kind: 'polymorphic_removed' });
  for (const { from: a, to: b } of polys.pairs) {
    changes.push(...fieldChanges(a, b, POLYMORPHIC_FIELDS, { ...polyBase(b), kind: 'polymorphic_changed' }));
    for (const t of b.targets.filter((x) => !a.targets.includes(x))) changes.push({ ...polyBase(b), kind: 'polymorphic_target_added', value: t });
    for (const t of a.targets.filter((x) => !b.targets.includes(x))) changes.push({ ...polyBase(b), kind: 'polymorphic_target_removed', value: t });
  }

  return { changes: changes.sort(compareChanges), tables: tableMap, columns: columnMap };
}

const FIELD_WORDS = {
  domain: 'domain',
  kind: 'kind',
  note: 'note',
  note_source: 'original note',
  internal_note: 'internal note',
  sources: 'source tables',
  sti: 'single-table inheritance',
  partition: 'partitioning',
  unique: 'unique keys',
  generated_by: 'generated by',
  type: 'type',
  nullable: 'nullable',
  pk: 'primary key',
  pii: 'personal data (PII)',
  array: 'list of documents',
  engine: 'engine',
  tenant_schemas: 'tenant schemas',
  topology: 'replicas and shards',
  cardinality: 'cardinality',
  optional: 'optional',
  review: 'review state',
  type_column: 'type column',
  id_column: 'id column',
};

const quoted = (value) => `“${showValue(value)}”`;
// A column's `unique` is one flag, a table's is its list of unique keys.
const fieldWord = (c) => (c.field === 'unique' && c.kind === 'column_changed' ? 'unique' : FIELD_WORDS[c.field]);
// Flags read as a state ("now unique"), an absent flag being false.
const FLAGS = new Set(['pk', 'unique', 'pii', 'array', 'optional']);
const fromTo = (c) => {
  const word = fieldWord(c);
  if (FLAGS.has(c.field) && (c.kind !== 'table_changed' || c.field !== 'unique')) return c.after ? `now ${word}` : `no longer ${word}`;
  if (c.field === 'nullable' && c.after !== undefined) return c.after ? 'now nullable' : 'now NOT NULL';
  if (c.before === undefined) return `${word} set to ${quoted(c.after)}`;
  if (c.after === undefined) return `${word} ${quoted(c.before)} removed`;
  return `${word} changed from ${quoted(c.before)} to ${quoted(c.after)}`;
};
const guess = (c, direction) =>
  c.possibly ? ` (possibly renamed ${direction} ${nameOf(c.possibly.table)}: ${c.possibly.shared} of ${c.possibly.total} columns match)` : '';
const relationSummary = (r) => `${r.cardinality}${r.optional ? ', optional' : ''}, ${r.kind}`;

/** One plain English sentence for change `c`. */
export function describeChange(c) {
  const t = c.table ? nameOf(c.table) : '';
  switch (c.kind) {
    case 'database_added':
      return `Database ${c.database} added (${c.after})`;
    case 'database_removed':
      return `Database ${c.database} removed`;
    case 'database_changed':
      return `Database ${c.database}: ${fromTo(c)}`;
    case 'table_added':
      return `Table ${t} added in domain ${c.after}${guess(c, 'from')}`;
    case 'table_removed':
      return `Table ${t} removed${guess(c, 'to')}`;
    case 'table_renamed':
      return `Table renamed from ${c.before} to ${c.after}`;
    case 'table_changed':
      return `Table ${t}: ${fromTo(c)}`;
    case 'entity_added':
      return `Embedded document ${c.column} added`;
    case 'entity_removed':
      return `Embedded document ${c.column} removed`;
    case 'entity_changed':
      return `Embedded document ${c.column}: ${fromTo(c)}`;
    case 'column_added':
      return `Column ${c.column} added (${c.after})`;
    case 'column_removed':
      return `Column ${c.column} removed`;
    case 'column_renamed':
      return `Column renamed from ${c.before} to ${c.after}`;
    case 'column_changed':
      return `Column ${c.column}: ${fromTo(c)}`;
    case 'enum_value_added':
      return `Enum ${c.column}: added value ${quoted(c.value)} (${c.after})`;
    case 'enum_value_removed':
      return `Enum ${c.column}: removed value ${quoted(c.value)}`;
    case 'enum_meaning_changed':
      return `Enum ${c.column}: meaning of ${quoted(c.value)} changed from ${quoted(c.before)} to ${quoted(c.after)}`;
    case 'relation_added':
      return `Relation ${c.subject} added (${relationSummary(c.relation)})`;
    case 'relation_removed':
      return `Relation ${c.subject} removed`;
    case 'relation_changed':
      return `Relation ${c.subject}: ${fromTo(c)}`;
    case 'polymorphic_added':
      return `Polymorphic ${c.subject} on ${t} added (targets: ${c.association.targets.map(nameOf).join(', ')})`;
    case 'polymorphic_removed':
      return `Polymorphic ${c.subject} on ${t} removed`;
    case 'polymorphic_changed':
      return `Polymorphic ${c.subject} on ${t}: ${fromTo(c)}`;
    case 'polymorphic_target_added':
      return `Polymorphic ${c.subject} on ${t}: added target ${nameOf(c.value)}`;
    case 'polymorphic_target_removed':
      return `Polymorphic ${c.subject} on ${t}: removed target ${nameOf(c.value)}`;
    default:
      throw new Error(`unknown change kind ${c.kind}`);
  }
}

/** Short label of a change's kind for the Change column, e.g. "Column renamed". */
export function changeLabel(kind) {
  const [scope, ...rest] = kind.split('_');
  const words = { polymorphic: 'Polymorphic', entity: 'Embedded document', enum: 'Enum' };
  return `${words[scope] ?? scope[0].toUpperCase() + scope.slice(1)} ${rest.join(' ')}`;
}

/**
 * Totals for the one-line summary. A possibly renamed table still counts as
 * removed and added; columns count once per column whatever changed in it,
 * relations once per relation or polymorphic association.
 */
export function summarize(changes) {
  const count = (kind) => changes.filter((c) => c.kind === kind).length;
  const distinct = (kinds, key) => new Set(changes.filter((c) => kinds.some((k) => c.kind.startsWith(k))).map(key)).size;
  return {
    tablesAdded: count('table_added'),
    tablesRemoved: count('table_removed'),
    tablesRenamed: count('table_renamed'),
    columnsChanged: distinct(['column_', 'enum_', 'entity_'], (c) => `${c.table}\u0000${c.column}`),
    relationsChanged: distinct(['relation_', 'polymorphic_'], (c) => (c.relation ? relationKey(c.relation) : `${c.table}\u0000${c.subject}`)),
  };
}

export function summaryLine(s) {
  return `+${s.tablesAdded} tables · −${s.tablesRemoved} tables · ${s.tablesRenamed} renamed · ${s.columnsChanged} columns changed · ${s.relationsChanged} relations changed`;
}
