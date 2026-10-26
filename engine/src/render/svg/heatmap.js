import { dbDisplayName } from '../../display-name.js';
import { strength } from '../../layout/domains.js';
import { compareStrings } from '../../model/load.js';
import { measureText, truncate } from '../../text/measure.js';

// The heatmap view: every table as a tile, grouped by domain in the card
// order of the overview (databases apart), most referenced first; a tile is
// shaded by how many relations point at its table (see referenceCounts), so
// the tables the rest of the schema leans on stand out. Drawn at render time
// from the model alone, so it needs no positions in layout.json and reads
// the same without script. The viewer adds tooltips and clicks (a tile opens
// its table, a domain name its domain).

const TILE = { w: 184, h: 34 };
const GAP = 6;
const COLS = 6;
const PAD = 12;
const NAME_FONT = { size: 12, weight: 400 };
const COUNT_FONT = { size: 12, weight: 700 };
const HEAD_FONT = { size: 13, weight: 700 };
const DB_FONT = { size: 14, weight: 700 };
const LEGEND_FONT = { size: 11, weight: 400 };
const TITLE_FONT = { size: 15, weight: 700 };
const SWATCH = 12;
const DB_ROW = 34;
const HEAD_ROW = 28;
const SECTION_GAP = 18;
const LEGEND_HEIGHT = 92;
const MARGIN = 40;
const STAR = '★ ';

// Sequential heat, lightest first; a table nothing points at stays grey.
export const HEAT = ['#fde9c8', '#fbc98a', '#f59e57', '#e5672f', '#b83a1b'];
const EMPTY = '#f1f3f6';
// From this shade up the text is white.
const DARK_LEVEL = 4;

const escapeXml = (text) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const nameOf = (key) => key.slice(key.indexOf('/') + 1);
const tableName = (id) => id.split('.').at(-1);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Fill of a tile whose table `count` relations point at, `max` the schema's highest count. */
export function heatFill(count, max) {
  return count === 0 ? EMPTY : HEAT[strength(count, max) - 1];
}

/**
 * Tiles of each domain in `order` (cluster keys), most referenced first,
 * ties by id: [{ key, tables: [{ id, in, out, central }] }]. `counts` from
 * referenceCounts. Exported for tests.
 */
export function heatmapSections(order, diagram, counts) {
  return order.map((key) => ({
    key,
    tables: diagram.clusters
      .get(key)
      .filter((id) => diagram.nodes.get(id).kind === 'table')
      .map((id) => ({ id, ...(counts.get(id) ?? { in: 0, out: 0 }), central: Boolean(diagram.nodes.get(id).central) }))
      .sort((a, b) => b.in - a.in || compareStrings(a.id, b.id)),
  }));
}

function legendSvg(max) {
  const parts = [
    `<text class="hm-title" x="0" y="${PAD + 6}" dominant-baseline="central">Most referenced tables</text>`,
    `<text class="hm-legend" x="0" y="${PAD + 32}" dominant-baseline="central">Each tile is a table; the darker, the more relations point at it. ★ = central table of its domain.</text>`,
  ];
  const y = PAD + 58;
  let x = 0;
  const words = (text) => {
    parts.push(`<text class="hm-legend" x="${x}" y="${y}" dominant-baseline="central">${escapeXml(text)}</text>`);
    x += Math.ceil(measureText(text, LEGEND_FONT)) + 8;
  };
  const swatch = (fill) => {
    parts.push(`<rect x="${x}" y="${y - SWATCH / 2}" width="${SWATCH}" height="${SWATCH}" rx="2" fill="${fill}"/>`);
    x += SWATCH + 3;
  };
  words('Relations pointing at the table:');
  swatch(EMPTY);
  x += 3;
  words('0');
  HEAT.forEach(swatch);
  x += 3;
  words(max > 0 ? `1 to ${max}` : '1 or more');
  return parts.join('');
}

/**
 * SVG content of the heatmap view (coordinates from 0,0) and its bounds.
 * `sections` from heatmapSections; `colorOf(key)` gives a domain's palette entry.
 */
export function heatmapSvg(sections, colorOf) {
  const max = Math.max(0, ...sections.flatMap((s) => s.tables.map((t) => t.in)));
  const multiDb = new Set(sections.map((s) => s.key.split('/')[0])).size > 1;
  const width = COLS * (TILE.w + GAP) - GAP;
  const out = [`<g class="hm-legend-strip">${legendSvg(max)}</g>`];
  let y = LEGEND_HEIGHT;
  let db = null;
  for (const { key, tables } of sections) {
    const d = key.split('/')[0];
    if (multiDb && d !== db) {
      out.push(`<text class="hm-db" x="0" y="${y + DB_ROW / 2}" dominant-baseline="central">${escapeXml(dbDisplayName(d))}</text>`);
      y += DB_ROW;
    }
    db = d;
    const c = colorOf(key);
    const label = nameOf(key);
    out.push(
      `<g class="hm-head" data-domain="${escapeXml(key)}"><rect class="hm-head-hit" x="0" y="${y}" width="${width}" height="${HEAD_ROW}"/>` +
        `<rect x="0" y="${y + HEAD_ROW / 2 - SWATCH / 2}" width="${SWATCH}" height="${SWATCH}" rx="2" fill="${c.header}" stroke="${c.label}"/>` +
        `<text class="hm-name" x="${SWATCH + 8}" y="${y + HEAD_ROW / 2}" dominant-baseline="central">${escapeXml(label)}</text>` +
        `<text class="hm-count" x="${SWATCH + 16 + Math.ceil(measureText(label, HEAD_FONT))}" y="${y + HEAD_ROW / 2}" dominant-baseline="central">${plural(tables.length, 'table')}</text></g>`,
    );
    y += HEAD_ROW;
    tables.forEach((t, i) => {
      const tx = (i % COLS) * (TILE.w + GAP);
      const ty = y + Math.floor(i / COLS) * (TILE.h + GAP);
      const count = String(t.in);
      const room = TILE.w - 2 * PAD - measureText(count, COUNT_FONT) - 8;
      const name = truncate(`${t.central ? STAR : ''}${tableName(t.id)}`, room, NAME_FONT).text;
      const dark = t.in > 0 && strength(t.in, max) >= DARK_LEVEL;
      const title = `${t.id}: ${plural(t.in, 'relation')} point at it, ${t.out} from it`;
      out.push(
        `<g class="hm-tile${dark ? ' on-dark' : ''}" data-id="${escapeXml(t.id)}" data-in="${t.in}" data-out="${t.out}"><title>${escapeXml(title)}</title>` +
          `<rect x="${tx}" y="${ty}" width="${TILE.w}" height="${TILE.h}" rx="4" fill="${heatFill(t.in, max)}"/>` +
          `<text class="hm-tile-name" x="${tx + PAD}" y="${ty + TILE.h / 2}" dominant-baseline="central">${escapeXml(name)}</text>` +
          `<text class="hm-tile-count" x="${tx + TILE.w - PAD}" y="${ty + TILE.h / 2}" dominant-baseline="central" text-anchor="end">${count}</text></g>`,
      );
    });
    y += Math.ceil(tables.length / COLS) * (TILE.h + GAP) - GAP + SECTION_GAP;
  }
  return { svg: out.join(''), bounds: { x: -MARGIN, y: -MARGIN, w: width + 2 * MARGIN, h: y + 2 * MARGIN } };
}

export const HEATMAP_STYLE = `.hm-title { font-size: ${TITLE_FONT.size}px; font-weight: ${TITLE_FONT.weight}; fill: #1f2a3d; }
.hm-legend { font-size: ${LEGEND_FONT.size}px; font-weight: ${LEGEND_FONT.weight}; fill: #56627a; }
.hm-db { font-size: ${DB_FONT.size}px; font-weight: ${DB_FONT.weight}; fill: #56627a; }
.hm-head-hit { fill: transparent; }
.hm-name { font-size: ${HEAD_FONT.size}px; font-weight: ${HEAD_FONT.weight}; fill: #2a3546; }
.hm-count { font-size: 12px; fill: #7a8597; }
.hm-tile-name { font-size: ${NAME_FONT.size}px; font-weight: ${NAME_FONT.weight}; fill: #2a3546; }
.hm-tile-count { font-size: ${COUNT_FONT.size}px; font-weight: ${COUNT_FONT.weight}; fill: #2a3546; }
.hm-tile.on-dark text { fill: #ffffff; }`;
