import { DB_FACT_FONT, DB_LABEL_FONT, ENGINE_FONT, LABEL_FONT, LABEL_OFFSET, clusterLabel, dbLabel, engineName, labelBox } from '../../layout/clusters.js';
import { VIEW_SOURCE, buildDiagram, domainPairs, relationId } from '../../layout/diagram.js';
import { STRENGTH_SEGMENTS, domainSummary } from '../../layout/domains.js';
import { resolveView } from '../../layout/index.js';
import { STUB, routeEdges } from '../../layout/router.js';
import { GRID, GROUP_DB_FONT, BADGE_ARROW_WIDTH, BADGE_FONT, CARD, CARD_DB_FONT, CARD_LABEL_FONT, CARD_TEXT_FONT, CARD_TITLE_FONT, EMBED_INSET, FACT_FONT, HEADER_HEIGHT, ICON_GUTTER, PADDING_X, ROW_HEIGHT, TAG_FONT, attachOffset } from '../../layout/table-box.js';
import { ALL_VIEW, OVERVIEW, hasAllView, viewNames } from '../../layout/views.js';
import { columnEntries, enumMeaning } from '../../model/columns.js';
import { compareStrings } from '../../model/load.js';
import { RANKING_VIEW } from '../../model/schema.js';
import { missingRelations } from '../../model/missing.js';
import { healthFindings } from '../../model/health.js';
import { measureText } from '../../text/measure.js';
import { FONT_FAMILY, TEXT_STYLE_CSS, fontFaceCss } from '../../text/font.js';
import { PALETTE } from '../../palette.js';
import { RANKING_STYLE, rankingSvg, rankingTables } from './ranking.js';
import { referenceCounts } from '../../model/centrality.js';
import { ICON_PAINT, UNCONFIRMED_DASH, endMarkers, enumIconSvg, indexIconSvg, isConfirmed, keyIconSvg, linkIconSvg, markerSvg, overviewStrokeWidth, starIconSvg, tableIconSvg } from './markers.js';
import viewerBundle from './viewer-bundle.json' with { type: 'json' };

const CANVAS_MARGIN = 40;
// Warning triangle of a column, inside the row's left padding (PADDING_X).
const WARN_SIZE = 8;
const WARN_INSET = 2;
const CORNER = 6;
const EDGE_LABEL_FONT = { size: 10, weight: 700 };
const EDGE_LABEL_PAD = { x: 4, y: 3 };
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
/* Personal data map: tables holding pii columns stay, those rows tinted,
   the rest fades; a selection's own fading takes over while it lasts. */
.pii-mode .view:not(.dimmed) :is(.table, .stub, .poly, .domain, .relation-group):not(.has-pii) { opacity: 0.2; }
.pii-mode .view:not(.dimmed) .table.has-pii .column:not(.pii) { opacity: 0.45; }
.pii-mode .view:not(.dimmed) :is(.table, .stub).has-pii:not(.hl) > rect:last-of-type { stroke: #d9603f; stroke-width: 2; }
.pii-mode .column.pii:not(.hl-column) .row-hit { fill: #ffd9cc; }
.pii-mode .column.pii .column-name { fill: #a8341a; }
.pii-mode .domain.has-pii .card-box { stroke: #d9603f; stroke-width: 2; }
.central-mode .view:not(.dimmed) :is(.table, .stub, .poly, .relation-group):not(.central) { opacity: 0.2; }
.central-mode .view:not(.dimmed) .table.central:not(.hl) > rect:last-of-type { stroke: #c99a06; stroke-width: 3; }
.view.oe-enter { animation: oe-enter 0.5s ease-out; }
@keyframes oe-enter { from { opacity: 0.15; } }
.pii-mode .rk-item:not(.has-pii) { opacity: 0.25; }
/* Schema health: a triangle on each table with a finding, its columns in a
   finding tinted, only while the mode is on. */
.health-mark { display: none; }
.health-mode .health-mark { display: inline; }
.health-mode .view:not(.dimmed) :is(.table, .stub).has-health:not(.hl) > rect:last-of-type { stroke: #e8a317; stroke-width: 2; }
.health-mode .column.health:not(.hl-column) .row-hit { fill: #fff1d6; }
.domain, .stub, .table, .poly, .relation-group, .hub-badge { cursor: pointer; }
.relation-hit { fill: none; stroke: transparent; stroke-width: 12; }
.view.dimmed :is(.table, .stub, .poly, .domain, .relation-group):not(.hl) { opacity: 0.16; }
.view.dimmed.center-selected :is(.table, .poly).ring-2:not(.hl) { opacity: 1; }
.view.dimmed.center-selected .ring-2:not(.hl) > rect:last-of-type { stroke: #d9dee6; }
.view.dimmed.center-selected .relation-group.ring-2:not(.hl) { opacity: 0.5; }
.hl > rect:last-of-type { stroke: #5b8def; stroke-width: 2; }
.selected > rect:last-of-type { stroke: #1d4ed8; stroke-width: 3; }
:is(.arrive:not(.cluster) > rect:last-of-type, .cluster.arrive > rect:first-of-type) { stroke: #e8590c; stroke-width: 3; animation: oe-arrive 0.4s ease-in-out 4 alternate; }
@keyframes oe-arrive { to { stroke-width: 8; } }
.flow-target > rect:last-of-type { stroke: #e8590c; stroke-width: 3; animation: oe-pulse 0.9s ease-in-out infinite alternate; }
.reached > rect:last-of-type { animation: oe-reach 0.5s ease-out; }
@keyframes oe-reach { from { stroke: #e8590c; stroke-width: 7; } }
.relation-group.hl .relation, .relation-group.hl .marker { stroke: #2563eb; stroke-width: 2; }
.view.domain-focus .domain:not(.focus-node) { opacity: 0.3; }
.domain.focus-node .card-box { stroke: #5b8def; stroke-width: 1.5; }
.domain:focus { outline: none; }
.domain:focus-visible .card-box { stroke: #2563eb; stroke-width: 2.5; }
.card-related { cursor: pointer; }
.card-related:hover .card-related-name { fill: #1d4ed8; text-decoration: underline; }
.card-link { cursor: pointer; }
.card-link-hit { fill: none; stroke: transparent; stroke-width: 14; }
.card-link-line { fill: none; stroke: #2563eb; stroke-opacity: 0.6; stroke-linecap: round; }
.card-link.cross_db .card-link-line { stroke-dasharray: 8 6; stroke-linecap: butt; }
.card-link:is(:hover, .selected) .card-link-line { stroke-opacity: 1; }
.rk-item { cursor: pointer; }
.rk-item:hover > .rk-hit { fill: #eef2f7; }
.rk-zero:hover rect { fill: #e3e9f2; }
.rk-zero:hover text { fill: #1d4ed8; }
.relation-group.flowing .relation { stroke-opacity: 0.35; }
.flow { fill: none; stroke: #2563eb; stroke-width: 3; stroke-dasharray: 6 10; pointer-events: none; animation: oe-flow 0.8s linear infinite; }
.poly-route { fill: none; stroke: #6b778a; stroke-width: 1.4; }
.hub-route .relation, .hub-route .marker { stroke: #2563eb; stroke-width: 1.6; }
.hub-route { cursor: pointer; }
@keyframes oe-flow { to { stroke-dashoffset: -16; } }
@keyframes oe-pulse { to { stroke-width: 6; } }
.oe-ui { font-family: '${FONT_FAMILY}', sans-serif; font-size: 13px; color: #1f2a3d; box-sizing: border-box; }
.oe-ui * { box-sizing: border-box; }
.oe-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; height: 44px; padding: 0 10px; background: #ffffff; border-bottom: 1px solid #e1e6ee; position: relative; }
.oe-left { display: flex; align-items: center; gap: 6px; flex: 1 1 auto; min-width: 0; }
.oe-right { display: flex; align-items: center; gap: 6px; flex: none; }
.oe-crumbs { display: flex; align-items: center; gap: 6px; min-width: 0; white-space: nowrap; overflow: hidden; }
.oe-crumbs > * { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.oe-crumbs > .here { flex: 0 0 auto; max-width: 100%; }
.oe-crumbs .sep { color: #9aa4b5; flex: none; }
.oe-crumbs .here { font-weight: 700; }
.oe-crumbs > .oe-drop { position: static; display: flex; overflow: visible; }
.oe-db-crumb { display: inline-flex; align-items: center; gap: 2px; min-width: 0; height: 26px; padding: 0 4px; margin: 0 -4px; border-radius: 6px; }
.oe-db-crumb .label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.oe-crumbs .oe-db-crumb:hover, .oe-crumbs .oe-db-crumb.on { background: #eef3fb; text-decoration: none; }
.oe-db-menu { top: 40px; right: auto; width: 260px; }
.oe-tool { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px; border-color: #dfe4ec; color: #3d4a5e; }
.oe-tool.icon-only { width: 30px; padding: 0; justify-content: center; }
.oe-icon { flex: none; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.icon-more path { stroke-width: 2.6; }
.oe-tool kbd { font: inherit; font-size: 11px; color: #7a8597; background: #f1f4f8; border: 1px solid #dfe4ec; border-radius: 4px; padding: 0 5px; line-height: 16px; }
.oe-search-trigger { color: #7a8597; min-width: 210px; }
.oe-search-trigger .label { flex: 1; text-align: left; }
.oe-drop { position: relative; }
.oe-menu { position: absolute; top: 36px; right: 0; width: 300px; background: #ffffff; border: 1px solid #d5dbe4; border-radius: 8px; box-shadow: 0 8px 24px rgba(20, 30, 50, 0.16); padding: 4px 0; white-space: normal; z-index: 1; }
.oe-item { display: flex; align-items: flex-start; gap: 6px; width: 100%; text-align: left; padding: 6px 10px 6px 6px; border: 0; background: none; font: inherit; color: #1f2a3d; cursor: pointer; }
.oe-item:hover:not(:disabled) { background: #eef3fb; }
.oe-item:disabled { color: #a7b0bf; cursor: default; }
.oe-item .mark { flex: none; width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; color: #2563eb; }
.oe-item .text { display: flex; flex-direction: column; min-width: 0; }
.oe-item .detail { color: #7a8597; font-size: 11px; line-height: 1.35; margin-top: 1px; }
.oe-item:disabled .detail { color: #a7b0bf; }
.oe-item kbd, .oe-result kbd { flex: none; margin-left: auto; font: inherit; font-size: 11px; color: #7a8597; background: #f1f4f8; border: 1px solid #dfe4ec; border-radius: 4px; padding: 0 5px; line-height: 16px; }
.oe-highlight-btn .oe-dot { display: none; width: 6px; height: 6px; border-radius: 50%; background: #2563eb; margin-left: -2px; }
.oe-highlight-btn.active { border-color: #93b4f0; background: #eef3fb; color: #1d4ed8; }
.oe-highlight-btn.active .oe-dot { display: inline-block; }
.oe-highlight-btn.on { background: #1f2a3d; border-color: #1f2a3d; color: #ffffff; }
.oe-highlight-menu { width: 300px; }
.oe-menu-sub { color: #7a8597; font-size: 11px; padding: 6px 10px 2px 28px; border-top: 1px solid #eef1f5; margin-top: 4px; }
.oe-menu-sep { border-top: 1px solid #eef1f5; margin: 4px 0; }
.oe-more-menu { width: 340px; }
.oe-spotlight-host { position: relative; width: 100%; height: 100%; }
.oe-spotlight-backdrop { position: absolute; inset: 0; background: rgba(20, 30, 50, 0.28); }
.oe-spotlight { position: absolute; left: 50%; top: 12%; transform: translateX(-50%); width: min(900px, 90vw); background: #ffffff; border-radius: 12px; box-shadow: 0 18px 48px rgba(20, 30, 50, 0.3); overflow: hidden; }
.oe-spotlight-field { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid #eef1f5; color: #7a8597; }
.oe-spotlight-input { flex: 1; font: inherit; font-size: 18px; border: 0; outline: none; color: #1f2a3d; background: none; }
.oe-spotlight-list { max-height: min(560px, 62vh); overflow: auto; padding: 4px 0; }
.oe-spotlight-list .oe-result { display: flex; align-items: baseline; gap: 10px; white-space: nowrap; min-width: 0; width: 100%; text-align: left; padding: 7px 16px; border: 0; background: none; font: inherit; cursor: pointer; }
.oe-spotlight-list .oe-result.active { background: #eef3fb; }
.oe-result .kind { flex: none; width: 38px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: #7a8597; }
.oe-result .kind.is-table { color: #2f6fd6; }
.oe-result .kind.is-command { display: inline-flex; align-self: center; color: #56627a; }
.oe-result kbd { margin-left: 0; align-self: center; }
.oe-spotlight-group { padding: 8px 16px 3px; font-size: 11px; font-weight: 700; color: #7a8597; text-transform: uppercase; letter-spacing: 0.04em; }
.oe-spotlight-group:not(:first-child) { border-top: 1px solid #eef1f5; margin-top: 4px; }
.oe-result .name { flex: 0 1 auto; font-weight: 700; color: #1f2a3d; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 70%; }
.oe-result .where { flex: 1 1 0; min-width: 0; text-align: right; color: #7a8597; font-size: 12px; margin-left: auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.oe-join-spot .oe-spotlight-field { padding: 10px 16px; }
.oe-field-label { flex: none; width: 44px; font-size: 12px; font-weight: 700; color: #56627a; text-transform: uppercase; letter-spacing: 0.04em; }
.oe-hint { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; color: #3b475c; background: rgba(255, 255, 255, 0.94); border: 1px solid #e3e7ee; border-radius: 14px; padding: 4px 6px 4px 12px; box-shadow: 0 2px 8px rgba(31, 42, 61, 0.08); white-space: nowrap; animation: oe-hint-in 0.3s ease-out; }
.oe-hint-label { font-size: 11px; font-weight: 600; color: #a07a06; }
.oe-hint kbd { font: inherit; font-size: 11px; color: #3b475c; background: #ffffff; border: 1px solid #d5dbe4; border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; }
.oe-hint-close { font: inherit; font-size: 14px; line-height: 16px; width: 20px; height: 20px; border: 0; border-radius: 10px; background: none; color: #a0a9b8; cursor: pointer; }
.oe-hint-close:hover { background: #f1f4f8; color: #56627a; }
@keyframes oe-hint-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.oe-toast { display: inline-block; background: #1f2a3d; color: #ffffff; font-size: 13px; padding: 8px 14px; border-radius: 8px; box-shadow: 0 6px 18px rgba(20, 30, 50, 0.25); white-space: nowrap; }
.oe-keys-group { margin: 14px 0 4px; font-size: 11px; font-weight: 700; color: #7a8597; text-transform: uppercase; letter-spacing: 0.04em; }
.oe-keys { border-collapse: collapse; width: 100%; }
.oe-keys td { padding: 4px 6px; vertical-align: top; }
.oe-keys td:first-child { width: 72px; white-space: nowrap; }
.oe-keys kbd { font: inherit; font-size: 12px; color: #1f2a3d; background: #f1f4f8; border: 1px solid #dfe4ec; border-radius: 4px; padding: 1px 6px; white-space: nowrap; }
.oe-keys kbd + kbd { margin-left: 4px; }
.oe-view-tabs .oe-btn { height: 30px; font-size: 12.5px; padding: 0 10px; display: inline-flex; align-items: center; gap: 6px; }
@media (max-width: 1180px) { .oe-view-tabs .label { display: none; } .oe-view-tabs .oe-btn { padding: 0 8px; } }
/* Narrow: the breadcrumb keeps the database switcher and where you are (Back walks the rest). */
@media (max-width: 960px) { .oe-crumbs > :not(.here):not(:last-child):not(.oe-drop):not(.sep), .oe-crumbs > .sep:not(:has(+ .here, + :last-child)) { display: none; } .oe-crumbs > .oe-drop { flex: none; } .oe-db-crumb { margin-left: 0; } .oe-crumbs > .here { flex: 0 1 auto; } }
@media (max-width: 960px) { .oe-search-trigger { min-width: 0; width: 30px; padding: 0; justify-content: center; } .oe-search-trigger .label, .oe-search-trigger kbd, .oe-highlight-btn .label { display: none; } .oe-highlight-btn { padding: 0 6px 0 8px; gap: 4px; } }
.oe-spotlight-empty { padding: 14px 16px; color: #7a8597; }
.oe-spotlight-hint { padding: 6px 16px; font-size: 11px; color: #9aa4b5; border-top: 1px solid #eef1f5; }
.oe-chip-group { margin: 8px 0 4px; }
.oe-chipbox { display: flex; flex-wrap: wrap; gap: 4px; }
.oe-chip { display: inline-flex; align-items: baseline; gap: 4px; font: inherit; font-size: 12px; line-height: 18px; padding: 0 7px; border: 1px solid #d5dbe4; border-radius: 9px; background: #f6f8fb; color: #1d4ed8; cursor: pointer; }
.oe-chip:hover { background: #eef3fb; border-color: #9fb5e0; }
.oe-chip.unconfirmed { border-style: dashed; border-color: #a7b0bf; background: #ffffff; }
.oe-chip .db { font-size: 9px; color: #7a8597; text-transform: uppercase; letter-spacing: 0.03em; }
.oe-more { font-size: 12px; margin-top: 4px; }
.oe-review { display: inline-flex; vertical-align: middle; }
.oe-review svg { overflow: visible; }
.oe-line-facts { display: flex; align-items: center; gap: 6px; }
.oe-panel .oe-line-facts { flex-wrap: wrap; margin: 6px 0 10px; }
.oe-badge { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; line-height: 18px; padding: 1px 8px; border-radius: 10px; background: #f1f4f8; color: #3a4659; }
.oe-badge.review-reviewed { background: #e8f6ee; color: #1f7a45; }
.oe-badge.review-pending, .oe-badge.review-stale { background: #fff4e0; color: #8a5a00; }
.oe-rel-sentence { margin: 0 0 10px; color: #1f2a3d; }
.oe-rel-card { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; width: 100%; font: inherit; text-align: left; background: #f8fafc; border: 1px solid #dfe4ec; border-radius: 8px; padding: 8px 10px; cursor: pointer; }
.oe-rel-card:hover { border-color: #e8833a; background: #fffaf5; }
.oe-rel-card .side { display: flex; gap: 6px; width: 100%; font-size: 11px; font-weight: 700; color: #7a8597; text-transform: uppercase; letter-spacing: 0.04em; }
.oe-rel-card .side .db { margin-left: auto; font-weight: 400; text-transform: none; letter-spacing: 0; }
.oe-rel-card .name { display: flex; align-items: center; gap: 6px; font-weight: 700; color: #1d4ed8; overflow-wrap: anywhere; }
.oe-rel-card .col { margin-left: 19px; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; color: #3a4659; overflow-wrap: anywhere; }
.oe-rel-card .targets { margin-left: 19px; font-size: 12px; color: #56627a; overflow-wrap: anywhere; }
.oe-rel-arrow { margin: 4px 0 4px 14px; font-size: 12px; color: #56627a; }
.oe-review-chip { display: inline-flex; align-items: center; gap: 6px; background: #fff4e0; color: #8a5a00; border: 1px solid #f0c987; border-radius: 14px; padding: 3px 4px 3px 10px; font-size: 12px; box-shadow: 0 2px 6px rgba(20, 30, 50, 0.1); white-space: nowrap; }
.oe-chip-close { font: inherit; font-size: 14px; line-height: 16px; width: 20px; height: 20px; border: 0; border-radius: 10px; background: none; color: #8a5a00; cursor: pointer; }
.oe-chip-close:hover { background: #fde3b4; }
.oe-chip-list { font: inherit; font-size: 12px; font-weight: 600; line-height: 18px; padding: 0 8px; border: 1px solid currentColor; border-radius: 10px; background: #ffffff; color: inherit; cursor: pointer; }
.oe-chip-list:hover { background: rgba(255, 255, 255, 0.6); box-shadow: inset 0 0 0 1px currentColor; }
.oe-pii-chip { background: #fff0eb; color: #a8341a; border-color: #f3b3a1; }
.oe-central-chip { background: #fff8e1; color: #8a6400; border-color: #ecd27a; }
.oe-central-chip .oe-chip-close { color: #8a6400; }
.oe-central-chip .oe-chip-close:hover { background: #fdeeb5; }
.oe-central-domain { border-top: 1px solid #f0f2f6; padding: 6px 0; }
.oe-central-domain > .name { font-weight: 600; color: #172033; overflow-wrap: anywhere; margin-bottom: 4px; }
.oe-pii-chip .oe-chip-close { color: #a8341a; }
.oe-pii-chip .oe-chip-close:hover { background: #ffd9cc; }
.oe-pii-domain { border-top: 1px solid #f0f2f6; padding: 6px 0; }
.oe-pii-domain > summary { display: flex; align-items: baseline; gap: 6px; cursor: pointer; font-weight: 600; color: #172033; }
.oe-pii-domain > summary .name { min-width: 0; overflow-wrap: anywhere; }
.oe-pii-domain > summary::-webkit-details-marker { display: none; }
.oe-pii-domain > summary::before { content: '▸'; flex: none; width: 10px; color: #7a8597; }
.oe-pii-domain[open] > summary::before { content: '▾'; }
.oe-pii-domain > summary .db { color: #7a8597; font-weight: 400; }
.oe-pii-domain > summary .n { margin-left: auto; color: #a8341a; font-weight: 600; font-size: 12px; }
.oe-pii-table { margin: 6px 0 0 16px; }
.oe-pii-tname { display: flex; align-items: center; gap: 6px; width: 100%; font: inherit; font-weight: 600; color: #1f2a3d; background: none; border: 0; border-radius: 4px; padding: 2px 4px; cursor: pointer; text-align: left; }
.oe-pii-tname .oe-icon { color: #56627a; }
.oe-pii-tname .name { min-width: 0; overflow-wrap: anywhere; }
.oe-pii-tname .n { margin-left: auto; flex: none; color: #7a8597; font-weight: 400; font-size: 12px; }
.oe-pii-col { display: block; width: calc(100% - 11px); margin-left: 11px; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; color: #a8341a; background: none; border: 0; border-left: 1px solid #e3e7ee; padding: 2px 0 2px 12px; cursor: pointer; text-align: left; overflow-wrap: anywhere; }
.oe-pii-tname:hover, .oe-pii-col:hover { background: #fff0eb; }
.oe-health-filters { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 4px; }
.oe-health-filter { font-size: 12px; padding: 2px 10px; }
.oe-health-item { border-top: 1px solid #f0f2f6; padding: 8px 0; }
.oe-health-item.ticked { background: #fff7e6; box-shadow: -8px 0 #fff7e6, 8px 0 #fff7e6; }
.oe-health-tick { margin: 0; align-self: center; cursor: pointer; accent-color: #b8740a; }
.oe-health-ticked { margin: 8px 0 4px; }
.oe-health-count { font-weight: 600; color: #172033; }
.oe-health-head { display: flex; align-items: baseline; gap: 6px; }
.oe-health-head .rule { font-weight: 600; color: #172033; }
.oe-health-where { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 6px; margin-top: 4px; }
.oe-health-where > .oe-link { overflow-wrap: anywhere; }
.oe-health-item p { margin: 4px 0; }
.oe-health-sql { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; color: #1f2a3d; background: #f6f8fb; border: 1px solid #e3e7ed; border-radius: 4px; padding: 6px 8px; margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; -webkit-user-select: text; user-select: text; }
.oe-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; color: #4c4f9e; background: #f1f1fa; border-radius: 3px; padding: 0 3px; overflow-wrap: anywhere; }
.oe-tip .oe-code { color: #c8caff; background: #2c3650; }
.oe-star { color: #d99a00; }
.oe-popover { position: absolute; top: calc(100% + 4px); left: 0; right: auto; width: max-content; min-width: 140px; z-index: 3; }
.oe-panel .oe-drop { position: relative; }
.legend-central { fill: #fde7a8; stroke: #a87a00; }
.legend-pii { fill: #ffd9cc; }
.legend-pii-text { font-size: 12px; fill: #a8341a; }
.legend-pii-card { fill: #ffffff; stroke: #d9603f; stroke-width: 2; }
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
.oe-join-picks .oe-result { display: block; width: 100%; text-align: left; border: 0; background: none; font: inherit; cursor: pointer; }
.oe-join-picks .oe-result:hover { background: #eef3fb; }
.oe-join-picks .oe-result .where { color: #7a8597; font-size: 11px; margin: 0; max-width: none; }
.oe-panel { background: #ffffff; border: 1px solid #c3cad5; border-radius: 8px; padding: 12px 14px; box-shadow: 0 6px 18px rgba(20, 30, 50, 0.12); overflow: auto; }
.oe-panel-close { float: right; position: sticky; top: 0; z-index: 1; margin: -6px -8px 0 8px; font: inherit; font-size: 18px; line-height: 24px; width: 26px; height: 26px; border: 0; border-radius: 13px; background: #ffffff; color: #56627a; cursor: pointer; }
.oe-panel-close::before { content: '×'; }
.oe-panel-close:hover { background: #eef1f5; color: #1f2a3d; }
.oe-panel h3 { margin: 0 0 4px; font-size: 14px; overflow-wrap: anywhere; }
.oe-ph { margin-bottom: 10px; }
.oe-trail { display: flex; align-items: center; gap: 4px; margin: -2px 0 8px; font-size: 12px; color: #7a8597; min-width: 0; }
.oe-trail .items { display: flex; align-items: center; gap: 4px; flex: 1 1 auto; min-width: 0; justify-content: flex-end; overflow: hidden; white-space: nowrap; }
.oe-trail .items > * { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.oe-trail .items > .here, .oe-trail .items > .sep { flex: none; }
.oe-trail .here { color: #1f2a3d; }
.oe-trail-btn { flex: none; font: inherit; width: 22px; height: 22px; border: 1px solid #dfe4ec; border-radius: 5px; background: #ffffff; color: #3d4a5e; cursor: pointer; padding: 0; }
.oe-trail-btn:hover:not(:disabled) { background: #eef3fb; }
.oe-trail-btn:disabled { color: #c3cad5; cursor: default; }
.oe-ph-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.oe-ph-name { font-size: 15px; color: #172033; overflow-wrap: anywhere; }
.oe-domain-chip { font: inherit; font-size: 11px; line-height: 18px; padding: 0 8px; border: 1px solid; border-radius: 9px; background: #ffffff; cursor: pointer; }
.oe-domain-chip:hover { background: #f6f8fb; }
.oe-ph-note { color: #3d4a5e; margin-top: 4px; overflow-wrap: anywhere; }
.oe-ph-sub { color: #7a8597; font-size: 12px; margin-top: 3px; overflow-wrap: anywhere; }
.oe-ph-facts { margin-top: 4px; font-size: 12px; color: #56627a; }
.oe-actions { display: flex; align-items: center; gap: 6px; margin: 0 0 10px; flex-wrap: wrap; }
.oe-hint-row { font-size: 11.5px; margin: -4px 0 10px; }
.oe-review-domain { display: flex; align-items: center; gap: 6px; margin: 4px 0; }
.oe-review-item { display: flex; align-items: center; gap: 6px; width: 100%; padding: 4px 6px; border: 0; border-radius: 4px; background: none; font: inherit; color: #1f2a3d; text-align: left; cursor: pointer; overflow-wrap: anywhere; }
.oe-review-item:hover { background: #f3f6fa; }
.oe-picked-row { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-bottom: 1px solid #eef1f5; }
.oe-picked-row .oe-chip-close { margin-left: auto; color: #8a94a6; }
.oe-actions .oe-tool { height: 28px; width: 28px; }
.oe-actions-label { font-size: 12px; color: #7a8597; }
.oe-ph-sep { color: #7a8597; }
.oe-actions .oe-seg .oe-btn { height: 28px; font-size: 12px; }
.oe-btn.oe-small { font-size: 12px; padding: 3px 8px; }
.oe-status-inline { font-size: 12px; }
.oe-tabs { display: flex; gap: 2px; border-bottom: 1px solid #e1e6ee; margin-bottom: 4px; }
.oe-tab { font: inherit; font-size: 12px; padding: 6px 10px; border: 0; border-bottom: 2px solid transparent; background: none; color: #56627a; cursor: pointer; display: inline-flex; gap: 5px; }
.oe-tab .n { color: #9aa4b5; }
.oe-tab.on { color: #1f2a3d; border-bottom-color: #2563eb; font-weight: 700; }
.oe-col { padding: 6px 2px 7px; border-bottom: 1px solid #f0f2f6; }
.oe-col.open { background: #fff8db; }
.oe-col .l1 { display: flex; align-items: center; gap: 5px; min-width: 0; }
.oe-col .gutter { flex: none; width: 14px; height: 14px; display: inline-flex; }
.oe-col .name { color: #1f2a3d; overflow-wrap: anywhere; }
.oe-col .name.pk { font-weight: 700; }
.oe-col .type { margin-left: auto; padding-left: 8px; flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: #8a94a6; }
.oe-col .l2 { margin: 2px 0 0 19px; font-size: 11.5px; line-height: 1.4; color: #66728a; overflow-wrap: anywhere; }
.oe-col .l2.internal { color: #9aa4b5; }
.oe-col .hint { flex: none; display: inline-flex; margin-left: -1px; }
.oe-col .hint svg { overflow: visible; }
.oe-badge { flex: none; font: inherit; font-size: 10px; line-height: 15px; padding: 0 5px; border-radius: 4px; background: #eef1f5; color: #56627a; border: 0; white-space: nowrap; max-width: 140px; overflow: hidden; text-overflow: ellipsis; }
.oe-badge.null { background: #f1f4f8; color: #7a8597; }
.oe-badge.default { background: #eef4ff; color: #36569a; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.oe-badge.enum { background: #f1ecfb; color: #6a4bb0; cursor: pointer; }
.oe-badge.enum:hover { background: #e6dcf8; }
.oe-badge.pii { background: #ffe1d8; color: #a8341a; font-weight: 700; }
.oe-badge.sev-medium { background: #fde3b4; color: #8a5a00; font-weight: 700; }
.oe-badge.sev-low { background: #e6ebf2; color: #56627a; font-weight: 700; }
.oe-badge.unique { background: #e6f4f1; color: #136e63; font-weight: 700; }
.oe-enum-list { margin: 4px 0 0 19px; padding: 4px 8px; border-left: 2px solid #e6dcf8; font-size: 12px; color: #3d4a5e; }
.oe-enum-list > div { margin: 2px 0; overflow-wrap: anywhere; }
.oe-idx { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; padding: 6px 2px; border-bottom: 1px solid #f0f2f6; }
.oe-idx .cols { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #1f2a3d; }
.oe-idx .iname { font-size: 11px; color: #9aa4b5; overflow-wrap: anywhere; }
.oe-idx .where { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: #7a8597; flex-basis: 100%; }
.oe-legend-pill, .oe-help { display: inline-flex; align-items: center; gap: 8px; font: inherit; font-size: 12px; font-weight: 700; padding: 6px 10px; border: 1px solid #c3cad5; border-radius: 8px; background: #ffffff; color: #3d4a5e; box-shadow: 0 6px 18px rgba(20, 30, 50, 0.12); cursor: pointer; transition: transform 0.12s, border-color 0.12s, box-shadow 0.12s; }
.oe-legend-pill:hover, .oe-help:hover { border-color: #8a96a8; transform: translateY(-1px); box-shadow: 0 8px 22px rgba(20, 30, 50, 0.18); }
.oe-help { width: 26px; height: 26px; justify-content: center; padding: 0; border-radius: 50%; font-size: 13px; color: #7a8597; border-color: #dfe4ec; box-shadow: none; opacity: 0.6; }
.oe-help:hover, .oe-help:focus-visible { opacity: 1; color: #3d4a5e; }
.oe-help span { line-height: 16px; }
.oe-chevron { color: #7a8597; }
.oe-back-pill { font: inherit; font-size: 12px; padding: 4px 12px 4px 10px; border: 1px solid #c3cad5; border-radius: 14px; background: #ffffff; color: #1d4ed8; box-shadow: 0 2px 8px rgba(20, 30, 50, 0.12); cursor: pointer; white-space: nowrap; max-width: 360px; overflow: hidden; text-overflow: ellipsis; }
.oe-back-pill:hover { background: #eef3fb; }
.oe-tour { display: flex; align-items: center; gap: 12px; background: #ffffff; border: 1px solid #c3cad5; border-radius: 8px; padding: 10px 10px 10px 14px; box-shadow: 0 6px 18px rgba(20, 30, 50, 0.12); }
.oe-tour-text { flex: 1; min-width: 0; }
.oe-tour-head { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.oe-tour-head b { font-size: 14px; overflow-wrap: anywhere; }
.oe-tour-count { flex: none; font-size: 11px; line-height: 18px; padding: 0 7px; border-radius: 9px; background: #eef1f5; color: #56627a; white-space: nowrap; }
.oe-tour-note { margin-top: 4px; color: #3d4a5e; line-height: 1.45; overflow-wrap: anywhere; }
.oe-tour-controls { flex: none; display: flex; gap: 4px; }
/* Pills float over the drawing: a drag that starts on one selects no text. */
.oe-toolbar, .oe-back-pill, .oe-legend-pill, .oe-help { -webkit-user-select: none; user-select: none; }
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
.oe-status:not(:empty) { padding: 6px 10px; color: #56627a; font-size: 12px; border-top: 1px solid #eef1f5; overflow-wrap: anywhere; }
.oe-panel .label-inline { color: #7a8597; font-size: 12px; min-width: 36px; }
.oe-join-field input { font: inherit; flex: 1; padding: 4px 8px; border: 1px solid #c3cad5; border-radius: 6px; }
.oe-join-picks .oe-result { padding: 4px 10px 4px 42px; }
.oe-paths { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 6px; }
.oe-paths .oe-btn { font-size: 12px; padding: 3px 10px; }
.oe-hops { padding-left: 20px; }
.oe-hops li { margin: 6px 0; }
.oe-hops code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: #f3f5f8; border-radius: 4px; padding: 1px 4px; overflow-wrap: anywhere; }
.oe-chips .chip.flag-trust { background: #fff1d6; color: #8a5a00; }
.oe-chips .chip.flag-cross_db { background: #e7f0ff; color: #1d4ed8; }
.oe-chips .chip.flag-polymorphic { background: #f6efdf; color: #6b5428; }
.oe-chips .chip.flag-shared_parent { background: #fff4e0; color: #9a5b00; }
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
  '.diff-removed :is(.table-title, .stub-title, .poly-title, .card-title), .column.col-removed text { text-decoration: line-through; }',
  '.column.col-removed .column-name { fill: #c92a2a; }',
  '.relation-group.diff-removed .relation { stroke-dasharray: 6 4; }',
  // Changes mode (a class on the root, set when a diff drawing opens):
  // what the diff did not change fades like the rest of a selection; tables
  // at the end of a changed line only half, so the line still reads. A
  // selection's own fading takes over while it lasts.
  `.changes-mode .view:not(.dimmed) :is(.table, .stub, .poly, .domain, .relation-group):not(${Object.keys(DIFF_COLORS).map((s) => `.diff-${s}`).join(', ')}, .near-change) { opacity: 0.16; }`,
  '.changes-mode .view:not(.dimmed) :is(.table, .stub, .poly).near-change { opacity: 0.55; }',
  ...Object.entries(DIFF_COLORS).map(([status, c]) => `.oe-badge.diff-${status} { background: ${c.fill}; color: ${c.stroke}; font-weight: 700; }`),
  // Lines the diff did not change go grey, except in Review mode, which
  // colours every line by its review state.
  '.diff-mode:not(.review-mode) .relation-group:not(.diff-added, .diff-removed, .diff-changed) :is(.relation, .marker) { stroke: #c3cad5; stroke-dasharray: none; }',
  '.diff-mode:not(.review-mode) .relation-group:not(.diff-added, .diff-removed, .diff-changed) .edge-label text { fill: #9aa4b5; }',
  '.banner-box { fill: #ffffff; stroke: #94a0b2; stroke-width: 1.2; }',
  `.banner-title { font-size: ${BANNER_TITLE_FONT.size}px; font-weight: ${BANNER_TITLE_FONT.weight}; fill: #172033; }`,
  `.banner-summary { font-size: ${BANNER_SUMMARY_FONT.size}px; font-weight: ${BANNER_SUMMARY_FONT.weight}; fill: #2a3546; }`,
  `.banner-legend { font-size: ${BANNER_LEGEND_FONT.size}px; font-weight: ${BANNER_LEGEND_FONT.weight}; fill: #56627a; }`,
].join('\n');

// Lines are one neutral colour, solid when confirmed and dashed when not
// (see isConfirmed). Review mode (a class the viewer sets on the root)
// colours them by review state for reviewers: pending amber, stale red.
// Icon colours come from ICON_PAINT so the SVG and the draw.io export never drift apart.
const ICON_CSS = Object.entries(ICON_PAINT)
  .map(([cls, paint]) => `.${cls} { ${Object.entries(paint).map(([k, v]) => `${k}: ${v};`).join(' ')} }`)
  .join('\n');

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
${ICON_CSS}
.review-icon { fill: none; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.review-icon-reviewed { stroke: #2f9e44; }
.review-icon-pending { stroke: #c27c0e; }
.review-icon-stale { stroke: #c53030; }
.table.central .table-title { font-size: 13px; }
.table.central > rect:last-of-type { stroke-width: 2.2; }
.col-warn { fill: #e8a317; stroke: #ffffff; stroke-width: 0.8; stroke-linejoin: round; }
.badge-text { font-size: ${BADGE_FONT.size}px; font-weight: ${BADGE_FONT.weight}; fill: #56627a; }
.badge-arrow { fill: none; stroke: #56627a; stroke-width: 1.2; }
.poly-box { fill: #fffdf7; stroke: #a08a5c; stroke-width: 1; stroke-dasharray: 4 3; }
.poly-title { font-size: 13px; font-weight: 700; fill: #6b5428; }
.poly-target { font-size: 12px; font-weight: 400; fill: #4a4236; }
.stub-box { fill: #f3f5f8; stroke: #c3cad5; stroke-width: 1; stroke-dasharray: 3 3; }
.stub-title { font-size: 12px; font-weight: 400; fill: #8a94a6; }
.group-stub .stub-box { fill: #f7f8fa; }
.group-title { font-size: 13px; font-weight: 700; }
.group-table { font-size: 12px; font-weight: 400; fill: #56627a; }
.group-row[data-table] { cursor: pointer; }
.group-row[data-table]:hover .row-hit { fill: #eef3fb; }
.group-row[data-table]:hover .group-table { fill: #1d4ed8; }
.group-head { cursor: pointer; }
.group-db-pill { fill: #eef1f5; }
.group-db { font-size: ${GROUP_DB_FONT.size}px; font-weight: ${GROUP_DB_FONT.weight}; fill: #56627a; }
.card-box { fill: #ffffff; stroke: #cfd6e0; stroke-width: 1; }
.card-accent { fill: none; stroke-width: 4; stroke-linecap: round; }
.card-title { font-size: ${CARD_TITLE_FONT.size}px; font-weight: ${CARD_TITLE_FONT.weight}; }
.card-count { font-size: ${CARD_TEXT_FONT.size}px; font-weight: ${CARD_TEXT_FONT.weight}; fill: #7a8597; }
.card-note { font-size: ${CARD_TEXT_FONT.size}px; font-weight: ${CARD_TEXT_FONT.weight}; fill: #3d4a5e; }
.card-central { font-size: ${CARD_TEXT_FONT.size}px; font-weight: ${CARD_TEXT_FONT.weight}; fill: #56627a; }
.card-central .fact-code { fill: #4c4f9e; }
.card-divider { stroke: #e6eaf0; }
.card-label { font-size: ${CARD_LABEL_FONT.size}px; font-weight: ${CARD_LABEL_FONT.weight}; fill: #8a94a6; }
.card-related-name { font-size: ${CARD_TEXT_FONT.size}px; font-weight: ${CARD_TEXT_FONT.weight}; fill: #2a3546; }
.card-none { font-size: ${CARD_TEXT_FONT.size}px; font-weight: ${CARD_TEXT_FONT.weight}; fill: #9aa4b5; }
.card-db-pill { fill: #eef1f5; }
.card-db { font-size: ${CARD_DB_FONT.size}px; font-weight: ${CARD_DB_FONT.weight}; fill: #56627a; }
.card-related-hit { fill: transparent; }
.seg { fill: #e3e7ee; }
.seg.on { fill: #5d7fb8; }
${RANKING_STYLE}
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
.review-mode .view[data-view="overview"] .domain.has-review .card-box { stroke: #c27c0e; stroke-width: 2; }
.review-mode .view[data-view="overview"] .domain:not(.has-review) { opacity: 0.35; }
.kind-view_source .relation { stroke: #a9b2c0; stroke-dasharray: 5 4; }
.table-tag { font-size: ${TAG_FONT.size}px; font-weight: ${TAG_FONT.weight}; fill: #5f6b7e; letter-spacing: 0.02em; }
.table.is-view > rect:last-of-type { stroke-dasharray: 5 3; }
.tenant-copy { fill: #ffffff; stroke: #c9d1dc; stroke-width: 1; }
.inset-box { fill: #f6f8fb; stroke: #d5dbe4; stroke-width: 1; }
.inset-title { font-size: 12px; font-weight: 700; fill: #56627a; }
.fact-text { font-size: ${FACT_FONT.size}px; font-weight: ${FACT_FONT.weight}; fill: #5f6b7e; }
/* Identifiers and values inside a fact line, set apart from its words by
   colour only: same font and weight, so measured widths still hold. */
.fact-code { fill: #4c4f9e; }
.db-fact-pill { fill: #eef1f5; stroke: #c3cad5; stroke-width: 1; }
.db-fact { font-size: ${DB_FACT_FONT.size}px; font-weight: ${DB_FACT_FONT.weight}; fill: #3d4a5e; }
${DIFF_STYLE}
${VIEWER_STYLE}`;

function escapeXml(text) {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

const camel = (name) => name.replace(/_(.)/g, (_, c) => c.toUpperCase());

// Marks of a plain render: nothing changed.
const NO_MARKS = { nodes: new Map(), columns: new Map(), links: new Map(), sentences: { nodes: new Map(), links: new Map() }, near: new Set() };
const diffClass = (marks, id) => (marks.nodes.has(id) ? ` diff-${marks.nodes.get(id)}` : marks.near.has(id) ? ' near-change' : '');
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

// A cross-DB line in a table view names both databases it joins, in the
// direction of the reference ("billing → auth"), so a line touching one
// database never reads as belonging to only the other.
function labelText(link) {
  // A group stub names its database itself.
  return link.kind === 'cross_db' && !link.group ? `${link.from.node.split('.')[0]} → ${link.to.node.split('.')[0]}` : null;
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
  // The overview draws cards only: its links (domainLinks) order the cards
  // and the viewer draws a card's connectors on hover.
  let relations = [];
  if (name !== OVERVIEW) {
    // A line standing for relations of different cardinalities has no ends.
    const markers = view.links.map((l) => (l.kind === VIEW_SOURCE || l.cardinality === null ? { from: 'none', to: 'none' } : endMarkers(l)));
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

// Marks after a column name: enum values to read, a column in an index.
const HINT_ICONS = { enum: enumIconSvg, index: indexIconSvg };
const hintsSvg = (r, nameX, cy) => r.hints.map((h) => HINT_ICONS[h.kind](nameX + h.x, cy)).join('');
// Icon in a row's left gutter: primary key or reference to another table.
const KEY_ICONS = { pk: keyIconSvg, fk: linkIconSvg };
const keySvg = (r, left, cy) => (r.key ? KEY_ICONS[r.key](left + ICON_GUTTER / 2 - 1, cy) : '');

// A fact line with its identifiers and values in tspans of their own. The
// line was cut to fit as one string; the parts are cut at the same length.
function factSvg(f, x, y) {
  const tip = f.text.truncated ? `<title>${escapeXml(f.text.full)}</title>` : '';
  let left = f.text.truncated ? f.text.text.length - 1 : f.text.text.length;
  const spans = [];
  for (const part of f.parts) {
    if (left <= 0) break;
    const text = part.text.slice(0, left);
    left -= text.length;
    spans.push(part.code ? `<tspan class="fact-code">${escapeXml(text)}</tspan>` : escapeXml(text));
  }
  return `<text class="fact-text" x="${x}" y="${y}" dominant-baseline="central">${spans.join('')}${f.text.truncated ? '…' : ''}${tip}</text>`;
}

// A possibly missing relation: a small amber triangle in the row's left
// padding, so no box grows and no stored layout goes stale. Its title is the
// tooltip without script.
function warnSvg(left, cy, text) {
  const x0 = left + WARN_INSET;
  const half = WARN_SIZE / 2;
  return `<path class="col-warn" d="M${x0} ${cy + half}L${x0 + half} ${cy - half}L${x0 + WARN_SIZE} ${cy + half}Z"><title>${escapeXml(`Possibly missing relation: ${text}`)}</title></path>`;
}

// Each row is a group so the viewer can show the column's details on hover
// (the transparent rect makes the whole row hoverable). Embedded columns are
// indented inside their entity's inset box. A central table (see
// centrality.js) gets a stronger header, a star and a thicker border.
function tableSvg(n, colors, marks, warnings) {
  const { x, y, w, h, box } = n;
  const columnMarks = marks.columns.get(n.id);
  const rows = box.rows.map((r) => {
    const indent = EMBED_INSET * r.depth;
    const status = columnMarks?.get(r.column);
    const top = y + r.centerY - ROW_HEIGHT / 2;
    return [
      `<g class="column${status ? ` col-${status}` : ''}" data-column="${escapeXml(r.column)}">`,
      `<rect class="row-hit" x="${x + indent}" y="${top}" width="${w - 2 * indent}" height="${ROW_HEIGHT}"/>`,
      status ? `<rect class="col-mark col-${status}" x="${x + indent + 1}" y="${top + 2}" width="3" height="${ROW_HEIGHT - 4}"/>` : '',
      warnings?.has(r.column) ? warnSvg(x + indent, y + r.centerY, warnings.get(r.column)) : '',
      keySvg(r, x + PADDING_X + indent, y + r.centerY),
      textEl(r.pk ? 'column-name pk' : 'column-name', x + PADDING_X + indent + ICON_GUTTER, y + r.centerY, r.name),
      hintsSvg(r, x + PADDING_X + indent + ICON_GUTTER, y + r.centerY),
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
  const facts = box.facts.map((f) => factSvg(f, x + PADDING_X, y + f.centerY));
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
  const central = box.central;
  const headerIcon = (central ? starIconSvg : tableIconSvg)(x + PADDING_X + ICON_GUTTER / 2 - 1, y + box.title.centerY);
  return [
    `<g class="table${kind === 'table' ? '' : ' is-view'}${central ? ' central' : ''}${diffClass(marks, n.id)}" data-id="${escapeXml(n.id)}"><title>${escapeXml(titleText(marks, n.id, central ? `${n.id} (most connected table of its domain)` : n.id))}</title>`,
    copies,
    `<rect class="table-box" x="${x}" y="${y}" width="${w}" height="${h}" rx="${CORNER}"/>`,
    headerPath(x, y, w, central ? colors.central : colors.header),
    `<path d="M${x} ${y + HEADER_HEIGHT}H${x + w}" stroke="${central ? colors.centralStroke : colors.stroke}"/>`,
    headerIcon,
    textEl('table-title', x + PADDING_X + ICON_GUTTER, y + box.title.centerY, box.title),
    tag,
    ...insets,
    ...rows,
    separator,
    ...facts,
    ...badges,
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${CORNER}" fill="none" stroke="${central ? colors.centralStroke : '#b8c2d0'}"/>`,
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

// Tables of one other domain in a domain view, as one box: the domain's
// name in its colour (with its database when that differs), one row per
// table; a click on a row opens that table, on the header that domain.
function groupStubSvg(n, colors) {
  const { x, y, w, h, box } = n;
  const { key, tables } = n.group;
  const tip = `${clusterLabel(key)}${box.db ? ` (${box.db})` : ''}: ${tables.map((t) => t.split('.')[2]).join(', ')}`;
  const pill = box.db
    ? (() => {
        const pw = Math.ceil(measureText(box.db, GROUP_DB_FONT)) + 10;
        const px = x + w - PADDING_X - pw;
        return `<rect class="group-db-pill" x="${px}" y="${y + box.title.centerY - 7}" width="${pw}" height="14" rx="7"/><text class="group-db" x="${px + pw / 2}" y="${y + box.title.centerY}" dominant-baseline="central" text-anchor="middle">${escapeXml(box.db)}</text>`;
      })()
    : '';
  const rows = box.rows.map(
    (r) =>
      `<g class="group-row"${r.table ? ` data-table="${escapeXml(r.table)}"` : ''}><rect class="row-hit" x="${x}" y="${y + r.centerY - ROW_HEIGHT / 2}" width="${w}" height="${ROW_HEIGHT}"/>` +
      `${textEl('group-table', x + PADDING_X, y + r.centerY, r.name)}</g>`,
  );
  return (
    `<g class="stub group-stub" data-id="${escapeXml(n.id)}" data-domain="${escapeXml(key)}" data-tables="${json(tables)}"><title>${escapeXml(tip)}</title>` +
    `<rect class="stub-box" x="${x}" y="${y}" width="${w}" height="${h}" rx="${CORNER}"/>` +
    `<path d="M${x} ${y + HEADER_HEIGHT}H${x + w}" stroke="#d5dbe4"/>` +
    `<g class="group-head"><text class="group-title" x="${x + PADDING_X}" y="${y + box.title.centerY}" dominant-baseline="central" fill="${colors.label}">${escapeXml(box.title.text)}</text>${pill}</g>` +
    `${rows.join('')}</g>`
  );
}

function stubSvg(n, marks) {
  const { x, y, w, h, box } = n;
  return (
    `<g class="stub${diffClass(marks, n.id)}" data-id="${escapeXml(n.id)}"><title>${escapeXml(titleText(marks, n.id, n.id))}</title>` +
    `<rect class="stub-box" x="${x}" y="${y}" width="${w}" height="${h}" rx="${CORNER}"/>` +
    `${textEl('stub-title', x + PADDING_X, y + box.title.centerY, box.title)}</g>`
  );
}

// Overview card of a domain (see domainCard): an accent bar in the
// domain's colour, name and table count, the business note, the central
// table, and the most related domains with a strength bar each (no numbers:
// the tooltips and the connector panels carry them). Each related row
// leads to that domain.
function cardSvg(n, colors, colorOf, marks) {
  const { x, y, w, h, box } = n;
  const c = CARD;
  const left = x + c.padX;
  const right = x + w - c.padX;
  const text = (cls, tx, f, extra = '') => textEl(cls, tx, y + f.centerY, f, extra || undefined);
  const note = box.note ? box.note.lines.map((l) => `<text class="card-note" x="${left}" y="${y + l.centerY}" dominant-baseline="central">${escapeXml(l.text)}</text>`).join('') : '';
  const central = box.central
    ? `${starIconSvg(left + ICON_GUTTER / 2 - 2, y + box.central.centerY)}<text class="card-central" x="${left + ICON_GUTTER}" y="${y + box.central.centerY}" dominant-baseline="central">${escapeXml(box.central.text.slice(0, 9))}<tspan class="fact-code">${escapeXml(box.central.text.slice(9))}</tspan>${box.central.truncated ? `<title>${escapeXml(box.central.full)}</title>` : ''}</text>`
    : '';
  const segW = c.segment.w + c.segment.gap;
  const barX = right - STRENGTH_SEGMENTS * segW + c.segment.gap;
  const related = box.related.map((r) => {
    const cy = y + r.centerY;
    const segs = Array.from({ length: STRENGTH_SEGMENTS }, (_, i) => `<rect class="seg${i < r.segments ? ' on' : ''}" x="${barX + i * segW}" y="${cy - c.segment.h / 2}" width="${c.segment.w}" height="${c.segment.h}" rx="1"/>`).join('');
    const nameW = Math.ceil(r.name.width);
    const tag = r.db
      ? (() => {
          const tw = Math.ceil(measureText(r.db, CARD_DB_FONT)) + 8;
          const tx = left + c.swatch + nameW + c.dbGap;
          return `<rect class="card-db-pill" x="${tx}" y="${cy - 7}" width="${tw}" height="14" rx="7"/><text class="card-db" x="${tx + tw / 2}" y="${cy}" dominant-baseline="central" text-anchor="middle">${escapeXml(r.db)}</text>`;
        })()
      : '';
    const swatch = colorOf(r.key);
    const nameX = left + c.swatch;
    return (
      `<g class="card-related" data-domain="${escapeXml(r.key)}"><title>${escapeXml(`${r.name.full}${r.db ? ` (${r.db})` : ''}: ${r.count} relation${r.count === 1 ? '' : 's'} with ${box.title.full}`)}</title>` +
      `<rect class="card-related-hit" x="${left - 4}" y="${cy - 9}" width="${right - left + 8}" height="18"/>` +
      `<rect x="${left}" y="${cy - 4}" width="8" height="8" rx="2" fill="${swatch.header}" stroke="${swatch.label}"/>` +
      `<text class="card-related-name" x="${nameX}" y="${cy}" dominant-baseline="central">${escapeXml(r.name.text)}</text>${tag}${segs}</g>`
    );
  });
  const none = box.related.length === 0 ? `<text class="card-none" x="${left}" y="${y + box.layout.relatedY[0]}" dominant-baseline="central">No relations with other domains</text>` : '';
  const tip = [box.title.full, box.count.full, box.note?.full, box.central?.full].filter(Boolean).join('\n');
  return (
    `<g class="domain${diffClass(marks, n.id)}" data-domain="${escapeXml(n.id)}"><title>${escapeXml(tip)}</title>` +
    `<rect class="card-box" x="${x}" y="${y}" width="${w}" height="${h}" rx="10"/>` +
    `<path class="card-accent" d="M${x + 6} ${y + 12}V${y + h - 12}" stroke="${colors.label}"/>` +
    `<text class="card-title" x="${left}" y="${y + box.title.centerY}" dominant-baseline="central" fill="${colors.label}">${escapeXml(box.title.text)}${box.title.truncated ? `<title>${escapeXml(box.title.full)}</title>` : ''}</text>` +
    text('card-count', right, box.count, 'end') +
    note +
    central +
    `<path class="card-divider" d="M${left} ${y + box.layout.dividerY}H${right}"/>` +
    `<text class="card-label" x="${left}" y="${y + box.layout.relatedLabelY}" dominant-baseline="central">Related domains</text>` +
    related.join('') +
    none +
    '</g>'
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

/** "3 tables in Billing reference orders.id", or the other way round. */
export function groupLinkText(link) {
  const outwards = link.to.node.startsWith('group:');
  const own = outwards ? link.from : link.to;
  const ownText = `${own.node.split('.')[2]}${own.column ? `.${own.column}` : ''}`;
  const n = link.tables.length;
  const tables = `${n} ${n === 1 ? 'table' : 'tables'} in ${clusterLabel(link.group)}`;
  return outwards ? `${ownText} references ${tables}` : `${tables} reference${n === 1 ? 's' : ''} ${ownText}`;
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
  const grouped = link.group ? ` data-group="${escapeXml(link.group)}" data-tables="${json(link.tables)}" data-label="${escapeXml(groupLinkText(link))}"` : '';
  return (
    `<g class="relation-group kind-${link.kind} review-${link.review}${styleClass(link)}${linkDiffClass(marks, link.id)}" data-id="${escapeXml(link.id)}"` +
    ` data-from="${escapeXml(link.from.node)}" data-to="${escapeXml(link.to.node)}" data-kind="${link.kind}" data-review="${link.review}"${via}${grouped}>` +
    `<title>${escapeXml(titleText(marks, link.id, link.group ? groupLinkText(link) : link.via ? `${link.id} (n-n via ${link.via})` : link.id, 'links'))}</title>` +
    `<path class="relation" d="${d}"${link.group ? ` style="stroke-width:${overviewStrokeWidth(link.relations.length)}"` : ''}/>${markers}${label}</g>`
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

// Hidden views are shown by the embedded viewer script; without script the
// opening view alone is what a reader sees.
function viewGroup(name, { x, y, w, h }, visible, content) {
  const hidden = visible ? '' : ' style="display:none"';
  return [`<g class="view" data-view="${escapeXml(name)}" data-bounds="${x} ${y} ${w} ${h}"${hidden}>`, `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#ffffff"/>`, ...content, '</g>'].join('\n');
}

function viewSvg(scene, colorOf, visible, marks, banner, warnings) {
  const nodes = scene.nodes.map((n) => {
    if (n.kind === 'table') return tableSvg(n, colorOf(n.node.cluster), marks, warnings.get(n.id));
    if (n.kind === 'poly') return polySvg(n, marks);
    if (n.kind === 'stub') return stubSvg(n, marks);
    if (n.kind === 'group') return groupStubSvg(n, colorOf(n.group.key));
    return cardSvg(n, colorOf(n.id), colorOf, marks);
  });
  return viewGroup(scene.name, scene.bounds, visible, [
    `<g class="groups">${scene.groups.map((g) => groupSvg(g, colorOf)).join('')}</g>`,
    `<g class="relations">${scene.relations.map((r) => relationSvg(r, marks)).join('')}${polyRoutesSvg(scene.polyRoutes)}${hubRoutesSvg(scene.hubRoutes)}</g>`,
    `<g class="nodes">${nodes.join('')}</g>`,
    banner ?? '',
  ]);
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
export function viewerData(model, diagram, diff = null, warnings = missingRelations(model), health = healthFindings(model)) {
  const warned = warningsByTable(warnings);
  // Note fields in a fixed order; a sharing profile has already removed the
  // ones it drops.
  const notes = (o) => Object.fromEntries(['note', 'note_source', 'internal_note'].filter((f) => o[f]).map((f) => [f === 'note' ? f : camel(f), o[f]]));
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
  });
  const nodes = {};
  for (const id of [...diagram.nodes.keys()].sort(compareStrings)) {
    const n = diagram.nodes.get(id);
    if (n.kind === 'poly') {
      const a = n.association;
      nodes[id] = { kind: 'poly', cluster: n.cluster, table: a.table, name: a.name, typeColumn: a.type_column, idColumn: a.id_column, optional: a.optional, review: a.review, targets: a.targets, ...notes(a) };
      continue;
    }
    const t = n.table;
    nodes[id] = {
      kind: 'table',
      cluster: n.cluster,
      ...(t.kind && t.kind !== 'table' ? { tableKind: t.kind } : {}),
      ...(n.central ? { central: true } : {}),
      ...notes(t),
      ...(n.facts.length > 0 ? { facts: n.facts } : {}),
      ...(t.indexes ? { indexes: t.indexes.map((i) => ({ ...(i.name ? { name: i.name } : {}), columns: i.columns, unique: i.unique === true, ...(i.where ? { where: i.where } : {}), ...(i.using ? { using: i.using } : {}) })) } : {}),
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
        ...(n.box.rows.find((r) => r.column === path)?.key === 'fk' ? { fk: true } : {}),
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
  // The relations of each pair of domains, for the overview's connectors
  // and their panels.
  const domains = Object.fromEntries(
    domainPairs(diagram)
      .filter((d) => d.from.node !== d.to.node)
      .map((d) => [
        d.id,
        d.relations.map((r) => ({
          from: r.from.table,
          column: r.from.column,
          to: r.to,
          cardinality: r.cardinality,
          kind: r.kind,
          review: r.review,
          ...(r.association ? { association: r.association } : {}),
          ...(r.via ? { via: r.via } : {}),
        })),
      ]),
  );
  // Database name -> its engine as written in the model (`engine`, for the
  // schema copy) and as printed on its frame (`label`, for cross-DB panels).
  const databases = Object.fromEntries(model.databases.map((db) => [db.database, { engine: db.engine, label: engineName(db.engine) }]));
  // Facts waiting for a reviewer, for the review mode menu entry.
  const facts = [...model.relations, ...model.polymorphic];
  const review = { pending: facts.filter((f) => f.review === 'pending').length, stale: facts.filter((f) => f.review === 'stale').length };
  // Downloads are named after the one database, else the project (its one
  // source), else plainly `erd`.
  const sources = model.config.sources ?? [];
  const project = model.databases.length === 1 ? model.databases[0].database : sources.length === 1 ? sources[0].name : 'erd';
  // Business note of each domain, for its card's tooltip.
  const domainNotes = Object.fromEntries(model.databases.flatMap((db) => Object.entries(db.domains ?? {}).filter(([, d]) => d.note).map(([name, d]) => [`${db.database}/${name}`, d.note])));
  // Domains most connected first (see domainSummary), for the tour.
  const domainOrder = domainSummary(model, diagram).order;
  const base = { project, nodes, links, hubLinks, domainLinks: domains, domainNotes, domainOrder, databases, review, mostCentral: diagram.mostCentral };
  // Schema health findings for the Health list; left out when there are none.
  if (health.length > 0) base.health = health.map(({ related, ...f }) => f);
  if (!diff) return base;
  const sorted = (map) => Object.fromEntries([...map].sort(([a], [b]) => compareStrings(a, b)));
  const { sentences, nodes: status, links: lineStatus, counts } = diff.marks;
  return {
    ...base,
    changes: { from: diff.from, to: diff.to, summary: diff.summary, nodes: sorted(sentences.nodes), links: sorted(sentences.links), status: sorted(status), lineStatus: sorted(lineStatus), counts },
  };
}

/** Every view a render draws: the laid-out ones, then the ranking unless switched off. */
export const renderedViews = (diagram) => [...viewNames(diagram), ...(diagram.views.ranking === 'on' ? [RANKING_VIEW] : [])];

/**
 * The view a plain render opens on and draws without script: the
 * configured `default_view` when this diagram has it, else the view of all
 * tables, else the overview. `fallback` is true when a configured view was
 * missing (the view of all tables of a very large schema, a domain a
 * profile hid); a schema too large for the view of all tables opens on the
 * overview without one when nothing is configured.
 */
export function openingView(model, diagram = buildDiagram(model)) {
  const configured = model.config.default_view;
  const wanted = configured ?? ALL_VIEW;
  if (renderedViews(diagram).includes(wanted)) return { view: wanted, fallback: false };
  return { view: OVERVIEW, fallback: configured !== undefined };
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
 * seen without script. When anything is marked, the root also gets
 * `changes-mode`, which fades what did not change.
 *
 * `{ warnings }`: the possibly missing relations to mark (missingRelations
 * of `model` when left out); a profile render passes the ones found on the
 * full model (see warningsFor), a diff passes none.
 *
 * `{ health }`: the schema health findings the viewer lists (healthFindings
 * of `model` when left out); a profile render passes the ones found on the
 * full model and narrowed by healthFor, a diff passes none.
 */
export function renderSvg(model, layout, options = {}) {
  const { diff = null, warnings = missingRelations(model), health = diff ? [] : healthFindings(model), ...sceneOptions } = options;
  const diagram = buildDiagram(model);
  const marks = diff?.marks ?? NO_MARKS;
  // A diff opens with the Changes mode on (see the viewer), so the static
  // drawing fades what did not change too.
  const changed = marks.nodes.size + marks.links.size > 0;
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
  const columnWarnings = warningsByTable(warnings).columns;
  const ranking = renderedViews(diagram).includes(RANKING_VIEW) ? rankingSvg(rankingTables(diagram, referenceCounts(model))) : null;
  const { x, y, w, h } = visible === RANKING_VIEW ? ranking.bounds : scenes.find((s) => s.scene.name === visible).scene.bounds;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg"${diff ? ` class="diff-mode${changed ? ' changes-mode' : ''}"` : ''} width="${w}" height="${h}" viewBox="${x} ${y} ${w} ${h}">`,
    `<style>${STYLE}</style>`,
    ...scenes.map((s) => viewSvg(s.scene, colorOf, s.scene.name === visible, marks, s.banner, columnWarnings)),
    ranking ? viewGroup(RANKING_VIEW, ranking.bounds, visible === RANKING_VIEW, [ranking.svg]) : '',
    `<script type="application/json" id="open-erd-data">${scriptJson(viewerData(model, diagram, diff, warnings, health))}</script>`,
    `<script><![CDATA[\n${VIEWER_SCRIPT}\n]]></script>`,
    '</svg>',
    '',
  ].join('\n');
}
