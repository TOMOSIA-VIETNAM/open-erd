import { TIMESTAMP_TYPE } from '../model/columns.js';
import { compareStrings } from '../model/load.js';
import { clusterKey } from './clusters.js';
import { polyBox, tableBox } from './table-box.js';

// What the diagram draws, derived from the model once so layout and render
// can never disagree on it: which tables are boxes, which relations are
// lines, which become hub badges, and the virtual polymorphic nodes.

// When one drawn line stands for several relations it takes the least
// certain kind and review state among them, so collapsing never hides doubt.
// The review checklist walks them in the reverse order: least certain first.
export const KIND_TRUST = ['db_fk', 'declared', 'cross_db', 'inferred'];
export const REVIEW_TRUST = ['reviewed', 'pending', 'stale'];
const leastTrusted = (values, order) => values.reduce((a, b) => (order.indexOf(b) > order.indexOf(a) ? b : a));

/** Id of the line drawn for relation `r`. */
export function relationId(r) {
  return `${r.from.table}(${r.from.columns.join(',')})->${r.to.table}(${r.to.columns.join(',')})`;
}

/** Node id of the virtual node of a polymorphic association. */
export function polyNodeId(association) {
  return `${association.table}«${association.name}»`;
}

function isHub(config, r) {
  const hub = config.hub ?? {};
  return (hub.tables ?? []).includes(r.to.table) || r.from.columns.some((c) => (hub.columns ?? []).includes(c));
}

// Hub relations grouped per referencing table and hub target, in id order.
function hubBadges(hubRelations) {
  const byTable = new Map();
  for (const r of hubRelations) {
    if (!byTable.has(r.from.table)) byTable.set(r.from.table, new Map());
    const targets = byTable.get(r.from.table);
    if (!targets.has(r.to.table)) targets.set(r.to.table, []);
    targets.get(r.to.table).push(...r.from.columns);
  }
  const badges = new Map();
  for (const [table, targets] of byTable) {
    badges.set(
      table,
      [...targets]
        .sort(([a], [b]) => compareStrings(a, b))
        .map(([target, columns]) => ({ target, count: columns.length, columns: [...columns].sort(compareStrings) })),
    );
  }
  return badges;
}

// Tables made of exactly two n-1 foreign keys (plus timestamp columns, which a
// join table may carry and still count as "pure") that nothing
// references, that own no polymorphic association, and whose keys are drawn
// as lines (a key to a hub stays a badge, so its table is kept).
function joinTables(model, drawn) {
  const result = new Map();
  for (const t of model.tables) {
    const out = model.relations.filter((r) => r.from.table === t.id);
    if (out.length !== 2 || out.some((r) => r.cardinality !== 'n-1' || r.to.table === t.id || !drawn.has(r))) continue;
    if (model.relations.some((r) => r.to.table === t.id)) continue;
    if (model.polymorphic.some((a) => a.table === t.id || a.targets.includes(t.id))) continue;
    const keys = new Set(out.flatMap((r) => r.from.columns));
    if (t.columns.every((c) => keys.has(c.name) || TIMESTAMP_TYPE.test(c.type))) result.set(t.id, out);
  }
  return result;
}

function relationLink(r) {
  return {
    id: relationId(r),
    from: { node: r.from.table, column: r.from.columns[0] },
    to: { node: r.to.table, column: r.to.columns[0] },
    cardinality: r.cardinality,
    optional: r.optional,
    kind: r.kind,
    review: r.review,
  };
}

function collapsedLink(joinId, [a, b]) {
  return {
    id: `${a.to.table}(${a.to.columns.join(',')})<-${joinId}->${b.to.table}(${b.to.columns.join(',')})`,
    from: { node: a.to.table, column: a.to.columns[0] },
    to: { node: b.to.table, column: b.to.columns[0] },
    // Either side may have any number of rows on the other, including none.
    cardinality: 'n-n',
    optional: true,
    kind: leastTrusted([a.kind, b.kind], KIND_TRUST),
    review: leastTrusted([a.review, b.review], REVIEW_TRUST),
    via: joinId,
  };
}

// A view's dependency on a table it reads: drawn muted and dashed, without
// crow's feet (it is not a reference between rows), from the view's header
// to the source's header.
export const VIEW_SOURCE = 'view_source';
function viewSourceLinks(t) {
  return (t.sources ?? []).map((source) => ({
    id: `${t.id}=>${source}`,
    from: { node: t.id, column: null },
    to: { node: source, column: null },
    cardinality: null,
    optional: true,
    kind: VIEW_SOURCE,
    review: 'reviewed',
  }));
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * One short line per special pattern a table carries, shown at the bottom
 * of its box and in the viewer. `tenancy` is the tenant_schemas entry of the
 * table's schema, if any.
 */
export function tableFacts(t, tenancy) {
  const facts = [];
  if (t.sti) facts.push(`STI on ${t.sti.column}: ${t.sti.subclasses.join(', ')}`);
  if (t.partition) {
    const by = t.partition.interval ?? t.partition.method;
    facts.push(`partitioned by ${by} on ${t.partition.columns.join(', ')}`);
  }
  for (const key of t.unique ?? []) facts.push(`unique (${key.join(', ')})`);
  if (tenancy) facts.push(tenancy.count ? `× ${plural(tenancy.count, 'tenant')}` : 'one copy per tenant');
  if (t.generated_by) facts.push(`generated by ${t.generated_by}`);
  return facts;
}

/** Notes printed on a database frame: its topology and tenant schemas. */
export function databaseFacts(db) {
  const facts = [];
  const topology = db.topology ?? {};
  const parts = [topology.replicas && plural(topology.replicas, 'replica'), topology.shards && plural(topology.shards, 'shard')].filter(Boolean);
  if (parts.length > 0) facts.push(parts.join(' · '));
  for (const t of db.tenant_schemas ?? []) {
    facts.push(t.count ? `schema ${t.schema} × ${plural(t.count, 'tenant')}` : `schema ${t.schema}: one copy per tenant`);
  }
  return facts;
}

/** Id of the line from a polymorphic association's table to its virtual node. */
export function polyLinkId(a) {
  return `${a.table}(${a.id_column})->«${a.name}»`;
}

function polyLink(a) {
  return {
    id: polyLinkId(a),
    from: { node: a.table, column: a.id_column },
    to: { node: polyNodeId(a), column: null },
    cardinality: 'n-1',
    optional: a.optional,
    kind: 'polymorphic',
    review: a.review,
  };
}

/**
 * nodes: Map id -> { id, kind: 'table'|'poly', cluster, box, table?, facts?,
 *   tenant?, association? }
 * links: lines between nodes, [{ id, from: { node, column }, to, cardinality,
 *   optional, kind, review, via? }] in id order
 * hubLinks: the hub relations, same shape, in id order. They are badges in
 *   every box; the viewer lists them and draws them only on demand (a hub
 *   table selected, its neighborhood), so a central table still shows what
 *   points at it.
 * clusters: Map cluster key -> node ids
 */
export function buildDiagram(model) {
  const hubRelations = model.relations.filter((r) => isHub(model.config, r));
  const drawn = new Set(model.relations.filter((r) => !hubRelations.includes(r)));
  const joins = model.config.collapse_join_tables ? joinTables(model, drawn) : new Map();
  const badges = hubBadges(hubRelations);

  const tenancy = new Map(
    model.databases.flatMap((db) => (db.tenant_schemas ?? []).map((t) => [`${db.database}.${t.schema}`, t])),
  );
  const nodes = new Map();
  for (const t of model.tables) {
    if (joins.has(t.id)) continue;
    const [db, schema] = t.id.split('.');
    const tenant = tenancy.get(`${db}.${schema}`) ?? null;
    const facts = tableFacts(t, tenant);
    nodes.set(t.id, { id: t.id, kind: 'table', cluster: clusterKey(t), box: tableBox(t, badges.get(t.id), facts), table: t, facts, tenant });
  }
  const tablesById = new Map(model.tables.map((t) => [t.id, t]));
  for (const a of model.polymorphic) {
    const id = polyNodeId(a);
    nodes.set(id, { id, kind: 'poly', cluster: clusterKey(tablesById.get(a.table)), box: polyBox(a), association: a });
  }

  const links = [
    ...[...drawn].filter((r) => !joins.has(r.from.table)).map(relationLink),
    ...[...joins].map(([id, pair]) => collapsedLink(id, pair)),
    ...model.polymorphic.map(polyLink),
    // A join table collapsed into a line is never a view source target:
    // views read tables, and a collapsed table is no longer drawn.
    ...model.tables.flatMap(viewSourceLinks).filter((l) => nodes.has(l.from.node) && nodes.has(l.to.node)),
  ].sort((a, b) => compareStrings(a.id, b.id));

  const clusters = new Map();
  for (const n of [...nodes.values()].sort((a, b) => compareStrings(a.id, b.id))) {
    if (!clusters.has(n.cluster)) clusters.set(n.cluster, []);
    clusters.get(n.cluster).push(n.id);
  }
  // A hub relation whose referencing table was collapsed as a join table is
  // impossible: a join table's keys are drawn lines by definition.
  const hubLinks = hubRelations.map(relationLink).sort((a, b) => compareStrings(a.id, b.id));
  return { nodes, links, hubLinks, clusters: new Map([...clusters].sort(([a], [b]) => compareStrings(a, b))) };
}

/** Id of the overview line between domains `a` and `b`, whatever their order. */
export function domainLinkId(a, b) {
  return compareStrings(a, b) <= 0 ? `${a}<->${b}` : `${b}<->${a}`;
}

/**
 * Relations between domains for the overview: one line per pair of domains,
 * whichever way its relations point, so two domains are joined by one line
 * however they reference each other. Ends are in id order (`from` sorts
 * before `to`); each relation keeps its own direction. A polymorphic
 * association counts once per target, since that is where its rows point; a
 * collapsed join table is one n-n relation, from its first key's table to its
 * second. Hub relations are left out, as in every other view: a hub is
 * declared precisely so that it does not draw lines.
 *
 * Each line carries the relations it stands for (`relations`, in id order),
 * which the viewer lists by direction when the line is clicked:
 *   { id, from: { table, column }, to, cardinality, optional, kind, review, via? }
 */
export function domainLinks(diagram) {
  const pairs = new Map();
  const add = (owner, target, relation) => {
    const [a, b] = [diagram.nodes.get(owner).cluster, diagram.nodes.get(target).cluster];
    if (a === b) return;
    const id = domainLinkId(a, b);
    if (!pairs.has(id)) pairs.set(id, { id, ends: [a, b].sort(compareStrings), relations: [] });
    pairs.get(id).relations.push(relation);
  };
  const entry = (l, from, column, to, extra = {}) => ({
    id: l.id,
    from: { table: from, column },
    to,
    cardinality: l.cardinality,
    optional: l.optional,
    kind: l.kind,
    review: l.review,
    ...extra,
  });
  for (const l of diagram.links) {
    // The overview counts references between rows; a view reading a table
    // is not one.
    if (l.kind === VIEW_SOURCE) continue;
    if (l.kind === 'polymorphic') {
      const a = diagram.nodes.get(l.to.node).association;
      for (const t of a.targets) {
        if (diagram.nodes.has(t)) add(a.table, t, entry(l, a.table, a.id_column, t, { association: a.name }));
      }
    } else {
      add(l.from.node, l.to.node, entry(l, l.from.node, l.from.column, l.to.node, l.via ? { via: l.via } : {}));
    }
  }
  return [...pairs.values()]
    .sort((a, b) => compareStrings(a.id, b.id))
    .map(({ id, ends: [a, b], relations }) => ({
      id,
      from: { node: a, column: null },
      to: { node: b, column: null },
      count: relations.length,
      kind: a.split('/')[0] === b.split('/')[0] ? 'domain' : 'cross_db',
      relations: [...relations].sort((x, y) => compareStrings(x.id, y.id) || compareStrings(x.to, y.to)),
    }));
}
