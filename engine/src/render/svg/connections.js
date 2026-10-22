import { dbDisplayName } from '../../display-name.js';
import { STRENGTH_SEGMENTS, strength } from '../../layout/domains.js';
import { measureText } from '../../text/measure.js';

// The connections view: one row and one column per domain, in the card
// order of the overview, grouped by database; a cell is shaded by how many
// relations go from the row's domain to the column's (rows reference
// columns), the diagonal by the relations inside one domain, in muted
// greys. Drawn at render time from the model alone, so it needs no
// positions in layout.json and reads the same without script. The viewer
// keeps the header row and column on screen while the matrix is panned
// (classes mx-sticky-*), and adds hover and click.

export const CELL = 26;
const NAME_FONT = { size: 12, weight: 400 };
const DB_FONT = { size: 11, weight: 700 };
const LEGEND_FONT = { size: 11, weight: 400 };
const TITLE_FONT = { size: 13, weight: 700 };
const SWATCH = 10;
const PAD = 12;
// Column names run up and to the right at this angle.
const SLANT = Math.PI / 4;
const DB_ROW = 26;
const DB_GAP = 10;
const MIN_CORNER = { w: 120, h: 60 };
// Title and legend above the matrix; they scroll away with it.
const LEGEND_HEIGHT = 64;
const MARGIN = 40;

// Sequential shades, lightest first: blue between domains, grey within one.
export const SHADES = ['#dce7f9', '#b4ccf2', '#82a8e6', '#4f80d4', '#2556b0'];
export const WITHIN_SHADES = ['#eef0f3', '#e1e5eb', '#d2d8e0', '#c1c8d3', '#aeb6c3'];
const EMPTY = '#f7f8fa';

const escapeXml = (text) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const nameOf = (key) => key.slice(key.indexOf('/') + 1);
const round = (v) => Math.round(v * 100) / 100;
const plural = (n) => `${n} relation${n === 1 ? '' : 's'}`;

/** Fill of a cell holding `count` relations (see connectionMatrix). */
export function cellFill(count, within, matrix) {
  if (count === 0) return EMPTY;
  const level = strength(count, within ? matrix.maxWithin : matrix.max);
  return (within ? WITHIN_SHADES : SHADES)[level - 1];
}

/**
 * Geometry of the matrix: rows and columns by key, database separators and
 * the frame of each sticky part. Exported for tests.
 */
export function matrixGeometry(matrix) {
  const { keys } = matrix;
  const multiDb = new Set(keys.map((k) => k.split('/')[0])).size > 1;
  const names = keys.map((k) => measureText(nameOf(k), NAME_FONT));
  const longest = Math.max(0, ...names);
  const corner = {
    y: LEGEND_HEIGHT,
    w: Math.ceil(Math.max(MIN_CORNER.w, longest + SWATCH + 3 * PAD)),
    h: Math.ceil(Math.max(MIN_CORNER.h, longest * Math.sin(SLANT) + 2 * PAD)),
  };
  const rows = new Map();
  const cols = new Map();
  const dbs = [];
  let x = corner.w;
  let y = corner.y + corner.h;
  let db = null;
  for (const k of keys) {
    const d = k.split('/')[0];
    if (d !== db) {
      if (multiDb) {
        if (db !== null) x += DB_GAP;
        dbs.push({ database: d, y, x });
        y += DB_ROW;
      }
      db = d;
    }
    rows.set(k, y);
    cols.set(k, x);
    y += CELL;
    x += CELL;
  }
  const right = x;
  const bottom = y;
  // Column names lean right past the last column; the legend may be wider still.
  const overhang = Math.ceil(longest * Math.cos(SLANT));
  const width = Math.max(right + overhang, legendSvg().w);
  return { corner, rows, cols, dbs, right, bottom, bounds: { x: -MARGIN, y: -MARGIN, w: width + 2 * MARGIN, h: bottom + 2 * MARGIN } };
}

// Title, then one legend line: what a row and a column mean, the shades.
function legendSvg() {
  const parts = [`<text class="mx-title" x="${PAD}" y="${PAD + 8}" dominant-baseline="central">Relations between domains</text>`];
  const y = PAD + 36;
  let x = PAD;
  const words = (text) => {
    parts.push(`<text class="mx-legend" x="${x}" y="${y}" dominant-baseline="central">${text}</text>`);
    x += Math.ceil(measureText(text, LEGEND_FONT)) + 16;
  };
  words('Each row references the column domains');
  SHADES.forEach((fill, i) => parts.push(`<rect x="${x + i * (SWATCH + 2)}" y="${y - SWATCH / 2}" width="${SWATCH}" height="${SWATCH}" fill="${fill}"/>`));
  x += STRENGTH_SEGMENTS * (SWATCH + 2) + 4;
  words('darker = more relations');
  parts.push(`<rect x="${x}" y="${y - SWATCH / 2}" width="${SWATCH}" height="${SWATCH}" fill="${WITHIN_SHADES[2]}"/>`);
  x += SWATCH + 6;
  words('inside one domain');
  return { svg: `<g class="mx-legend-strip">${parts.join('')}</g>`, w: x };
}

/**
 * SVG content of the connections view (coordinates from 0,0 at the top
 * left of the corner) and its bounds. `colorOf(key)` gives a domain's
 * palette entry; `matrix` comes from connectionMatrix.
 */
export function connectionsSvg(matrix, colorOf) {
  const g = matrixGeometry(matrix);
  const { keys, counts } = matrix;
  const count = (a, b) => counts.get(`${a}\u0000${b}`) ?? 0;
  const cells = [];
  for (const a of keys) {
    for (const b of keys) {
      const n = count(a, b);
      const within = a === b;
      const title = within ? `${nameOf(a)}: ${plural(n)} inside the domain` : `${nameOf(a)} → ${nameOf(b)}: ${plural(n)}, ${nameOf(b)} → ${nameOf(a)}: ${plural(count(b, a))}`;
      cells.push(
        `<rect class="mx-cell${within ? ' within' : ''}" data-from="${escapeXml(a)}" data-to="${escapeXml(b)}" x="${g.cols.get(b)}" y="${g.rows.get(a)}" width="${CELL}" height="${CELL}" fill="${cellFill(n, within, matrix)}"><title>${escapeXml(title)}</title></rect>`,
      );
    }
  }
  // Top of the cells, below the legend and the column names.
  const top = g.corner.y + g.corner.h;
  // Thin white grid over the cells keeps neighbouring shades apart; a darker
  // line between databases.
  const grid = [
    ...keys.map((k) => `M${g.cols.get(k)} ${top}V${g.bottom}`),
    ...keys.map((k) => `M${g.corner.w} ${g.rows.get(k)}H${g.right}`),
  ].join('');
  const separators = g.dbs
    .slice(1)
    .map((d) => `M${d.x - DB_GAP / 2} ${top}V${g.bottom}M${g.corner.w} ${d.y - 1}H${g.right}`)
    .join('');
  const rowHeads = keys.map((k) => {
    const y = g.rows.get(k) + CELL / 2;
    const c = colorOf(k);
    return (
      `<g class="mx-head" data-domain="${escapeXml(k)}"><rect class="mx-head-hit" x="0" y="${g.rows.get(k)}" width="${g.corner.w}" height="${CELL}"/>` +
      `<rect x="${PAD}" y="${y - SWATCH / 2}" width="${SWATCH}" height="${SWATCH}" rx="2" fill="${c.header}" stroke="${c.label}"/>` +
      `<text class="mx-name" x="${PAD + SWATCH + 8}" y="${y}" dominant-baseline="central">${escapeXml(nameOf(k))}</text></g>`
    );
  });
  const dbRows = g.dbs.map((d) => `<text class="mx-db" x="${PAD}" y="${d.y + DB_ROW / 2}" dominant-baseline="central">${escapeXml(dbDisplayName(d.database))}</text>`);
  const colHeads = keys.map((k) => {
    const x = g.cols.get(k) + CELL / 2;
    const y = top - 8;
    return (
      `<g class="mx-head" data-domain="${escapeXml(k)}"><text class="mx-name" x="${x}" y="${y}" transform="rotate(${round((-SLANT * 180) / Math.PI)} ${x} ${y})">${escapeXml(nameOf(k))}</text></g>`
    );
  });
  const svg = [
    `<g class="mx-cells">${cells.join('')}<path class="mx-grid" d="${grid}"/>${separators ? `<path class="mx-sep" d="${separators}"/>` : ''}</g>`,
    `<g class="mx-rows mx-sticky-x"><rect class="mx-bg" x="0" y="${top}" width="${g.corner.w}" height="${g.bottom - top}"/>${dbRows.join('')}${rowHeads.join('')}</g>`,
    `<g class="mx-cols mx-sticky-y" data-top="${g.corner.y}"><rect class="mx-bg" x="${g.corner.w}" y="${g.corner.y}" width="${g.bounds.x + g.bounds.w - g.corner.w}" height="${g.corner.h}"/>${colHeads.join('')}</g>`,
    `<g class="mx-corner mx-sticky-x mx-sticky-y" data-top="${g.corner.y}"><rect class="mx-bg" x="0" y="${g.corner.y}" width="${g.corner.w}" height="${g.corner.h}"/></g>`,
    legendSvg().svg,
  ].join('');
  return { svg, bounds: g.bounds, geometry: g };
}

export const CONNECTIONS_STYLE = `.mx-bg { fill: #ffffff; }
.mx-grid { fill: none; stroke: #ffffff; stroke-width: 1; }
.mx-sep { fill: none; stroke: #94a0b2; stroke-width: 1.5; }
.mx-name { font-size: ${NAME_FONT.size}px; font-weight: ${NAME_FONT.weight}; fill: #2a3546; }
.mx-db { font-size: ${DB_FONT.size}px; font-weight: ${DB_FONT.weight}; fill: #56627a; }
.mx-title { font-size: ${TITLE_FONT.size}px; font-weight: ${TITLE_FONT.weight}; fill: #1f2a3d; }
.mx-legend { font-size: ${LEGEND_FONT.size}px; font-weight: ${LEGEND_FONT.weight}; fill: #56627a; }
.mx-head-hit { fill: transparent; }`;
