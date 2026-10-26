import { compareStrings } from '../../model/load.js';
import { measureText, truncate } from '../../text/measure.js';

// The heatmap view: the tables relations point at, ranked, one section per
// database. Each table is a row with its full name and a bar whose length and
// colour grow with that count (see referenceCounts), so the tables the rest of
// the schema leans on stand out; under each database, the tables no other
// table refers to follow as a grid of names. Drawn at render time from the
// model alone, so it needs no positions in layout.json and reads the same
// without script. Hovering a row names the table with its counts both ways;
// a click opens the table.

const WIDTH = 900;
const ROW = 22;
const BAR_H = 14;
const COL_GAP = 12;
const COUNT_W = 40;
const NAME_MIN = 120;
const NAME_MAX = 280;
const DB_GAP = 30;
const ZERO_COLS = 3;
const ZERO_CELL = 22;
const ZERO_GAP = 4;
const ZERO_PAD = 8;
const NAME_FONT = { size: 13, weight: 400 };
const COUNT_FONT = { size: 13, weight: 700 };
const ZERO_FONT = { size: 12, weight: 400 };
const DB_FONT = { size: 14, weight: 700 };
const MARGIN = 40;

// Heat stops, pale to deep, interpolated by the square root of count / max.
export const HEAT = [
  [255, 236, 190],
  [253, 196, 110],
  [240, 120, 50],
  [196, 40, 30],
  [130, 15, 25],
];

const escapeXml = (text) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const databaseOf = (id) => id.split('.')[0];
const tableName = (id) => id.split('.').at(-1);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const round = (v) => Math.round(v * 100) / 100;

/** Fill of a bar whose table `count` relations point at, `max` the highest count. */
export function heatFill(count, max) {
  const t = Math.sqrt(count / max) * (HEAT.length - 1);
  const i = Math.min(HEAT.length - 2, Math.floor(t));
  const f = t - i;
  return `rgb(${HEAT[i].map((c, k) => Math.round(c + (HEAT[i + 1][k] - c) * f)).join(',')})`;
}

/**
 * Every table of the diagram with its counts, grouped by database (by name),
 * each database's tables most referenced first, ties by id:
 * [{ database, tables: [{ id, in, out }] }]. `counts` from
 * referenceCounts. Exported for tests.
 */
export function heatmapTables(diagram, counts) {
  const byDb = new Map();
  for (const [id, n] of diagram.nodes) {
    if (n.kind !== 'table') continue;
    const db = databaseOf(id);
    if (!byDb.has(db)) byDb.set(db, []);
    byDb.get(db).push({ id, ...(counts.get(id) ?? { in: 0, out: 0 }) });
  }
  return [...byDb]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([database, tables]) => ({ database, tables: tables.sort((a, b) => b.in - a.in || compareStrings(a.id, b.id)) }));
}

const tipOf = (t) => `<title>${escapeXml(`${t.id}: ${plural(t.in, 'relation')} point${t.in === 1 ? 's' : ''} at it, ${t.out} from it`)}</title>`;
const tileAttrs = (t) => `data-id="${escapeXml(t.id)}" data-in="${t.in}" data-out="${t.out}"`;

// A database's header: its name, table and reference counts, a rule below.
function dbHeader(database, tables, y) {
  const refs = tables.reduce((n, t) => n + t.in, 0);
  const x = measureText(database, DB_FONT) + 10;
  return (
    `<text class="hm-db" x="0" y="${y}" dominant-baseline="central">${escapeXml(database)}</text>` +
    `<text class="hm-legend" x="${round(x)}" y="${y}" dominant-baseline="central">${plural(tables.length, 'table')} · ${plural(refs, 'reference')}</text>` +
    `<line class="hm-rule" x1="0" y1="${y + 14}" x2="${WIDTH}" y2="${y + 14}"/>`
  );
}

// One row: right-aligned name, bar, count; a full-width rect takes hover and clicks.
function barRow(t, y, nameW, max) {
  const barX = nameW + COL_GAP;
  const barW = WIDTH - barX - COL_GAP - COUNT_W;
  const name = truncate(tableName(t.id), nameW, NAME_FONT).text;
  return (
    `<g class="hm-tile" ${tileAttrs(t)}>${tipOf(t)}` +
    `<rect class="hm-hit" x="0" y="${y}" width="${WIDTH}" height="${ROW}" rx="3"/>` +
    `<text class="hm-name" x="${nameW}" y="${y + ROW / 2}" text-anchor="end" dominant-baseline="central">${escapeXml(name)}</text>` +
    `<rect x="${barX}" y="${y + (ROW - BAR_H) / 2}" width="${round(Math.max(4, (t.in / max) * barW))}" height="${BAR_H}" rx="3" fill="${heatFill(t.in, max)}"/>` +
    `<text class="hm-num" x="${WIDTH - COUNT_W}" y="${y + ROW / 2}" dominant-baseline="central">${t.in}</text></g>`
  );
}

// The tables no other table refers to, as a grid of names under the bars;
// the first grid of the view says why they have no bar.
function zeroGrid(tables, top, left, explain) {
  const cellW = (WIDTH - left - (ZERO_COLS - 1) * ZERO_GAP) / ZERO_COLS;
  const parts = [
    `<text class="hm-sub" x="${left}" y="${top}" dominant-baseline="central">No other table refers to these (${tables.length})</text>`,
  ];
  if (explain) parts.push(`<text class="hm-legend" x="${left}" y="${top + 17}" dominant-baseline="central">No column of another table points at them, so they get no bar. They may still point at other tables themselves: hover to see.</text>`);
  const gridTop = top + (explain ? 32 : 16);
  tables.forEach((t, i) => {
    const x = left + (i % ZERO_COLS) * (cellW + ZERO_GAP);
    const y = gridTop + Math.floor(i / ZERO_COLS) * (ZERO_CELL + ZERO_GAP);
    parts.push(
      `<g class="hm-tile hm-zero" ${tileAttrs(t)}>${tipOf(t)}` +
        `<rect x="${round(x)}" y="${y}" width="${round(cellW)}" height="${ZERO_CELL}" rx="4"/>` +
        `<text x="${round(x + ZERO_PAD)}" y="${y + ZERO_CELL / 2}" dominant-baseline="central">${escapeXml(truncate(tableName(t.id), cellW - 2 * ZERO_PAD, ZERO_FONT).text)}</text></g>`,
    );
  });
  return { svg: parts.join(''), h: gridTop - top + Math.ceil(tables.length / ZERO_COLS) * (ZERO_CELL + ZERO_GAP) };
}

/**
 * SVG content of the heatmap view (coordinates from 0,0) and its bounds.
 * `groups` from heatmapTables.
 */
export function heatmapSvg(groups) {
  const all = groups.flatMap((g) => g.tables);
  const max = Math.max(1, ...all.map((t) => t.in));
  const hot = all.filter((t) => t.in > 0);
  const nameW = Math.min(NAME_MAX, Math.max(NAME_MIN, ...hot.map((t) => measureText(tableName(t.id), NAME_FONT))));
  const out = [
    `<text class="hm-title" x="0" y="0" dominant-baseline="central">Most referenced tables</text>`,
    `<text class="hm-legend" x="0" y="22" dominant-baseline="central">Each bar counts the relations pointing at the table: columns of other tables that refer to it. Hover a row for both counts; click to open the table.</text>`,
  ];
  let y = 60;
  let explained = false;
  for (const { database, tables } of groups) {
    out.push(dbHeader(database, tables, y));
    y += 24;
    for (const t of tables.filter((x) => x.in > 0)) {
      out.push(barRow(t, y, nameW, max));
      y += ROW;
    }
    const zero = tables.filter((t) => t.in === 0);
    if (zero.length > 0) {
      const grid = zeroGrid(zero, y + 16, 0, !explained);
      explained = true;
      out.push(grid.svg);
      y += 16 + grid.h;
    }
    y += DB_GAP;
  }
  return { svg: out.join(''), bounds: { x: -MARGIN, y: -MARGIN, w: WIDTH + 2 * MARGIN, h: y + MARGIN } };
}

export const HEATMAP_STYLE = `.hm-title { font-size: 15px; font-weight: 700; fill: #1f2a3d; }
.hm-db { font-size: ${DB_FONT.size}px; font-weight: ${DB_FONT.weight}; fill: #1f2a3d; }
.hm-sub { font-size: 12px; font-weight: 600; fill: #3b475c; }
.hm-legend { font-size: 11px; fill: #56627a; }
.hm-rule { stroke: #e3e7ee; stroke-width: 1; }
.hm-hit { fill: transparent; }
.hm-name { font-size: ${NAME_FONT.size}px; fill: #2a3546; }
.hm-num { font-size: ${COUNT_FONT.size}px; font-weight: ${COUNT_FONT.weight}; fill: #2a3546; }
.hm-zero rect { fill: #f3f5f8; }
.hm-zero text { font-size: ${ZERO_FONT.size}px; fill: #56627a; }`;
