import { isCollection, isMap, isSeq, parseDocument, visit } from 'yaml';
import { possibleRenames } from '../diff/changes.js';
import { columnEntries } from './columns.js';
import { indexKey, indexPath, relationPath } from './facts.js';
import { compareStrings } from './load.js';
import { CROSS_DB_FILE, DOMAIN_VIEW_PREFIX } from './schema.js';

// Applies the mechanical part of compareFacts' deltas to the model files,
// without a person or an AI: tables, columns and indexes added or removed,
// column attributes, and relations a database constraint backs (`db_fk`)
// added or removed. Anything that needs a decision is left as it is and
// listed for `/open-erd:sync`:
//   - a removed table that looks like an added one (possible rename), and
//     either side of that pair;
//   - a table or column something else still uses (a relation not removed
//     with it, a polymorphic association, a view, sti/partition, a config
//     list), or one a reviewed relation or polymorphic association uses;
//   - a reviewed relation the facts no longer back, and any change of a
//     relation's kind (declared vs db_fk);
//   - columns of embedded documents, tables of a database or schema the
//     model does not have, facts the engine could not read;
//   - every added table, which goes into UNASSIGNED_DOMAIN until sync picks
//     its domain and writes its notes.
// Edits go through the yaml Document API, so comments and each node's
// flow or block style survive; only edited files are re-serialized.

export const UNASSIGNED_DOMAIN = 'Unassigned';
const SYNC = '/open-erd:sync';

// Order of fields in a column written from scratch or completed.
const COLUMN_ORDER = ['name', 'type', 'nullable', 'pk', 'unique', 'default', 'auto_increment'];
const FLAG_FIELDS = new Set(['pk', 'unique', 'auto_increment']);
// An index as the model writes it: fields in schema order.
const modelIndex = (i) => ({ ...(i.name ? { name: i.name } : {}), columns: i.columns, ...(i.unique ? { unique: true } : {}), ...(i.where ? { where: i.where } : {}), ...(i.using ? { using: i.using } : {}) });

const usesColumn = (end, table, column) => end.table === table && end.columns.includes(column);
const touches = (r, table) => r.from.table === table || r.to.table === table;
const reviewed = (x) => x.review === 'reviewed';

/**
 * Applies `deltas` (from compareFacts on `model`) to workspace `files`
 * (`{ relativePath: text }`, as readWorkspaceFiles returns them). Returns
 * `{ files, applied, needsSync }`: `files` the model files that changed,
 * with their new text; `applied` the deltas applied; `needsSync` sorted
 * `{ path, reason }` for what is left to `/open-erd:sync`.
 */
export function applyFacts(files, model, deltas) {
  const needsSync = [];
  const defer = (path, reason) => needsSync.push({ path, reason });
  const applied = [];
  const scoped = (change, scope) => deltas.filter((d) => d.change === change && d.scope === scope);
  const fileOf = new Map(model.databases.map((d) => [d.database, d.file]));
  const tablesById = new Map(model.tables.map((t) => [t.id, t]));
  for (const d of deltas.filter((x) => x.change === 'error')) defer(d.path, d.message);

  // Relations first: whether one goes decides whether what it uses can go.
  const goneRelations = new Set();
  for (const d of scoped('removed', 'relation')) {
    if (reviewed(d.before)) {
      defer(d.path, `reviewed relation no longer backed by a constraint: ${SYNC} marks it stale`);
      continue;
    }
    goneRelations.add(d.path);
    applied.push(d);
  }
  for (const d of scoped('changed', 'relation')) defer(d.path, `kind ${d.before} in the model, ${d.after} in the facts: ${SYNC} decides`);
  const staying = (r) => !goneRelations.has(relationPath(r.from, r.to));
  const protectedBy = (table, column) =>
    model.relations.some((r) => reviewed(r) && (usesColumn(r.from, table, column) || usesColumn(r.to, table, column))) ||
    model.polymorphic.some((a) => reviewed(a) && a.table === table && (a.type_column === column || a.id_column === column));

  // Tables.
  const guesses = possibleRenames(scoped('removed', 'table').map((d) => d.before), scoped('added', 'table').map((d) => d.after));
  const renamePartner = new Map(guesses.flatMap((g) => [[g.added, g.removed], [g.removed, g.added]]));
  const addedTables = new Map();
  for (const d of scoped('added', 'table')) {
    const [db, schema] = d.table.split('.');
    if (renamePartner.has(d.table)) defer(d.path, `possibly renamed from ${renamePartner.get(d.table)}: ${SYNC} asks`);
    else if (schema === '?') defer(d.path, 'database has several schemas: give the schema of this table in the facts');
    else if (!fileOf.has(db)) defer(d.path, `database ${db} is not in the model: ${SYNC} adds it`);
    else {
      const { columns, indexes } = d.after;
      addedTables.set(d.table, { id: d.table, domain: UNASSIGNED_DOMAIN, columns, ...(indexes ? { indexes: indexes.map(modelIndex) } : {}) });
      applied.push(d);
      defer(d.path, `new table, put in domain ${UNASSIGNED_DOMAIN}: ${SYNC} picks its domain and writes notes`);
    }
  }
  const goneTables = new Set();
  for (const d of scoped('removed', 'table')) {
    if (renamePartner.has(d.table)) {
      defer(d.path, `possibly renamed to ${renamePartner.get(d.table)}: ${SYNC} asks`);
      continue;
    }
    // A constraint goes with its table; any other relation is a decision.
    const relations = model.relations.filter((r) => touches(r, d.table) && staying(r));
    const cascade = relations.filter((r) => r.kind === 'db_fk' && !reviewed(r));
    const users = [...relations.filter((r) => !cascade.includes(r)).map((r) => `relation ${relationPath(r.from, r.to)}`), ...tableUsers(model, d.table, goneTables)];
    if (users.length > 0) {
      defer(d.path, `removed from the facts but still used by ${users.join('; ')}: ${SYNC} decides`);
      continue;
    }
    for (const r of cascade) goneRelations.add(relationPath(r.from, r.to));
    goneTables.add(d.table);
    applied.push(d);
  }

  // Columns and indexes of tables kept.
  const removedColumns = new Map();
  const addedColumns = new Map();
  const columnEdits = [];
  const indexRemovals = new Map();
  const indexAdds = [];
  const embedded = (d) => d.path.slice(d.table.length + 1).includes('.');
  for (const d of deltas.filter((x) => x.scope === 'column')) {
    const column = d.path.slice(d.table.length + 1);
    if (embedded(d)) defer(d.path, `column of an embedded document: ${SYNC} updates it`);
    else if (d.change === 'added') {
      addedColumns.set(d.table, [...(addedColumns.get(d.table) ?? []), d.after]);
      applied.push(d);
    } else if (d.change === 'changed') {
      if (protectedBy(d.table, column)) defer(d.path, `${d.field} changed on a column a reviewed relation uses: ${SYNC} marks it stale`);
      else {
        columnEdits.push(d);
        applied.push(d);
      }
    } else {
      const users = columnUsers(model, d.table, column, staying);
      if (protectedBy(d.table, column)) users.push('a reviewed relation');
      if (users.length > 0) defer(d.path, `removed from the facts but still used by ${users.join('; ')}: ${SYNC} decides`);
      else {
        removedColumns.set(d.table, [...(removedColumns.get(d.table) ?? []), column]);
        applied.push(d);
      }
    }
  }
  // An index on a dropped column is dropped with it.
  for (const [id, columns] of removedColumns) {
    for (const i of tablesById.get(id).indexes ?? []) if (i.columns.some((c) => columns.includes(c))) indexRemovals.set(`${id}\u0000${indexKey(i)}`, { table: id, index: i });
  }
  for (const d of deltas.filter((x) => x.scope === 'index')) {
    if (d.change === 'removed') indexRemovals.set(`${d.table}\u0000${indexKey(d.before)}`, { table: d.table, index: d.before });
    else if (d.change === 'added') indexAdds.push(d);
    else columnEdits.push(d);
    applied.push(d);
  }

  // Columns each table has once the above is applied.
  const columnsAfter = (id) => {
    const t = addedTables.get(id) ?? (goneTables.has(id) ? null : tablesById.get(id));
    if (!t) return null;
    const gone = removedColumns.get(id) ?? [];
    return [...columnEntries(t).map((e) => e.column).filter((c) => !gone.includes(c.name)), ...(addedColumns.get(id) ?? [])];
  };
  const addedRelations = [];
  for (const d of scoped('added', 'relation')) {
    const ends = [d.after.from, d.after.to].map((e) => ({ e, columns: columnsAfter(e.table) }));
    if (ends.some(({ e, columns }) => !columns || !e.columns.every((c) => columns.some((x) => x.name === c)))) {
      defer(d.path, `constraint on a table or column not applied here: ${SYNC} adds it`);
    } else if (d.after.evidence.length === 0) defer(d.path, `constraint without evidence in the facts: ${SYNC} adds it`);
    else {
      addedRelations.push(dbFkRelation(d.after, ends[0].columns, addedTables.get(d.after.from.table) ?? tablesById.get(d.after.from.table)));
      applied.push(d);
    }
  }

  // Edit the files. Only documents something was applied to are written.
  const docs = new Map();
  const edit = (path) => {
    if (!docs.has(path)) docs.set(path, parseDocument(files[path]));
    return docs.get(path);
  };
  const fileOfTable = (id) => fileOf.get(id.split('.')[0]);
  const tableNode = (id) => edit(fileOfTable(id)).get('tables').items.find((n) => n.get('id') === id);
  // First item of `key` in any table of the file, to copy its style.
  const sample = (path, key) => edit(path).get('tables').items.map((t) => t.get(key)?.items?.[0]).find(Boolean) ?? null;

  for (const id of goneTables) removeItems(edit(fileOfTable(id)), 'tables', (n) => n.get('id') === id);
  for (const t of [...addedTables.values()].sort((a, b) => compareStrings(a.id, b.id))) {
    const path = fileOfTable(t.id);
    const node = edit(path).createNode(t);
    for (const key of ['columns', 'indexes']) for (const item of node.get(key)?.items ?? []) flowUnless(item, sample(path, key));
    // Kept in id order when the file is.
    const tables = edit(path).get('tables');
    const at = tables.items.findIndex((n) => compareStrings(String(n.get('id')), t.id) > 0);
    tables.items.splice(at === -1 ? tables.items.length : at, 0, node);
  }
  for (const [id, columns] of removedColumns) removeItems(tableNode(id), 'columns', (n) => columns.includes(n.get('name')));
  for (const [id, columns] of addedColumns) {
    const seq = tableNode(id).get('columns');
    for (const c of columns) seq.items.push(styled(edit(fileOfTable(id)).createNode(c), seq.items[0]));
  }
  for (const d of columnEdits) {
    const node =
      d.scope === 'column'
        ? tableNode(d.table).get('columns').items.find((n) => n.get('name') === d.path.slice(d.table.length + 1))
        : tableNode(d.table).get('indexes').items.find((n) => `${d.table} index ${indexPath(n.toJSON())}` === d.path);
    setField(node, d.field, d.after);
  }
  for (const { table, index } of indexRemovals.values()) removeItems(tableNode(table), 'indexes', (n) => indexKey(n.toJSON()) === indexKey(index));
  for (const d of indexAdds) {
    const path = fileOfTable(d.table);
    const node = tableNode(d.table);
    if (!isSeq(node.get('indexes'))) node.set('indexes', edit(path).createNode([]));
    const seq = node.get('indexes');
    seq.items.push(flowUnless(edit(path).createNode(modelIndex(d.after)), seq.items[0] ?? sample(path, 'indexes')));
  }
  if (goneRelations.size > 0) {
    for (const path of [...model.databases.map((d) => d.file), CROSS_DB_FILE].filter((p) => files[p] !== undefined)) {
      const gone = (n) => goneRelations.has(relationPath(n.get('from').toJSON(), n.get('to').toJSON()));
      if (parseDocument(files[path]).get('relations')?.items?.some(gone)) removeItems(edit(path), 'relations', gone);
    }
  }
  for (const r of addedRelations) {
    const doc = edit(fileOfTable(r.from.table));
    if (!isSeq(doc.get('relations'))) doc.set('relations', doc.createNode([]));
    const seq = doc.get('relations');
    seq.items.push(flowUnless(doc.createNode(r), seq.items[0]));
  }
  dropEmptyDomains(model, docs, goneTables, fileOf);

  const changed = {};
  for (const [path, doc] of docs) changed[path] = serialize(doc, files[path]);
  needsSync.sort((a, b) => compareStrings(a.path, b.path) || compareStrings(a.reason, b.reason));
  return { files: changed, applied, needsSync };
}

/** A db_fk relation from a facts constraint, its cardinality and optionality read from the columns. */
function dbFkRelation(after, fromColumns, fromTable) {
  const columns = after.from.columns.map((name) => fromColumns.find((c) => c.name === name));
  const same = (list) => list.length === after.from.columns.length && list.every((c) => after.from.columns.includes(c));
  const pk = fromColumns.filter((c) => c.pk).map((c) => c.name);
  const unique =
    (columns.length === 1 && (columns[0].unique || columns[0].pk)) || same(pk) || (fromTable.indexes ?? []).some((i) => i.unique && !i.where && same(i.columns));
  return {
    from: after.from,
    to: after.to,
    cardinality: unique ? '1-1' : 'n-1',
    optional: columns.some((c) => c.nullable === true),
    kind: 'db_fk',
    evidence: [...after.evidence].sort(compareStrings),
    review: 'pending',
  };
}

/** What besides relations uses table `id`: polymorphic associations, views, config lists. */
function tableUsers(model, id, goneTables) {
  const users = [];
  for (const a of model.polymorphic) if (a.table === id || a.targets.includes(id)) users.push(`polymorphic «${a.name}» on ${a.table}`);
  for (const t of model.tables) if (!goneTables.has(t.id) && t.sources?.includes(id)) users.push(`view ${t.id}`);
  const c = model.config;
  const lists = [['hub', c.hub], ['hidden', c.hidden], ['ignore_missing', c.ignore_missing], ...Object.entries(c.profiles ?? {}).map(([name, p]) => [`profiles.${name}.hide`, p.hide])];
  for (const [name, list] of lists) if (list?.tables?.includes(id)) users.push(`${name}.tables in open-erd.yaml`);
  const table = model.tables.find((t) => t.id === id);
  const view = `${DOMAIN_VIEW_PREFIX}${id.split('.')[0]}/${table.domain}`;
  if (c.default_view === view && !model.tables.some((t) => t.id !== id && !goneTables.has(t.id) && `${DOMAIN_VIEW_PREFIX}${t.id.split('.')[0]}/${t.domain}` === view)) users.push('default_view in open-erd.yaml');
  return users;
}

/** What uses column `column` of table `table`, besides relations removed in this run. */
function columnUsers(model, table, column, staying) {
  const users = [];
  for (const r of model.relations) if (staying(r) && (usesColumn(r.from, table, column) || usesColumn(r.to, table, column))) users.push(`relation ${relationPath(r.from, r.to)}`);
  for (const a of model.polymorphic) if (a.table === table && (a.type_column === column || a.id_column === column)) users.push(`polymorphic «${a.name}»`);
  const t = model.tables.find((x) => x.id === table);
  if (t.sti?.column === column) users.push('sti');
  if (t.partition?.columns.includes(column)) users.push('partition');
  const ref = `${table}.${column}`;
  const c = model.config;
  const lists = [['hidden', c.hidden], ['ignore_missing', c.ignore_missing], ...Object.entries(c.profiles ?? {}).map(([name, p]) => [`profiles.${name}.hide`, p.hide])];
  for (const [name, list] of lists) if (list?.columns?.includes(ref)) users.push(`${name}.columns in open-erd.yaml`);
  return users;
}

/** Removes the items of `parent`'s sequence `key` that match; an optional list left empty is dropped. */
function removeItems(parent, key, match) {
  const seq = parent.get(key);
  if (!isSeq(seq)) return;
  seq.items = seq.items.filter((n) => !match(n));
  if (seq.items.length === 0 && (key === 'indexes' || key === 'relations')) parent.delete(key);
}

/**
 * `node` written flow or block like `sample`, a sibling item, down to the
 * values they share a key for (a block relation whose ends are flow maps).
 */
function styled(node, sample) {
  if (!isCollection(node) || !isCollection(sample)) return node;
  if (sample.flow) node.flow = true;
  if (isMap(node) && isMap(sample)) for (const pair of node.items) styled(pair.value, sample.get(pair.key, true));
  return node;
}

// With no sibling to copy, items are one flow map per line, as the model
// format's examples write them.
function flowUnless(node, sample) {
  if (sample) return styled(node, sample);
  node.flow = true;
  return node;
}

/** Sets `field` of a column or index node to `value` as compareFacts reports it (undefined = absent). */
function setField(node, field, value) {
  if (value === undefined || (FLAG_FIELDS.has(field) && value === false)) {
    node.delete(field);
    return;
  }
  if (node.has(field)) {
    node.set(field, value);
    return;
  }
  // A new field goes after the last field that precedes it in COLUMN_ORDER.
  const rank = (k) => (COLUMN_ORDER.includes(k) ? COLUMN_ORDER.indexOf(k) : COLUMN_ORDER.length);
  const pair = node.items.find((p) => rank(String(p.key)) > rank(field));
  node.set(field, value);
  if (pair) {
    const added = node.items.pop();
    node.items.splice(node.items.indexOf(pair), 0, added);
  }
}

/** Drops `domains` entries no table of their database is in any more. */
function dropEmptyDomains(model, docs, goneTables, fileOf) {
  for (const db of model.databases) {
    const doc = docs.get(fileOf.get(db.database));
    if (!doc || !db.domains) continue;
    const used = new Set(model.tables.filter((t) => t.id.startsWith(`${db.database}.`) && !goneTables.has(t.id)).map((t) => t.domain));
    for (const name of Object.keys(db.domains)) if (!used.has(name)) doc.deleteIn(['domains', name]);
    if (doc.get('domains')?.items?.length === 0) doc.delete('domains');
  }
}

/**
 * Text of edited `doc`, in the flow style of `original`: the yaml library
 * pads every flow collection (`{ a: 1 }`, `[ a ]`); a file that writes
 * flow maps or flow sequences without the inner spaces keeps them that way.
 */
function serialize(doc, original) {
  const padded = { Map: null, Seq: null };
  const look = (type) => (_, n) => {
    if (!n.flow || padded[type] !== null || !n.items.length || !n.range) return;
    padded[type] = original[n.range[0] + 1] === ' ';
  };
  visit(parseDocument(original), { Map: look('Map'), Seq: look('Seq') });
  const text = doc.toString({ lineWidth: 0 });
  const cuts = [];
  visit(parseDocument(text), {
    Map: (_, n) => n.flow && n.items.length && padded.Map === false && cuts.push(n.range[0] + 1, n.range[1] - 2),
    Seq: (_, n) => n.flow && n.items.length && padded.Seq === false && cuts.push(n.range[0] + 1, n.range[1] - 2),
  });
  let out = text;
  for (const at of cuts.sort((a, b) => b - a)) if (out[at] === ' ') out = out.slice(0, at) + out.slice(at + 1);
  return out;
}

/** The list of what is left to sync, as Markdown for a pull request comment. */
export function needsSyncMarkdown(needsSync) {
  if (needsSync.length === 0) return `Nothing left for \`${SYNC}\`.\n`;
  const cell = (s) => s.replaceAll('|', '\\|').replaceAll('\n', ' ');
  return [`**Left for \`${SYNC}\`** (${needsSync.length}):`, '', ...needsSync.map((n) => `- \`${cell(n.path)}\`: ${cell(n.reason)}`), ''].join('\n');
}
