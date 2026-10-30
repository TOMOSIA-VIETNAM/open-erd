import { clusterKey } from '../layout/clusters.js';
import { LAYOUT_SCHEMA_VERSION } from '../layout/layout-file.js';
import { collapsedLinkId, isHubAssociation, polyLinkId, polyNodeId, relationId } from '../layout/diagram.js';
import { compareStrings } from '../model/load.js';
import { describeChange, summarize } from './changes.js';

// What the diff diagram draws: one model holding both sides, and which of
// its nodes, columns and lines changed. Everything of the "to" side is drawn
// as it is now; what the "to" side lost (tables, columns, relations,
// polymorphic associations) is added back so it can be drawn as removed.

const DIFF_STATUSES = ['added', 'removed', 'changed', 'renamed'];

const TABLE_CONTENT = /^(table_changed|entity_|column_|enum_)/;
const withoutRename = ({ renamed_from, ...rest }) => rest;
const columnWithoutRename = (c) => (c.renamed_from === undefined ? c : withoutRename(c));

// The "to" table with the columns and embedded documents it lost appended,
// so their rows can be drawn struck through.
function withRemoved(to, from, changes) {
  const lost = changes.filter((c) => c.table === to.id && (c.kind === 'column_removed' || c.kind === 'entity_removed'));
  const table = { ...withoutRename(to), columns: to.columns.map(columnWithoutRename) };
  if (to.embedded) table.embedded = to.embedded.map((e) => ({ ...e, columns: e.columns.map(columnWithoutRename) }));
  for (const c of lost) {
    const [entityName, name] = c.column.includes('.') ? c.column.split('.') : [null, c.column];
    if (c.kind === 'entity_removed') {
      table.embedded = [...(table.embedded ?? []), from.embedded.find((e) => e.name === c.column)];
    } else if (!entityName) {
      table.columns = [...table.columns, from.columns.find((col) => col.name === name)];
    } else {
      const old = from.embedded.find((e) => e.name === entityName).columns.find((col) => col.name === name);
      table.embedded = table.embedded.map((e) => (e.name === entityName ? { ...e, columns: [...e.columns, old] } : e));
    }
  }
  return table;
}

/**
 * The union model of a diff (see diffModels for `result`), with
 * `renamed_from` dropped: every renamed table is already under its new id,
 * and layout must not carry old positions onto it a second time.
 */
export function unionModel(from, to, result) {
  const old = new Map([...result.tables].map(([a, b]) => [b, a]));
  const fromById = new Map(from.tables.map((t) => [t.id, t]));
  const tables = to.tables.map((t) => (old.has(t.id) ? withRemoved(t, fromById.get(old.get(t.id)), result.changes) : withoutRename(t)));
  for (const t of from.tables) if (!result.tables.has(t.id)) tables.push(withoutRename(t));
  const removed = (kind) => result.changes.filter((c) => c.kind === kind);
  const dbs = new Set(to.databases.map((d) => d.database));
  return {
    config: to.config,
    databases: [...to.databases, ...from.databases.filter((d) => !dbs.has(d.database))].sort((a, b) => compareStrings(a.database, b.database)),
    tables: tables.sort((a, b) => compareStrings(a.id, b.id)),
    relations: [...to.relations, ...removed('relation_removed').map((c) => c.relation)].sort((a, b) => compareStrings(relationId(a), relationId(b))),
    polymorphic: [...to.polymorphic, ...removed('polymorphic_removed').map((c) => c.association)].sort(
      (a, b) => compareStrings(a.table, b.table) || compareStrings(a.name, b.name),
    ),
  };
}

/**
 * Positions to lay the union model out from: every entry of the "to"
 * layout, plus the "from" entries the "to" layout does not have, so a
 * removed table starts where it used to be. `computeLayout` then separates
 * whatever overlaps by the usual stability rules.
 */
export function mergeLayouts(fromLayout, toLayout) {
  const views = {};
  for (const layout of [fromLayout, toLayout]) {
    for (const [name, view] of Object.entries(layout?.views ?? {})) {
      views[name] ??= { clusters: {} };
      for (const [slot, members] of Object.entries(view.clusters)) {
        views[name].clusters[slot] = { ...views[name].clusters[slot], ...members };
      }
    }
  }
  return { schema_version: LAYOUT_SCHEMA_VERSION, colors: { ...fromLayout?.colors, ...toLayout?.colors }, views };
}

const push = (map, key, value) => {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
};

/**
 * Per drawn element of the union model, what changed:
 *   nodes      Map node id (table, polymorphic node, overview domain) -> status
 *   columns    Map table id -> Map column path -> status
 *   links      Map line id -> status
 *   sentences  { nodes: Map node id -> [sentence], links: Map line id -> [sentence] }
 *   near       Set of node ids (tables, overview domains) with no status of
 *              their own but at the end of a changed line, or holding such a table
 *   counts     { tables, columns, relations }: tables with a status, then
 *              the column and relation totals of the summary line
 * A status is one of DIFF_STATUSES. A table is "changed" when its own
 * fields, columns or enums changed, or a hub association it owns (a badge,
 * see isHubAssociation) changed; relation changes colour the line and
 * are listed on both end tables.
 */
export function diffMarks(union, changes) {
  const nodes = new Map();
  const columns = new Map();
  const links = new Map();
  const sentences = { nodes: new Map(), links: new Map() };
  // Tables at the end of a changed line that hold no sentence of it.
  const lineEnds = new Set();
  const setColumn = (table, path, status) => {
    if (!columns.has(table)) columns.set(table, new Map());
    // Renamed and removed say more than changed.
    if (status !== 'changed' || !columns.get(table).has(path)) columns.get(table).set(path, status);
  };
  const tablesById = new Map(union.tables.map((t) => [t.id, t]));
  for (const c of changes) {
    const text = describeChange(c);
    if (c.kind === 'table_added' || c.kind === 'table_removed') nodes.set(c.table, c.kind === 'table_added' ? 'added' : 'removed');
    else if (c.kind === 'table_renamed') nodes.set(c.table, 'renamed');
    else if (TABLE_CONTENT.test(c.kind) && !nodes.has(c.table)) nodes.set(c.table, 'changed');

    if (c.kind === 'entity_added' || c.kind === 'entity_removed') {
      const entity = tablesById.get(c.table).embedded.find((e) => e.name === c.column);
      for (const col of entity.columns) setColumn(c.table, `${c.column}.${col.name}`, c.kind === 'entity_added' ? 'added' : 'removed');
    } else if (c.kind.startsWith('column_') || c.kind.startsWith('enum_')) {
      setColumn(c.table, c.column, { column_added: 'added', column_removed: 'removed', column_renamed: 'renamed' }[c.kind] ?? 'changed');
    }

    if (c.relation) {
      const id = relationId(c.relation);
      links.set(id, { relation_added: 'added', relation_removed: 'removed' }[c.kind] ?? 'changed');
      push(sentences.links, id, text);
      // A join table's two keys are drawn as one many-to-many line (see
      // joinTables in layout/diagram.js), which then shows the change. Ids
      // of pairs that are not drawn that way are never looked up.
      const join = c.relation.from.table;
      for (const other of union.relations.filter((r) => r.from.table === join && relationId(r) !== id)) {
        for (const line of [collapsedLinkId(join, c.relation, other), collapsedLinkId(join, other, c.relation)]) {
          if (!links.has(line)) links.set(line, 'changed');
          push(sentences.links, line, text);
        }
        lineEnds.add(other.to.table);
      }
      push(sentences.nodes, c.relation.from.table, text);
      if (c.relation.to.table !== c.relation.from.table) push(sentences.nodes, c.relation.to.table, text);
    } else if (c.association && isHubAssociation(union.config, c.association)) {
      // Drawn as a badge on its owner: the owner's box shows the change.
      if (!nodes.has(c.table)) nodes.set(c.table, 'changed');
      push(sentences.nodes, c.table, text);
    } else if (c.association) {
      const status = { polymorphic_added: 'added', polymorphic_removed: 'removed' }[c.kind] ?? 'changed';
      nodes.set(polyNodeId(c.association), status);
      links.set(polyLinkId(c.association), status);
      for (const id of [polyNodeId(c.association), c.table]) push(sentences.nodes, id, text);
      push(sentences.links, polyLinkId(c.association), text);
    } else if (c.table) {
      push(sentences.nodes, c.table, text);
    }
  }
  // An overview domain is added or removed when all its tables are, changed
  // when any of them changed.
  const byCluster = new Map();
  for (const t of union.tables) push(byCluster, clusterKey(t), nodes.get(t.id));
  for (const [key, list] of byCluster) {
    if (list.every((s) => s === 'added')) nodes.set(key, 'added');
    else if (list.every((s) => s === 'removed')) nodes.set(key, 'removed');
    else if (list.some((s) => s !== undefined)) nodes.set(key, 'changed');
  }
  const near = new Set();
  for (const t of union.tables) {
    if (nodes.has(t.id) || !(sentences.nodes.has(t.id) || lineEnds.has(t.id))) continue;
    near.add(t.id);
    if (!nodes.has(clusterKey(t))) near.add(clusterKey(t));
  }
  const { columnsChanged, relationsChanged } = summarize(changes);
  const counts = { tables: union.tables.filter((t) => nodes.has(t.id)).length, columns: columnsChanged, relations: relationsChanged };
  return { nodes, columns, links, sentences, near, counts };
}
