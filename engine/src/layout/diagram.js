import { centralTables } from '../model/centrality.js';
import { TIMESTAMP_TYPE } from '../model/columns.js';
import { compareStrings } from '../model/load.js';
import { VIEWS_DEFAULTS } from '../model/schema.js';
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
export const leastTrusted = (values, order) => values.reduce((a, b) => (order.indexOf(b) > order.indexOf(a) ? b : a));

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

// The relations drawn as badges: hub references that cut across domains.
// Inside the hub table's own domain a hub reference is that domain's
// structure, so it stays a line; and a table whose every relation is a hub
// reference keeps its lines, or it would float with nothing drawn to it.
function badgeRelations(model) {
  const tables = new Map(model.tables.map((t) => [t.id, t]));
  const hub = model.relations.filter(
    (r) => isHub(model.config, r) && clusterKey(tables.get(r.from.table)) !== clusterKey(tables.get(r.to.table)),
  );
  const linked = new Set([
    ...model.relations.filter((r) => !hub.includes(r)).flatMap((r) => [r.from.table, r.to.table]),
    ...model.polymorphic.flatMap((a) => [a.table, ...a.targets]),
  ]);
  return hub.filter((r) => linked.has(r.from.table));
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

/** Id of the many-to-many line drawn for join table `joinId` with keys `a` and `b` (see joinTables). */
export const collapsedLinkId = (joinId, a, b) => `${a.to.table}(${a.to.columns.join(',')})<-${joinId}->${b.to.table}(${b.to.columns.join(',')})`;

function collapsedLink(joinId, [a, b]) {
  return {
    id: collapsedLinkId(joinId, a, b),
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

// Prose and code parts of a fact line: identifiers and values from the
// schema are `code`, so outputs can set them apart from the words around.
const prose = (text) => ({ text, code: false });
const code = (text) => ({ text, code: true });
// Lines a table box gives to the polymorphic associations pointing at it.
export const POLY_FACT_LIMIT = 3;

/** The plain text of a fact given as parts (see tableFacts). */
export const factText = (parts) => parts.map((p) => p.text).join('');

/**
 * One short line per special pattern a table carries, shown at the bottom
 * of its box and in the viewer, each as a list of parts { text, code }.
 * `tenancy` is the tenant_schemas entry of the table's schema, if any. A
 * unique index over several columns gets a line too: it is a business rule
 * ("one entry per user and lesson") a reader looks for on the box.
 * `pointedBy` are the polymorphic associations listing the table as a
 * target: the box names their id columns, since no line is drawn to it; past
 * POLY_FACT_LIMIT lines the rest is counted (the viewer's Relations tab
 * lists them all).
 */
export function tableFacts(t, tenancy, pointedBy = []) {
  const facts = [];
  if (t.sti) facts.push([prose('STI on '), code(t.sti.column), prose(': '), code(t.sti.subclasses.join(', '))]);
  if (t.partition) {
    const by = t.partition.interval ?? t.partition.method;
    facts.push([prose('partitioned by '), code(by), prose(' on '), code(t.partition.columns.join(', '))]);
  }
  for (const index of t.indexes ?? []) {
    if (index.unique && index.columns.length > 1) facts.push([prose('unique ('), code(index.columns.join(', ')), prose(')')]);
  }
  if (tenancy) facts.push(tenancy.count ? [code(`× ${tenancy.count}`), prose(` ${tenancy.count === 1 ? 'tenant' : 'tenants'}`)] : [prose('one copy per tenant')]);
  if (t.generated_by) facts.push([prose('generated by '), code(t.generated_by)]);
  const named = pointedBy.length > POLY_FACT_LIMIT ? pointedBy.slice(0, POLY_FACT_LIMIT - 1) : pointedBy;
  for (const a of named) facts.push([prose('polymorphic from '), code(`${a.table.split('.').slice(2).join('.')}.${a.id_column}`)]);
  if (named.length < pointedBy.length) facts.push([prose(`and ${pointedBy.length - named.length} more polymorphic`)]);
  return facts;
}

/**
 * Key columns per table id: `fk` the columns that reference another table
 * (the `from` end of any relation, hub relations included, and the id
 * column of a polymorphic association), `indexed` the columns in any index.
 */
export function keyColumns(model) {
  const keys = new Map(model.tables.map((t) => [t.id, { fk: new Set(), indexed: new Set((t.indexes ?? []).flatMap((i) => i.columns)) }]));
  for (const r of model.relations) for (const c of r.from.columns) keys.get(r.from.table)?.fk.add(c);
  for (const a of model.polymorphic) keys.get(a.table)?.fk.add(a.id_column);
  return keys;
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
 * hubLinks: the relations drawn as badges (badgeRelations), same shape, in id order. They are badges in
 *   every box; the viewer lists them and draws them only on demand (a hub
 *   table selected, its neighborhood), so a central table still shows what
 *   points at it.
 * clusters: Map cluster key -> node ids
 * centralOf: Map cluster key -> id of its central table (see centrality.js)
 * mostCentral: id of the drawn table with the highest centrality score (ties
 *   by id), where the viewer opens the view of all tables; null when no
 *   table has a link
 * views: the whole-schema view switches, `views` of open-erd.yaml over
 *   VIEWS_DEFAULTS
 */
export function buildDiagram(model) {
  const hubRelations = badgeRelations(model);
  const drawn = new Set(model.relations.filter((r) => !hubRelations.includes(r)));
  const joins = model.config.collapse_join_tables ? joinTables(model, drawn) : new Map();
  const badges = hubBadges(hubRelations);

  const tenancy = new Map(
    model.databases.flatMap((db) => (db.tenant_schemas ?? []).map((t) => [`${db.database}.${t.schema}`, t])),
  );
  const nodes = new Map();
  const keys = keyColumns(model);
  const drawnTables = model.tables.filter((t) => !joins.has(t.id));
  const pointedBy = new Map();
  for (const a of [...model.polymorphic].sort((x, y) => compareStrings(`${x.table}.${x.id_column}`, `${y.table}.${y.id_column}`))) {
    for (const target of a.targets) pointedBy.set(target, [...(pointedBy.get(target) ?? []), a]);
  }
  const clusterOf = new Map(drawnTables.map((t) => [t.id, clusterKey(t)]));
  const centrality = centralTables(model, clusterOf.keys(), (id) => clusterOf.get(id));
  for (const t of drawnTables) {
    const [db, schema] = t.id.split('.');
    const tenant = tenancy.get(`${db}.${schema}`) ?? null;
    const facts = tableFacts(t, tenant, pointedBy.get(t.id));
    const central = centrality.central.has(t.id);
    const box = tableBox(t, badges.get(t.id), facts, { ...keys.get(t.id), central });
    nodes.set(t.id, { id: t.id, kind: 'table', cluster: clusterKey(t), box, table: t, facts, tenant, central });
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
  // The central table of each domain, for the overview's domain boxes.
  const centralOf = centrality.byCluster;
  const [mostCentral = null] = drawnTables
    .map((t) => t.id)
    .filter((id) => centrality.scores.get(id) > 0)
    .sort((a, b) => centrality.scores.get(b) - centrality.scores.get(a) || compareStrings(a, b));
  const views = { ...VIEWS_DEFAULTS, ...model.config.views };
  return { nodes, links, hubLinks, clusters: new Map([...clusters].sort(([a], [b]) => compareStrings(a, b))), centralOf, mostCentral, views };
}

/** Id of the pair of domains `a` and `b`, whatever their order (`a<->a` for a domain with itself). */
function domainLinkId(a, b) {
  return compareStrings(a, b) <= 0 ? `${a}<->${b}` : `${b}<->${a}`;
}

/**
 * Relations grouped by pair of domains, whichever way they point, a domain
 * with itself included (relations inside one domain). Ends are in id order
 * (`from` sorts before `to`); each relation keeps its own direction. A
 * polymorphic association counts once per target, since that is where its
 * rows point; a collapsed join table is one n-n relation, from its first
 * key's table to its second. Hub relations are left out, as in every other
 * view: a hub is declared precisely so that it does not count as structure.
 *
 * Each pair carries the relations it stands for (`relations`, in id order),
 * which the viewer lists by direction:
 *   { id, from: { table, column }, to, cardinality, optional, kind, review, via?, association? }
 */
export function domainPairs(diagram) {
  const pairs = new Map();
  const add = (owner, target, relation) => {
    const [a, b] = [diagram.nodes.get(owner).cluster, diagram.nodes.get(target).cluster];
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
    // References between rows only; a view reading a table is not one.
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

/** The pairs of two different domains (see domainPairs): what ties domains together. */
export function domainLinks(diagram) {
  return domainPairs(diagram).filter((p) => p.from.node !== p.to.node);
}
