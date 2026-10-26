import { compareStrings } from '../../model/load.js';
import { measureText, truncate } from '../../text/measure.js';

// The heatmap view: a treemap of the tables relations point at, each block's
// area and colour growing with that count (see referenceCounts), so the
// tables the rest of the schema leans on stand out at a glance; the tables
// nothing points at follow as a line of names. Drawn at render time from the
// model alone, so it needs no positions in layout.json and reads the same
// without script. A block too small for its name shows none or a shortened
// one; the viewer's tooltip names it in full, and a click opens the table.

const WIDTH = 1100;
const HEIGHT = 680;
const GAP = 2;
const PAD = 8;
const NAME_SIZES = [16, 14, 12];
const COUNT_FONT = { size: 15, weight: 700 };
const ZERO_FONT = { size: 12, weight: 400 };
const LEGEND_FONT = { size: 11, weight: 400 };
const TITLE_FONT = { size: 15, weight: 700 };
const SCALE_W = 220;
const LEGEND_HEIGHT = 92;
const ZERO_LINE = 20;
const ZERO_SEP = '  ·  ';
const MARGIN = 40;
const STAR = '★ ';

// Heat stops, pale to deep, interpolated by the square root of count / max.
export const HEAT = [
  [255, 236, 190],
  [253, 196, 110],
  [240, 120, 50],
  [196, 40, 30],
  [130, 15, 25],
];
// From this point of the scale up, text is white.
const DARK_FROM = 0.45;

const escapeXml = (text) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const tableName = (id) => id.split('.').at(-1);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const round = (v) => Math.round(v * 100) / 100;
const heatAt = (count, max) => Math.sqrt(count / max);

/** Fill of a block whose table `count` relations point at, `max` the highest count. */
export function heatFill(count, max) {
  const t = heatAt(count, max) * (HEAT.length - 1);
  const i = Math.min(HEAT.length - 2, Math.floor(t));
  const f = t - i;
  return `rgb(${HEAT[i].map((c, k) => Math.round(c + (HEAT[i + 1][k] - c) * f)).join(',')})`;
}

/**
 * Every table of the diagram with its counts, most referenced first, ties by
 * id: [{ id, in, out, central }]. `counts` from referenceCounts. Exported for tests.
 */
export function heatmapTables(diagram, counts) {
  return [...diagram.nodes]
    .filter(([, n]) => n.kind === 'table')
    .map(([id, n]) => ({ id, ...(counts.get(id) ?? { in: 0, out: 0 }), central: Boolean(n.central) }))
    .sort((a, b) => b.in - a.in || compareStrings(a.id, b.id));
}

/**
 * Squarified treemap: `items` ({ value } > 0, largest first) laid out in the
 * w × h rectangle, each with { x, y, w, h } of area proportional to its value.
 * Exported for tests.
 */
export function squarify(items, w, h) {
  const total = items.reduce((n, i) => n + i.value, 0);
  const left = items.map((i) => ({ item: i, area: (i.value / total) * w * h }));
  const out = [];
  let box = { x: 0, y: 0, w, h };
  const worst = (row, side) => {
    const s = row.reduce((n, r) => n + r.area, 0);
    const areas = row.map((r) => r.area);
    return Math.max((side * side * Math.max(...areas)) / (s * s), (s * s) / (side * side * Math.min(...areas)));
  };
  const place = (row) => {
    const s = row.reduce((n, r) => n + r.area, 0);
    const across = box.w >= box.h;
    const thick = s / (across ? box.h : box.w);
    let at = across ? box.y : box.x;
    for (const r of row) {
      const len = r.area / thick;
      out.push({ ...r.item, ...(across ? { x: box.x, y: at, w: thick, h: len } : { x: at, y: box.y, w: len, h: thick }) });
      at += len;
    }
    box = across ? { x: box.x + thick, y: box.y, w: box.w - thick, h: box.h } : { x: box.x, y: box.y + thick, w: box.w, h: box.h - thick };
  };
  let row = [];
  for (const r of left) {
    const side = Math.min(box.w, box.h);
    if (row.length === 0 || worst([...row, r], side) <= worst(row, side)) row.push(r);
    else {
      place(row);
      row = [r];
    }
  }
  if (row.length > 0) place(row);
  return out;
}

// A block's name and count, as large as the block allows; nothing when even
// the smallest size leaves no room.
function blockText(b, dark) {
  const inner = { w: b.w - 2 * PAD, h: b.h - 2 * PAD };
  const label = `${b.central ? STAR : ''}${tableName(b.id)}`;
  const size = NAME_SIZES.find((s) => inner.h >= s + COUNT_FONT.size + 6 && inner.w >= measureText(label.slice(0, 4), { size: s, weight: 400 }));
  if (!size) return '';
  const name = truncate(label, inner.w, { size, weight: 400 }).text;
  const cls = dark ? ' on-dark' : '';
  return (
    `<text class="hm-name${cls}" x="${round(b.x + PAD)}" y="${round(b.y + PAD + size * 0.8)}" style="font-size:${size}px">${escapeXml(name)}</text>` +
    `<text class="hm-num${cls}" x="${round(b.x + PAD)}" y="${round(b.y + PAD + size + 4 + COUNT_FONT.size * 0.8)}">${b.in}</text>`
  );
}

function legendSvg(max) {
  const y = PAD + 58;
  const stops = HEAT.map((c, i) => `<stop offset="${i / (HEAT.length - 1)}" stop-color="rgb(${c.join(',')})"/>`).join('');
  const after = `${max} relation${max === 1 ? '' : 's'} pointing at the table`;
  return [
    `<text class="hm-title" x="0" y="${PAD + 6}" dominant-baseline="central">Most referenced tables</text>`,
    `<text class="hm-legend" x="0" y="${PAD + 32}" dominant-baseline="central">Each block is a table; its size and colour grow with the relations pointing at it. ★ = central table of its domain.</text>`,
    `<linearGradient id="hm-scale">${stops}</linearGradient>`,
    `<text class="hm-legend" x="0" y="${y}" dominant-baseline="central">1</text>`,
    `<rect x="14" y="${y - 5}" width="${SCALE_W}" height="10" rx="5" fill="url(#hm-scale)"/>`,
    `<text class="hm-legend" x="${SCALE_W + 22}" y="${y}" dominant-baseline="central">${escapeXml(after)}</text>`,
  ].join('');
}

// The tables nothing points at, as names flowing over lines.
function zeroSvg(tables, top) {
  if (tables.length === 0) return { svg: '', h: 0 };
  const parts = [`<text class="hm-legend" x="0" y="${top}" dominant-baseline="central">Nothing points at ${plural(tables.length, 'table')}:</text>`];
  const sep = measureText(ZERO_SEP, ZERO_FONT);
  let x = 0;
  let y = top + ZERO_LINE;
  for (const t of tables) {
    const w = measureText(tableName(t.id), ZERO_FONT);
    if (x > 0 && x + sep + w > WIDTH) {
      x = 0;
      y += ZERO_LINE;
    } else if (x > 0) x += sep;
    parts.push(
      `<g class="hm-tile hm-zero" data-id="${escapeXml(t.id)}" data-in="0" data-out="${t.out}"><title>${escapeXml(`${t.id}: nothing points at it, ${t.out} from it`)}</title>` +
        `<text x="${round(x)}" y="${y}" dominant-baseline="central">${escapeXml(tableName(t.id))}</text></g>`,
    );
    x += w;
  }
  return { svg: parts.join(''), h: y - top + ZERO_LINE };
}

/**
 * SVG content of the heatmap view (coordinates from 0,0) and its bounds.
 * `tables` from heatmapTables.
 */
export function heatmapSvg(tables) {
  const hot = tables.filter((t) => t.in > 0);
  const max = hot[0]?.in ?? 0;
  const blocks = squarify(hot.map((t) => ({ ...t, value: t.in })), WIDTH, HEIGHT).map((b) => ({ ...b, y: b.y + LEGEND_HEIGHT }));
  const out = [`<g class="hm-legend-strip">${legendSvg(Math.max(max, 1))}</g>`];
  for (const b of blocks) {
    const dark = heatAt(b.in, max) >= DARK_FROM;
    out.push(
      `<g class="hm-tile" data-id="${escapeXml(b.id)}" data-in="${b.in}" data-out="${b.out}"><title>${escapeXml(`${b.id}: ${plural(b.in, 'relation')} point at it, ${b.out} from it`)}</title>` +
        `<rect x="${round(b.x + GAP / 2)}" y="${round(b.y + GAP / 2)}" width="${round(Math.max(0, b.w - GAP))}" height="${round(Math.max(0, b.h - GAP))}" rx="4" fill="${heatFill(b.in, max)}"/>` +
        `${blockText(b, dark)}</g>`,
    );
  }
  const below = LEGEND_HEIGHT + (hot.length > 0 ? HEIGHT : 0) + 28;
  const zero = zeroSvg(tables.filter((t) => t.in === 0), below);
  out.push(zero.svg);
  return { svg: out.join(''), bounds: { x: -MARGIN, y: -MARGIN, w: WIDTH + 2 * MARGIN, h: below + zero.h + 2 * MARGIN } };
}

export const HEATMAP_STYLE = `.hm-title { font-size: ${TITLE_FONT.size}px; font-weight: ${TITLE_FONT.weight}; fill: #1f2a3d; }
.hm-legend { font-size: ${LEGEND_FONT.size}px; font-weight: ${LEGEND_FONT.weight}; fill: #56627a; }
.hm-name { font-weight: 400; fill: #2a3546; }
.hm-num { font-size: ${COUNT_FONT.size}px; font-weight: ${COUNT_FONT.weight}; fill: #2a3546; }
.hm-name.on-dark, .hm-num.on-dark { fill: #ffffff; }
.hm-zero text { font-size: ${ZERO_FONT.size}px; fill: #56627a; }`;
