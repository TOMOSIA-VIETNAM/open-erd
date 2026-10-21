import assert from 'node:assert/strict';
import { MARGIN, STUB } from '../../src/layout/router.js';
import {
  BADGE_ARROW_WIDTH,
  BADGE_FONT,
  COLUMN_FONT,
  DOMAIN_COUNT_FONT,
  DOMAIN_TITLE_FONT,
  EMBED_INSET,
  FACT_FONT,
  MUTED_TITLE_FONT,
  PADDING_X,
  PK_FONT,
  TAG_FONT,
  TITLE_FONT,
  TYPE_FONT,
} from '../../src/layout/table-box.js';
import { measureText } from '../../src/text/measure.js';

export function segments(points) {
  return points.slice(1).map((p, i) => [points[i], p]);
}

// True when the axis-aligned segment touches the open interior of `box`.
export function hits([[ax, ay], [bx, by]], box) {
  const [x0, x1] = [Math.min(ax, bx), Math.max(ax, bx)];
  const [y0, y1] = [Math.min(ay, by), Math.max(ay, by)];
  return x0 < box.x + box.w && x1 > box.x && y0 < box.y + box.h && y1 > box.y;
}

export function inflate(b, by) {
  return { x: b.x - by, y: b.y - by, w: b.w + 2 * by, h: b.h + 2 * by };
}

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export function pathLength(points) {
  return segments(points).reduce((sum, [[ax, ay], [bx, by]]) => sum + Math.abs(bx - ax) + Math.abs(by - ay), 0);
}

// Every line keeps the router margin from every box it does not attach to,
// never crosses a group label, and leaves its own boxes horizontally with a
// straight stub at least STUB long.
export function assertLinesClear(scene) {
  for (const r of scene.relations) {
    const segs = segments(r.points);
    const ends = new Set([r.link.from.node, r.link.to.node]);
    for (const n of scene.nodes) {
      // The first and last segment leave/enter their own box; everything else
      // must keep the router margin, including around the endpoint boxes.
      const checked = ends.has(n.id) ? segs.slice(1, -1) : segs;
      for (const s of checked) assert.ok(!hits(s, inflate(n, MARGIN - 1)), `${scene.name}: ${r.id} crosses ${n.id}: ${JSON.stringify(s)}`);
    }
    for (const label of scene.labels) for (const s of segs) assert.ok(!hits(s, label), `${scene.name}: ${r.id} crosses ${label.id}`);
    for (const [seg, side] of [
      [segs[0], r.fromSide],
      [[...segs.at(-1)].reverse(), r.toSide],
    ]) {
      const [[ax, ay], [bx, by]] = seg;
      assert.equal(ay, by, `${scene.name}: ${r.id} end segment is not horizontal`);
      assert.ok((bx - ax) * side >= STUB, `${scene.name}: ${r.id} stub shorter than ${STUB}`);
    }
  }
}

// Edge labels cover no box, no group label and no other edge label.
export function assertEdgeLabelsClear(scene) {
  const placed = scene.relations.filter((r) => r.label);
  for (const r of placed) {
    assert.ok([r.label.x, r.label.y, r.label.w, r.label.h].every(Number.isFinite), `${scene.name}: label of ${r.id} has no position`);
    for (const n of scene.nodes) assert.ok(!overlaps(r.label, n), `${scene.name}: label of ${r.id} covers ${n.id}`);
    for (const l of scene.labels) assert.ok(!overlaps(r.label, l), `${scene.name}: label of ${r.id} covers ${l.id}`);
    for (const o of placed) if (o !== r) assert.ok(!overlaps(r.label, o.label), `${scene.name}: labels of ${r.id} and ${o.id} overlap`);
  }
}

// Every text drawn inside a box fits its inner width; group labels fit
// inside their frames.
export function assertTextFits(scene) {
  const fits = (id, text, font, room) => assert.ok(measureText(text, font) <= room, `${scene.name}: ${id}: "${text}" wider than ${room}`);
  for (const { id, box } of scene.nodes) {
    const inner = box.w - 2 * PADDING_X;
    if (box.kind === 'table') {
      const tag = box.tag ? measureText(box.tag.text, TAG_FONT) : 0;
      assert.ok(measureText(box.title.text, TITLE_FONT) + tag < inner, `${scene.name}: ${id}: title and tag wider than ${inner}`);
      for (const r of box.rows) {
        const used = measureText(r.name.text, r.pk ? PK_FONT : COLUMN_FONT) + measureText(r.type.text, TYPE_FONT);
        const room = inner - 2 * EMBED_INSET * r.depth;
        assert.ok(used < room, `${scene.name}: ${id}.${r.column}: ${used} > ${room}`);
      }
      for (const e of box.insets) fits(id, e.title.text, COLUMN_FONT, inner - 2 * EMBED_INSET);
      for (const f of box.facts) fits(id, f.text.text, FACT_FONT, inner);
      for (const b of box.badges) fits(id, b.label.text, BADGE_FONT, inner - BADGE_ARROW_WIDTH);
      // Every line of the box is one 20 px row below the 30 px header.
      const lines = box.rows.length + box.insets.length + box.facts.length + box.badges.length;
      assert.ok(lines * 20 + 30 < box.h, `${scene.name}: ${id} rows overflow its height`);
      const bottoms = [...box.rows, ...box.insets.map((e) => e.title), ...box.facts, ...box.badges].map((r) => r.centerY + 10);
      assert.ok(bottoms.every((b) => b <= box.h), `${scene.name}: ${id} a row ends below the box`);
    } else if (box.kind === 'poly') {
      fits(id, box.title.text, TITLE_FONT, inner);
      for (const r of box.rows) fits(id, r.name.text, COLUMN_FONT, inner);
    } else if (box.kind === 'stub') {
      fits(id, box.title.text, MUTED_TITLE_FONT, inner);
    } else {
      fits(id, box.title.text, DOMAIN_TITLE_FONT, inner);
      fits(id, box.count.text, DOMAIN_COUNT_FONT, inner);
    }
  }
  for (const l of scene.labels) {
    const g = scene.groups.find((x) => `label:${x.kind === 'cluster' ? x.group.key : x.group.id}` === l.id);
    const f = g.frame;
    assert.ok(l.x >= f.x && l.x + l.w <= f.x + f.w && l.y >= f.y && l.y + l.h <= f.y + f.h, `${scene.name}: ${l.id} outside its frame`);
  }
}

export function assertSceneGeometry(scene) {
  assertLinesClear(scene);
  assertEdgeLabelsClear(scene);
  assertTextFits(scene);
}
