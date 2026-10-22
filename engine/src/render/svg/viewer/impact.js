// Impact of changing a table or one of its columns: the tables that depend
// on it, ring by ring. Pure and DOM-free over the viewer data of an erd.svg:
// the viewer draws the rings, node:test checks them.
//
// The graph is the join path finder's (joinGraph): every relation as an
// edge from the referencing table to the referenced one, a collapsed join
// table as its two relations from the join table, a polymorphic
// association as one edge per target, hub relations included, plus a
// view's line to each table it reads. The rings walk it backwards:
//   ring 1  tables referencing the target: for a table every relation
//           pointing at it, for a column only the relations whose key
//           includes that column (a view names no columns, so it counts for
//           a table only);
//   ring 2+ tables referencing a table of the previous ring, by any
//           relation: a referencing table is taken as affected as a whole,
//           so deeper rings may list more than a change really reaches.
// A table is listed once, in the smallest ring it reaches. Self-references
// add nothing. A hub table (referenced from everywhere, drawn as badges) is
// a full target, but met in a ring it is not walked further: everything
// referencing a hub would flood the next ring, and what changed in it is
// one of its referencing columns, not the key the others point at.
import { joinGraph } from './join-path.js';

export const IMPACT_DEPTH = 3;

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// The edges into each table, built once per viewer data.
const incomingCache = new WeakMap();
function incoming(data) {
  if (!incomingCache.has(data)) {
    const graph = joinGraph(data, { viewSources: true });
    const into = new Map();
    for (const e of graph.edges) {
      if (e.a === e.b) continue;
      if (!into.has(e.b)) into.set(e.b, []);
      into.get(e.b).push(e);
    }
    incomingCache.set(data, { into, hubs: graph.hubs });
  }
  return incomingCache.get(data);
}

/** Columns of `table` some relation points at (the keys a column-level impact can start from). */
export function referencedColumns(data, table) {
  return new Set((incoming(data).into.get(table) ?? []).flatMap((e) => e.bColumns));
}

/**
 * Rings of tables depending on `table` (or on its `column`), up to `depth`:
 * [[{ id, edges, hub }]]. `edges` are the join graph edges (see joinGraph)
 * from this table to the target or to tables of the previous ring that put
 * it in its ring, sorted by id; `hub` says the table is a hub left
 * unwalked. Ring 1 is in id order; each further table follows the earliest
 * table of the previous ring it references, so a branch stays together
 * around the circle. Empty rings at the end are dropped.
 */
export function impactRings(data, table, column = null, depth = IMPACT_DEPTH) {
  const { into, hubs } = incoming(data);
  const seen = new Set([table]);
  const rings = [];
  let previous = [table];
  for (let ring = 1; ring <= depth; ring++) {
    const found = new Map();
    previous.forEach((target, i) => {
      if (ring > 1 && hubs.has(target)) return;
      for (const e of into.get(target) ?? []) {
        if (seen.has(e.a)) continue;
        if (ring === 1 && column !== null && !e.bColumns.includes(column)) continue;
        if (!found.has(e.a)) found.set(e.a, { parent: i, edges: [] });
        found.get(e.a).edges.push(e);
      }
    });
    if (found.size === 0) break;
    const entries = [...found]
      .sort(([a, x], [b, y]) => x.parent - y.parent || cmp(a, b))
      .map(([id, { edges }]) => ({ id, edges: edges.sort((x, y) => cmp(x.id, y.id)), hub: ring < depth && hubs.has(id) }));
    for (const t of entries) seen.add(t.id);
    rings.push(entries);
    previous = entries.map((t) => t.id);
  }
  return rings;
}
