import { compareStrings } from './load.js';

// A central table is the one a domain is built around: the table with the
// most links, drawn with a stronger header and placed in the middle of its
// domain by a fresh layout. "Clearly more connected" is measured against the
// whole schema so a small, evenly linked domain gets none.
//
// Score of a table: every relation it is an end of counts 1 (hub relations
// included: a hub table is central to whatever points at it; a
// self-reference counts once), every polymorphic association it owns counts
// 1, and every association targeting it counts 1.
//
// A table is central when its score is at least CENTRAL_MIN_LINKS and at
// least CENTRAL_MEDIAN_FACTOR times the median score of all tables, and
//   - it has the strictly highest score of its domain (a tie means the
//     domain has no single centre, so none), or
//   - it is among the CENTRAL_GLOBAL_TOP highest scores of the schema
//     (ties broken by id), which lets a domain with two hubs show both.
export const CENTRAL_MIN_LINKS = 5;
export const CENTRAL_MEDIAN_FACTOR = 2;
export const CENTRAL_GLOBAL_TOP = 3;

/** Score per table id, as described above. */
export function centralityScores(model) {
  const scores = new Map(model.tables.map((t) => [t.id, 0]));
  const add = (id) => scores.has(id) && scores.set(id, scores.get(id) + 1);
  for (const r of model.relations) {
    add(r.from.table);
    if (r.to.table !== r.from.table) add(r.to.table);
  }
  for (const a of model.polymorphic) {
    add(a.table);
    for (const t of a.targets) add(t);
  }
  return scores;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Central tables among `candidates` (table ids drawn as boxes, each with
 * its cluster key in `clusterOf`). Returns { scores, central: Set of ids,
 * byCluster: Map cluster key -> its highest-scoring central table }.
 */
export function centralTables(model, candidates, clusterOf) {
  const scores = centralityScores(model);
  const ids = [...candidates].sort(compareStrings);
  const threshold = Math.max(CENTRAL_MIN_LINKS, CENTRAL_MEDIAN_FACTOR * median(model.tables.map((t) => scores.get(t.id))));
  const strong = ids.filter((id) => scores.get(id) >= threshold);
  const ranked = (list) => [...list].sort((a, b) => scores.get(b) - scores.get(a) || compareStrings(a, b));
  const central = new Set(ranked(strong).slice(0, CENTRAL_GLOBAL_TOP));
  const clusters = new Map();
  for (const id of ids) {
    const key = clusterOf(id);
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(id);
  }
  for (const members of clusters.values()) {
    const [top, next] = ranked(members);
    if (scores.get(top) >= threshold && (next === undefined || scores.get(next) < scores.get(top))) central.add(top);
  }
  const byCluster = new Map();
  for (const [key, members] of [...clusters].sort(([a], [b]) => compareStrings(a, b))) {
    const [best] = ranked(members.filter((id) => central.has(id)));
    if (best) byCluster.set(key, best);
  }
  return { scores, central, byCluster };
}
