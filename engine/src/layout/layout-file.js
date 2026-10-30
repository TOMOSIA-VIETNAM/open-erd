import { compareStrings } from '../model/load.js';
import { GRID, roundToGrid } from './table-box.js';

// layout.json shape:
// {
//   "schema_version": 1,
//   "colors": { "<database>/<domain>": 0 },
//   "views": {
//     "<view>": {
//       "clusters": {
//         "<database>/<domain>": { "<table id>": { "x": 0, "y": 0, "w": 0, "h": 0 } }
//       }
//     }
//   }
// }
// Coordinates are integer px on the layout grid. `w`/`h` record the box size the
// position was computed for: `layout` compares them with the current model to
// see which tables grew, and `render` refuses a layout whose sizes are stale.
// Nodes are grouped by cluster so the file reads like the diagram and a table
// that changes domain is recognised as leaving its old cluster.
// Each view keeps its own positions, grouped by the innermost group a node
// is stored under:
//   "all"                    "<database>/<domain>" -> table ids, and polymorphic
//                            nodes as "<table id>«<association name>»"; absent
//                            above ALL_VIEW_MAX_TABLES tables (see views.js)
//   "domain:<db>/<domain>"   the same for that one domain, plus "related" ->
//                            stubs of the tables outside it, by table id
//   "overview"               "<database>" -> domain boxes, by "<database>/<domain>"
// Database frames are not stored: they are drawn around their content.
// `colors` holds each cluster's palette index, given once when the cluster
// first appears and kept even after the domain is removed, so a colour is
// never reused for a different domain while unused colours remain.
export const LAYOUT_FILE = 'layout.json';
export const LAYOUT_SCHEMA_VERSION = 1;
const NODE_FIELDS = ['x', 'y', 'w', 'h'];
// The router steps on the grid, so a position or width off it would never
// find a route; `h` is the height of the table's own rows and is free.
const GRID_FIELDS = ['x', 'y', 'w'];

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Parses layout.json text; throws an Error naming the first invalid path.
 * A node off the grid is an error, unless `snap` moves it to the nearest
 * grid line (what `layout` does to repair a hand-edited file).
 */
export function parseLayout(text, { snap = false } = {}) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`${LAYOUT_FILE}: invalid JSON: ${e.message}`);
  }
  const fail = (path, message) => {
    throw new Error(`${LAYOUT_FILE}: ${path}: ${message}`);
  };
  if (!isObject(data)) fail('(root)', 'must be an object');
  if (data.schema_version !== LAYOUT_SCHEMA_VERSION) fail('schema_version', `must be ${LAYOUT_SCHEMA_VERSION}`);
  if (!isObject(data.colors)) fail('colors', 'must be an object');
  for (const [cluster, index] of Object.entries(data.colors)) {
    if (!Number.isInteger(index) || index < 0) fail(`colors["${cluster}"]`, 'must be a non-negative integer');
  }
  if (!isObject(data.views)) fail('views', 'must be an object');
  for (const [view, body] of Object.entries(data.views)) {
    if (!isObject(body) || !isObject(body.clusters)) fail(`views.${view}.clusters`, 'must be an object');
    for (const [cluster, nodes] of Object.entries(body.clusters)) {
      if (!isObject(nodes)) fail(`views.${view}.clusters["${cluster}"]`, 'must be an object');
      for (const [id, node] of Object.entries(nodes)) {
        const path = `views.${view}.clusters["${cluster}"]["${id}"]`;
        if (!isObject(node)) fail(path, 'must be an object');
        for (const field of NODE_FIELDS) {
          if (!Number.isInteger(node[field])) fail(`${path}.${field}`, 'must be an integer');
        }
        for (const field of GRID_FIELDS) {
          if (node[field] % GRID === 0) continue;
          if (!snap) fail(`${path}.${field}`, `must be a multiple of ${GRID}; run layout to snap it`);
          node[field] = roundToGrid(node[field]);
        }
        if (node.w <= 0 || node.h <= 0) fail(path, 'w and h must be positive');
      }
    }
  }
  return data;
}

function sortedEntries(obj) {
  return Object.entries(obj).sort(([a], [b]) => compareStrings(a, b));
}

/** Stable text form: sorted keys, one node per line, trailing newline. */
export function serializeLayout(layout) {
  const node = (n) => `{ ${NODE_FIELDS.map((f) => `"${f}": ${n[f]}`).join(', ')} }`;
  const block = (entries, indent, render) =>
    entries.length === 0
      ? '{}'
      : `{\n${entries.map(([k, v]) => `${indent}  ${JSON.stringify(k)}: ${render(v)}`).join(',\n')}\n${indent}}`;
  const views = block(sortedEntries(layout.views), '  ', (view) =>
    block([['clusters', view.clusters]], '    ', (clusters) =>
      block(sortedEntries(clusters), '      ', (nodes) => block(sortedEntries(nodes), '        ', node)),
    ),
  );
  const colors = block(sortedEntries(layout.colors), '  ', String);
  return `{\n  "schema_version": ${LAYOUT_SCHEMA_VERSION},\n  "colors": ${colors},\n  "views": ${views}\n}\n`;
}
