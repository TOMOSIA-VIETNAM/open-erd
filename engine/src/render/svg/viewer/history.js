// Where the reader has been, as two stacks of steps: a step is what was on
// screen (a view, and the table focused in it, if any). Pure functions over
// plain data, so the model is tested without a browser; the viewer keeps
// one `{ back, forward }` and replaces it on every move.

/** Steps kept behind; older ones are dropped. */
export const HISTORY_LIMIT = 50;

export const emptyHistory = () => ({ back: [], forward: [] });

/** Leaving `current` for somewhere new: it goes behind, the way forward is gone. */
export function visit(h, current, limit = HISTORY_LIMIT) {
  return { back: [...h.back, current].slice(-limit), forward: [] };
}

/** One step back from `current`: { history, target }, target null at the start. */
export function goBack(h, current) {
  if (h.back.length === 0) return { history: h, target: null };
  return { history: { back: h.back.slice(0, -1), forward: [current, ...h.forward] }, target: h.back.at(-1) };
}

/** One step forward from `current`: { history, target }, target null at the end. */
export function goForward(h, current) {
  if (h.forward.length === 0) return { history: h, target: null };
  return { history: { back: [...h.back, current], forward: h.forward.slice(1) }, target: h.forward[0] };
}

/**
 * The last `n` tables visited up to and including `current` (a step's
 * `table`), a table met twice in a row counted once: the trail shown in a
 * table's panel.
 */
export function tableTrail(h, current, n = 4) {
  const tables = [...h.back, current].map((s) => s.table).filter(Boolean);
  return tables.filter((t, i) => t !== tables[i - 1]).slice(-n);
}
