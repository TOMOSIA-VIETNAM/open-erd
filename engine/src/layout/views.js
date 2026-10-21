import { compareStrings } from '../model/load.js';
import { CLUSTER_GAP, CLUSTER_PAD, DB_GAP, DB_PAD, STUB_GAP, TABLE_GAP, clusterLabel } from './clusters.js';
import { databaseFacts, domainLinks } from './diagram.js';
import { domainBox, stubBox } from './table-box.js';

// Every view is a tree of nested groups over leaf boxes. Layout and render
// both walk the same tree: layout to place the leaves group by group, render
// to draw each group's frame around what it contains.
//
//   leaf:  { id, kind: 'table'|'poly'|'stub'|'domain', slot, box, node? }
//          `slot` is the group key the leaf is stored under in layout.json.
//   group: { id, kind: 'page'|'db'|'cluster', children, pad, gap, aspect,
//            strategy: 'layered'|'pack'|'around', ... }
//          `pad` is the frame padding (none for the page), `gap` the minimum
//          free space between children, `aspect` the shape aimed at when a
//          child is added, `strategy` how children are placed from scratch.

export const ALL_VIEW = 'all';
export const OVERVIEW = 'overview';
export const DOMAIN_VIEW_PREFIX = 'domain:';
// Layout slot of the stubs in a domain view. Cluster keys always contain a
// '/', so this key can never collide with one.
export const STUB_SLOT = 'related';

// Shapes aimed at: a domain somewhat wider than tall, the page 16:9.
const CLUSTER_ASPECT = 1.3;
const PAGE_ASPECT = 16 / 9;
// Overview lines attach to the left and right side of a domain box, so the
// domains of one database are packed in wide rows: neighbours then connect
// with straight lines instead of loops around a column.
const OVERVIEW_DB_ASPECT = 4;

/** All views of a diagram; the overview comes first because it is shown first. */
export function viewNames(diagram) {
  return [OVERVIEW, ALL_VIEW, ...[...diagram.clusters.keys()].map((k) => DOMAIN_VIEW_PREFIX + k)];
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

function dbGroups(model, diagram, aspect, childrenOf) {
  return model.databases
    .map((db) => {
      const keys = [...diagram.clusters.keys()].filter((k) => k.split('/')[0] === db.database);
      return { id: `db:${db.database}`, kind: 'db', database: db.database, engine: db.engine, facts: databaseFacts(db), keys };
    })
    .filter((g) => g.keys.length > 0)
    .map(({ keys, ...g }) => ({ ...g, pad: DB_PAD, gap: CLUSTER_GAP, aspect, strategy: 'pack', children: childrenOf(g, keys) }));
}

const page = (children, extra = {}) => ({ id: 'page', kind: 'page', pad: null, gap: DB_GAP, aspect: PAGE_ASPECT, strategy: 'pack', children, ...extra });

function allView(model, diagram) {
  return { root: page(dbGroups(model, diagram, PAGE_ASPECT, (_, keys) => keys.map((k) => clusterGroup(diagram, k)))), links: diagram.links };
}

function overview(model, diagram) {
  const children = (g, keys) =>
    keys.map((k) => {
      const tables = diagram.clusters.get(k).filter((id) => diagram.nodes.get(id).kind === 'table').length;
      return { id: k, kind: 'domain', slot: g.database, box: domainBox(clusterLabel(k), tables) };
    });
  return { root: page(dbGroups(model, diagram, OVERVIEW_DB_ASPECT, children)), links: domainLinks(diagram) };
}

// One domain plus a muted stub for every table outside it that a drawn line
// reaches, so the reader sees where the domain connects without the rest.
function domainView(diagram, key) {
  const core = clusterGroup(diagram, key);
  const inside = new Set(diagram.clusters.get(key));
  const links = diagram.links.filter((l) => inside.has(l.from.node) || inside.has(l.to.node));
  const outside = [...new Set(links.flatMap((l) => [l.from.node, l.to.node]).filter((id) => !inside.has(id)))].sort(compareStrings);
  const stubs = outside.map((id) => {
    const node = diagram.nodes.get(id);
    return { id, kind: 'stub', slot: STUB_SLOT, box: stubBox(node.table), node };
  });
  return { root: page([core, ...stubs], { gap: STUB_GAP, strategy: 'around', core: key }), links };
}

/** The tree and the lines of view `name`; throws on an unknown view. */
export function viewTree(model, diagram, name) {
  if (name === ALL_VIEW) return allView(model, diagram);
  if (name === OVERVIEW) return overview(model, diagram);
  if (name.startsWith(DOMAIN_VIEW_PREFIX) && diagram.clusters.has(name.slice(DOMAIN_VIEW_PREFIX.length))) {
    return domainView(diagram, name.slice(DOMAIN_VIEW_PREFIX.length));
  }
  throw new Error(`unknown view "${name}"`);
}

/** Leaves of a tree, depth first in child order. */
export function leavesOf(node) {
  return node.children ? node.children.flatMap(leavesOf) : [node];
}
