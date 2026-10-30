import { columnEntries } from './columns.js';
import { compareStrings, parseHealthIgnore } from './load.js';
import { MISSING_KINDS, missingRelations } from './missing.js';
import { HEALTH_RULES, HEALTH_SEVERITIES } from './schema.js';
import { qualifiedName, quoter } from '../render/svg/viewer/schema-copy.js';

// Schema health: a list of findings a reviewer can act on, found only on
// what the model records for certain. There is no score, and the SQL is a
// starting point to review, never a migration for a framework. A rule that
// needs data the model does not have (no index recorded anywhere in a
// database) skips that database instead of guessing.

// Engines whose findings come with SQL; the rest get words only (MongoDB
// gets a mongosh line for its indexes).
const SQL_ENGINES = new Set(['postgresql', 'postgres', 'mysql', 'mariadb', 'sqlite', 'sqlserver', 'oracle']);
const MONGO = 'mongodb';
const DROP_INDEX_ON_TABLE = new Set(['mysql', 'mariadb', 'sqlserver']);
// InnoDB creates an index for every foreign key constraint by itself, so a
// db_fk column there is indexed even when the model lists no index.
const FK_INDEXED_ENGINES = new Set(['mysql', 'mariadb']);

const isView = (t) => (t.kind ?? 'table') !== 'table';
const listText = (columns) => columns.join(', ');
const sameSet = (a, b) => a.length === b.length && a.every((c) => b.includes(c));
// Name an index or constraint the way most migrations do: prefix, table, columns.
const generatedName = (prefix, tableId, columns) => [prefix, tableId.split('.')[2], ...columns].join('_').replace(/\W/g, '_');

/**
 * Indexes a lookup can use on `t`: the declared ones, the primary key (its
 * columns in table order) and each column marked unique. Only for coverage:
 * the implied ones are never reported as redundant, since the declared
 * index behind a `unique` flag is usually the same index.
 */
function usableIndexes(t) {
  const entries = columnEntries(t);
  const pk = entries.filter((e) => e.column.pk).map((e) => e.path);
  return [
    ...(t.indexes ?? []),
    ...(pk.length > 0 ? [{ columns: pk, unique: true }] : []),
    ...entries.filter((e) => e.column.unique).map((e) => ({ columns: [e.path], unique: true })),
  ];
}
// Some index begins with exactly these columns, in any order among themselves.
const coveredBy = (indexes, columns) => indexes.some((i) => i.columns.length >= columns.length && sameSet(i.columns.slice(0, columns.length), columns));

function createIndex(engine, tableId, columns) {
  if (engine === MONGO) return `db.getCollection(${JSON.stringify(tableId.split('.')[2])}).createIndex({ ${columns.map((c) => `${JSON.stringify(c)}: 1`).join(', ')} })`;
  if (!SQL_ENGINES.has(engine)) return undefined;
  const q = quoter(engine);
  return `CREATE INDEX ${q(generatedName('idx', tableId, columns))} ON ${qualifiedName(tableId, q)} (${columns.map(q).join(', ')});`;
}

function dropIndex(engine, tableId, name) {
  if (name === undefined) return undefined;
  if (engine === MONGO) return `db.getCollection(${JSON.stringify(tableId.split('.')[2])}).dropIndex(${JSON.stringify(name)})`;
  if (!SQL_ENGINES.has(engine)) return undefined;
  const q = quoter(engine);
  if (DROP_INDEX_ON_TABLE.has(engine)) return `DROP INDEX ${q(name)} ON ${qualifiedName(tableId, q)};`;
  // PostgreSQL and Oracle keep an index in its table's schema.
  const schema = tableId.split('.')[1];
  return `DROP INDEX ${schema === '_' || engine === 'sqlite' ? '' : `${q(schema)}.`}${q(name)};`;
}

function addForeignKey(engine, r) {
  if (!SQL_ENGINES.has(engine) || engine === 'sqlite') return undefined;
  const q = quoter(engine);
  const list = (columns) => columns.map(q).join(', ');
  return `ALTER TABLE ${qualifiedName(r.from.table, q)} ADD CONSTRAINT ${q(generatedName('fk', r.from.table, r.from.columns))} FOREIGN KEY (${list(r.from.columns)}) REFERENCES ${qualifiedName(r.to.table, q)} (${list(r.to.columns)});`;
}

const finding = (rule, table, fields) => ({ rule, severity: HEALTH_RULES[rule], table, ...fields });

/**
 * Findings of every rule (HEALTH_RULES), minus those `health.ignore` in
 * open-erd.yaml silences, sorted by severity (medium first), table, rule,
 * then columns. Each is `{ rule, severity, table, columns?, message,
 * suggestion, sql?, related? }`; `related` names the other table and
 * columns the message or SQL mention, so a profile can drop the finding
 * with them (see healthFor). Rules:
 *   - missing_fk: a `declared` relation (written in code) on a SQL database
 *     with no `db_fk` on the same columns; skipped when an end is a view or
 *     partitioned, the columns are a polymorphic association's, a column is
 *     inside an embedded document, or the target columns are not a primary
 *     key or unique (no constraint could reference them). SQLite cannot add
 *     a constraint to an existing table, so it gets no SQL;
 *   - unindexed_fk: the columns at the `from` end of a relation (not an
 *     inferred one) are not the leading columns of any index, the primary
 *     key or a unique column; only on databases that record indexes, and
 *     not for a `db_fk` on MySQL / MariaDB, which index those themselves;
 *   - polymorphic_unindexed: no index starts with the association's type
 *     and id columns, in either order; only on databases that record indexes;
 *   - orphan_table: the tables missingRelations reports as unconnected,
 *     minus hub tables and views;
 *   - redundant_index: a declared index whose columns begin another one of
 *     the same table (same access method and predicate). A unique index is
 *     never redundant to a longer one, since it enforces more; of two
 *     identical indexes the one listed first stays.
 */
export function healthFindings(model) {
  const engineOf = new Map(model.databases.map((db) => [db.database, db.engine]));
  const engine = (tableId) => engineOf.get(tableId.split('.')[0]);
  const tables = new Map(model.tables.map((t) => [t.id, t]));
  const indexed = new Set(model.tables.filter((t) => (t.indexes ?? []).length > 0).map((t) => t.id.split('.')[0]));
  const recordsIndexes = (tableId) => indexed.has(tableId.split('.')[0]);
  const polymorphicColumns = new Set(model.polymorphic.flatMap((a) => [a.type_column, a.id_column].map((c) => `${a.table}.${c}`)));
  const fromKey = (end) => `${end.table}\u0000${end.columns.join(',')}`;
  const constrained = new Set(model.relations.filter((r) => r.kind === 'db_fk').map((r) => fromKey(r.from)));
  const embeddedPath = (columns) => columns.some((c) => c.includes('.'));
  const findings = [];

  const fkSeen = new Set();
  for (const r of model.relations) {
    if (r.kind !== 'declared' || constrained.has(fromKey(r.from)) || fkSeen.has(fromKey(r.from))) continue;
    const from = tables.get(r.from.table);
    const to = tables.get(r.to.table);
    if (!SQL_ENGINES.has(engine(from.id)) || from.id.split('.')[0] !== to.id.split('.')[0]) continue;
    if ([from, to].some((t) => isView(t) || t.partition) || embeddedPath(r.from.columns)) continue;
    if (r.from.columns.some((c) => polymorphicColumns.has(`${from.id}.${c}`))) continue;
    if (!usableIndexes(to).some((i) => i.unique && !i.where && sameSet(i.columns, r.to.columns))) continue;
    fkSeen.add(fromKey(r.from));
    const sql = addForeignKey(engine(from.id), r);
    findings.push(
      finding('missing_fk', from.id, {
        columns: r.from.columns,
        message: `${listText(r.from.columns)} references ${r.to.table} in code only; the database does not check it.`,
        suggestion: sql
          ? `Add a foreign key constraint so the database rejects rows pointing at a missing ${r.to.table.split('.')[2]} row.`
          : 'SQLite cannot add a constraint to an existing table: rebuild the table with the foreign key.',
        ...(sql ? { sql } : {}),
        related: { table: r.to.table, columns: r.to.columns },
      }),
    );
  }

  const indexSeen = new Set();
  for (const r of [...model.relations].sort((a, b) => compareStrings(fromKey(a.from), fromKey(b.from)) || compareStrings(a.to.table, b.to.table))) {
    const from = tables.get(r.from.table);
    if (r.kind === 'inferred' || isView(from) || !recordsIndexes(from.id) || indexSeen.has(fromKey(r.from))) continue;
    if (r.kind === 'db_fk' && FK_INDEXED_ENGINES.has(engine(from.id))) continue;
    if (embeddedPath(r.from.columns) && engine(from.id) !== MONGO) continue;
    if (coveredBy(usableIndexes(from), r.from.columns)) continue;
    indexSeen.add(fromKey(r.from));
    const sql = createIndex(engine(from.id), from.id, r.from.columns);
    findings.push(
      finding('unindexed_fk', from.id, {
        columns: r.from.columns,
        message: `${listText(r.from.columns)} references ${r.to.table}, but no index starts with ${r.from.columns.length > 1 ? 'these columns' : 'it'}, so lookups by it read the whole table.`,
        suggestion: `Add an index on ${listText(r.from.columns)}.`,
        ...(sql ? { sql } : {}),
        related: { table: r.to.table, columns: r.to.columns },
      }),
    );
  }

  for (const a of model.polymorphic) {
    const owner = tables.get(a.table);
    const pair = [a.type_column, a.id_column];
    if (isView(owner) || !recordsIndexes(owner.id) || coveredBy(usableIndexes(owner), pair)) continue;
    const sql = createIndex(engine(owner.id), owner.id, pair);
    findings.push(
      finding('polymorphic_unindexed', owner.id, {
        columns: pair,
        message: `The polymorphic association «${a.name}» looks rows up by ${a.type_column} and ${a.id_column}, but no index starts with both.`,
        suggestion: `Add an index on (${listText(pair)}).`,
        ...(sql ? { sql } : {}),
      }),
    );
  }

  const hubs = new Set(model.config.hub?.tables ?? []);
  for (const w of missingRelations(model)) {
    if (w.kind !== MISSING_KINDS.table || hubs.has(w.table) || isView(tables.get(w.table))) continue;
    findings.push(
      finding('orphan_table', w.table, {
        message: 'No relation, hub reference or polymorphic association connects this table.',
        suggestion: 'Declare its relations, or list it under ignore_missing.tables if it stands alone on purpose.',
      }),
    );
  }

  for (const t of model.tables) {
    if (isView(t)) continue;
    const indexes = t.indexes ?? [];
    const method = (i) => (i.using ?? 'btree').toLowerCase();
    indexes.forEach((a, i) => {
      const covering = indexes.find((b, j) => {
        if (j === i || method(a) !== method(b) || (a.where ?? '') !== (b.where ?? '') || a.columns.length > b.columns.length) return false;
        if (a.columns.some((c, k) => b.columns[k] !== c)) return false;
        if (a.columns.length < b.columns.length) return !a.unique;
        // Same columns: the non-unique one goes; of two alike, the later one.
        return Boolean(a.unique) === Boolean(b.unique) ? j < i : !a.unique;
      });
      if (!covering) return;
      const name = (x) => x.name ?? `(${listText(x.columns)})`;
      const duplicate = covering.columns.length === a.columns.length;
      const sql = dropIndex(engine(t.id), t.id, a.name);
      findings.push(
        finding('redundant_index', t.id, {
          columns: a.columns,
          message: `Index ${name(a)} ${duplicate ? 'duplicates' : 'is a prefix of'} index ${name(covering)}, which serves the same lookups.`,
          suggestion: `Drop index ${name(a)}.`,
          ...(sql ? { sql } : {}),
          related: { table: t.id, columns: covering.columns },
        }),
      );
    });
  }

  const ignored = (model.config.health?.ignore ?? []).map(parseHealthIgnore);
  const silenced = (f) => ignored.some((x) => x.rule === f.rule && x.table === f.table && (!x.column || (f.columns ?? []).includes(x.column)));
  const severity = (f) => HEALTH_SEVERITIES.indexOf(f.severity);
  return findings
    .filter((f) => !silenced(f))
    .sort((a, b) => severity(a) - severity(b) || compareStrings(a.table, b.table) || compareStrings(a.rule, b.rule) || compareStrings((a.columns ?? []).join(','), (b.columns ?? []).join(',')));
}

/**
 * The findings about what `shown` (a profile's model) still holds: found on
 * the full model, so a hidden table does not leave its neighbours looking
 * orphaned, then narrowed so no finding names a hidden table or column, in
 * its message or its SQL.
 */
export function healthFor(findings, shown) {
  const columns = new Map(shown.tables.map((t) => [t.id, new Set(columnEntries(t).map((e) => e.path))]));
  const present = (table, names = []) => columns.has(table) && names.every((c) => columns.get(table).has(c));
  return findings.filter((f) => present(f.table, f.columns) && (!f.related || present(f.related.table, f.related.columns)));
}

/** "3 health findings (2 medium, 1 low)", or null when there are none. */
export function healthSummary(findings) {
  if (findings.length === 0) return null;
  const counts = HEALTH_SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length]).filter(([, n]) => n > 0);
  return `${findings.length} health finding${findings.length === 1 ? '' : 's'} (${counts.map(([s, n]) => `${n} ${s}`).join(', ')})`;
}
