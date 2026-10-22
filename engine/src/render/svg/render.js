import { DB_FACT_FONT, DB_LABEL_FONT, ENGINE_FONT, LABEL_FONT, LABEL_OFFSET, clusterLabel, dbLabel, engineName, labelBox } from '../../layout/clusters.js';
import { VIEW_SOURCE, buildDiagram, domainLinks, plural, polyLinkId, relationId } from '../../layout/diagram.js';
import { resolveView } from '../../layout/index.js';
import { routeOverview } from '../../layout/overview-router.js';
import { STUB, routeEdges } from '../../layout/router.js';
import { GRID, BADGE_ARROW_WIDTH, BADGE_FONT, DOMAIN_COUNT_FONT, DOMAIN_TITLE_FONT, EMBED_INSET, FACT_FONT, HEADER_HEIGHT, PADDING_X, ROW_HEIGHT, TAG_FONT, attachOffset } from '../../layout/table-box.js';
import { ALL_VIEW, OVERVIEW, hasAllView, viewNames } from '../../layout/views.js';
import { columnEntries, enumMeaning, technicalColumns } from '../../model/columns.js';
import { compareStrings } from '../../model/load.js';
import { missingRelations } from '../../model/missing.js';
import { measureText } from '../../text/measure.js';
import { FONT_FAMILY, TEXT_STYLE_CSS, fontFaceCss } from '../../text/font.js';
import { PALETTE } from '../../palette.js';
import { UNCONFIRMED_DASH, endMarkers, enumIconSvg, isConfirmed, markerSvg, overviewStrokeWidth } from './markers.js';
import viewerBundle from './viewer-bundle.json' with { type: 'json' };

const CANVAS_MARGIN = 40;
// Warning triangle of a column, inside the row's left padding (PADDING_X).
const WARN_SIZE = 8;
const WARN_INSET = 2;
const CORNER = 6;
const EDGE_LABEL_FONT = { size: 10, weight: 700 };
const EDGE_LABEL_PAD = { x: 4, y: 3 };
// Round badge with the relation count, at the middle of an overview line;
// a pill when the number is too wide for a circle.
const BADGE_COUNT_FONT = { size: 10, weight: 700 };
const BADGE_HEIGHT = 16;
const BANNER_TITLE_FONT = { size: 15, weight: 700 };
const BANNER_SUMMARY_FONT = { size: 13, weight: 400 };
const BANNER_LEGEND_FONT = { size: 12, weight: 400 };
const BANNER_PAD = 14;
const BANNER_LINE = 22;
const BANNER_GAP = 24;
const SWATCH = 12;
const LEGEND_GAP = 18;

// Rules the embedded viewer script relies on. Without script none of these
// classes is ever set, so the static drawing is unaffected.
const VIEWER_STYLE = `.row-hit { fill: transparent; }
/* The drawing moves under the pointer when dragged: no text selection, and
   one composited layer for the pan/zoom transform. */
.camera { -webkit-user-select: none; user-select: none; will-change: transform; }
.column:hover .row-hit { fill: #eef3fb; }
.column.hl-column .row-hit { fill: #fff1b8; }
.domain, .stub, .table, .poly, .relation-group, .hub-badge { cursor: pointer; }
.relation-hit { fill: none; stroke: transparent; stroke-width: 12; }
.view.dimmed :is(.table, .stub, .poly, .domain, .relation-group):not(.hl) { opacity: 0.16; }
.view.dimmed.center-selected :is(.table, .poly).hop-2:not(.hl) { opacity: 1; }
.view.dimmed.center-selected .hop-2:not(.hl) > rect:last-of-type { stroke: #d9dee6; }
.view.dimmed.center-selected .relation-group.hop-2:not(.hl) { opacity: 0.5; }
.hl > rect:last-of-type { stroke: #5b8def; stroke-width: 2; }
.selected > rect:last-of-type { stroke: #1d4ed8; stroke-width: 3; }
.flow-target > rect:last-of-type { stroke: #e8590c; stroke-width: 3; animation: oe-pulse 0.9s ease-in-out infinite alternate; }
.relation-group.hl .relation, .relation-group.hl .marker { stroke: #2563eb; stroke-width: 2; }
.overview-link.hl .count-badge rect { stroke: #2563eb; }
.relation-group.flowing .relation { stroke-opacity: 0.35; }
.flow { fill: none; stroke: #2563eb; stroke-width: 3; stroke-dasharray: 6 10; pointer-events: none; animation: oe-flow 0.8s linear infinite; }
.poly-route { fill: none; stroke: #6b778a; stroke-width: 1.4; }
.hub-route .relation, .hub-route .marker { stroke: #2563eb; stroke-width: 1.6; }
.hub-route { cursor: pointer; }
@keyframes oe-flow { to { stroke-dashoffset: -16; } }
@keyframes oe-pulse { to { stroke-width: 6; } }
.business .column-type { display: none; }
.business .column.technical { opacity: 0.18; }
.oe-ui { font-family: '${FONT_FAMILY}', sans-serif; font-size: 13px; color: #1f2a3d; box-sizing: border-box; }
.oe-ui * { box-sizing: border-box; }
.oe-toolbar { display: flex; align-items: center; gap: 10px; height: 44px; padding: 0 12px; background: #ffffff; border-bottom: 1px solid #d5dbe4; position: relative; }
.oe-crumbs { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; }
.oe-crumbs .sep { color: #9aa4b5; }
.oe-crumbs .here { font-weight: 700; }
.oe-link { color: #1d4ed8; cursor: pointer; background: none; border: 0; padding: 0; font: inherit; }
.oe-link:hover { text-decoration: underline; }
.oe-btn { font: inherit; padding: 4px 10px; border: 1px solid #c3cad5; border-radius: 6px; background: #ffffff; color: #1f2a3d; cursor: pointer; }
.oe-btn:hover { background: #f1f4f8; }
.oe-btn:disabled { color: #a7b0bf; cursor: default; background: #ffffff; }
.oe-btn.on { background: #1f2a3d; border-color: #1f2a3d; color: #ffffff; }
.oe-seg { display: flex; }
.oe-seg .oe-btn { border-radius: 0; }
.oe-seg .oe-btn:first-child { border-radius: 6px 0 0 6px; }
.oe-seg .oe-btn:last-child { border-radius: 0 6px 6px 0; margin-left: -1px; }
.oe-search { position: relative; }
.oe-search input { font: inherit; width: 220px; padding: 5px 9px; border: 1px solid #c3cad5; border-radius: 6px; }
.oe-results { position: absolute; top: 34px; right: 0; width: 360px; max-height: 360px; overflow: auto; background: #ffffff; border: 1px solid #c3cad5; border-radius: 6px; box-shadow: 0 6px 18px rgba(20, 30, 50, 0.15); }
.oe-result { display: block; width: 100%; text-align: left; padding: 6px 10px; border: 0; background: none; font: inherit; cursor: pointer; }
.oe-result:hover, .oe-result.active { background: #eef3fb; }
.oe-result .where { color: #7a8597; font-size: 11px; }
.oe-panel { background: #ffffff; border: 1px solid #c3cad5; border-radius: 8px; padding: 12px 14px; box-shadow: 0 6px 18px rgba(20, 30, 50, 0.12); overflow: auto; }
.oe-panel h3 { margin: 0 0 4px; font-size: 14px; overflow-wrap: anywhere; }
.oe-panel .sub { color: #7a8597; font-size: 12px; margin-bottom: 8px; overflow-wrap: anywhere; }
.oe-panel .row { display: flex; gap: 6px; align-items: center; margin: 8px 0; }
.oe-panel ul { margin: 4px 0 0; padding-left: 16px; }
.oe-panel li { margin: 3px 0; overflow-wrap: anywhere; }
.oe-panel p { margin: 6px 0; }
.oe-panel .muted { color: #7a8597; }
.oe-panel .row { flex-wrap: wrap; }
.oe-panel .where { color: #7a8597; font-size: 12px; }
.oe-panel .detail { display: block; color: #7a8597; font-size: 12px; }
.oe-panel .row > .label { flex-basis: 100%; }
.oe-panel details { margin: 10px 0 2px; }
.oe-panel summary { cursor: pointer; color: #7a8597; font-size: 12px; }
.oe-related { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.oe-related > span { color: #56627a; }
.oe-changes { background: #fff8eb; border: 1px solid #f3d9a4; border-radius: 6px; padding: 6px 10px; margin: 8px 0; }
.oe-changes .sub { margin-bottom: 2px; color: #8a5a00; }
.oe-changes li { word-break: normal; overflow-wrap: anywhere; }
.oe-tip { background: #1f2a3d; color: #f4f6f9; border-radius: 6px; padding: 8px 10px; font-size: 12px; line-height: 1.45; max-width: 360px; display: inline-block; overflow: auto; }
.oe-tip p { margin: 4px 0; }
.oe-chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0; }
.oe-chips .chip { font-size: 11px; line-height: 16px; padding: 0 6px; border-radius: 8px; background: #eef1f5; color: #3d4a5e; white-space: nowrap; }
.oe-tip .oe-chips .chip { background: #34415a; color: #dfe5ee; }
.oe-chips .chip.pii, .oe-tip .oe-chips .chip.pii { background: #ffe1d8; color: #a8341a; }
.oe-enum { border-collapse: collapse; margin: 4px 0; width: 100%; }
.oe-enum td { padding: 1px 8px 1px 0; vertical-align: top; overflow-wrap: anywhere; }
.oe-enum td.value { font-weight: 700; white-space: nowrap; }
.oe-tip .oe-enum td { color: #c9d1dd; }
.oe-tip .oe-enum td.value { color: #ffffff; }
.oe-hidden { display: none; }
.oe-legend { display: inline-block; background: #ffffff; border: 1px solid #c3cad5; border-radius: 8px; padding: 8px 12px; box-shadow: 0 6px 18px rgba(20, 30, 50, 0.12); font-size: 12px; max-width: 300px; }
.oe-legend .head { display: flex; justify-content: space-between; gap: 24px; }
.oe-legend .sub { color: #7a8597; font-size: 11px; margin: 6px 0 2px; }
.oe-legend .item { display: flex; align-items: center; gap: 8px; min-height: 20px; padding: 1px 0; line-height: 1.3; }
.oe-legend svg { flex: none; overflow: visible; }
.oe-grid-wrap { overflow-x: auto; margin: 4px 0 10px; }
.oe-grid { border-collapse: collapse; width: 100%; font-size: 11px; line-height: 1.35; }
.oe-grid th { text-align: left; color: #7a8597; font-weight: 400; border-bottom: 1px solid #d5dbe4; padding: 2px 4px; }
.oe-grid td { padding: 2px 4px; border-bottom: 1px solid #eef1f5; vertical-align: top; }
.oe-grid td.num { color: #9aa4b5; text-align: right; }
.oe-grid td.name { font-weight: 700; overflow-wrap: anywhere; }
.oe-grid td.type { color: #56627a; white-space: nowrap; }
.oe-grid .comment { color: #56627a; overflow-wrap: anywhere; }
.oe-grid tr.technical td.name { font-weight: 400; color: #56627a; }
.oe-grid tr.open > td { background: #fff1b8; }
.oe-grid tr[data-column] > td { border-bottom: 0; }
.oe-grid tr.more > td { padding-top: 0; }
.oe-grid details { margin: 0; }
.oe-grid summary { font-size: 11px; color: #7c5cc4; }
.oe-grid .chip { margin-left: 4px; font-size: 10px; padding: 0 4px; border-radius: 6px; font-weight: 700; background: #ffe1d8; color: #a8341a; }
.cluster-label { cursor: pointer; }
.fold-hit { fill: transparent; cursor: pointer; }
.fold-toggle rect { fill: #ffffff; stroke: #8a94a6; stroke-width: 1; }
.fold-toggle .fold-sign { fill: none; stroke: #56627a; stroke-width: 1.4; stroke-linecap: round; }
.oe-minimap { background: #ffffff; border: 1px solid #c3cad5; border-radius: 6px; box-shadow: 0 6px 18px rgba(20, 30, 50, 0.12); padding: 4px; cursor: crosshair; touch-action: none; line-height: 0; }
.oe-minimap .node { fill: #9aa4b5; }
.oe-minimap .frame { stroke: none; }
.oe-minimap .seen { fill: rgba(37, 99, 235, 0.08); stroke: #2563eb; stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.fold-badge rect { fill: #ffffff; stroke: #c3cad5; }
.fold-badge-text { font-size: 11px; font-weight: 400; fill: #56627a; }
.oe-download { position: relative; }
.oe-menu { position: absolute; top: 34px; right: 0; width: 300px; background: #ffffff; border: 1px solid #c3cad5; border-radius: 6px; box-shadow: 0 6px 18px rgba(20, 30, 50, 0.15); padding: 4px 0; white-space: normal; }
.oe-check { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-top: 1px solid #eef1f5; margin-top: 4px; color: #3d4a5e; cursor: pointer; }
.oe-status:not(:empty) { padding: 6px 10px; color: #56627a; font-size: 12px; border-top: 1px solid #eef1f5; overflow-wrap: anywhere; }
.oe-panel .label-inline { color: #7a8597; font-size: 12px; min-width: 36px; }
.oe-join-field input { font: inherit; flex: 1; padding: 4px 8px; border: 1px solid #c3cad5; border-radius: 6px; }
.oe-join-picks .oe-result { padding: 4px 10px 4px 42px; }
.oe-paths { margin: 10px 0 6px; flex-wrap: wrap; }
.oe-hops { padding-left: 20px; }
.oe-hops li { margin: 6px 0; }
.oe-hops code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: #f3f5f8; border-radius: 4px; padding: 1px 4px; overflow-wrap: anywhere; }
.oe-chips .chip.flag-trust { background: #fff1d6; color: #8a5a00; }
.oe-chips .chip.flag-cross_db { background: #e7f0ff; color: #1d4ed8; }
.oe-chips .chip.flag-polymorphic { background: #f6efdf; color: #6b5428; }
.oe-chips .chip.flag-multiplies { background: #fde8e8; color: #a61f1f; }
.oe-warn { color: #9a6208; font-size: 12px; margin: 4px 0; }
.oe-tip .oe-warn { color: #ffd27a; }
.oe-tip b { color: #ffffff; }
.oe-tip .muted { color: #aab4c4; }
.oe-tip .pii { color: #ffb4a2; font-weight: 700; }`;

// Diff colours: added green, removed red (dashed ghost, struck through),
// changed amber, renamed blue. In a diff drawing the lines nothing changed
// are greyed out, so review colours do not compete with change colours.
const DIFF_COLORS = {
  added: { stroke: '#2f9e44', fill: '#ebfbee' },
  removed: { stroke: '#e03131', fill: '#fff5f5' },
  changed: { stroke: '#f08c00', fill: '#fff4e6' },
  renamed: { stroke: '#1c7ed6', fill: '#e7f5ff' },
};
const DIFF_STYLE = [
  ...Object.entries(DIFF_COLORS).flatMap(([status, c]) => [
    `.diff-${status} > rect:last-of-type { stroke: ${c.stroke}; stroke-width: 3; }`,
    `.table.diff-${status} .table-box, .stub.diff-${status} .stub-box { fill: ${c.fill}; }`,
    `.relation-group.diff-${status} .relation, .relation-group.diff-${status} .marker { stroke: ${c.stroke}; stroke-width: 2.2; }`,
    `.column.col-${status} .row-hit { fill: ${c.fill}; }`,
    `.col-mark.col-${status}, .legend-swatch.diff-${status} { fill: ${c.stroke}; }`,
  ]),
  '.diff-removed > rect:last-of-type { stroke-dasharray: 6 4; }',
  '.table.diff-removed, .stub.diff-removed, .poly.diff-removed, .domain.diff-removed { opacity: 0.7; }',
  '.diff-removed :is(.table-title, .stub-title, .poly-title, .domain-title), .column.col-removed text { text-decoration: line-through; }',
  '.column.col-removed .column-name { fill: #c92a2a; }',
  '.relation-group.diff-removed .relation { stroke-dasharray: 6 4; }',
  '.diff-mode .relation-group:not(.diff-added, .diff-removed, .diff-changed) :is(.relation, .marker) { stroke: #c3cad5; stroke-dasharray: none; }',
  '.diff-mode .relation-group:not(.diff-added, .diff-removed, .diff-changed) .edge-label text { fill: #9aa4b5; }',
  '.banner-box { fill: #ffffff; stroke: #94a0b2; stroke-width: 1.2; }',
  `.banner-title { font-size: ${BANNER_TITLE_FONT.size}px; font-weight: ${BANNER_TITLE_FONT.weight}; fill: #172033; }`,
  `.banner-summary { font-size: ${BANNER_SUMMARY_FONT.size}px; font-weight: ${BANNER_SUMMARY_FONT.weight}; fill: #2a3546; }`,
  `.banner-legend { font-size: ${BANNER_LEGEND_FONT.size}px; font-weight: ${BANNER_LEGEND_FONT.weight}; fill: #56627a; }`,
].join('\n');

// Lines are one neutral colour, solid when confirmed and dashed when not
// (see isConfirmed). Review mode (a class the viewer sets on the root)
// colours them by review state for reviewers: pending amber, stale red.
const STYLE = `${fontFaceCss()}
text { font-family: '${FONT_FAMILY}', sans-serif; ${TEXT_STYLE_CSS} }
.cluster-label { font-size: ${LABEL_FONT.size}px; font-weight: ${LABEL_FONT.weight}; }
.db-frame { fill: #fbfcfd; stroke: #94a0b2; stroke-width: 1.2; }
.db-name { font-size: ${DB_LABEL_FONT.size}px; font-weight: ${DB_LABEL_FONT.weight}; fill: #1f2a3d; }
.db-icon { fill: #e4e9f0; stroke: #5b6880; stroke-width: 1.2; }
.engine-pill { fill: #2f3b4f; }
.engine-name { font-size: ${ENGINE_FONT.size}px; font-weight: ${ENGINE_FONT.weight}; fill: #ffffff; }
.table-box { fill: #ffffff; stroke: #b8c2d0; stroke-width: 1; }
.table-title { font-size: 13px; font-weight: 700; fill: #172033; }
.column-name { font-size: 12px; font-weight: 400; fill: #2a3546; }
.column-name.pk { font-weight: 700; }
.column-type { font-size: 12px; font-weight: 400; fill: #7a8597; }
.hint-enum { fill: none; stroke: #7c5cc4; stroke-width: 1.3; stroke-linecap: round; }
.col-warn { fill: #e8a317; stroke: #ffffff; stroke-width: 0.8; stroke-linejoin: round; }
.badge-text { font-size: ${BADGE_FONT.size}px; font-weight: ${BADGE_FONT.weight}; fill: #56627a; }
.badge-arrow { fill: none; stroke: #56627a; stroke-width: 1.2; }
.poly-box { fill: #fffdf7; stroke: #a08a5c; stroke-width: 1; stroke-dasharray: 4 3; }
.poly-title { font-size: 13px; font-weight: 700; fill: #6b5428; }
.poly-target { font-size: 12px; font-weight: 400; fill: #4a4236; }
.stub-box { fill: #f3f5f8; stroke: #c3cad5; stroke-width: 1; stroke-dasharray: 3 3; }
.stub-title { font-size: 12px; font-weight: 400; fill: #8a94a6; }
.domain-title { font-size: ${DOMAIN_TITLE_FONT.size}px; font-weight: ${DOMAIN_TITLE_FONT.weight}; }
.domain-count { font-size: ${DOMAIN_COUNT_FONT.size}px; font-weight: ${DOMAIN_COUNT_FONT.weight}; fill: #5f6b7e; }
.relation { fill: none; stroke: #6b778a; stroke-width: 1.4; stroke-linejoin: round; }
.marker { fill: none; stroke: #6b778a; stroke-width: 1.4; }
.marker .ring { fill: #ffffff; }
.edge-label rect { fill: #ffffff; }
.edge-label text { font-size: ${EDGE_LABEL_FONT.size}px; font-weight: ${EDGE_LABEL_FONT.weight}; fill: #4f5b6e; }
.unconfirmed .relation, .poly-route.unconfirmed { stroke-dasharray: ${UNCONFIRMED_DASH}; }
.review-mode .review-pending :is(.relation, .marker) { stroke: #c27c0e; }
.review-mode .review-pending .edge-label text { fill: #9a6208; }
.review-mode .review-stale :is(.relation, .marker) { stroke: #c53030; }
.review-mode .review-stale .edge-label text { fill: #a61f1f; }
.kind-view_source .relation { stroke: #a9b2c0; stroke-dasharray: 5 4; }
.overview-link .relation { stroke: #8a96a8; stroke-linecap: round; }
.overview-link.kind-cross_db .relation { stroke-dasharray: 8 6; stroke-linecap: butt; }
.count-badge rect { fill: #ffffff; stroke: #8a96a8; stroke-width: 1; }
.count-badge text { font-size: ${BADGE_COUNT_FONT.size}px; font-weight: ${BADGE_COUNT_FONT.weight}; fill: #3d4a5e; }
.table-tag { font-size: ${TAG_FONT.size}px; font-weight: ${TAG_FONT.weight}; fill: #5f6b7e; letter-spacing: 0.02em; }
.table.is-view > rect:last-of-type { stroke-dasharray: 5 3; }
.tenant-copy { fill: #ffffff; stroke: #c9d1dc; stroke-width: 1; }
.inset-box { fill: #f6f8fb; stroke: #d5dbe4; stroke-width: 1; }
.inset-title { font-size: 12px; font-weight: 700; fill: #56627a; }
.fact-text { font-size: ${FACT_FONT.size}px; font-weight: ${FACT_FONT.weight}; fill: #5f6b7e; }
.db-fact-pill { fill: #eef1f5; stroke: #c3cad5; stroke-width: 1; }
.db-fact { font-size: ${DB_FACT_FONT.size}px; font-weight: ${DB_FACT_FONT.weight}; fill: #3d4a5e; }
${DIFF_STYLE}
${VIEWER_STYLE}`;

function escapeXml(text) {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

const camel = (name) => name.replace(/_(.)/g, (_, c) => c.toUpperCase());

// Marks of a plain render: nothing changed.
const NO_MARKS = { nodes: new Map(), columns: new Map(), links: new Map(), sentences: { nodes: new Map(), links: new Map() } };
const diffClass = (marks, id) => (marks.nodes.has(id) ? ` diff-${marks.nodes.get(id)}` : '');
const linkDiffClass = (marks, id) => (marks.links.has(id) ? ` diff-${marks.links.get(id)}` : '');
// Native tooltip text: the id, then what changed, so a viewer without
// script still tells what happened to an element.
const titleText = (marks, id, text, kind = 'nodes') => [text, ...(marks.sentences[kind].get(id) ?? [])].join('\n');

/**
 * Banner of a diff drawing, above the content of a view: which snapshots
 * are compared, the summary line and the colour legend. Returns the SVG
 * and the view bounds grown to hold it.
 */
function diffBanner(bounds, diff) {
  const title = `Changes from ${diff.from} to ${diff.to}`;
  const legend = Object.keys(DIFF_COLORS).map((status) => {
    const text = status[0].toUpperCase() + status.slice(1);
    return { status, text, w: SWATCH + 6 + measureText(text, BANNER_LEGEND_FONT) };
  });
  const legendWidth = legend.reduce((n, l) => n + l.w, 0) + LEGEND_GAP * (legend.length - 1);
  const w = Math.ceil(Math.max(measureText(title, BANNER_TITLE_FONT), measureText(diff.summary, BANNER_SUMMARY_FONT), legendWidth)) + 2 * BANNER_PAD;
  const h = 3 * BANNER_LINE + 2 * BANNER_PAD - 8;
  const x = bounds.x + CANVAS_MARGIN;
  const y = bounds.y + CANVAS_MARGIN - BANNER_GAP - h;
  const line = (i) => y + BANNER_PAD + BANNER_LINE * i + BANNER_LINE / 2 - 4;
  let lx = x + BANNER_PAD;
  const items = legend.map((l) => {
    const item =
      `<rect class="legend-swatch diff-${l.status}" x="${lx}" y="${line(2) - SWATCH / 2}" width="${SWATCH}" height="${SWATCH}" rx="2"/>` +
      `<text class="banner-legend" x="${lx + SWATCH + 6}" y="${line(2)}" dominant-baseline="central">${l.text}</text>`;
    lx += l.w + LEGEND_GAP;
    return item;
  });
  const svg =
    `<g class="diff-banner"><rect class="banner-box" x="${x}" y="${y}" width="${w}" height="${h}" rx="8"/>` +
    `<text class="banner-title" x="${x + BANNER_PAD}" y="${line(0)}" dominant-baseline="central">${escapeXml(title)}</text>` +
    `<text class="banner-summary" x="${x + BANNER_PAD}" y="${line(1)}" dominant-baseline="central">${escapeXml(diff.summary)}</text>` +
    `${items.join('')}</g>`;
  const top = y - CANVAS_MARGIN;
  return { svg, bounds: { x: bounds.x, y: top, w: Math.max(bounds.w, w + 2 * CANVAS_MARGIN), h: bounds.y + bounds.h - top } };
}

const nodeRect = (n) => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h });

function countBadge(count, [cx, cy]) {
  const text = String(count);
  const w = Math.max(BADGE_HEIGHT, Math.ceil(measureText(text, BADGE_COUNT_FONT)) + 8);
  return { text, cx, cy, x: cx - w / 2, y: cy - BADGE_HEIGHT / 2, w, h: BADGE_HEIGHT };
}

// A cross-DB line in a table view names both databases it joins, in the
// direction of the reference ("billing → auth"), so a line touching one
// database never reads as belonging to only the other. Overview lines carry
// no label: their count badge says how many relations they stand for, the
// tooltip and panel name the databases.
function labelText(link) {
  return link.kind === 'cross_db' ? `${link.from.node.split('.')[0]} → ${link.to.node.split('.')[0]}` : null;
}

// Labels go where they read as part of their own line and cover nothing
// else. Candidates, in order of preference:
//   1. on a horizontal stretch clear of the end markers (the first and last
//      STUB px of the line), longest stretch first, centre first, then
//      sliding outwards one label step at a time;
//   2. the same stretches lifted just above the line, clear of the markers'
//      spread (used when a short line has no free stretch);
//   3. on a vertical segment, middle first.
// The first candidate that overlaps no placed label and no other line wins;
// then the first one that at least overlaps no placed label (a crowded
// overview has lines everywhere). A line too short for all of them (two
// domains side by side) tries spots around the middle of each segment,
// on, above, below and beside it, kept only when they cover no box; failing
// all, the first candidate. Route points keep MARGIN + GRID from
// foreign boxes, more than half a label's height, so a label on its line
// stays clear of them.
const LABEL_LIFT = 8;
const LABEL_STEP = 2 * GRID;

function labelSize(text) {
  return { w: Math.ceil(measureText(text, EDGE_LABEL_FONT)) + 2 * EDGE_LABEL_PAD.x, h: EDGE_LABEL_FONT.size + 2 * EDGE_LABEL_PAD.y };
}

// Centre positions along [lo, hi] for a label of length `len`: middle first,
// then alternately further out.
function slide(lo, hi, len) {
  const mid = (lo + hi) / 2;
  const room = (hi - lo - len) / 2;
  if (room < 0) return [];
  const out = [mid];
  for (let d = LABEL_STEP; d <= room; d += LABEL_STEP) out.push(mid - d, mid + d);
  return out;
}

function labelCandidates(points, { w, h }) {
  const last = points.length - 2;
  const segs = points.slice(1).map((b, i) => ({ a: points[i], b, i }));
  const flat = [];
  const upright = [];
  for (const s of segs) {
    if (s.a[1] === s.b[1]) {
      let [lo, hi] = [Math.min(s.a[0], s.b[0]), Math.max(s.a[0], s.b[0])];
      const [rawLo, rawHi] = [lo, hi];
      for (const [index, p] of [[0, points[0]], [last, points[last + 1]]]) {
        if (s.i !== index) continue;
        if (p[0] === rawLo) lo = rawLo + STUB;
        else hi = rawHi - STUB;
      }
      flat.push({ y: s.a[1], lo, hi, rawLo, rawHi });
    } else {
      upright.push({ x: s.a[0], lo: Math.min(s.a[1], s.b[1]), hi: Math.max(s.a[1], s.b[1]) });
    }
  }
  flat.sort((a, b) => b.hi - b.lo - (a.hi - a.lo));
  upright.sort((a, b) => b.hi - b.lo - (a.hi - a.lo));
  const at = (cx, cy) => ({ x: cx - w / 2, y: cy - h / 2, w, h, cx, cy });
  return [
    ...flat.flatMap((f) => slide(f.lo, f.hi, w + 2 * EDGE_LABEL_PAD.x).map((cx) => at(cx, f.y))),
    ...flat.flatMap((f) => slide(f.rawLo, f.rawHi, w).map((cx) => at(cx, f.y - h / 2 - LABEL_LIFT))),
    ...upright.flatMap((u) => slide(u.lo, u.hi, h).map((cy) => at(u.x, cy))),
  ];
}

// Spots around the middle of every segment, for a line too short to hold
// its label along it.
function nearbyCandidates(points, { w, h }) {
  const at = (cx, cy) => ({ x: cx - w / 2, y: cy - h / 2, w, h, cx, cy });
  return points.slice(1).flatMap((b, i) => {
    const [cx, cy] = [(points[i][0] + b[0]) / 2, (points[i][1] + b[1]) / 2];
    const lift = h / 2 + LABEL_LIFT;
    const aside = w / 2 + LABEL_LIFT;
    return [at(cx, cy), at(cx, cy - lift), at(cx, cy + lift), at(cx - aside, cy), at(cx + aside, cy)];
  });
}

const rectsOverlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function segmentHits([[ax, ay], [bx, by]], r) {
  return Math.min(ax, bx) < r.x + r.w && Math.max(ax, bx) > r.x && Math.min(ay, by) < r.y + r.h && Math.max(ay, by) > r.y;
}

function placeLabels(relations, texts, obstacles) {
  const placed = [];
  const clearOfBoxes = (c) => !obstacles.some((o) => rectsOverlap(c, o));
  return relations.map((r, i) => {
    if (!texts[i]) return null;
    const candidates = labelCandidates(r.points, labelSize(texts[i]));
    const clearOfLabels = (c) => !placed.some((p) => rectsOverlap(c, p));
    const free = (c) => clearOfLabels(c) && !relations.some((o, j) => j !== i && o.points.slice(1).some((p, k) => segmentHits([o.points[k], p], c)));
    // A line too short for any candidate still gets its label, centred on its
    // first segment.
    const [[ax, ay], [bx, by]] = r.points;
    const size = labelSize(texts[i]);
    const middle = { x: (ax + bx - size.w) / 2, y: (ay + by - size.h) / 2, ...size, cx: (ax + bx) / 2, cy: (ay + by) / 2 };
    const nearby = nearbyCandidates(r.points, size).filter(clearOfBoxes);
    const choice = candidates.find(free) ?? candidates.find(clearOfLabels) ?? nearby.find(free) ?? nearby.find(clearOfLabels) ?? candidates[0] ?? middle;
    placed.push(choice);
    return { text: texts[i], ...choice };
  });
}

// Routes from every polymorphic node to each of its targets drawn in the
// view (as a table or a stub), attached at the target's first primary key
// row: the id column points there. The viewer cannot route, so these are
// computed here and shown on click.
// ponytail: routed in a second pass that does not see the relation lines, so
// a target line may run on top of one; fold them into the main pass if that
// reads badly on real schemas.
function routePolyTargets(nodes, byId, obstacles, groups) {
  const edges = [];
  const ends = [];
  for (const n of nodes.filter((x) => x.kind === 'poly')) {
    for (const target of n.node.association.targets) {
      const t = byId.get(target);
      if (!t) continue;
      const column = t.kind === 'table' ? (t.node.table.columns.find((c) => c.pk) ?? t.node.table.columns[0]).name : null;
      edges.push({
        id: `${n.id}->${target}`,
        from: { box: nodeRect(n), y: n.y + attachOffset(n.box, null), marker: 'none' },
        to: { box: nodeRect(t), y: t.y + attachOffset(t.box, column), marker: 'none' },
      });
      ends.push({ poly: n.id, target, confirmed: isConfirmed('polymorphic', n.node.association.review) });
    }
  }
  return routeEdges(obstacles, groups.map((g) => g.frame), edges).map((r, i) => ({ ...ends[i], points: r.points }));
}

// Lines of the hub relations into each hub table drawn in the view, hidden
// until the viewer shows them for the selected hub table: a hub is drawn as
// badges so that it does not tangle every view, yet a reader looking at the
// hub table itself wants to see what points at it. Routed in a second pass
// like the polymorphic lines, with the crow's feet of a drawn relation.
// ponytail: a hub with more than HUB_ROUTE_LIMIT referencing tables in one
// view gets no lines there (its panel still lists them all). Such a fan is
// unreadable as lines, and routing it costs more than the rest of the view
// (150 `created_by` lines doubled the render time of a 150-table schema);
// raise the limit if a router pass gets cheaper.
export const HUB_ROUTE_LIMIT = 40;
function routeHubLinks(hubLinks, byId, obstacles, groups) {
  const drawable = hubLinks.filter((l) => l.from.node !== l.to.node && byId.has(l.from.node) && byId.get(l.to.node)?.kind === 'table');
  const perHub = new Map();
  for (const l of drawable) perHub.set(l.to.node, (perHub.get(l.to.node) ?? 0) + 1);
  const shown = drawable.filter((l) => perHub.get(l.to.node) <= HUB_ROUTE_LIMIT);
  const markers = shown.map(endMarkers);
  const end = (l, side, marker) => {
    const n = byId.get(l[side].node);
    return { box: nodeRect(n), y: n.y + attachOffset(n.box, l[side].column), marker };
  };
  const edges = shown.map((l, i) => ({ id: l.id, from: end(l, 'from', markers[i].from), to: end(l, 'to', markers[i].to) }));
  return routeEdges(obstacles, groups.map((g) => g.frame), edges).map((r, i) => ({ link: shown[i], ...r, markers: markers[i] }));
}

/**
 * Everything one view draws, with absolute coordinates: nodes, group frames,
 * routed lines with their end markers and labels. Kept separate from the SVG
 * text so geometry can be tested directly.
 */
export function buildScene(model, layout, name = ALL_VIEW, diagram = buildDiagram(model), options = {}) {
  const view = resolveView(model, layout, name, diagram, options);
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const labels = view.groups.map((g) =>
    g.kind === 'cluster'
      ? { id: `label:${g.group.key}`, ...labelBox(g.frame, g.group.key) }
      : { id: `label:${g.group.id}`, ...dbLabel(g.frame, g.group.database, g.group.engine, g.group.facts).box },
  );
  const obstacles = [...view.nodes.map(nodeRect), ...labels];
  const end = (link, side, marker) => {
    const e = link[side];
    const n = byId.get(e.node);
    return { box: nodeRect(n), y: n.y + attachOffset(n.box, e.column), marker };
  };
  let relations;
  if (name === OVERVIEW) {
    const routes = routeOverview(view.nodes.map(nodeRect), labels, view.groups.map((g) => g.frame), view.links);
    relations = view.links.map((link, i) => ({ link, ...routes[i], badge: countBadge(link.count, routes[i].middle) }));
  } else {
    const markers = view.links.map((l) => (l.kind === VIEW_SOURCE ? { from: 'none', to: 'none' } : endMarkers(l)));
    const edges = view.links.map((l, i) => ({ id: l.id, from: end(l, 'from', markers[i].from), to: end(l, 'to', markers[i].to) }));
    const routes = routeEdges(obstacles, view.groups.map((g) => g.frame), edges);
    const labelsOf = placeLabels(routes, view.links.map(labelText), obstacles);
    relations = view.links.map((link, i) => ({ link, ...routes[i], markers: markers[i], label: labelsOf[i] }));
  }
  const polyRoutes = routePolyTargets(view.nodes, byId, obstacles, view.groups);
  const hubRoutes = name === OVERVIEW ? [] : routeHubLinks(diagram.hubLinks, byId, obstacles, view.groups);

  // Lines may detour outside every frame, so they count towards the canvas.
  const xs = [];
  const ys = [];
  for (const b of [...view.groups.map((g) => g.frame), ...view.nodes]) {
    xs.push(b.x, b.x + b.w);
    ys.push(b.y, b.y + b.h);
  }
  for (const [px, py] of [...relations, ...polyRoutes, ...hubRoutes].flatMap((r) => r.points)) {
    xs.push(px);
    ys.push(py);
  }
  const x0 = Math.min(...xs) - CANVAS_MARGIN;
  const y0 = Math.min(...ys) - CANVAS_MARGIN;
  const x1 = Math.max(...xs) + CANVAS_MARGIN;
  const y1 = Math.max(...ys) + CANVAS_MARGIN;
  return { name, nodes: view.nodes, groups: view.groups, labels, relations, polyRoutes, hubRoutes, bounds: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
}

function textEl(cls, x, y, fitted, anchor) {
  const tip = fitted.truncated ? `<title>${escapeXml(fitted.full)}</title>` : '';
  const a = anchor ? ` text-anchor="${anchor}"` : '';
  return `<text class="${cls}" x="${x}" y="${y}" dominant-baseline="central"${a}>${escapeXml(fitted.text)}${tip}</text>`;
}

const json = (value) => escapeXml(JSON.stringify(value));

function headerPath(x, y, w, fill) {
  return (
    `<path d="M${x} ${y + HEADER_HEIGHT}V${y + CORNER}Q${x} ${y} ${x + CORNER} ${y}H${x + w - CORNER}` +
    `Q${x + w} ${y} ${x + w} ${y + CORNER}V${y + HEADER_HEIGHT}Z" fill="${fill}"/>`
  );
}

// The mark after a column name saying it has enum values to read.
const hintSvg = (r, nameX, cy) => (r.hint ? enumIconSvg(nameX + r.hintX, cy) : '');

// A possibly missing relation: a small amber triangle in the row's left
// padding, so no box grows and no stored layout goes stale. Its title is the
// tooltip without script.
function warnSvg(left, cy, text) {
  const x0 = left + WARN_INSET;
  const half = WARN_SIZE / 2;
  return `<path class="col-warn" d="M${x0} ${cy + half}L${x0 + half} ${cy - half}L${x0 + WARN_SIZE} ${cy + half}Z"><title>${escapeXml(`Possibly missing relation: ${text}`)}</title></path>`;
}

// Each row is a group so the viewer can show the column's details on hover
// (the transparent rect makes the whole row hoverable) and fade technical
// columns in Business mode. Embedded columns are indented inside their
// entity's inset box.
function tableSvg(n, colors, technical, marks, warnings) {
  const { x, y, w, h, box } = n;
  const columnMarks = marks.columns.get(n.id);
  const rows = box.rows.map((r) => {
    const indent = EMBED_INSET * r.depth;
    const status = columnMarks?.get(r.column);
    const top = y + r.centerY - ROW_HEIGHT / 2;
    return [
      `<g class="${technical.has(r.column) ? 'column technical' : 'column'}${status ? ` col-${status}` : ''}" data-column="${escapeXml(r.column)}">`,
      `<rect class="row-hit" x="${x + indent}" y="${top}" width="${w - 2 * indent}" height="${ROW_HEIGHT}"/>`,
      status ? `<rect class="col-mark col-${status}" x="${x + indent + 1}" y="${top + 2}" width="3" height="${ROW_HEIGHT - 4}"/>` : '',
      warnings?.has(r.column) ? warnSvg(x + indent, y + r.centerY, warnings.get(r.column)) : '',
      textEl(r.pk ? 'column-name pk' : 'column-name', x + PADDING_X + indent, y + r.centerY, r.name),
      hintSvg(r, x + PADDING_X + indent, y + r.centerY),
      textEl('column-type', x + w - PADDING_X - indent, y + r.centerY, r.type, 'end'),
      '</g>',
    ].join('');
  });
  const insets = box.insets.map(
    (e) =>
      `<g class="embedded" data-entity="${escapeXml(e.entity)}">` +
      `<rect class="inset-box" x="${x + EMBED_INSET}" y="${y + e.top + 1}" width="${w - 2 * EMBED_INSET}" height="${e.h - 2}" rx="4"/>` +
      `${textEl('inset-title', x + PADDING_X + EMBED_INSET, y + e.title.centerY, e.title)}</g>`,
  );
  const facts = box.facts.map((f) => textEl('fact-text', x + PADDING_X, y + f.centerY, f.text));
  const badges = box.badges.map((b) => {
    const cy = y + b.centerY;
    const ax = x + PADDING_X;
    const arrow = `<path class="badge-arrow" d="M${ax} ${cy}H${ax + BADGE_ARROW_WIDTH}M${ax + BADGE_ARROW_WIDTH - 4} ${cy - 3}L${ax + BADGE_ARROW_WIDTH} ${cy}L${ax + BADGE_ARROW_WIDTH - 4} ${cy + 3}"/>`;
    return (
      `<g class="hub-badge" data-target="${escapeXml(b.target)}" data-columns="${json(b.columns)}">` +
      `<title>${escapeXml(`${b.columns.join(', ')} → ${b.target}`)}</title>${arrow}` +
      `${textEl('badge-text', x + b.labelX, cy, b.label)}</g>`
    );
  });
  const separator = box.separatorY === null ? '' : `<path d="M${x} ${y + box.separatorY}H${x + w}" stroke="#e3e7ed"/>`;
  const tag = box.tag ? textEl('table-tag', x + w - PADDING_X, y + box.tag.centerY, box.tag, 'end') : '';
  // A table copied into every tenant schema is drawn as a small stack of
  // cards. The copies stay inside the router margin, so no line touches them.
  const copies = n.node.tenant
    ? [8, 4].map((d) => `<rect class="tenant-copy" x="${x + d}" y="${y + d}" width="${w}" height="${h}" rx="${CORNER}"/>`).join('')
    : '';
  const kind = n.node.table.kind ?? 'table';
  return [
    `<g class="table${kind === 'table' ? '' : ' is-view'}${diffClass(marks, n.id)}" data-id="${escapeXml(n.id)}"><title>${escapeXml(titleText(marks, n.id, n.id))}</title>`,
    copies,
    `<rect class="table-box" x="${x}" y="${y}" width="${w}" height="${h}" rx="${CORNER}"/>`,
    headerPath(x, y, w, colors.header),
    `<path d="M${x} ${y + HEADER_HEIGHT}H${x + w}" stroke="${colors.stroke}"/>`,
    textEl('table-title', x + PADDING_X, y + box.title.centerY, box.title),
    tag,
    ...insets,
    ...rows,
    separator,
    ...facts,
    ...badges,
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${CORNER}" fill="none" stroke="#b8c2d0"/>`,
    '</g>',
  ].join('');
}

// The virtual node carries the full association as data; lines to each
// target are drawn by the embedded viewer script on click, never here.
function polySvg(n, marks) {
  const { x, y, w, h, box } = n;
  const a = n.node.association;
  const data =
    ` data-id="${escapeXml(n.id)}" data-table="${escapeXml(a.table)}" data-name="${escapeXml(a.name)}"` +
    ` data-type-column="${escapeXml(a.type_column)}" data-id-column="${escapeXml(a.id_column)}" data-targets="${json(a.targets)}"`;
  return [
    `<g class="poly${diffClass(marks, n.id)}"${data}><title>${escapeXml(titleText(marks, n.id, `${a.table}.${a.type_column} / ${a.id_column} → ${a.targets.join(', ')}`))}</title>`,
    `<rect class="poly-box" x="${x}" y="${y}" width="${w}" height="${h}" rx="${CORNER}"/>`,
    `<path d="M${x} ${y + HEADER_HEIGHT}H${x + w}" stroke="#e2d6bb"/>`,
    textEl('poly-title', x + PADDING_X, y + box.title.centerY, box.title),
    ...box.rows.map((r) => textEl('poly-target', x + PADDING_X, y + r.centerY, r.name)),
    '</g>',
  ].join('');
}

function stubSvg(n, marks) {
  const { x, y, w, h, box } = n;
  return (
    `<g class="stub${diffClass(marks, n.id)}" data-id="${escapeXml(n.id)}"><title>${escapeXml(titleText(marks, n.id, n.id))}</title>` +
    `<rect class="stub-box" x="${x}" y="${y}" width="${w}" height="${h}" rx="${CORNER}"/>` +
    `${textEl('stub-title', x + PADDING_X, y + box.title.centerY, box.title)}</g>`
  );
}

function domainSvg(n, colors, marks) {
  const { x, y, w, h, box } = n;
  return (
    `<g class="domain${diffClass(marks, n.id)}" data-domain="${escapeXml(n.id)}"><title>${escapeXml(n.id)}</title>` +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${colors.header}" stroke="${colors.stroke}"/>` +
    `<text class="domain-title" x="${x + PADDING_X}" y="${y + box.title.centerY}" dominant-baseline="central" fill="${colors.label}">${escapeXml(box.title.text)}</text>` +
    `${textEl('domain-count', x + PADDING_X, y + box.count.centerY, box.count)}</g>`
  );
}

function groupSvg(g, colorOf) {
  const f = g.frame;
  if (g.kind === 'cluster') {
    const colors = colorOf(g.group.key);
    return (
      `<g class="cluster" data-cluster="${escapeXml(g.group.key)}">` +
      `<rect x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" rx="12" fill="${colors.fill}" stroke="${colors.stroke}"/>` +
      `<text class="cluster-label" x="${f.x + LABEL_OFFSET.x}" y="${f.y + LABEL_OFFSET.y}" dominant-baseline="central" fill="${colors.label}">${escapeXml(clusterLabel(g.group.key))}</text>` +
      '</g>'
    );
  }
  const l = dbLabel(f, g.group.database, g.group.engine, g.group.facts);
  const { x, y, w, h } = l.icon;
  const ry = 3;
  const icon =
    `<path class="db-icon" d="M${x} ${y + ry}V${y + h - ry}A${w / 2} ${ry} 0 0 0 ${x + w} ${y + h - ry}V${y + ry}A${w / 2} ${ry} 0 0 0 ${x} ${y + ry}Z"/>` +
    `<path class="db-icon" d="M${x} ${y + ry}A${w / 2} ${ry} 0 0 0 ${x + w} ${y + ry}" fill="none"/>`;
  return (
    `<g class="database" data-database="${escapeXml(g.group.database)}" data-engine="${escapeXml(g.group.engine)}">` +
    (g.group.facts.length > 0 ? `<title>${escapeXml(g.group.facts.join('\n'))}</title>` : '') +
    `<rect class="db-frame" x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" rx="16"/>${icon}` +
    `<text class="db-name" x="${l.name.x}" y="${l.cy}" dominant-baseline="central">${escapeXml(l.name.text)}</text>` +
    `<rect class="engine-pill" x="${l.pill.x}" y="${l.pill.y}" width="${l.pill.w}" height="${l.pill.h}" rx="9"/>` +
    `<text class="engine-name" x="${l.engine.x}" y="${l.cy}" dominant-baseline="central" text-anchor="middle">${escapeXml(l.engine.text)}</text>` +
    l.facts
      .map(
        (p) =>
          `<rect class="db-fact-pill" x="${p.pill.x}" y="${p.pill.y}" width="${p.pill.w}" height="${p.pill.h}" rx="9"/>` +
          `<text class="db-fact" x="${p.x}" y="${l.cy}" dominant-baseline="central" text-anchor="middle">${escapeXml(p.text)}</text>`,
      )
      .join('') +
    '</g>'
  );
}

// `unconfirmed` draws the line dashed (see isConfirmed); a view's line to
// its source has its own muted style.
const styleClass = (link) => (link.kind !== VIEW_SOURCE && !isConfirmed(link.kind, link.review) ? ' unconfirmed' : '');

const pathData = (points) => points.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px} ${py}`).join('');

function markersSvg(r) {
  const [first, last] = [r.points[0], r.points[r.points.length - 1]];
  const svg = markerSvg(r.markers.from, first[0], first[1], r.fromSide) + markerSvg(r.markers.to, last[0], last[1], r.toSide);
  // The legend lists only the end kinds a view draws: it reads them here.
  return svg ? `<g class="marker" data-ends="${r.markers.from} ${r.markers.to}">${svg}</g>` : '';
}

function relationSvg(r, marks) {
  const { link } = r;
  const d = pathData(r.points);
  const markers = markersSvg(r);
  const label = r.label
    ? `<g class="edge-label"><rect x="${r.label.x}" y="${r.label.y}" width="${r.label.w}" height="${r.label.h}" rx="3"/>` +
      `<text x="${r.label.cx}" y="${r.label.cy}" dominant-baseline="central" text-anchor="middle">${escapeXml(r.label.text)}</text></g>`
    : '';
  const via = link.via ? ` data-via="${escapeXml(link.via)}"` : '';
  return (
    `<g class="relation-group kind-${link.kind} review-${link.review}${styleClass(link)}${linkDiffClass(marks, link.id)}" data-id="${escapeXml(link.id)}"` +
    ` data-from="${escapeXml(link.from.node)}" data-to="${escapeXml(link.to.node)}" data-kind="${link.kind}" data-review="${link.review}"${via}>` +
    `<title>${escapeXml(titleText(marks, link.id, link.via ? `${link.id} (n-n via ${link.via})` : link.id, 'links'))}</title>` +
    `<path class="relation" d="${d}"/>${markers}${label}</g>`
  );
}

// An overview line: one per pair of domains, as thick as its relation count
// is high (the width is inline so highlighting cannot reset it), the count
// in a badge at its middle, no arrowheads, one neutral colour; dashed
// between databases.
function overviewLinkSvg(r, marks) {
  const { link, badge } = r;
  const [a, b] = [link.from.node, link.to.node];
  const title = `${clusterLabel(a)} ⇄ ${clusterLabel(b)}: ${plural(link.count, 'relation')}${link.kind === 'cross_db' ? ` (${a.split('/')[0]} ⇄ ${b.split('/')[0]})` : ''}`;
  return (
    `<g class="relation-group overview-link kind-${link.kind}${linkDiffClass(marks, link.id)}" data-id="${escapeXml(link.id)}" data-from="${escapeXml(a)}" data-to="${escapeXml(b)}" data-kind="${link.kind}">` +
    `<title>${escapeXml(title)}</title>` +
    `<path class="relation" d="${pathData(r.points)}" style="stroke-width:${overviewStrokeWidth(link.count)}"/>` +
    `<g class="count-badge"><rect x="${badge.x}" y="${badge.y}" width="${badge.w}" height="${badge.h}" rx="${badge.h / 2}"/>` +
    `<text x="${badge.cx}" y="${badge.cy}" dominant-baseline="central" text-anchor="middle">${badge.text}</text></g></g>`
  );
}

// Lines from a polymorphic node to each of its targets in the view, hidden
// until the viewer shows them on click.
function polyRoutesSvg(routes) {
  const byPoly = new Map();
  for (const r of routes) {
    if (!byPoly.has(r.poly)) byPoly.set(r.poly, []);
    byPoly.get(r.poly).push(r);
  }
  return [...byPoly]
    .map(
      ([poly, list]) =>
        `<g class="poly-routes" data-poly="${escapeXml(poly)}" style="display:none">` +
        list.map((r) => `<path class="poly-route${r.confirmed ? '' : ' unconfirmed'}" data-target="${escapeXml(r.target)}" d="${pathData(r.points)}"/>`).join('') +
        '</g>',
    )
    .join('');
}

// Hub lines grouped by hub table, hidden until that table is selected.
function hubRoutesSvg(routes) {
  const byHub = new Map();
  for (const r of routes) {
    if (!byHub.has(r.link.to.node)) byHub.set(r.link.to.node, []);
    byHub.get(r.link.to.node).push(r);
  }
  return [...byHub]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(
      ([hub, list]) =>
        `<g class="hub-routes" data-hub="${escapeXml(hub)}" style="display:none">` +
        list
          .map(
            (r) =>
              `<g class="hub-route kind-${r.link.kind} review-${r.link.review}${styleClass(r.link)}" data-id="${escapeXml(r.link.id)}" data-from="${escapeXml(r.link.from.node)}" data-to="${escapeXml(hub)}">` +
              `<path class="relation" d="${pathData(r.points)}"/>${markersSvg(r)}</g>`,
          )
          .join('') +
        '</g>',
    )
    .join('');
}

function viewSvg(scene, colorOf, visible, technical, marks, banner, warnings) {
  const { x, y, w, h } = scene.bounds;
  const nodes = scene.nodes.map((n) => {
    if (n.kind === 'table') return tableSvg(n, colorOf(n.node.cluster), technical.get(n.id), marks, warnings.get(n.id));
    if (n.kind === 'poly') return polySvg(n, marks);
    if (n.kind === 'stub') return stubSvg(n, marks);
    return domainSvg(n, colorOf(n.id), marks);
  });
  // Hidden views are shown by the embedded viewer script; without script the
  // overview alone is what a reader sees.
  const hidden = visible ? '' : ' style="display:none"';
  return [
    `<g class="view" data-view="${escapeXml(scene.name)}" data-bounds="${x} ${y} ${w} ${h}"${hidden}>`,
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#ffffff"/>`,
    `<g class="groups">${scene.groups.map((g) => groupSvg(g, colorOf)).join('')}</g>`,
    `<g class="relations">${scene.relations.map((r) => (scene.name === OVERVIEW ? overviewLinkSvg(r, marks) : relationSvg(r, marks))).join('')}${polyRoutesSvg(scene.polyRoutes)}${hubRoutesSvg(scene.hubRoutes)}</g>`,
    `<g class="nodes">${nodes.join('')}</g>`,
    banner ?? '',
    '</g>',
  ].join('\n');
}

// The viewer bundle is generated by scripts/bundle-viewer.js; a CDATA
// section cannot contain its own terminator.
const VIEWER_SCRIPT = viewerBundle.source;
if (VIEWER_SCRIPT.includes(']]>')) throw new Error('viewer bundle contains "]]>" and cannot sit in a CDATA section');

// JSON inside an XML element: escaping <, > and & as \u escapes keeps it
// valid JSON and leaves nothing for the XML parser to interpret.
const scriptJson = (value) => JSON.stringify(value).replace(/[<>&]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/**
 * Possibly missing relations (see missingRelations) by table: `columns` maps
 * a table id to its warned column paths and their message (both columns of
 * a pair that looks polymorphic), `tables` a table id to the message of a
 * table nothing connects to.
 */
function warningsByTable(warnings) {
  const columns = new Map();
  const tables = new Map();
  for (const w of warnings) {
    if (!w.column) {
      tables.set(w.table, w.message);
      continue;
    }
    if (!columns.has(w.table)) columns.set(w.table, new Map());
    for (const c of [w.column, w.typeColumn].filter(Boolean)) columns.get(w.table).set(c, w.message);
  }
  return { columns, tables };
}

/**
 * What the viewer needs beyond the drawing: every node's details (for
 * tooltips, search and panels) and every drawn relation (for the
 * neighborhood view, which spans domains). Keys are written in a fixed
 * order and lists come from the sorted model, so the text is deterministic.
 */
export function viewerData(model, diagram, technical = technicalColumns(model), diff = null, warnings = missingRelations(model)) {
  const warned = warningsByTable(warnings);
  // Note fields in a fixed order; a sharing profile has already removed the
  // ones it drops.
  const notes = (o) => Object.fromEntries(['note', 'note_source', 'internal_note'].filter((f) => o[f]).map((f) => [f === 'note' ? f : camel(f), o[f]]));
  const evidenceOf = new Map([
    ...model.relations.map((r) => [relationId(r), r.evidence ?? []]),
    ...model.polymorphic.map((a) => [polyLinkId(a), a.evidence ?? []]),
  ]);
  // Key columns of every relation, in key order, for the join path finder.
  // A collapsed join table's line keeps its two relations (both from the
  // join table, in model order like buildDiagram's) so a path can walk
  // through the join table hop by hop.
  const relationById = new Map(model.relations.map((r) => [relationId(r), r]));
  const keyHop = (r) => ({ fromColumns: r.from.columns, toColumns: r.to.columns, cardinality: r.cardinality, kind: r.kind, review: r.review });
  const columnsOf = (l) => {
    if (l.via) return { viaHops: model.relations.filter((r) => r.from.table === l.via).map(keyHop) };
    const r = relationById.get(l.id);
    return r ? { fromColumns: r.from.columns, toColumns: r.to.columns } : {};
  };
  const linkData = (l) => ({
    id: l.id,
    from: l.from.node,
    to: l.to.node,
    cardinality: l.cardinality,
    optional: l.optional,
    kind: l.kind,
    review: l.review,
    ...(l.via ? { via: l.via } : {}),
    ...columnsOf(l),
    ...(evidenceOf.get(l.id)?.length > 0 ? { evidence: evidenceOf.get(l.id) } : {}),
  });
  const nodes = {};
  for (const id of [...diagram.nodes.keys()].sort(compareStrings)) {
    const n = diagram.nodes.get(id);
    if (n.kind === 'poly') {
      const a = n.association;
      nodes[id] = { kind: 'poly', cluster: n.cluster, table: a.table, name: a.name, typeColumn: a.type_column, idColumn: a.id_column, optional: a.optional, review: a.review, targets: a.targets, ...notes(a) };
      if (a.evidence?.length > 0) nodes[id].evidence = a.evidence;
      continue;
    }
    const t = n.table;
    nodes[id] = {
      kind: 'table',
      cluster: n.cluster,
      ...(t.kind && t.kind !== 'table' ? { tableKind: t.kind } : {}),
      ...notes(t),
      ...(n.facts.length > 0 ? { facts: n.facts } : {}),
      ...(warned.tables.has(id) ? { warning: warned.tables.get(id) } : {}),
      ...(t.sources ? { sources: t.sources } : {}),
      columns: columnEntries(t).map(({ path, column: c, entity }) => ({
        name: path,
        ...(entity ? { entity: entity.name } : {}),
        type: c.type,
        ...(c.nullable === undefined ? {} : { nullable: c.nullable }),
        ...(c.pk ? { pk: true } : {}),
        ...(c.unique ? { unique: true } : {}),
        ...(c.auto_increment ? { autoIncrement: true } : {}),
        ...(c.default === undefined ? {} : { default: c.default }),
        ...(c.generated === undefined ? {} : { generated: c.generated }),
        ...(c.pii ? { pii: true } : {}),
        ...(technical.get(id).has(path) ? { technical: true } : {}),
        ...(warned.columns.get(id)?.has(path) ? { warning: warned.columns.get(id).get(path) } : {}),
        ...(c.enum ? { enum: Object.fromEntries(Object.entries(c.enum).map(([v, meaning]) => [v, enumMeaning(v, meaning)])) } : {}),
        ...notes(c),
      })),
    };
  }
  const links = diagram.links.map(linkData);
  // The referencing column too: a hub table's panel names it for each table
  // pointing at it.
  const hubLinks = diagram.hubLinks.map((l) => ({ ...linkData(l), column: l.from.column }));
  // The relations behind each overview line, listed when it is clicked.
  const domains = Object.fromEntries(
    domainLinks(diagram).map((d) => [
      d.id,
      d.relations.map((r) => ({
        from: r.from.table,
        column: r.from.column,
        to: r.to,
        cardinality: r.cardinality,
        kind: r.kind,
        ...(r.association ? { association: r.association } : {}),
        ...(r.via ? { via: r.via } : {}),
      })),
    ]),
  );
  // Database name -> engine as printed on its frame, for cross-DB panels.
  const databases = Object.fromEntries(model.databases.map((db) => [db.database, engineName(db.engine)]));
  // Downloads are named after the one database, else the project (its one
  // source), else plainly `erd`.
  const sources = model.config.sources ?? [];
  const project = model.databases.length === 1 ? model.databases[0].database : sources.length === 1 ? sources[0].name : 'erd';
  const base = { project, nodes, links, hubLinks, domainLinks: domains, databases };
  if (!diff) return base;
  const sorted = (map) => Object.fromEntries([...map].sort(([a], [b]) => compareStrings(a, b)));
  const { sentences } = diff.marks;
  return { ...base, changes: { from: diff.from, to: diff.to, summary: diff.summary, nodes: sorted(sentences.nodes), links: sorted(sentences.links) } };
}

/**
 * The view a plain render opens on and draws without script: the
 * configured `default_view` when this diagram has it, else the overview.
 * `fallback` is true when a configured view was missing (the view of all
 * tables of a very large schema, a domain a profile hid).
 */
export function openingView(model, diagram = buildDiagram(model)) {
  const wanted = model.config.default_view;
  if (!wanted || wanted === OVERVIEW) return { view: OVERVIEW, fallback: false };
  return viewNames(diagram).includes(wanted) ? { view: wanted, fallback: false } : { view: OVERVIEW, fallback: true };
}

/**
 * Static SVG holding every view; the opening view (see openingView) is the
 * one visible. Pass
 * `{ fitStored: true }` for a model filtered by a sharing profile (see
 * resolveView).
 *
 * `{ diff: { from, to, summary, marks } }` draws a diff instead (`marks`
 * from diffMarks, the model being the union model): changed elements are
 * coloured, every view gets the summary banner, the viewer data carries the
 * change sentences, and the view of all tables (the overview when the
 * diagram has none) is the one visible, since that is where changes can be
 * seen without script.
 *
 * `{ warnings }`: the possibly missing relations to mark (missingRelations
 * of `model` when left out); a profile render passes the ones found on the
 * full model (see warningsFor), a diff passes none.
 */
export function renderSvg(model, layout, options = {}) {
  const { diff = null, warnings = missingRelations(model), ...sceneOptions } = options;
  const diagram = buildDiagram(model);
  const marks = diff?.marks ?? NO_MARKS;
  // A diagram too large for the view of all tables opens a diff on the
  // overview, where the banner still tells what changed.
  const visible = diff ? (hasAllView(diagram) ? ALL_VIEW : OVERVIEW) : openingView(model, diagram).view;
  const scenes = viewNames(diagram).map((name) => {
    const scene = buildScene(model, layout, name, diagram, sceneOptions);
    if (!diff) return { scene };
    const banner = diffBanner(scene.bounds, diff);
    return { scene: { ...scene, bounds: banner.bounds }, banner: banner.svg };
  });
  // Indices past the palette cycle, which only happens once every tint is taken.
  const colorOf = (key) => PALETTE[layout.colors[key] % PALETTE.length];
  const technical = technicalColumns(model);
  const columnWarnings = warningsByTable(warnings).columns;
  const { x, y, w, h } = scenes.find((s) => s.scene.name === visible).scene.bounds;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg"${diff ? ' class="diff-mode"' : ''} width="${w}" height="${h}" viewBox="${x} ${y} ${w} ${h}">`,
    `<style>${STYLE}</style>`,
    ...scenes.map((s) => viewSvg(s.scene, colorOf, s.scene.name === visible, technical, marks, s.banner, columnWarnings)),
    `<script type="application/json" id="open-erd-data">${scriptJson(viewerData(model, diagram, technical, diff, warnings))}</script>`,
    `<script><![CDATA[\n${VIEWER_SCRIPT}\n]]></script>`,
    '</svg>',
    '',
  ].join('\n');
}
