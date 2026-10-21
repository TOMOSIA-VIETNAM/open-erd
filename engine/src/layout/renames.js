import { compareStrings } from '../model/load.js';
import { polyNodeId } from './diagram.js';
import { ALL_VIEW, DOMAIN_VIEW_PREFIX, OVERVIEW, STUB_SLOT } from './views.js';

const add = (map, key, value) => {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
};

/**
 * Rewrites the previous layout.json so a table the user confirmed as renamed
 * (`renamed_from`) keeps its place instead of being removed and added again.
 *   - Its entry, and the entries of its polymorphic nodes, move to the new id
 *     in every view, as long as the table stays in the same cluster.
 *   - When every renamed table of a cluster that no longer exists lands in one
 *     new cluster (a renamed database: `shop.x.y` -> `store.x.y`), the cluster
 *     itself is renamed: its positions, its domain view, its overview box and
 *     its colour carry over.
 * A table renamed into another cluster is placed as a new table there: its old
 * coordinates belong to the other cluster's area.
 * Returns { layout, renamed: [[old id, new id]] } with the tables carried over.
 */
export function carryRenames(model, diagram, previous) {
  const current = new Set(model.tables.map((t) => t.id));
  const ids = new Map();
  for (const t of model.tables) {
    if (t.renamed_from && !current.has(t.renamed_from)) ids.set(t.renamed_from, t.id);
  }
  if (!previous || ids.size === 0) return { layout: previous, renamed: [] };
  const tableIds = [...ids];
  for (const a of model.polymorphic) {
    const pair = tableIds.find(([, now]) => now === a.table);
    if (pair) ids.set(polyNodeId({ ...a, table: pair[0] }), polyNodeId(a));
  }

  // Where each table was: the view of all tables, or, for a large schema
  // laid out without it, the domain views (each table in its own cluster).
  const hasAll = previous.views?.[ALL_VIEW] !== undefined;
  const ownSlot = (view, slot) => (hasAll ? view === ALL_VIEW : view.startsWith(DOMAIN_VIEW_PREFIX) && slot !== STUB_SLOT);
  const all = {};
  for (const [view, body] of Object.entries(previous.views ?? {})) {
    for (const [slot, members] of Object.entries(body.clusters)) if (ownSlot(view, slot)) all[slot] = { ...all[slot], ...members };
  }
  const slotOf = (id) => Object.keys(all).find((key) => all[key][id]);
  const targets = new Map();
  for (const [old, now] of ids) {
    const slot = slotOf(old);
    if (slot) add(targets, slot, diagram.nodes.get(now)?.cluster);
  }
  const clusters = new Map();
  for (const [old, set] of targets) {
    const [now] = set;
    const fresh = now !== undefined && !all[now] && previous.colors?.[now] === undefined;
    if (set.size === 1 && now !== old && !diagram.clusters.has(old) && fresh) clusters.set(old, now);
  }
  const clusterOf = (key) => clusters.get(key) ?? key;

  const views = {};
  const carriedTables = new Set();
  for (const [view, body] of Object.entries(previous.views ?? {})) {
    const name = view.startsWith(DOMAIN_VIEW_PREFIX) ? DOMAIN_VIEW_PREFIX + clusterOf(view.slice(DOMAIN_VIEW_PREFIX.length)) : view;
    const out = {};
    const put = (slot, id, node) => {
      out[slot] ??= {};
      out[slot][id] ??= node;
    };
    for (const [slot, members] of Object.entries(body.clusters)) {
      for (const [id, node] of Object.entries(members)) {
        if (view === OVERVIEW) {
          // Overview boxes are clusters, stored under their database.
          const key = clusterOf(id);
          put(key.split('/')[0], key, node);
          continue;
        }
        const target = slot === STUB_SLOT ? slot : clusterOf(slot);
        const now = ids.get(id);
        // An entry not carried stays under its old id, so `layout` reports it
        // as removed.
        const carried = now !== undefined && (slot === STUB_SLOT || diagram.nodes.get(now)?.cluster === target);
        put(target, carried ? now : id, node);
        if (carried && ownSlot(view, slot)) carriedTables.add(id);
      }
    }
    views[name] = { clusters: out };
  }
  const colors = { ...previous.colors };
  for (const [old, now] of clusters) if (colors[old] !== undefined) colors[now] ??= colors[old];
  return {
    layout: { ...previous, colors, views },
    renamed: tableIds.filter(([old]) => carriedTables.has(old)).sort(([a], [b]) => compareStrings(a, b)),
  };
}
