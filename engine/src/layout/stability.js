// Layout stability: when the model changes, existing boxes move only through a
// strictly increasing remap of their old x and y coordinates. A monotone remap
// can never swap two boxes on either axis, so "A was left of / above B" stays
// true for every pair; it only stretches the space between coordinates where a
// grown or inserted box needs room.

const AXES = [
  { pos: 'x', size: 'w' },
  { pos: 'y', size: 'h' },
];

/**
 * Pairwise order of two boxes on one axis: -1 when `a` ends before `b` starts,
 * 1 when `b` ends before `a` starts, 0 when their extents overlap. Defined by
 * extents rather than corners so a box that grows does not flip an order that
 * still holds visually. The stability tests use this same definition.
 */
export function axisOrder(a, b, axis) {
  const { pos, size } = AXES.find((d) => d.pos === axis);
  if (a[pos] + a[size] <= b[pos]) return -1;
  if (b[pos] + b[size] <= a[pos]) return 1;
  return 0;
}

// Keys are [value, rank]. Boxes that existed before use rank 0 and their old
// coordinate; inserted boxes use a non-zero rank so they sort right before
// (negative) the old box sharing their value instead of tying with it.
function compareKeys(a, b) {
  return a[0] - b[0] || a[1] - b[1];
}

function keyId(key) {
  return `${key[0]}:${key[1]}`;
}

function constraintsFor(items, gap) {
  const constraints = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      const orders = AXES.map(({ pos }) => axisOrder(a.ref, b.ref, pos));
      let ordered = false;
      AXES.forEach(({ pos, size }, i) => {
        if (orders[i] === 0) return;
        ordered = true;
        const [first, second] = orders[i] < 0 ? [a, b] : [b, a];
        // Side by side (overlapping on the other axis) the full gap is needed
        // for routing. Diagonal pairs only must not get closer than they were,
        // otherwise an unrelated change would spread the whole cluster.
        const had = second.ref[pos] - (first.ref[pos] + first.ref[size]);
        constraints.push({ axis: pos, first, second, gap: orders[1 - i] === 0 ? gap : Math.min(gap, had) });
      });
      if (!ordered) constraints.push(fallbackConstraint(a, b, gap));
    }
  }
  return constraints.filter(Boolean);
}

// Boxes whose reference extents overlap (an inserted box placed on top of an
// old one, or a hand-edited layout.json) are separated along the axis that
// needs the smaller push, in key order so monotonicity still holds.
function fallbackConstraint(a, b, gap) {
  let best;
  for (const { pos, size } of AXES) {
    const order = compareKeys(a.key[pos], b.key[pos]);
    if (order === 0) continue;
    const [first, second] = order < 0 ? [a, b] : [b, a];
    const push = first.ref[pos] + first[size] + gap - second.ref[pos];
    if (!best || push < best.push) best = { axis: pos, first, second, gap, push };
  }
  return best;
}

function remapAxis(items, constraints, { pos, size }) {
  const keys = [...new Map(items.map((it) => [keyId(it.key[pos]), it.key[pos]])).values()].sort(compareKeys);
  const index = new Map(keys.map((k, i) => [keyId(k), i]));
  const incoming = keys.map(() => []);
  // `first` always sorts before `second`: ref extents agree with keys (callers
  // build them from the same coordinates) and the fallback orders by key.
  for (const c of constraints.filter((c) => c.axis === pos)) {
    incoming[index.get(keyId(c.second.key[pos]))].push(c);
  }
  const mapped = [];
  let lastOld = -1;
  keys.forEach((key, i) => {
    let value = i === 0 ? key[0] : mapped[i - 1];
    // Every key keeps at least its distance to the last old coordinate, so space
    // nobody asked for is never taken away. Old coordinates are GRID apart or
    // more, which keeps the remap strictly increasing between them; an inserted
    // slot may share a value with an old one without pushing it.
    if (lastOld >= 0) value = Math.max(value, mapped[lastOld] + key[0] - keys[lastOld][0]);
    for (const c of incoming[i]) {
      value = Math.max(value, mapped[index.get(keyId(c.first.key[pos]))] + c.first[size] + c.gap);
    }
    mapped.push(value);
    if (key[1] === 0) lastOld = i;
  });
  return (item) => mapped[index.get(keyId(item.key[pos]))];
}

/**
 * Moves boxes apart until every pair is at least `gap` apart, preserving the
 * order of keys on both axes.
 * items: [{ id, key: { x: [v, rank], y: [v, rank] }, ref: { x, y, w, h }, w, h }]
 *   key  - ordering coordinate (old position, or the slot an inserted box takes)
 *   ref  - geometry used to decide which pairs are ordered (old size for old boxes)
 *   w, h - size after the change
 * Returns Map id -> { x, y }.
 */
export function settle(items, gap) {
  const constraints = constraintsFor(items, gap);
  const [fx, fy] = AXES.map((axis) => remapAxis(items, constraints, axis));
  return new Map(items.map((it) => [it.id, { x: fx(it), y: fy(it) }]));
}

function boundsOf(boxes) {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
}

/**
 * Adds box `id` of `size` next to one of `anchors`, trying the slot right of
 * and the slot below each anchor. A slot is a key that sorts right after the
 * anchor, so settle() pushes whatever is in the way further right or down and
 * existing boxes keep their order. The slot that moves existing boxes least
 * wins; then the one whose overall shape is closer to `aspect` (w / h); then
 * anchor order, right before below.
 * boxes: Map id -> { x, y, w, h }, already non-overlapping.
 * Returns Map id -> { x, y } for the existing boxes and the new one.
 */
export function insertNextTo(boxes, id, size, anchors, gap, aspect) {
  const current = [...boxes].map(([k, b]) => ({ id: k, key: { x: [b.x, 0], y: [b.y, 0] }, ref: b, w: b.w, h: b.h }));
  let best;
  for (const anchor of anchors) {
    const a = boxes.get(anchor);
    for (const slot of [
      { x: a.x + a.w + gap, y: a.y },
      { x: a.x, y: a.y + a.h + gap },
    ]) {
      const candidate = { id, key: { x: [slot.x, -1], y: [slot.y, -1] }, ref: { ...slot, ...size }, ...size };
      const result = settle([...current, candidate], gap);
      let moved = 0;
      for (const [k, b] of boxes) moved += Math.abs(result.get(k).x - b.x) + Math.abs(result.get(k).y - b.y);
      const all = [...result].map(([k, p]) => {
        const { w, h } = k === id ? size : boxes.get(k);
        return { x: p.x, y: p.y, w, h };
      });
      const { w, h } = boundsOf(all);
      const shape = Math.abs(Math.log(w / h / aspect));
      if (!best || moved < best.moved || (moved === best.moved && shape < best.shape - 1e-9)) best = { moved, shape, result };
    }
  }
  return best.result;
}
