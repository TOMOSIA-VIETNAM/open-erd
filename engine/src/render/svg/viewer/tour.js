// The tour: the viewer shows one domain after another, each zoomed on its
// central table with a caption. Pure functions over the embedded data, so
// the steps are tested without a browser.

/** Time a tour step stays on screen before the next one, in milliseconds. */
export const TOUR_STEP_MS = 6000;

/**
 * One step per domain (cluster key) of `order`, in that order:
 * { cluster, centrals (its central tables, starred on the diagram, in id
 * order), central (the first of them or null), title ("<domain> · N tables"),
 * note (the domain's business note or null) }. `nodes` and `notes` are the
 * viewer data's `nodes` and `domainNotes`.
 */
export function tourSteps(order, nodes, notes = {}) {
  return order.map((cluster) => {
    const tables = Object.keys(nodes).filter((id) => nodes[id].kind === 'table' && nodes[id].cluster === cluster);
    const name = cluster.split('/').slice(1).join('/');
    const centrals = tables.filter((id) => nodes[id].central).sort();
    return {
      cluster,
      centrals,
      central: centrals[0] ?? null,
      title: `${name} · ${tables.length} table${tables.length === 1 ? '' : 's'}`,
      note: notes[cluster] ?? null,
    };
  });
}

/** Index `by` steps away from `i` among `n` steps; past either end it wraps round. */
export const tourIndex = (i, by, n) => (((i + by) % n) + n) % n;
