import { columnEntries } from './columns.js';
import { compareStrings } from './load.js';
import { endText, renames } from './lock.js';

// Mechanical check of the model against the extract facts files
// (extract/facts/<source>.json): the structure a script reads from schema
// files must be in the model as the script saw it. Covers tables, columns
// (type, nullable, pk, unique, default, auto_increment), indexes and the
// relations a database constraint backs (facts `constraint: true` <=> model
// `kind: db_fk`). Notes, enum meanings, domains and relations without a
// constraint are written by a person or an AI and are not compared here.
//
// Facts files come from scripts written per project, so their shape varies:
// only the fields listed in `model.md` ("Extract facts file") are read, and
// a field is compared only when the file carries it somewhere (a script
// written before `default` existed does not report every default as gone).

export const COLUMN_FIELDS = ['type', 'nullable', 'pk', 'unique', 'default', 'auto_increment'];
const BOOLEAN_FIELDS = new Set(['nullable', 'pk', 'unique', 'auto_increment']);
const INDEX_FIELDS = ['name'];

export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/** A facts or model value as compared: booleans default to false, defaults are strings. */
export function value(field, v) {
  if (BOOLEAN_FIELDS.has(field)) return v === true;
  if (v === undefined || v === null) return undefined;
  return String(v);
}

/**
 * The parts of facts files the comparison reads, from `files` (`[{ file,
 * data }]`, data parsed JSON). Returns `{ tables, associations, fields,
 * errors }`: `tables` `{ file, source, database, schema, name, evidence,
 * columns, indexes }`, `associations` `{ file, from, to, constraint,
 * evidence }`, `fields` per file the column fields its script reports
 * (plus `indexes` when it reports indexes). Evidence gets the
 * `<source>:` prefix the model uses.
 */
export function readFacts(files) {
  const errors = [];
  const tables = [];
  const associations = [];
  const fields = new Map();
  for (const { file, data } of files) {
    if (!isObject(data) || !Array.isArray(data.tables)) {
      errors.push({ file, path: 'tables', message: 'must be an array of tables' });
      continue;
    }
    const source = typeof data.source === 'string' ? data.source : null;
    const evidence = (raw) => list(raw).filter((e) => typeof e === 'string').map((e) => (source ? `${source}:${e}` : e));
    const reported = new Set();
    const databaseOf = new Map();
    data.tables.forEach((t, i) => {
      const at = `tables[${i}]`;
      if (!isObject(t) || typeof t.name !== 'string' || !Array.isArray(t.columns)) {
        errors.push({ file, path: at, message: 'needs a name and a columns array' });
        return;
      }
      const columns = [];
      t.columns.forEach((c, k) => {
        if (!isObject(c) || typeof c.name !== 'string' || typeof c.type !== 'string') {
          errors.push({ file, path: `${at}.columns[${k}]`, message: 'needs a name and a type' });
          return;
        }
        for (const f of COLUMN_FIELDS) if (c[f] !== undefined && c[f] !== null) reported.add(f);
        // `generated` is kept for facts-diff; the model comparison does not read it.
        columns.push(Object.fromEntries([['name', c.name], ...COLUMN_FIELDS.map((f) => [f, c[f]]), ...(c.generated == null ? [] : [['generated', c.generated]])]));
      });
      // Older scripts write unique keys as `unique: [[a, b]]` on the table.
      const indexes = [
        ...list(t.indexes).filter((x) => isObject(x) && Array.isArray(x.columns)),
        ...list(t.unique).filter(Array.isArray).map((columns) => ({ columns, unique: true })),
      ].map((x) => ({ columns: x.columns, ...(x.name ? { name: x.name } : {}), ...(x.unique ? { unique: true } : {}), ...(x.where ? { where: x.where } : {}), ...(x.using ? { using: x.using } : {}) }));
      if (t.indexes !== undefined || t.unique !== undefined) reported.add('indexes');
      const database = t.database ?? data.database ?? null;
      databaseOf.set(t.name, database);
      tables.push({ file, source, database, schema: t.schema ?? null, name: t.name, evidence: evidence(t.evidence), columns, indexes });
    });
    fields.set(file, reported);
    list(data.associations).forEach((a, i) => {
      if (!isObject(a)) return;
      const end = (e) =>
        isObject(e) && typeof e.table === 'string' && Array.isArray(e.columns) ? { database: e.database ?? databaseOf.get(e.table) ?? data.database ?? null, table: e.table, columns: e.columns } : null;
      const [from, to] = [end(a.from), end(a.to)];
      if (!from || !to) {
        errors.push({ file, path: `associations[${i}]`, message: 'from and to need a table and columns' });
        return;
      }
      associations.push({ file, from, to, constraint: a.constraint === true, evidence: evidence(a.evidence) });
    });
  }
  return { tables, associations, fields, errors };
}

const relationPath = (from, to) => `${endText(from)} -> ${endText(to)}`;
// Identity of an index: what it covers and how, not its name.
export const indexKey = (i) => [i.columns.join(','), i.unique ? 'unique' : '', i.where ?? '', i.using ?? ''].join('\u0000');
export const indexPath = (i) => `(${i.columns.join(', ')})${i.unique ? ' unique' : ''}${i.where ? ` where ${i.where}` : ''}${i.using ? ` using ${i.using}` : ''}`;

/** A facts column in model form (only the fields the model writes). */
function modelColumn(c, reported) {
  const column = { name: c.name, type: c.type };
  for (const f of COLUMN_FIELDS.slice(1)) {
    if (!reported.has(f)) continue;
    const v = value(f, c[f]);
    if (BOOLEAN_FIELDS.has(f) ? v || f === 'nullable' : v !== undefined) column[f] = v;
  }
  return column;
}

/**
 * Differences between the structure in `model` (as loaded) and the facts
 * read by readFacts, as a sorted list of deltas. Each delta names what it
 * is about by model ids, never by array position, and carries what is
 * needed to apply it:
 *   { change: 'added' | 'removed' | 'changed',
 *     scope: 'table' | 'column' | 'index' | 'relation',
 *     table,            model table id (the from table of a relation)
 *     path,             `<table id>`, `<table id>.<column>`,
 *                       `<table id> index (<columns>)...`, `<from> -> <to>`
 *     field?,           changed: the attribute (`type`, `kind`, `name`, ...)
 *     before?, after?,  model value / facts value; for added and removed
 *                       the whole entry in model form (a table with its
 *                       columns and indexes, a column, an index, a relation
 *                       `{ from, to, kind, evidence }`)
 *     evidence? }       facts evidence of an added or changed entry
 * Only databases some facts table belongs to are compared. Left alone:
 * model tables with `generated_by` or of kind view / materialized_view the
 * facts do not list, facts tables named in `not_in_model` of open-erd.yaml,
 * the parent column of an embedded entity, and db_fk relations touching a
 * table the facts do not list or whose evidence includes `db` (database
 * metadata, which scripts do not read).
 * Facts listing a table the model renamed (`renamed_from`) follow the rename.
 * A delta about a `review: stale` relation or polymorphic association, or a
 * table or column one uses, is left out: the model keeps that fact on
 * purpose until a person decides.
 */
export function compareFacts(model, facts) {
  const deltas = [];
  const follow = renames(model);
  const modelDatabases = model.databases.map((d) => d.database);
  const resolveDb = (db) => db ?? (modelDatabases.length === 1 ? modelDatabases[0] : null);
  const byDbName = new Map();
  for (const t of model.tables) {
    const [db, , name] = t.id.split('.');
    const key = `${db}\u0000${name}`;
    byDbName.set(key, [...(byDbName.get(key) ?? []), t.id]);
  }
  const tablesById = new Map(model.tables.map((t) => [t.id, t]));
  // Schema an added table goes in: the one every table of its database shares.
  const schemaOf = (db) => {
    const schemas = new Set(model.tables.filter((t) => t.id.startsWith(`${db}.`)).map((t) => t.id.split('.')[1]));
    return schemas.size === 1 ? [...schemas][0] : null;
  };
  // Model id of a facts table: same database and name, in the schema the
  // facts give or (schema null) the one schema the model has it in.
  const idOf = (db, schema, name) => {
    if (!db) return { error: 'no database: set `database` on the table or the file' };
    if (schema) return { id: follow.table(`${db}.${schema}.${name}`) };
    const ids = (byDbName.get(`${db}\u0000${name}`) ?? []).filter((id) => tablesById.has(id));
    if (ids.length > 1) return { error: `matches several model tables (${ids.join(', ')}); give its schema in the facts`, ids };
    if (ids.length === 1) return { id: ids[0] };
    const renamed = model.tables.find((t) => t.renamed_from && t.renamed_from.split('.')[0] === db && t.renamed_from.split('.')[2] === name);
    if (renamed) return { id: renamed.id };
    const s = schemaOf(db);
    return { id: s ? `${db}.${s}.${name}` : `${db}.?.${name}` };
  };

  const ignored = new Set(model.config.not_in_model ?? []);
  const seen = new Set();
  // Model tables a facts table without a schema could be: not reported as
  // removed, since the facts may well list them.
  const ambiguous = new Set();
  const covered = new Set();
  for (const ft of facts.tables) {
    const db = resolveDb(ft.database);
    const { id, error, ids } = idOf(db, ft.schema, ft.name);
    if (error) {
      for (const candidate of ids ?? []) ambiguous.add(candidate);
      deltas.push({ change: 'error', scope: 'table', table: `${db ?? '?'}.?.${ft.name}`, path: `${ft.file}: ${ft.name}`, message: error });
      continue;
    }
    covered.add(db);
    if (ignored.has(id) || seen.has(id)) continue;
    seen.add(id);
    const reported = facts.fields.get(ft.file);
    const table = tablesById.get(id);
    if (!table) {
      const after = { id, columns: ft.columns.map((c) => modelColumn(c, reported)), ...(ft.indexes.length > 0 ? { indexes: ft.indexes } : {}) };
      deltas.push({ change: 'added', scope: 'table', table: id, path: id, after, evidence: ft.evidence });
      continue;
    }
    compareColumns(table, ft, reported, deltas);
    if (reported.has('indexes')) compareIndexes(table, ft, deltas);
  }

  for (const t of model.tables) {
    if (!covered.has(t.id.split('.')[0]) || seen.has(t.id) || ambiguous.has(t.id) || t.generated_by || (t.kind ?? 'table') !== 'table') continue;
    deltas.push({ change: 'removed', scope: 'table', table: t.id, path: t.id, before: t });
  }

  compareConstraints(model, facts, { resolveDb, idOf, seen, ignored }, deltas);
  const stale = staleNames(model);
  return deltas.filter((d) => !stale.has(d.path)).sort((a, b) => compareStrings(sortKey(a), sortKey(b)));
}

// What a `review: stale` fact names: the relation itself, and the tables
// and columns it uses. The model keeps such a fact as reviewed until a
// person decides, so the facts disagreeing with it is known, not news.
function staleNames(model) {
  const names = new Set();
  const column = (table, c) => names.add(table).add(`${table}.${c}`);
  for (const r of model.relations.filter((x) => x.review === 'stale')) {
    names.add(relationPath(r.from, r.to));
    for (const end of [r.from, r.to]) end.columns.forEach((c) => column(end.table, c));
  }
  for (const a of model.polymorphic.filter((x) => x.review === 'stale')) {
    [a.type_column, a.id_column].forEach((c) => column(a.table, c));
    a.targets.forEach((t) => names.add(t));
  }
  return names;
}

const SCOPES = ['error', 'table', 'column', 'index', 'relation'];
const sortKey = (d) => [SCOPES.indexOf(d.scope), d.table, d.path, d.field ?? '', d.change].join('\u0000');

function compareColumns(table, ft, reported, deltas) {
  const entries = new Map(columnEntries(table).map((e) => [e.path, e.column]));
  const entities = new Set((table.embedded ?? []).map((e) => e.name));
  const factsNames = new Set(ft.columns.map((c) => c.name));
  for (const c of ft.columns) {
    const path = `${table.id}.${c.name}`;
    const column = entries.get(c.name);
    if (!column) {
      // The parent column of an embedded entity is modelled as the entity.
      if (!entities.has(c.name)) deltas.push({ change: 'added', scope: 'column', table: table.id, path, after: modelColumn(c, reported), evidence: ft.evidence });
      continue;
    }
    for (const f of COLUMN_FIELDS) {
      if (!reported.has(f)) continue;
      // Uniqueness of a primary key is implied; scripts disagree on stating it.
      if (f === 'unique' && (column.pk || c.pk)) continue;
      const [before, after] = [value(f, column[f]), value(f, c[f])];
      if (before !== after) deltas.push({ change: 'changed', scope: 'column', table: table.id, path, field: f, before, after, evidence: ft.evidence });
    }
  }
  // An embedded entity's columns are compared only when the facts list them.
  for (const [name, column] of entries) {
    const entity = name.includes('.') ? name.split('.')[0] : null;
    if (factsNames.has(name) || (entity && ![...factsNames].some((n) => n.startsWith(`${entity}.`)))) continue;
    deltas.push({ change: 'removed', scope: 'column', table: table.id, path: `${table.id}.${name}`, before: column });
  }
}

function compareIndexes(table, ft, deltas) {
  const modelIndexes = new Map((table.indexes ?? []).map((i) => [indexKey(i), i]));
  const factsIndexes = new Map(ft.indexes.map((i) => [indexKey(i), i]));
  for (const [key, i] of factsIndexes) {
    const path = `${table.id} index ${indexPath(i)}`;
    const current = modelIndexes.get(key);
    if (!current) {
      deltas.push({ change: 'added', scope: 'index', table: table.id, path, after: i, evidence: ft.evidence });
      continue;
    }
    for (const f of INDEX_FIELDS) {
      if (i[f] !== undefined && current[f] !== i[f]) deltas.push({ change: 'changed', scope: 'index', table: table.id, path, field: f, before: current[f], after: i[f], evidence: ft.evidence });
    }
  }
  for (const [key, i] of modelIndexes) {
    if (!factsIndexes.has(key)) deltas.push({ change: 'removed', scope: 'index', table: table.id, path: `${table.id} index ${indexPath(i)}`, before: i });
  }
}

function compareConstraints(model, facts, { resolveDb, idOf, seen, ignored }, deltas) {
  const modelRelations = new Map();
  for (const r of model.relations) {
    const k = relationPath(r.from, r.to);
    if (!modelRelations.has(k)) modelRelations.set(k, r);
  }
  // Facts associations by model path; `constraint` true when any entry for
  // that path has one.
  const associations = new Map();
  // (database, table name) pairs of an association end that could not be
  // resolved to one model table: a model relation on such a table is not
  // known to be gone.
  const unresolved = new Set();
  for (const a of facts.associations) {
    const [fromDb, toDb] = [resolveDb(a.from.database), resolveDb(a.to.database)];
    // A constraint never spans databases; such an entry is not one.
    if (fromDb !== toDb) continue;
    const [from, to] = [a.from, a.to].map((e) => {
      const { id } = idOf(fromDb, null, e.table);
      if (!id) unresolved.add(`${fromDb}\u0000${e.table}`);
      return { table: id, columns: e.columns };
    });
    if (!from.table || !to.table || ignored.has(from.table) || ignored.has(to.table)) continue;
    const k = relationPath(from, to);
    const known = associations.get(k);
    if (!known || (a.constraint && !known.constraint)) associations.set(k, { from, to, constraint: a.constraint, evidence: a.evidence });
  }
  for (const [k, a] of associations) {
    if (!a.constraint) continue;
    const r = modelRelations.get(k);
    if (!r) deltas.push({ change: 'added', scope: 'relation', table: a.from.table, path: k, after: { from: a.from, to: a.to, kind: 'db_fk', evidence: a.evidence }, evidence: a.evidence });
    else if (r.kind !== 'db_fk') deltas.push({ change: 'changed', scope: 'relation', table: a.from.table, path: k, field: 'kind', before: r.kind, after: 'db_fk', evidence: a.evidence });
  }
  for (const r of model.relations) {
    const k = relationPath(r.from, r.to);
    if (r.kind !== 'db_fk' || associations.get(k)?.constraint || r.evidence.includes('db')) continue;
    // A table the facts do not list has its own delta, or is left alone.
    if (!seen.has(r.from.table) || !seen.has(r.to.table)) continue;
    if ([r.from.table, r.to.table].some((id) => unresolved.has(`${id.split('.')[0]}\u0000${id.split('.')[2]}`))) continue;
    // Still declared in code without a constraint, or gone from the code.
    const a = associations.get(k);
    if (a) deltas.push({ change: 'changed', scope: 'relation', table: r.from.table, path: k, field: 'kind', before: 'db_fk', after: 'declared', evidence: a.evidence });
    else deltas.push({ change: 'removed', scope: 'relation', table: r.from.table, path: k, before: r });
  }
}

const show = (v) => (v === undefined ? '(none)' : JSON.stringify(v));

/** One line per delta, as `verify` prints it. */
export function describeDelta(d) {
  if (d.change === 'error') return `${d.path}: ${d.message}`;
  if (d.change === 'changed') return `${d.scope} ${d.path}: ${d.field} ${show(d.before)} in the model, ${show(d.after)} in the facts`;
  const where = d.change === 'added' ? 'in the facts, missing from the model' : 'in the model, missing from the facts';
  return `${d.scope} ${d.path}: ${where}`;
}
