import { compareStrings } from '../model/load.js';
import { domainPairs } from './diagram.js';

// What the overview cards and the heatmap say about domains, derived once
// from the diagram so cards, heatmap, draw.io and the viewer
// can never disagree on order or strength.

/** Related domains named on a card; the viewer's hover shows them all. */
export const RELATED_ON_CARD = 3;
/** Segments of a card's strength bar, and shades of a heatmap tile. */
export const STRENGTH_SEGMENTS = 5;
// Counts at or above this fill every segment even when the schema's
// strongest pair is weaker, so a schema of thin links shows thin bars.
const STRENGTH_FLOOR = 10;

/**
 * Filled segments (0..STRENGTH_SEGMENTS) for `count` relations when the
 * strongest pair of the schema has `max`: by square root, which keeps the
 * strongest pairs apart from each other and still tells 1 from 3; any
 * relation fills one.
 */
export function strength(count, max) {
  if (count <= 0) return 0;
  const top = Math.max(max, STRENGTH_FLOOR);
  return Math.min(STRENGTH_SEGMENTS, Math.max(1, Math.round(STRENGTH_SEGMENTS * Math.sqrt(count / top))));
}

const nameOf = (key) => key.slice(key.indexOf('/') + 1);

/**
 * Per domain (cluster key):
 *   { key, database, name, tables, note, central (table id or null),
 *     connectivity (relations with other domains), within (relations
 *     inside it), related: [{ key, count, crossDb }] strongest first, ties
 *     by key }
 * `order`: cluster keys database by database (model order), each database's
 * domains most connected first, ties by key: the card order of a fresh
 * overview and the domain order of the heatmap.
 * `max`: the largest relation count between two domains (0 when none).
 */
export function domainSummary(model, diagram) {
  const notes = new Map(model.databases.flatMap((db) => Object.entries(db.domains ?? {}).map(([name, d]) => [`${db.database}/${name}`, d.note ?? null])));
  const cards = new Map();
  for (const [key, ids] of diagram.clusters) {
    cards.set(key, {
      key,
      database: key.split('/')[0],
      name: nameOf(key),
      tables: ids.filter((id) => diagram.nodes.get(id).kind === 'table').length,
      note: notes.get(key) ?? null,
      central: diagram.centralOf.get(key) ?? null,
      connectivity: 0,
      within: 0,
      related: [],
    });
  }
  let max = 0;
  for (const p of domainPairs(diagram)) {
    const [a, b] = [p.from.node, p.to.node];
    if (a === b) {
      cards.get(a).within = p.count;
      continue;
    }
    max = Math.max(max, p.count);
    const crossDb = p.kind === 'cross_db';
    for (const [x, y] of [[a, b], [b, a]]) {
      cards.get(x).connectivity += p.count;
      cards.get(x).related.push({ key: y, count: p.count, crossDb });
    }
  }
  for (const c of cards.values()) c.related.sort((x, y) => y.count - x.count || compareStrings(x.key, y.key));
  const order = model.databases.flatMap((db) =>
    [...cards.values()]
      .filter((c) => c.database === db.database)
      .sort((x, y) => y.connectivity - x.connectivity || compareStrings(x.key, y.key))
      .map((c) => c.key),
  );
  return { cards, order, max };
}
