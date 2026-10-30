// Join paths between two tables, found in the viewer data of an erd.svg. Pure
// and DOM-free: the viewer calls it, node:test checks it.
//
// The graph is the model's relations as the viewer data carries them: every
// drawn line, a collapsed join table taken apart again into its two
// relations (so a path through it has a hop into and a hop out of the join
// table), each polymorphic association as one edge per target, and the hub
// relations drawn as badges. The data was filtered by the sharing profile
// before it was written, so a path can never use a hidden table or column.
import { trustOf } from '../markers.js';

// Cost of one hop, plus a penalty for each step down in trust: a database
// constraint or a reviewed fact costs nothing extra, an association the code
// declares a little, an inference (or a fact the code no longer supports)
// more. A path one hop longer still loses to any shorter one: the largest
// penalty stays below one hop.
const HOP_COST = 10;
const TRUST_PENALTY = { trusted: 0, declared: 3, doubtful: 6 };
// Passing through a hub table (users, companies: referenced from
// everywhere) joins rows that share an audit user or a tenant, rarely what
// a reader means. Allowed, but as costly as several hops.
export const HUB_COST = 40;
// Going up to a table both sides point at and back down (orders.company_id
// -> companies <- invoices.company_id) joins every row that shares the
// parent row: right for a join table (product_tags -> products <-
// order_items), often too wide for an owner. Counts as two hops, so a chain
// one hop longer through the rows themselves ranks first, whatever its trust.
export const SHARED_PARENT_COST = 20;
export const MAX_PATHS = 3;
// Paths exactly as short as the last of MAX_PATHS are listed too, since only
// the alphabetical tie-break would cut them, up to this many paths in all: a
// hub-heavy schema can tie dozens.
export const MAX_TIED_PATHS = 8;
// Paths taken in the search, variants of one route included: tables joined
// by several relations multiply the variants, and this bounds the work.
// ponytail: a fixed bound, may list fewer routes on a schema of many
// parallel relations; merge parallel edges before the search if it bites.
const MAX_SEARCHED = 64;

const VIEW_SOURCE = 'view_source';
const POLYMORPHIC = 'polymorphic';

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const pkColumns = (node) => (node?.columns ?? []).filter((c) => c.pk).map((c) => c.name);

/**
 * Edges of the join graph, sorted by id:
 *   { id, a, aColumns, b, bColumns, cardinality (a to b), kind, review,
 *     line: { type: 'link' | 'hub' | 'poly', id, poly?, target? },
 *     typeColumn? (polymorphic: the owner's column to filter on) }
 * and `hubs`, the tables hub relations point at. Every edge points from the
 * referencing table `a` to the referenced table `b`. A view's line to a
 * table it reads is no join and is left out.
 */
function joinGraph(data) {
  const edges = [];
  // Ids come from the data, never from its order, so ties break the same way
  // however the lists are ordered.
  const edge = (e, part = '') => edges.push({ ...e, id: `${e.line.id}${part}` });
  for (const l of data.links) {
    if (l.kind === VIEW_SOURCE) continue;
    if (l.kind === POLYMORPHIC) {
      const poly = data.nodes[l.to];
      for (const target of poly.targets) {
        const keys = pkColumns(data.nodes[target]);
        if (keys.length !== 1) continue;
        edge({ a: poly.table, aColumns: [poly.idColumn], b: target, bColumns: keys, cardinality: 'n-1', kind: POLYMORPHIC, review: l.review, typeColumn: poly.typeColumn, line: { type: 'poly', id: l.id, poly: l.to, target } }, `->${target}`);
      }
    } else if (l.via) {
      // Both relations of the collapsed join table point from it.
      for (const [i, end] of [[0, l.from], [1, l.to]]) {
        const hop = l.viaHops[i];
        edge({ a: l.via, aColumns: hop.fromColumns, b: end, bColumns: hop.toColumns, cardinality: hop.cardinality, kind: hop.kind, review: hop.review, line: { type: 'link', id: l.id } }, `#${i}`);
      }
    } else {
      edge({ a: l.from, aColumns: l.fromColumns, b: l.to, bColumns: l.toColumns, cardinality: l.cardinality, kind: l.kind, review: l.review, line: { type: 'link', id: l.id } });
    }
  }
  for (const l of data.hubLinks) {
    edge({ a: l.from, aColumns: l.fromColumns, b: l.to, bColumns: l.toColumns, cardinality: l.cardinality, kind: l.kind, review: l.review, line: { type: 'hub', id: l.id } });
  }
  edges.sort((x, y) => cmp(x.id, y.id));
  return { edges, hubs: new Set(data.hubLinks.map((l) => l.to)) };
}

const edgeCost = (e) => HOP_COST + TRUST_PENALTY[trustOf(e.kind, e.review)];

// Sides of edge `e` walked from table `at`, as [from side, to side] of its
// cardinality ("<a side>-<b side>").
const sides = (e, at) => {
  const [aSide, bSide] = (e.cardinality ?? '1-1').split('-');
  return e.a === at ? [aSide, bSide] : [bSide, aSide];
};
// Walking from many rows to the one they point at, or back down.
const goesUp = (e, at) => sides(e, at).join('-') === 'n-1';
const goesDown = (e, at) => sides(e, at).join('-') === '1-n';
// The path came up to `at` over `prev` (walked from `prevAt`) and goes back
// down over `e`.
const viaSharedParent = (prev, prevAt, e, at) => goesUp(prev, prevAt) && goesDown(e, at);

/**
 * Cost of a path: its hops, plus HUB_COST for each hub table it passes
 * through and SHARED_PARENT_COST for each table it goes up to and back down.
 */
function pathCost(graph, nodes, edges) {
  let cost = edges.reduce((n, e) => n + edgeCost(e), 0) + nodes.slice(1, -1).filter((n) => graph.hubs.has(n)).length * HUB_COST;
  for (let i = 1; i < edges.length; i++) if (viaSharedParent(edges[i - 1], nodes[i - 1], edges[i], nodes[i])) cost += SHARED_PARENT_COST;
  return cost;
}

// Equal costs are ordered by the tables, then the edges, along the path.
function comparePaths(p, q) {
  if (p.cost !== q.cost) return p.cost - q.cost;
  for (let i = 0; i < Math.max(p.nodes.length, q.nodes.length); i++) {
    const c = cmp(p.nodes[i] ?? '', q.nodes[i] ?? '') || cmp(p.edges[i]?.id ?? '', q.edges[i]?.id ?? '');
    if (c !== 0) return c;
  }
  return 0;
}

function adjacency(graph) {
  const adj = new Map();
  const add = (n, e, other) => {
    if (!adj.has(n)) adj.set(n, []);
    adj.get(n).push({ e, other });
  };
  for (const e of graph.edges) {
    if (e.a === e.b) continue;
    add(e.a, e, e.b);
    add(e.b, e, e.a);
  }
  return adj;
}

// A polymorphic owner row points at one target: walking in from one target
// and out to another over the same association would join rows that never
// meet. Search states are therefore (table, polymorphic line it was entered
// by, whether it was entered going up), so such a pair of hops is never
// taken and the cost of going back down is known.
const polyLine = (e) => (e?.line.type === 'poly' ? e.line.id : '');
const stateKey = (node, e, up) => `${node}\u0000${polyLine(e)}\u0000${up ? 1 : 0}`;

// Cheapest path from `source` to `target` avoiding the banned nodes and
// edges; among equal costs the smallest by comparePaths. Labels hold whole
// paths: two paths reaching the same state compare by their prefix, which
// appending the same hop never reorders.
function cheapest(graph, adj, source, target, bannedNodes, bannedEdges, entered = null, enteredFrom = null) {
  const best = new Map([[stateKey(source, entered, entered && goesUp(entered, enteredFrom)), { nodes: [source], edges: [], cost: 0 }]]);
  const done = new Set();
  // ponytail: linear scan for the next label, O(n^2) per search; a heap if a
  // schema of thousands of tables makes path finding feel slow.
  for (;;) {
    let current = null;
    for (const [key, label] of best) if (!done.has(key) && (!current || comparePaths(label, current.label) < 0)) current = { key, label };
    if (!current) return null;
    const { label } = current;
    const at = label.nodes.at(-1);
    if (at === target) return label;
    done.add(current.key);
    const last = label.edges.at(-1) ?? entered;
    const lastFrom = label.edges.length > 0 ? label.nodes.at(-2) : enteredFrom;
    for (const { e, other } of adj.get(at) ?? []) {
      if (bannedNodes.has(other) || bannedEdges.has(e.id) || label.nodes.includes(other)) continue;
      if (polyLine(e) && polyLine(e) === polyLine(last)) continue;
      const key = stateKey(other, e, goesUp(e, at));
      if (done.has(key)) continue;
      const hub = other !== target && graph.hubs.has(other) ? HUB_COST : 0;
      const parent = last && viaSharedParent(last, lastFrom, e, at) ? SHARED_PARENT_COST : 0;
      const next = { nodes: [...label.nodes, other], edges: [...label.edges, e], cost: label.cost + edgeCost(e) + hub + parent };
      if (!best.has(key) || comparePaths(next, best.get(key)) < 0) best.set(key, next);
    }
  }
}

const sameStart = (p, nodes, edges) =>
  nodes.every((n, i) => p.nodes[i] === n) && edges.every((e, i) => p.edges[i]?.id === e.id);
const sameRoute = (p, q) => p.nodes.length === q.nodes.length && p.nodes.every((n, i) => q.nodes[i] === n);

/**
 * The cheapest simple paths from table `from` to table `to` (Yen's
 * k-shortest paths), cheapest first, ties by table and edge ids: the same
 * data always gives the same list. One path per sequence of tables: a
 * variant joining some pair of them by another relation takes no place of
 * its own, its relation is listed on the hop (see describeHops). `limit`
 * routes, then those exactly as short as the last of them, up to `cap` in
 * all (no ties are added when `limit` is larger). Each path is { cost, nodes: [table ids], hops: [hop] }, see
 * describeHop.
 */
export function findJoinPaths(data, from, to, limit = MAX_PATHS, cap = MAX_TIED_PATHS) {
  if (from === to) return [];
  const graph = joinGraph(data);
  const adj = adjacency(graph);
  const first = cheapest(graph, adj, from, to, new Set(), new Set());
  if (!first) return [];
  // `found` holds every path taken, variants of one route included, since
  // Yen's spurs must avoid them all; `routes` the first of each route.
  const found = [first];
  const routes = [first];
  const candidates = [];
  while (routes.length < Math.max(limit, cap) && found.length < MAX_SEARCHED) {
    const previous = found.at(-1);
    for (let i = 0; i < previous.nodes.length - 1; i++) {
      const rootNodes = previous.nodes.slice(0, i + 1);
      const rootEdges = previous.edges.slice(0, i);
      const bannedEdges = new Set(found.filter((p) => sameStart(p, rootNodes, rootEdges)).map((p) => p.edges[i].id));
      const spur = cheapest(graph, adj, rootNodes[i], to, new Set(rootNodes.slice(0, -1)), bannedEdges, rootEdges.at(-1), rootNodes.at(-2));
      if (!spur) continue;
      const nodes = [...rootNodes.slice(0, -1), ...spur.nodes];
      const edges = [...rootEdges, ...spur.edges];
      const path = { nodes, edges, cost: pathCost(graph, nodes, edges) };
      if (![...found, ...candidates].some((p) => p.edges.length === edges.length && sameStart(p, nodes, edges))) candidates.push(path);
    }
    if (candidates.length === 0) break;
    candidates.sort(comparePaths);
    if (routes.length >= limit && candidates[0].cost !== routes.at(-1).cost) break;
    const next = candidates.shift();
    found.push(next);
    if (!routes.some((p) => sameRoute(p, next))) routes.push(next);
  }
  return routes.map((p) => ({ cost: p.cost, nodes: p.nodes, hops: describeHops(p.nodes, p.edges, graph) }));
}

/**
 * One path through tables `ids` in the order given: the cheapest path
 * between each pair of neighbours (a direct relation, when there is one, is
 * always the cheapest), joined end to end, in findJoinPaths' shape.
 * `{ path }`, or `{ gap: [from, to] }` naming the first pair no path joins.
 */
export function pathThrough(data, ids) {
  const path = { cost: 0, nodes: [ids[0]], hops: [] };
  for (let i = 1; i < ids.length; i++) {
    const [best] = findJoinPaths(data, ids[i - 1], ids[i], 1, 1);
    if (!best) return { gap: [ids[i - 1], ids[i]] };
    path.cost += best.cost;
    path.nodes.push(...best.nodes.slice(1));
    path.hops.push(...best.hops);
  }
  return { path };
}

const dbOf = (id) => id.split('.')[0];

/**
 * One hop walked from table `at`: { from, to, pairs: [[from column, to
 * column], ...] in key order, edge, flags }. Flags:
 *   { type: 'trust', text: 'inferred' | 'pending review' | 'stale', review? }
 *     `review` (pending | stale) when the flag is about the review state,
 *     which the viewer shows as an icon
 *   { type: 'cross_db' }  the two tables are in different databases
 *   { type: 'polymorphic', column }  rows of `column`'s table point at
 *     several tables: filter on that type column
 *   { type: 'multiplies' }  one row on the `from` side meets many on the
 *     `to` side, so the join repeats `from` rows
 *   { type: 'hub', table }  `to` is a hub table the path passes through
 *   { type: 'shared_parent', table }  set by describeHops: the path came up
 *     to `table` (= `from`) and goes back down, so it joins the rows that
 *     share one `table` row
 * describeHops adds `alternatives`: the other relations joining `from` and
 * `to`, as hops without alternatives, cheapest first, then by edge id.
 */
export function describeHop(edge, at, graph) {
  const forward = edge.a === at;
  const [from, to] = forward ? [edge.a, edge.b] : [edge.b, edge.a];
  const [fromColumns, toColumns] = forward ? [edge.aColumns, edge.bColumns] : [edge.bColumns, edge.aColumns];
  const flags = [];
  // A reviewed inference is a confirmed fact.
  if (edge.kind === 'inferred' && edge.review !== 'reviewed') flags.push({ type: 'trust', text: 'inferred' });
  else if (edge.review === 'pending') flags.push({ type: 'trust', text: 'pending review', review: 'pending' });
  if (edge.review === 'stale') flags.push({ type: 'trust', text: 'stale', review: 'stale' });
  if (dbOf(from) !== dbOf(to)) flags.push({ type: 'cross_db' });
  if (edge.typeColumn) flags.push({ type: 'polymorphic', table: edge.a, column: edge.typeColumn });
  // cardinality is "<a side>-<b side>": walking to the side marked n repeats rows.
  const [aSide, bSide] = (edge.cardinality ?? '1-1').split('-');
  if ((forward ? bSide : aSide) === 'n') flags.push({ type: 'multiplies' });
  return { from, to, pairs: fromColumns.map((c, i) => [c, toColumns[i]]), edge, flags, hub: graph?.hubs.has(to) ?? false };
}

// The hops of a path, each described from the table it leaves, with the
// other relations between the same two tables. A polymorphic association the
// hop next to it walks is no alternative: the path would enter its owner
// from one target and leave to another.
function describeHops(nodes, edges, graph) {
  return edges.map((e, i) => {
    const hop = describeHop(e, nodes[i], graph);
    if (i > 0 && viaSharedParent(edges[i - 1], nodes[i - 1], e, nodes[i])) hop.flags.push({ type: 'shared_parent', table: nodes[i] });
    const pair = new Set([nodes[i], nodes[i + 1]]);
    const near = new Set([polyLine(edges[i - 1]), polyLine(edges[i + 1])]);
    hop.alternatives = graph.edges
      .filter((x) => x.id !== e.id && x.a !== x.b && pair.has(x.a) && pair.has(x.b) && !(polyLine(x) && near.has(polyLine(x))))
      .sort((x, y) => edgeCost(x) - edgeCost(y) || cmp(x.id, y.id))
      .map((x) => describeHop(x, nodes[i], graph));
    return hop;
  });
}

/**
 * Names to print for the tables of a path: the table name, or the full id
 * when two tables of the path share a name (two databases or schemas).
 */
export function pathNames(nodes) {
  const short = (id) => id.split('.').slice(2).join('.') || id;
  const count = new Map();
  for (const id of new Set(nodes)) count.set(short(id), (count.get(short(id)) ?? 0) + 1);
  return (id) => (count.get(short(id)) > 1 ? id : short(id));
}

/** `a.x = b.y AND a.z = b.w` for one hop; `name` from pathNames. */
export function hopCondition(hop, name) {
  return hop.pairs.map(([f, t]) => `${name(hop.from)}.${f} = ${name(hop.to)}.${t}`).join(' AND ');
}

/**
 * Names for the tables of a path inside SQL: the table name, or
 * `schema.table` when two tables of the path share a name. Only for a path
 * within one database (see sqlSkeleton); a schema written `_` (an engine
 * without schemas) is never printed.
 */
export function sqlNames(nodes) {
  const table = (id) => id.split('.').slice(2).join('.');
  const count = new Map();
  for (const id of new Set(nodes)) count.set(table(id), (count.get(table(id)) ?? 0) + 1);
  return (id) => {
    const schema = id.split('.')[1];
    return count.get(table(id)) > 1 && schema !== '_' ? `${schema}.${table(id)}` : table(id);
  };
}

// What a hop from one row to many does: the SQL comment and the join
// panel's tooltip both say it.
export const rowsRepeat = (name, hop) => `one ${name(hop.from)} row matches many ${name(hop.to)} rows`;

// Comment lines above a JOIN, one per thing to check before running it.
const SQL_NOTES = {
  trust: (f) => `verify: ${f.text}`,
  polymorphic: (f, name) => `add filter on ${name(f.table)}.${f.column}`,
  multiplies: (f, name, hop) => `rows repeat: ${rowsRepeat(name, hop)}`,
};

/**
 * A starting point for a query along `path`: `SELECT *`, `FROM` the first
 * table, one INNER JOIN per hop (composite keys joined with AND), each risky
 * hop preceded by `-- ` comment lines. Nothing is guessed beyond the
 * conditions (no LEFT JOIN, no soft-delete filter, no type value).
 * Returns { sql } or, for a path spanning databases, { blocked: reason }.
 */
export function sqlSkeleton(path) {
  const dbs = [...new Set(path.nodes.map(dbOf))];
  if (dbs.length > 1) return { blocked: `The path spans ${dbs.length} databases (${dbs.join(', ')}): it cannot be one query. Join the results in the application.` };
  const name = sqlNames(path.nodes);
  const lines = ['-- Generated from the ERD: review before running', 'SELECT *', `FROM ${name(path.nodes[0])}`];
  for (const hop of path.hops) {
    for (const f of hop.flags) if (SQL_NOTES[f.type]) lines.push(`-- ${SQL_NOTES[f.type](f, name, hop)}`);
    lines.push(`JOIN ${name(hop.to)} ON ${hopCondition(hop, name)}`);
  }
  return { sql: lines.join('\n') };
}
