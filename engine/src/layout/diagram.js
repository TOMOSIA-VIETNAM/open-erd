import { compareStrings } from '../model/load.js';
import { clusterKey } from './clusters.js';
import { polyBox, tableBox } from './table-box.js';

// What the diagram draws, derived from the model once so layout and render
// can never disagree on it: which tables are boxes, which relations are
// lines, which become hub badges, and the virtual polymorphic nodes.

// Columns a join table may carry besides its two foreign keys and still count
// as "pure". Matched on type, not name, because stacks name them differently
// (created_at, inserted_at, createdAt).
const TIMESTAMP_TYPE = /^(timestamp|timestamptz|datetime|date|time)\b/i;

// When one drawn line stands for several relations it takes the least
// certain kind and review state among them, so collapsing never hides doubt.
const KIND_TRUST = ['db_fk', 'declared', 'cross_db', 'inferred'];
const REVIEW_TRUST = ['reviewed', 'pending', 'stale'];
const leastTrusted = (values, order) => values.reduce((a, b) => (order.indexOf(b) > order.indexOf(a) ? b : a));

function relationId(r) {
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

// Tables made of exactly two n-1 foreign keys (plus timestamps) that nothing
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

function polyLink(a) {
  return {
    id: `${a.table}(${a.id_column})->«${a.name}»`,
    from: { node: a.table, column: a.id_column },
    to: { node: polyNodeId(a), column: null },
    cardinality: 'n-1',
    optional: a.optional,
    kind: 'polymorphic',
    review: a.review,
  };
}

/**
 * nodes: Map id -> { id, kind: 'table'|'poly', cluster, box, table?, association? }
 * links: lines between nodes, [{ id, from: { node, column }, to, cardinality,
 *   optional, kind, review, via? }] in id order
 * clusters: Map cluster key -> node ids
 */
export function buildDiagram(model) {
  const hubRelations = model.relations.filter((r) => isHub(model.config, r));
  const drawn = new Set(model.relations.filter((r) => !hubRelations.includes(r)));
  const joins = model.config.collapse_join_tables ? joinTables(model, drawn) : new Map();
  const badges = hubBadges(hubRelations);

  const nodes = new Map();
  for (const t of model.tables) {
    if (joins.has(t.id)) continue;
    nodes.set(t.id, { id: t.id, kind: 'table', cluster: clusterKey(t), box: tableBox(t, badges.get(t.id)), table: t });
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
  ].sort((a, b) => compareStrings(a.id, b.id));

  const clusters = new Map();
  for (const n of [...nodes.values()].sort((a, b) => compareStrings(a.id, b.id))) {
    if (!clusters.has(n.cluster)) clusters.set(n.cluster, []);
    clusters.get(n.cluster).push(n.id);
  }
  return { nodes, links, clusters: new Map([...clusters].sort(([a], [b]) => compareStrings(a, b))) };
}

/**
 * Relations between domains for the overview, one entry per pair of
 * clusters in key order. A polymorphic association counts once per target,
 * since that is where its rows point. Hub relations are left out, as in every
 * other view: a hub is declared precisely so that it does not draw lines.
 */
export function domainLinks(diagram) {
  const pairs = new Map();
  const add = (a, b, review) => {
    if (a === b) return;
    const [from, to] = compareStrings(a, b) < 0 ? [a, b] : [b, a];
    const key = `${from}\u0000${to}`;
    if (!pairs.has(key)) pairs.set(key, { from, to, count: 0, reviews: [] });
    const p = pairs.get(key);
    p.count += 1;
    p.reviews.push(review);
  };
  for (const l of diagram.links) {
    const owner = diagram.nodes.get(l.from.node).cluster;
    if (l.kind === 'polymorphic') {
      const a = diagram.nodes.get(l.to.node).association;
      for (const t of a.targets) {
        const target = diagram.nodes.get(t);
        if (target) add(owner, target.cluster, l.review);
      }
    } else {
      add(owner, diagram.nodes.get(l.to.node).cluster, l.review);
    }
  }
  return [...pairs.values()]
    .sort((a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to))
    .map((p) => ({
      id: `${p.from}<->${p.to}`,
      from: { node: p.from, column: null },
      to: { node: p.to, column: null },
      count: p.count,
      kind: p.from.split('/')[0] === p.to.split('/')[0] ? 'domain' : 'cross_db',
      review: leastTrusted(p.reviews, REVIEW_TRUST),
    }));
}
