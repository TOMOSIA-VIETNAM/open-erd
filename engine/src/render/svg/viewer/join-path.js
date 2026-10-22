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
export const HOP_COST = 10;
export const TRUST_PENALTY = { trusted: 0, declared: 3, doubtful: 6 };
// Passing through a hub table (users, companies: referenced from
// everywhere) joins rows that share an audit user or a tenant, rarely what
// a reader means. Allowed, but as costly as several hops.
export const HUB_COST = 40;
export const MAX_PATHS = 3;

const VIEW_SOURCE = 'view_source';
const POLYMORPHIC = 'polymorphic';

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Trust class of a fact, shared with the line styles of the drawing.
export { trustOf };

const pkColumns = (node) => (node?.columns ?? []).filter((c) => c.pk).map((c) => c.name);

/**
 * Edges of the join graph, sorted by id:
 *   { id, a, aColumns, b, bColumns, cardinality (a to b), kind, review,
 *     line: { type: 'link' | 'hub' | 'poly', id, poly?, target? },
 *     typeColumn? (polymorphic: the owner's column to filter on) }
 * and `hubs`, the tables hub relations point at.
 */
export function joinGraph(data) {
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

/** Cost of a path: its hops, plus HUB_COST for each hub table it passes through. */
function pathCost(graph, nodes, edges) {
  return edges.reduce((n, e) => n + edgeCost(e), 0) + nodes.slice(1, -1).filter((n) => graph.hubs.has(n)).length * HUB_COST;
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
// by), so such a pair of hops is never taken.
const polyLine = (e) => (e?.line.type === 'poly' ? e.line.id : '');
const stateKey = (node, e) => `${node}\u0000${polyLine(e)}`;

// Cheapest path from `source` to `target` avoiding the banned nodes and
// edges; among equal costs the smallest by comparePaths. Labels hold whole
// paths: two paths reaching the same state compare by their prefix, which
// appending the same hop never reorders.
function cheapest(graph, adj, source, target, bannedNodes, bannedEdges, entered = null) {
  const best = new Map([[stateKey(source, entered), { nodes: [source], edges: [], cost: 0 }]]);
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
    for (const { e, other } of adj.get(at) ?? []) {
      if (bannedNodes.has(other) || bannedEdges.has(e.id) || label.nodes.includes(other)) continue;
      if (polyLine(e) && polyLine(e) === polyLine(last)) continue;
      const key = stateKey(other, e);
      if (done.has(key)) continue;
      const hub = other !== target && graph.hubs.has(other) ? HUB_COST : 0;
      const next = { nodes: [...label.nodes, other], edges: [...label.edges, e], cost: label.cost + edgeCost(e) + hub };
      if (!best.has(key) || comparePaths(next, best.get(key)) < 0) best.set(key, next);
    }
  }
}

const sameStart = (p, nodes, edges) =>
  nodes.every((n, i) => p.nodes[i] === n) && edges.every((e, i) => p.edges[i]?.id === e.id);

/**
 * Up to `limit` cheapest simple paths from table `from` to table `to`
 * (Yen's k-shortest paths), cheapest first, ties by table and edge ids:
 * the same data always gives the same list. Each path is
 * { cost, nodes: [table ids], hops: [hop] }, see describeHop.
 */
export function findJoinPaths(data, from, to, limit = MAX_PATHS) {
  if (from === to) return [];
  const graph = joinGraph(data);
  const adj = adjacency(graph);
  const first = cheapest(graph, adj, from, to, new Set(), new Set());
  if (!first) return [];
  const found = [first];
  const candidates = [];
  while (found.length < limit) {
    const previous = found.at(-1);
    for (let i = 0; i < previous.nodes.length - 1; i++) {
      const rootNodes = previous.nodes.slice(0, i + 1);
      const rootEdges = previous.edges.slice(0, i);
      const bannedEdges = new Set(found.filter((p) => sameStart(p, rootNodes, rootEdges)).map((p) => p.edges[i].id));
      const spur = cheapest(graph, adj, rootNodes[i], to, new Set(rootNodes.slice(0, -1)), bannedEdges, rootEdges.at(-1));
      if (!spur) continue;
      const nodes = [...rootNodes.slice(0, -1), ...spur.nodes];
      const edges = [...rootEdges, ...spur.edges];
      const path = { nodes, edges, cost: pathCost(graph, nodes, edges) };
      if (![...found, ...candidates].some((p) => p.edges.length === edges.length && sameStart(p, nodes, edges))) candidates.push(path);
    }
    if (candidates.length === 0) break;
    candidates.sort(comparePaths);
    found.push(candidates.shift());
  }
  return found.map((p) => ({ cost: p.cost, nodes: p.nodes, hops: p.edges.map((e, i) => describeHop(e, p.nodes[i], graph)) }));
}

const dbOf = (id) => id.split('.')[0];

/**
 * One hop walked from table `at`: { from, to, pairs: [[from column, to
 * column], ...] in key order, edge, flags }. Flags:
 *   { type: 'trust', text: 'inferred' | 'pending review' | 'stale' }
 *   { type: 'cross_db' }  the two tables are in different databases
 *   { type: 'polymorphic', column }  rows of `column`'s table point at
 *     several tables: filter on that type column
 *   { type: 'multiplies' }  one row on the `from` side meets many on the
 *     `to` side, so the join repeats `from` rows
 *   { type: 'hub', table }  `to` is a hub table the path passes through
 */
export function describeHop(edge, at, graph) {
  const forward = edge.a === at;
  const [from, to] = forward ? [edge.a, edge.b] : [edge.b, edge.a];
  const [fromColumns, toColumns] = forward ? [edge.aColumns, edge.bColumns] : [edge.bColumns, edge.aColumns];
  const flags = [];
  // A reviewed inference is a confirmed fact.
  if (edge.kind === 'inferred' && edge.review !== 'reviewed') flags.push({ type: 'trust', text: 'inferred' });
  else if (edge.review === 'pending') flags.push({ type: 'trust', text: 'pending review' });
  if (edge.review === 'stale') flags.push({ type: 'trust', text: 'stale' });
  if (dbOf(from) !== dbOf(to)) flags.push({ type: 'cross_db' });
  if (edge.typeColumn) flags.push({ type: 'polymorphic', table: edge.a, column: edge.typeColumn });
  // cardinality is "<a side>-<b side>": walking to the side marked n repeats rows.
  const [aSide, bSide] = (edge.cardinality ?? '1-1').split('-');
  if ((forward ? bSide : aSide) === 'n') flags.push({ type: 'multiplies' });
  return { from, to, pairs: fromColumns.map((c, i) => [c, toColumns[i]]), edge, flags, hub: graph?.hubs.has(to) ?? false };
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
 * The conditions of a path as plain text, one hop per line, for the Copy
 * button. A polymorphic hop says which type column to filter on, without a
 * value: the stored value depends on the application. Never SQL.
 */
export function conditionsText(path) {
  const name = pathNames(path.nodes);
  return path.hops
    .map((h) => {
      const poly = h.flags.find((f) => f.type === 'polymorphic');
      return `${hopCondition(h, name)}${poly ? ` (filter by ${name(poly.table)}.${poly.column})` : ''}`;
    })
    .join('\n');
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

// Comment lines above a JOIN, one per thing to check before running it.
const SQL_NOTES = {
  trust: (f) => `verify: ${f.text}`,
  polymorphic: (f, name) => `add filter on ${name(f.table)}.${f.column}`,
  multiplies: (f, name, hop) => `rows repeat: one ${name(hop.from)} row matches many ${name(hop.to)} rows`,
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
