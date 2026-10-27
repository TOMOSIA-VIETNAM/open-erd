import { compareStrings } from '../model/load.js';
import { DOMAIN_VIEW_PREFIX } from '../model/schema.js';
import { CLUSTER_GAP, CLUSTER_PAD, DB_GAP, DB_PAD, STUB_GAP, TABLE_GAP, clusterLabel } from './clusters.js';
import { KIND_TRUST, REVIEW_TRUST, VIEW_SOURCE, databaseFacts, domainLinks, leastTrusted } from './diagram.js';
import { RELATED_ON_CARD, STRENGTH_SEGMENTS, domainSummary, strength } from './domains.js';
import { domainCard, groupBox, stubBox } from './table-box.js';

// Every view is a tree of nested groups over leaf boxes. Layout and render
// both walk the same tree: layout to place the leaves group by group, render
// to draw each group's frame around what it contains.
//
//   leaf:  { id, kind: 'table'|'poly'|'stub'|'group'|'domain', slot, box, node?, group? }
//          `slot` is the group key the leaf is stored under in layout.json.
//   group: { id, kind: 'page'|'db'|'cluster', children, pad, gap, aspect,
//            strategy: 'layered'|'pack'|'grid'|'around', ... }
//          `pad` is the frame padding (none for the page), `gap` the minimum
//          free space between children, `aspect` the shape aimed at when a
//          child is added, `strategy` how children are placed from scratch.

export const ALL_VIEW = 'all';
export const OVERVIEW = 'overview';
export { DOMAIN_VIEW_PREFIX } from '../model/schema.js';
// Layout slot of the stubs in a domain view. Cluster keys always contain a
// '/', so this key can never collide with one.
export const STUB_SLOT = 'related';

// Shapes aimed at: a domain somewhat wider than tall, the page 16:9.
const CLUSTER_ASPECT = 1.3;
const PAGE_ASPECT = 16 / 9;
// The domain cards of one database sit on a grid somewhat wider than tall,
// the most connected domain in the middle and related domains side by side
// (see cardGrid in index.js).
//
// Only a fresh layout is placed this way: cards already in layout.json
// keep their positions (stability rules), and a new domain goes next to the
// one it shares most relations with. `layout --relayout overview`
// re-places the overview alone.
const OVERVIEW_DB_ASPECT = 2;
const CARD_GAP = 50;

// Above this many tables the view of all tables is left out. Routing it
// grows much faster than the table count (on an Apple M4 a few seconds at
// 150 tables, about 15 s at 300, 90 s at 500 and five minutes at 1000), and
// at that size it is a canvas nobody reads as a whole: the overview, the
// domain views and the neighborhood view (built from the domain views)
// remain. `views.all` in open-erd.yaml forces it on or off.
export const ALL_VIEW_MAX_TABLES = 300;

/** Whether the diagram gets the view of all tables: as configured, else when small enough. */
export function hasAllView(diagram) {
  if (diagram.views.all !== 'auto') return diagram.views.all === 'on';
  let tables = 0;
  for (const n of diagram.nodes.values()) if (n.kind === 'table') tables += 1;
  return tables <= ALL_VIEW_MAX_TABLES;
}

/** All views of a diagram; the overview comes first because it is shown first. */
export function viewNames(diagram) {
  return [OVERVIEW, ...(hasAllView(diagram) ? [ALL_VIEW] : []), ...[...diagram.clusters.keys()].map((k) => DOMAIN_VIEW_PREFIX + k)];
}

function clusterGroup(diagram, key) {
  return {
    id: key,
    kind: 'cluster',
    key,
    pad: CLUSTER_PAD,
    gap: TABLE_GAP,
    aspect: CLUSTER_ASPECT,
    strategy: 'layered',
    children: diagram.clusters.get(key).map((id) => {
      const node = diagram.nodes.get(id);
      return { id, kind: node.kind, slot: key, box: node.box, node };
    }),
  };
}

function dbGroups(model, diagram, aspect, childrenOf, strategy = 'pack', gap = CLUSTER_GAP) {
  return model.databases
    .map((db) => {
      const keys = [...diagram.clusters.keys()].filter((k) => k.split('/')[0] === db.database);
      return { id: `db:${db.database}`, kind: 'db', database: db.database, engine: db.engine, facts: databaseFacts(db), keys };
    })
    .filter((g) => g.keys.length > 0)
    .map(({ keys, ...g }) => ({ ...g, pad: DB_PAD, gap, aspect, strategy, children: childrenOf(g, keys) }));
}

const page = (children, extra = {}) => ({ id: 'page', kind: 'page', pad: null, gap: DB_GAP, aspect: PAGE_ASPECT, strategy: 'pack', children, ...extra });

function allView(model, diagram) {
  return { root: page(dbGroups(model, diagram, PAGE_ASPECT, (_, keys) => keys.map((k) => clusterGroup(diagram, k)))), links: diagram.links };
}

function overview(model, diagram) {
  const summary = domainSummary(model, diagram);
  const rank = new Map(summary.order.map((k, i) => [k, i]));
  const withNotes = [...summary.cards.values()].some((c) => c.note);
  const children = (g, keys) =>
    [...keys]
      .sort((a, b) => rank.get(a) - rank.get(b))
      .map((k) => {
        const card = summary.cards.get(k);
        const related = card.related.slice(0, RELATED_ON_CARD);
        const box = domainCard(card, { related, segments: related.map((r) => strength(r.count, summary.max)), total: STRENGTH_SEGMENTS, withNotes });
        return { id: k, kind: 'domain', slot: g.database, box };
      });
  return { root: page(dbGroups(model, diagram, OVERVIEW_DB_ASPECT, children, 'cards', CARD_GAP)), links: domainLinks(diagram) };
}

// A domain view draws the tables outside the domain that its lines reach as
// muted stubs. A domain linked to many outside tables (the domain of a
// central table) would get a tall column of stubs with a line each, so the
// outside tables of one other domain become one group stub as soon as that
// domain contributes GROUP_MIN_TABLES of them: a box named after the
// domain listing its tables, joined to each table of this domain by one
// line per referencing or referenced column, standing for all of them.
export const GROUP_MIN_TABLES = 2;
export const GROUP_PREFIX = 'group:';

// One line for several relations between a group stub and one table of the
// domain: same direction and same column on the domain's side. Its ends
// follow the relations when they all agree on cardinality and optionality,
// and show none when they differ; kind and review take the least certain.
function groupLink(key, list) {
  const [first] = list;
  const outwards = !first.groupedFrom;
  const same = (f) => list.every((l) => f(l) === f(first));
  const groupEnd = { node: GROUP_PREFIX + key, column: null };
  const own = outwards ? first.from : first.to;
  return {
    id: `${GROUP_PREFIX}${key}${outwards ? '<-' : '->'}${own.node}(${own.column ?? ''})`,
    from: outwards ? own : groupEnd,
    to: outwards ? groupEnd : own,
    cardinality: same((l) => l.cardinality) ? first.cardinality : null,
    optional: same((l) => l.optional) ? first.optional : true,
    kind: first.kind === VIEW_SOURCE ? VIEW_SOURCE : leastTrusted(list.map((l) => l.kind), KIND_TRUST),
    review: leastTrusted(list.map((l) => l.review), REVIEW_TRUST),
    group: key,
    tables: [...new Set(list.map((l) => (outwards ? l.to.node : l.from.node)))].sort(compareStrings),
    relations: list.map((l) => l.id).sort(compareStrings),
  };
}

function domainView(model, diagram, key) {
  const core = clusterGroup(diagram, key);
  const inside = new Set(diagram.clusters.get(key));
  const touching = diagram.links.filter((l) => inside.has(l.from.node) || inside.has(l.to.node));
  const outside = [...new Set(touching.flatMap((l) => [l.from.node, l.to.node]).filter((id) => !inside.has(id)))].sort(compareStrings);
  const byDomain = new Map();
  for (const id of outside) {
    const cluster = diagram.nodes.get(id).cluster;
    if (!byDomain.has(cluster)) byDomain.set(cluster, []);
    byDomain.get(cluster).push(id);
  }
  const grouped = new Map([...byDomain].filter(([, ids]) => ids.length >= GROUP_MIN_TABLES));
  const groupOf = (id) => (inside.has(id) ? null : grouped.has(diagram.nodes.get(id).cluster) ? diagram.nodes.get(id).cluster : null);
  const stubs = outside
    .filter((id) => !groupOf(id))
    .map((id) => {
      const node = diagram.nodes.get(id);
      return { id, kind: 'stub', slot: STUB_SLOT, box: stubBox(node.table), node };
    });
  const groups = [...grouped].map(([cluster, ids]) => ({
    id: GROUP_PREFIX + cluster,
    kind: 'group',
    slot: STUB_SLOT,
    box: groupBox(clusterLabel(cluster), ids, cluster.split('/')[0] === key.split('/')[0] ? null : cluster.split('/')[0]),
    group: { key: cluster, tables: ids },
  }));
  // Lines to a group, bundled by (group, direction, table and column of this domain).
  const bundles = new Map();
  const links = [];
  for (const l of touching) {
    const g = groupOf(l.from.node) ?? groupOf(l.to.node);
    if (!g) {
      links.push(l);
      continue;
    }
    const groupedFrom = Boolean(groupOf(l.from.node));
    const own = groupedFrom ? l.to : l.from;
    const bundle = JSON.stringify([g, groupedFrom, own.node, own.column, l.kind === VIEW_SOURCE]);
    if (!bundles.has(bundle)) bundles.set(bundle, []);
    bundles.get(bundle).push({ ...l, groupedFrom });
  }
  for (const list of bundles.values()) links.push(groupLink(groupOf(list[0].groupedFrom ? list[0].from.node : list[0].to.node), list));
  links.sort((a, b) => compareStrings(a.id, b.id));
  const around = [...stubs, ...groups].sort((a, b) => compareStrings(a.id, b.id));
  return { root: page([core, ...around], { gap: STUB_GAP, strategy: 'around', core: key }), links };
}

/** The tree and the lines of view `name`; throws on an unknown view. */
export function viewTree(model, diagram, name) {
  if (name === ALL_VIEW && hasAllView(diagram)) return allView(model, diagram);
  if (name === OVERVIEW) return overview(model, diagram);
  if (name.startsWith(DOMAIN_VIEW_PREFIX) && diagram.clusters.has(name.slice(DOMAIN_VIEW_PREFIX.length))) {
    return domainView(model, diagram, name.slice(DOMAIN_VIEW_PREFIX.length));
  }
  throw new Error(`unknown view "${name}"`);
}

/** Leaves of a tree, depth first in child order. */
export function leavesOf(node) {
  return node.children ? node.children.flatMap(leavesOf) : [node];
}
