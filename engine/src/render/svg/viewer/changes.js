// The changes of a diff drawing, for the Changes mode's chip and list. Pure
// functions over the embedded data, so the label and the order are tested
// without a browser.

const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
// Order of the list: new and renamed tables first, then changed, removed,
// and last the tables only at the end of a changed relation (no status).
const STATUS_ORDER = ['added', 'renamed', 'changed', 'removed'];
const rank = (status) => (status ? STATUS_ORDER.indexOf(status) : STATUS_ORDER.length);

/**
 * `changes` is the viewer data's `changes` (sentences per node, `status` per
 * node, `counts`), `nodes` its `nodes`. Returns null when nothing is drawn
 * as changed, else { label, tables: [{ id, status, sentences }] }: the label
 * names the non-zero counts ("3 tables, 5 columns, 2 relations"); the list
 * holds every table with a change sentence, its status (undefined when only
 * a relation at it changed), in STATUS_ORDER then by id.
 */
export function changesSummary(changes, nodes) {
  const tables = Object.keys(changes.nodes)
    .filter((id) => nodes[id]?.kind === 'table')
    .map((id) => ({ id, status: changes.status[id], sentences: changes.nodes[id] }))
    .sort((a, b) => rank(a.status) - rank(b.status) || byKey(a.id, b.id));
  if (tables.length === 0 && Object.keys(changes.links).length === 0) return null;
  const { counts } = changes;
  const parts = [[counts.tables, 'table'], [counts.columns, 'column'], [counts.relations, 'relation']].filter(([n]) => n > 0).map(([n, word]) => plural(n, word));
  return { label: parts.join(', ') || plural(tables.length, 'table'), tables };
}
