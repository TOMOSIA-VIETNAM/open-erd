// Viewer embedded in erd.svg. It runs when the SVG is opened directly in a
// browser; it turns the static drawing (the opening view visible, other
// views hidden) into an explorable diagram. Everything it adds is created
// here at runtime, so a viewer without script still shows the plain
// opening view.
import { dbDisplayName } from '../../../display-name.js';
import { REVIEW_WORDS, endMarkers, enumIconSvg, indexIconSvg, isConfirmed, keyIconSvg, linkIconSvg, markerSvg, overviewStrokeWidth, reviewIconSvg, starIconSvg } from '../markers.js';
import { CANVAS_LIMITS, PIXEL_RATIO, canvasScale, exportBaseName } from './download.js';
import { findJoinPaths, hopCondition, pathNames, pathThrough, sqlSkeleton } from './join-path.js';
import { formatHash, parseHash } from './deep-link.js';
import { collectionDocument, createTableSql, isDocumentStore, markdownTable } from './schema-copy.js';
import { centreOn, fitsInside, frameFocus, minimapSize, visibleRect } from './minimap.js';
import { columnBadges, panelTabs } from './panel-parts.js';
import { emptyHistory, goBack, goForward, tableTrail, visit } from './history.js';
import { endTransforms, radialLayout, straightLink } from './radial.js';
import { TOUR_STEP_MS, tourIndex, tourSteps } from './tour.js';
import { piiSummary } from './pii.js';
import { nextTip, tipList } from './tips.js';
import { changesSummary } from './changes.js';
import { commandsFirst, matchCommands, parseJoinQuery } from './palette.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const HTML_NS = 'http://www.w3.org/1999/xhtml';
const OVERVIEW = 'overview';
const ALL_VIEW = 'all';
const RANKING = 'ranking';
const DOMAIN_PREFIX = 'domain:';
const NEIGHBORHOOD = 'neighborhood';
// View the viewer builds for a join path no drawn view holds.
const JOIN_VIEW = 'join-path';
const TOOLBAR_HEIGHT = 44;
// Wide enough for a table's column grid.
const PANEL_WIDTH = 440;
const PANEL_MARGIN = 12;
const FIT_PADDING = 24;
// Small views are not blown up beyond this when fitted.
const MAX_FIT_SCALE = 1.5;
const MIN_SCALE = 0.03;
const MAX_SCALE = 4;
// A press that moves less than this is a click, more is a pan.
const DRAG_THRESHOLD = 4;
// Wheel zoom: scale changes by exp(-deltaY * ZOOM_PER_PIXEL). A trackpad
// pinch sends many small deltas (about 5 px each), so ten of them double the
// scale; a mouse wheel notch sends 100 px or more, so one event is capped at
// ZOOM_MAX_PIXELS (about 1.6x) to keep a notch from jumping.
const ZOOM_PER_PIXEL = 0.015;
const ZOOM_MAX_PIXELS = 30;
// Pixels per wheel line (deltaMode 1); a page (deltaMode 2) is the viewport height.
const LINE_PIXELS = 16;
const FOCUS_MARGIN = 160;
const FOCUS_MAX_SCALE = 1.2;
// Gap kept above and below a table a large view opens on.
const FOCUS_PAD = 8;
const RING_GAP = 40;
const NEIGHBORHOOD_MARGIN = 60;
const SEARCH_LIMIT = 40;
const TIP_OFFSET = 14;
// Smallest text in table boxes and ranking rows, and the size it should
// have on screen at least when a large view opens zoomed in.
const SMALLEST_TEXT = 12;
const READABLE_TEXT = 11;
// Hovering off a card waits this long before its connectors go, so the
// pointer can travel to a connector across the gap.
const UNFOCUS_DELAY = 250;
// Height the Back pill takes under the toolbar, left free when fitting a view.
const BACK_PILL_ROOM = 36;
// Column tooltips list this many enum values; a click on the column shows all.
const TIP_ENUM_ROWS = 8;
// A collapsed domain frame keeps only its header bar.
const COLLAPSED_HEIGHT = 48;
// The two sizes of neighborhood, worded for readers who do not think in
// graph hops. Toolbar and panel use the same words.
const RELATED = {
  label: 'Related:',
  title: 'Shows this table with the tables it is related to, in a ring around it.',
  options: [
    { hops: 1, text: 'Direct', title: 'Tables linked to this one by a relation.' },
    { hops: 2, text: '+1 level', title: 'Tables linked to this one, and the tables linked to those (direct + next level).' },
  ],
};

const svg = document.documentElement;
// Shortcuts use Cmd on a Mac, Ctrl elsewhere.
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl+';
const data = JSON.parse(document.getElementById('open-erd-data').textContent);

// ---------------------------------------------------------------- helpers

function el(tag, attrs = {}, children = [], ns = HTML_NS) {
  const e = document.createElementNS(ns, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') e.textContent = v;
    else if (k === 'on') for (const [type, fn] of Object.entries(v)) e.addEventListener(type, fn);
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c) e.append(c);
  return e;
}
const svgEl = (tag, attrs = {}, children = []) => el(tag, attrs, children, SVG_NS);
// Name shown for a node: the table name, or «name» for a polymorphic node.
const short = (id) => (data.nodes[id]?.kind === 'poly' ? `«${data.nodes[id].name}»` : id.split('.').length === 3 ? id.split('.')[2] : id);
const clusterOf = (id) => data.nodes[id]?.cluster;
const domainView = (cluster) => DOMAIN_PREFIX + cluster;
const nodeIdOf = (g) => g.getAttribute('data-id') ?? g.getAttribute('data-domain');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
// "shop (PostgreSQL) → events (MongoDB)" for the databases of two
// names; `⇄` for a pair of domains, which stands for both directions.
const dbOf = (name) => name.split(/[./]/)[0];
const crossing = (from, to, arrow = '→') => `${dbDisplayName(dbOf(from))} (${data.databases[dbOf(from)].label}) ${arrow} ${dbDisplayName(dbOf(to))} (${data.databases[dbOf(to)].label})`;
const domainName = (cluster) => cluster.split('/').slice(1).join('/');
// Key of the relations between two domains in data.domainLinks (code-unit
// order, as the engine writes it).
const pairId = (a, b) => (a <= b ? `${a}<->${b}` : `${b}<->${a}`);
// Table nodes per domain, for the counts in the breadcrumb.
const tableCount = (cluster) => Object.values(data.nodes).filter((n) => n.kind === 'table' && (cluster === null || n.cluster === cluster)).length;

// A table's box and a database's frame are named: tables draw tenant copies
// before their box, databases draw pills after their frame. Other nodes have
// one direct rect.
function boxOf(g) {
  const r = g.querySelector(':scope > .table-box, :scope > .db-frame') ?? g.querySelector(':scope > rect');
  return { x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height') };
}

const NODE_SELECTOR = '.table, .stub, .poly, .domain';

// Each view's nodes by id, with their box in view coordinates.
function indexView(view, offsets = new Map()) {
  const index = new Map();
  for (const g of view.querySelectorAll(NODE_SELECTOR)) {
    const id = nodeIdOf(g);
    const b = boxOf(g);
    const o = offsets.get(id) ?? { dx: 0, dy: 0 };
    index.set(id, { el: g, box: { x: b.x + o.dx, y: b.y + o.dy, w: b.w, h: b.h } });
  }
  return index;
}

// ---------------------------------------------------------------- setup

const views = new Map();
const indexes = new Map();
for (const v of svg.querySelectorAll('g.view')) {
  views.set(v.getAttribute('data-view'), v);
  indexes.set(v.getAttribute('data-view'), indexView(v));
}
// Every table and polymorphic node as a full box, for the neighborhood view:
// taken from the view of all tables, or, in a large schema drawn without
// that view, from each node's own domain view (stubs are only names).
const fullBoxes =
  indexes.get(ALL_VIEW) ??
  new Map(
    [...indexes]
      .filter(([name]) => name.startsWith(DOMAIN_PREFIX))
      .flatMap(([, index]) => [...index].filter(([, entry]) => !entry.el.classList.contains('stub'))),
  );
// The viewer draws its own tooltips; native ones would show on top of them.
for (const t of svg.querySelectorAll('.nodes title, .relations title, .rk-item title')) t.remove();

// Lines are 1.4 px wide; a wide transparent twin makes them clickable.
function addHitPaths(root) {
  for (const p of root.querySelectorAll('.relation-group > path.relation, .hub-route > path.relation')) {
    p.before(svgEl('path', { class: 'relation-hit', d: p.getAttribute('d') }));
  }
}
addHitPaths(svg);

// Personal data (see the PII mode section): the tables, ranking rows,
// columns and domain cards holding columns marked `pii` get classes the
// mode's styles pick out. Marked once here, before the neighborhood and
// join views copy boxes, so their copies carry the marks too. A sharing
// profile that drops pii columns leaves nothing to mark.
const PII = piiSummary(data.nodes);
{
  const columns = new Map(PII.domains.flatMap((d) => d.tables.map((t) => [t.id, new Set(t.columns)])));
  const domains = new Set(PII.domains.map((d) => d.cluster));
  for (const g of svg.querySelectorAll('.table[data-id], .stub[data-id], .rk-item[data-id]')) {
    const mine = columns.get(g.getAttribute('data-id'));
    if (!mine) continue;
    g.classList.add('has-pii');
    for (const c of g.querySelectorAll('.column')) if (mine.has(c.getAttribute('data-column'))) c.classList.add('pii');
  }
  for (const g of svg.querySelectorAll('.domain[data-domain]')) if (domains.has(g.getAttribute('data-domain'))) g.classList.add('has-pii');
}

// What a diff drawing changed (see the Changes mode section); null in a
// plain drawing or a diff that marks nothing.
const CHANGES = data.changes ? changesSummary(data.changes, data.nodes) : null;

// Schema health (see the health mode section): each table with a finding
// gets a small amber triangle on its top right corner and its columns in a
// finding a class, both shown only while the mode is on. Marked here for
// the same reason as personal data. A render without findings has none.
const HEALTH = data.health ?? [];
{
  const byTable = new Map();
  for (const f of HEALTH) {
    if (!byTable.has(f.table)) byTable.set(f.table, { columns: new Set() });
    for (const c of f.columns ?? []) byTable.get(f.table).columns.add(c);
  }
  for (const g of svg.querySelectorAll('.table[data-id], .stub[data-id]')) {
    const mine = byTable.get(g.getAttribute('data-id'));
    if (!mine) continue;
    g.classList.add('has-health');
    for (const c of g.querySelectorAll('.column')) if (mine.columns.has(c.getAttribute('data-column'))) c.classList.add('health');
    const { x, y, w } = boxOf(g);
    const cx = x + w - 2;
    g.append(svgEl('path', { class: 'col-warn health-mark', d: `M${cx - 7} ${y + 5}L${cx} ${y - 8}L${cx + 7} ${y + 5}Z` }));
  }
}

const camera = svgEl('g', { class: 'camera' });
views.values().next().value.before(camera);
for (const v of views.values()) camera.append(v);
svg.removeAttribute('viewBox');
svg.setAttribute('width', '100%');
svg.setAttribute('height', '100%');
svg.style.background = '#eef1f5';

function overlay(cls) {
  const div = el('div', { class: `oe-ui ${cls}` });
  const fo = svgEl('foreignObject', { x: 0, y: 0, width: 1, height: 1 }, [div]);
  svg.append(fo);
  return { fo, div };
}

const state = { view: OVERVIEW, hops: 1, center: null, joinPath: null, cam: { x: 0, y: 0, s: 1 } };
// Steps behind and ahead (see history.js): Back and Forward walk views and,
// inside them, the tables the reader jumped between.
let nav = emptyHistory();

// ---------------------------------------------------------------- camera

const viewport = () => ({ w: window.innerWidth, h: window.innerHeight });

let cameraFrame = 0;
// Whether the reader moved the camera (a pan or a zoom) since the viewer
// last framed the view itself: only then does the link say where it is.
let cameraMoved = false;
let cameraLinkTimer = 0;
// How long the camera rests before the address says where it is.
const CAMERA_LINK_MS = 400;
function applyCamera(byReader = false) {
  if (cameraFrame) cancelAnimationFrame(cameraFrame);
  cameraFrame = 0;
  const { x, y, s } = state.cam;
  camera.setAttribute('transform', `translate(${x} ${y}) scale(${s})`);
  placeBackPill();
  updateMinimap();
  if (!byReader && !cameraMoved) return;
  cameraMoved = byReader;
  clearTimeout(cameraLinkTimer);
  cameraLinkTimer = setTimeout(syncHash, CAMERA_LINK_MS);
}

// Pan and zoom gestures fire many events per frame: write the transform once
// per frame, with the latest camera.
function scheduleCamera() {
  if (!cameraFrame) cameraFrame = requestAnimationFrame(() => applyCamera(true));
}
// The camera as the link writes it: the drawing point at the middle of the
// screen below the toolbar, and the scale, so it opens alike on any screen.
function cameraCentre() {
  const { w, h } = viewport();
  const { x, y, s } = state.cam;
  return [Math.round((w / 2 - x) / s), Math.round(((h + TOOLBAR_HEIGHT) / 2 - y) / s), Number(s.toPrecision(4))];
}
function centreCamera([cx, cy, s]) {
  const { w, h } = viewport();
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
  state.cam = { s: scale, x: w / 2 - cx * scale, y: (h + TOOLBAR_HEIGHT) / 2 - cy * scale };
  applyCamera(true);
}

// The panel covers the right edge of the screen; fitting leaves that strip free.
function zoomToRect(r, maxScale) {
  const { w, h } = viewport();
  const panelOpen = panel.fo.style.display !== 'none';
  // The Back pill floats under the toolbar in a navigated view: keep clear of it.
  const top = TOOLBAR_HEIGHT + (backPillShown() ? BACK_PILL_ROOM : 0);
  // The tour's caption takes a strip at the bottom.
  const area = { w: panelOpen ? w - PANEL_WIDTH - 2 * PANEL_MARGIN : w, h: h - top - tourRoom() };
  const s = Math.min((area.w - 2 * FIT_PADDING) / r.w, (area.h - 2 * FIT_PADDING) / r.h, maxScale);
  state.cam = { s, x: (area.w - r.w * s) / 2 - r.x * s, y: top + (area.h - r.h * s) / 2 - r.y * s };
  applyCamera();
}

function viewBounds(name) {
  const [x, y, w, h] = views.get(name).getAttribute('data-bounds').split(' ').map(Number);
  return { x, y, w, h };
}

function zoomAt(clientX, clientY, factor) {
  const { x, y, s } = state.cam;
  const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s * factor));
  const wx = (clientX - x) / s;
  const wy = (clientY - y) / s;
  state.cam = { s: next, x: clientX - wx * next, y: clientY - wy * next };
  scheduleCamera();
}

function panBy(dx, dy) {
  state.cam = { ...state.cam, x: state.cam.x + dx, y: state.cam.y + dy };
  scheduleCamera();
}

// ---------------------------------------------------------------- views

const currentView = () => views.get(state.view);
const currentIndex = () => indexes.get(state.view);

function showView(name) {
  clearSelection();
  // The tooltip described whatever was under the pointer in the old view.
  hideTip();
  focusDomain(null);
  for (const [n, v] of views) v.style.display = n === name ? '' : 'none';
  const moved = state.view !== name;
  state.view = name;
  // A neighborhood or join view of the same name may hold other tables now.
  map.view = null;
  if (name === RANKING) readableStart(viewBounds(name), null, 1);
  else zoomToRect(viewBounds(name), MAX_FIT_SCALE);
  renderToolbar();
  // The legend keeps the reader's choice (open or folded to its pill),
  // except in the views where it would cover the drawing; its content
  // follows the view.
  legendFolded = LEGEND_FOLDED_VIEWS.includes(name);
  showLegend();
  if (moved) setTimeout(showHint, TIP_OPEN_MS);
  syncHash();
}

// A large view opens where its text can be read: the whole view when it
// fits at a readable size, else on `focus` (a box) at scale 1, shrunk while
// readable to keep all of it on screen (a long central table above the
// tour's caption), or from the top left corner when there is no focus.
function readableStart(bounds, focus, maxScale = MAX_FIT_SCALE) {
  const { w } = viewport();
  const h = viewport().h - tourRoom();
  const fit = Math.min((w - 2 * FIT_PADDING) / bounds.w, (h - TOOLBAR_HEIGHT - 2 * FIT_PADDING) / bounds.h, maxScale);
  if (fit * SMALLEST_TEXT >= READABLE_TEXT) return zoomToRect(bounds, maxScale);
  state.cam = focus
    ? frameFocus(focus, { w, h }, TOOLBAR_HEIGHT, READABLE_TEXT / SMALLEST_TEXT, FOCUS_PAD)
    : // Centred when it is narrower than the screen, from its top.
      { s: 1, x: Math.max(FIT_PADDING, (w - bounds.w) / 2) - bounds.x, y: TOOLBAR_HEIGHT + FIT_PADDING - bounds.y };
  applyCamera();
}

// What is on screen, as a step Back or Forward can return to: the view,
// the selected table, its panel's tab and scroll position.
function snapshot() {
  const tab = panel.div.querySelector('.oe-tab.on')?.getAttribute('data-tab') ?? null;
  return { view: state.view, center: state.center, hops: state.hops, joinPath: state.joinPath, table: selectedTable(), tab, scroll: panel.div.scrollTop };
}
function recordVisit() {
  nav = visit(nav, snapshot());
  updateBackPill();
}

/** Switches view and/or focuses `focus`, remembering where we came from. */
function navigate(name, { focus, column } = {}) {
  // Going somewhere ends the tour where the reader went.
  endTour(false);
  if (name !== state.view || (focus && focus !== selectedTable())) recordVisit();
  if (name !== state.view) showView(name);
  if (focus) {
    focusNode(focus, column);
    arrive(focus);
  }
}

// Back to a step: its view (rebuilt when the viewer builds it), then its
// table with the same panel tab and scroll.
function restore(step) {
  if (step.view === NEIGHBORHOOD) buildNeighborhood(step.center, step.hops);
  if (step.view === JOIN_VIEW) buildJoinView(step.joinPath);
  if (step.view !== state.view || step.view === NEIGHBORHOOD || step.view === JOIN_VIEW) showView(step.view);
  if (step.table && currentIndex().has(step.table)) {
    focusNode(step.table);
    if (step.tab) panel.div.querySelector(`.oe-tab[data-tab="${step.tab}"]`)?.click();
    panel.div.scrollTop = step.scroll ?? 0;
    arrive(step.table);
  } else clearSelection();
  renderToolbar();
}
function back() {
  endTour(false);
  const { history, target } = goBack(nav, snapshot());
  if (!target) return;
  nav = history;
  restore(target);
}
function forward() {
  endTour(false);
  const { history, target } = goForward(nav, snapshot());
  if (!target) return;
  nav = history;
  restore(target);
}

// A table reached by a jump pulses briefly, so the eye finds it.
const ARRIVE_MS = 1600;
function arrive(id) {
  pulse(currentIndex().get(id)?.el);
}
// The orange pulse on the border of `g` (a table box or a domain frame).
function pulse(g) {
  if (!g) return;
  g.classList.remove('arrive');
  // Restart the animation when the same table is reached twice.
  void g.getBoundingClientRect();
  g.classList.add('arrive');
  setTimeout(() => g.classList.remove('arrive'), ARRIVE_MS);
}

/** Domain view holding table `id` (its own domain), or null for unknown ids. */
function homeView(id) {
  const cluster = clusterOf(id);
  return cluster ? domainView(cluster) : null;
}

/** Selects `id` in the current view if drawn there as a full box, else jumps to its domain view. */
function goToNode(id, column) {
  // Overview nodes are domains (cluster keys), not tables.
  if (!data.nodes[id] && indexes.get(OVERVIEW).has(id)) navigate(domainView(id));
  // A stub only names the table; its columns are in its own domain view.
  else if (currentIndex().has(id) && state.view !== OVERVIEW && !currentIndex().get(id).el.classList.contains('stub')) {
    if (id !== selectedTable()) recordVisit();
    focusNode(id, column);
    arrive(id);
  }
  else if (homeView(id)) navigate(homeView(id), { focus: id, column });
}

// ---------------------------------------------------------------- collapsing domains

// A domain frame in the view of all tables or a domain view folds into its
// header bar: its tables and every line touching them are hidden, the header
// says how many tables and lines it holds. Nothing else moves: the layout is
// fixed and identical on every render, and a reflow here would show the
// reader positions no file has, so the folded frame leaves an empty band
// instead. State lives in memory only, per view.
const collapsed = new Map();
const collapsedIn = (name) => collapsed.get(name) ?? new Set();
const clusterGroups = (view) => [...view.querySelectorAll('.cluster')];
const keyOf = (c) => c.getAttribute('data-cluster');

function applyCollapse(name) {
  const view = views.get(name);
  const shut = collapsedIn(name);
  const hidden = new Set();
  for (const c of clusterGroups(view)) {
    const key = keyOf(c);
    const fold = shut.has(key);
    const frame = c.querySelector(':scope > rect');
    const label = c.querySelector('.cluster-label');
    if (!frame.hasAttribute('data-height')) {
      frame.setAttribute('data-height', frame.getAttribute('height'));
      label.setAttribute('data-text', label.textContent);
    }
    frame.setAttribute('height', fold ? COLLAPSED_HEIGHT : frame.getAttribute('data-height'));
    label.textContent = fold ? `${label.getAttribute('data-text')} · ${plural(tableCount(key), 'table')} (collapsed)` : label.getAttribute('data-text');
    c.classList.toggle('folded', fold);
    c.querySelector('.fold-badge')?.remove();
    for (const g of view.querySelectorAll('.nodes .table, .nodes .poly')) {
      if (clusterOf(nodeIdOf(g)) !== key) continue;
      g.classList.toggle('oe-hidden', fold);
      if (fold) hidden.add(nodeIdOf(g));
    }
  }
  const linesHidden = new Map();
  for (const g of view.querySelectorAll('.relation-group')) {
    const gone = [g.getAttribute('data-from'), g.getAttribute('data-to')].filter((id) => hidden.has(id));
    g.classList.toggle('oe-hidden', gone.length > 0);
    for (const key of new Set(gone.map(clusterOf))) linesHidden.set(key, (linesHidden.get(key) ?? 0) + 1);
  }
  setToggles(view);
  // Folded boxes leave the minimap.
  if (name === state.view) map.view = null;
  for (const c of clusterGroups(view)) {
    const n = linesHidden.get(keyOf(c));
    if (!n) continue;
    const label = c.querySelector('.cluster-label');
    const x = +label.getAttribute('x') + label.getComputedTextLength() + 10;
    const y = +label.getAttribute('y');
    const text = svgEl('text', { class: 'fold-badge-text', x: x + 8, y, 'dominant-baseline': 'central', text: `${plural(n, 'link')} hidden` });
    const badge = svgEl('g', { class: 'fold-badge' }, [svgEl('rect', { x, y: y - 9, width: 1, height: 18, rx: 9 }), text]);
    c.append(badge);
    badge.firstChild.setAttribute('width', text.getComputedTextLength() + 16);
  }
}

function setCollapsed(name, keys, fold) {
  clearSelection();
  const shut = new Set(collapsedIn(name));
  for (const k of keys) {
    if (fold) shut.add(k);
    else shut.delete(k);
  }
  collapsed.set(name, shut);
  applyCollapse(name);
  syncHash();
}

/** Opens the folded domain holding `id` in the current view, if any. */
function unfoldFor(id) {
  if (collapsedIn(state.view).has(clusterOf(id))) setCollapsed(state.view, [clusterOf(id)], false);
}

// Each foldable frame gets a +/− toggle before its title and a header band
// that shows it can be clicked (added here: without script nothing folds).
// The title moves right to make room; the space the router keeps around a
// title is wider than that.
const DB_HEADER_HEIGHT = 60;
const TOGGLE_SIZE = 9;
const TOGGLE_ROOM = TOGGLE_SIZE + 6;
function addFoldToggles(view) {
  const add = (g, frame, left, cy, band) => {
    const half = TOGGLE_SIZE / 2;
    const cx = left + half;
    const icon = svgEl('g', { class: 'fold-toggle' }, [
      svgEl('rect', { x: cx - half, y: cy - half, width: TOGGLE_SIZE, height: TOGGLE_SIZE, rx: 2 }),
      svgEl('path', { class: 'fold-sign', d: '' }),
    ]);
    icon.setAttribute('data-cx', cx);
    icon.setAttribute('data-cy', cy);
    const hit = svgEl('rect', { class: 'fold-hit', x: frame.x, y: frame.y, width: frame.w, height: band }, [svgEl('title', { text: 'Collapse group' })]);
    g.append(icon, hit);
  };
  for (const c of clusterGroups(view)) {
    const label = c.querySelector('.cluster-label');
    const x = +label.getAttribute('x');
    label.setAttribute('data-x', x);
    label.setAttribute('x', x + TOGGLE_ROOM);
    add(c, boxOf(c), x, +label.getAttribute('y'), COLLAPSED_HEIGHT);
  }
  for (const db of view.querySelectorAll('.database')) {
    // The header (cylinder, name, pills) is read from its markup, since a
    // hidden view has no layout boxes to measure, then moved right.
    const x = +/^M\s*(-?[\d.]+)/.exec(db.querySelector('.db-icon').getAttribute('d'))[1];
    for (const e of db.children) if (!e.matches('.db-frame, title')) e.setAttribute('transform', `translate(${TOGGLE_ROOM} 0)`);
    add(db, boxOf(db), x, +db.querySelector('.db-name').getAttribute('y'), DB_HEADER_HEIGHT);
  }
  setToggles(view);
}

// "−" while a group is open, "+" once folded (a database: once all its
// domains are).
function setToggles(view) {
  const shut = collapsedIn(view.getAttribute('data-view'));
  const set = (g, folded) => {
    const icon = g.querySelector(':scope > .fold-toggle');
    if (!icon) return;
    const [cx, cy] = [+icon.getAttribute('data-cx'), +icon.getAttribute('data-cy')];
    const arm = TOGGLE_SIZE / 2 - 2;
    icon.querySelector('.fold-sign').setAttribute('d', `M${cx - arm} ${cy}H${cx + arm}${folded ? `M${cx} ${cy - arm}V${cy + arm}` : ''}`);
    g.querySelector(':scope > .fold-hit title').textContent = folded ? 'Expand group' : 'Collapse group';
  };
  for (const c of clusterGroups(view)) set(c, shut.has(keyOf(c)));
  for (const db of view.querySelectorAll('.database')) {
    const keys = clusterGroups(view).map(keyOf).filter((k) => k.split('/')[0] === db.getAttribute('data-database'));
    set(db, keys.length > 0 && keys.every((k) => shut.has(k)));
  }
}

for (const [name, view] of views) if (name !== OVERVIEW) addFoldToggles(view);

// A click on the header band of a domain frame, or on a database frame's
// header (which folds or unfolds all its domains); null when elsewhere.
function headerClick(e) {
  const within = (rect, band) => {
    const r = rect.getBoundingClientRect();
    return e.clientY - r.top <= band * (r.height / +rect.getAttribute('height'));
  };
  const cluster = e.target.closest('.cluster');
  if (cluster && within(cluster.querySelector(':scope > rect'), COLLAPSED_HEIGHT)) return () => setCollapsed(state.view, [keyOf(cluster)], !collapsedIn(state.view).has(keyOf(cluster)));
  const db = e.target.closest('.database');
  if (db && state.view !== OVERVIEW && within(db.querySelector('.db-frame'), DB_HEADER_HEIGHT)) {
    const keys = clusterGroups(currentView()).map(keyOf).filter((k) => k.split('/')[0] === db.getAttribute('data-database'));
    if (keys.length === 0) return null;
    return () => setCollapsed(state.view, keys, keys.some((k) => !collapsedIn(state.view).has(k)));
  }
  return null;
}

// ---------------------------------------------------------------- selection

function clearSelection() {
  picked = [];
  linkColumn = null;
  stopFlows();
  for (const v of views.values()) {
    v.classList.remove('dimmed', 'center-selected');
    for (const e of v.querySelectorAll('.hl, .selected, .flow-target, .reached, .flowing, .hl-column')) {
      e.classList.remove('hl', 'selected', 'flow-target', 'reached', 'flowing', 'hl-column');
    }
    for (const e of v.querySelectorAll('.flow')) e.remove();
    for (const e of v.querySelectorAll('.poly-routes, .hub-routes')) e.style.display = 'none';
  }
  hidePanel();
  syncHash();
}

function relationGroups() {
  return [...currentView().querySelectorAll('.relation-group')];
}

/** Highlights node `id`, its lines and the nodes at their other end. */
function selectNode(id) {
  clearSelection();
  const index = currentIndex();
  const entry = index.get(id);
  if (!entry) return;
  const lit = new Set([id]);
  for (const g of relationGroups()) {
    const [from, to] = [g.getAttribute('data-from'), g.getAttribute('data-to')];
    if (from !== id && to !== id) continue;
    g.classList.add('hl');
    lit.add(from).add(to);
  }
  const poly = data.nodes[id]?.kind === 'poly' ? data.nodes[id] : null;
  if (poly) {
    for (const routes of currentView().querySelectorAll('.poly-routes')) {
      if (routes.getAttribute('data-poly') !== id) continue;
      routes.style.display = '';
      for (const p of routes.querySelectorAll('.poly-route')) lit.add(p.getAttribute('data-target'));
    }
  }
  // A hub table brings up the lines of the relations pointing at it, which
  // every other selection leaves as badges.
  for (const routes of currentView().querySelectorAll('.hub-routes')) {
    if (routes.getAttribute('data-hub') !== id) continue;
    routes.style.display = '';
    for (const r of routes.querySelectorAll('.hub-route')) lit.add(r.getAttribute('data-from'));
  }
  for (const n of lit) index.get(n)?.el.classList.add('hl');
  entry.el.classList.add('selected');
  currentView().classList.add('dimmed');
  // In a neighborhood, selecting its centre keeps the second ring readable:
  // it is what the reader asked to see.
  currentView().classList.toggle('center-selected', state.view === NEIGHBORHOOD && id === state.center);
  showPanel(poly ? polyPanel(id, poly) : nodePanel(id));
  syncHash();
}

function focusNode(id, column) {
  const entry = currentIndex().get(id);
  if (!entry) return;
  unfoldFor(id);
  selectNode(id);
  if (column) {
    for (const c of entry.el.querySelectorAll('.column')) if (c.getAttribute('data-column') === column) c.classList.add('hl-column');
    linkColumn = column;
  }
  const b = entry.box;
  zoomToRect({ x: b.x - FOCUS_MARGIN, y: b.y - FOCUS_MARGIN, w: b.w + 2 * FOCUS_MARGIN, h: b.h + 2 * FOCUS_MARGIN }, FOCUS_MAX_SCALE);
}

/** Runs dashes along line `g` from its source to its target, which lights up. */
function flowRelation(g) {
  clearSelection();
  // A hub line belongs to its hub table's set of lines, hidden otherwise.
  if (g.classList.contains('hub-route')) g.parentNode.style.display = '';
  const index = currentIndex();
  const [from, to] = [g.getAttribute('data-from'), g.getAttribute('data-to')];
  g.classList.add('hl', 'flowing');
  index.get(from)?.el.classList.add('hl');
  index.get(to)?.el.classList.add('hl', 'flow-target');
  // Route points start at the `from` end, so a falling dash offset moves the
  // dashes towards the target.
  g.append(svgEl('path', { class: 'flow', d: g.querySelector('path.relation').getAttribute('d') }));
  currentView().classList.add('dimmed');
  showPanel(relationPanel(g));
  syncHash();
}

// ---------------------------------------------------------------- neighborhood

function adjacency() {
  const adj = new Map();
  const link = (a, b) => {
    if (a === b) return;
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a).add(b);
  };
  for (const l of data.links) {
    link(l.from, l.to);
    link(l.to, l.from);
  }
  return adj;
}
const ADJACENCY = adjacency();
const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Neighbours of a centre that its drawn lines do not give: the tables whose
 * hub relations point at it (badges everywhere else), and for a polymorphic
 * node every target. Only the centre gets them, so a hub or a polymorphic
 * node met further out does not flood the rings.
 */
function centreExtras(center) {
  const n = data.nodes[center];
  if (n?.kind === 'poly') return n.targets;
  return data.hubLinks.filter((l) => l.to === center && l.from !== center).map((l) => l.from);
}

/**
 * Rings of nodes 1..hops away from `center` over drawn relations. Ring 1 is
 * in id order; each further node follows the earliest node of the previous
 * ring it hangs off, so a branch stays together around the circle.
 */
function rings(center, hops) {
  const seen = new Set([center]);
  const result = [];
  let previous = [center];
  for (let hop = 1; hop <= hops; hop++) {
    const parent = new Map();
    previous.forEach((p, i) => {
      const next = new Set([...(ADJACENCY.get(p) ?? []), ...(hop === 1 ? centreExtras(center) : [])]);
      for (const n of [...next].sort(byId)) {
        if (!seen.has(n) && !parent.has(n)) parent.set(n, i);
      }
    });
    const ring = [...parent.keys()].sort((a, b) => parent.get(a) - parent.get(b) || byId(a, b));
    for (const n of ring) seen.add(n);
    result.push(ring);
    previous = ring;
  }
  return result;
}

const linePath = (points) => points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x} ${y}`).join('');

/**
 * A straight line between the boxes of `from` and `to` (in `boxes`), with
 * the crow's feet of its cardinality as in the drawn views (a view's line to
 * its source has none), for the views the viewer builds itself.
 */
function straightRelation(l, from, to, boxes, extraClass = '') {
  const points = straightLink(boxes.get(from), boxes.get(to));
  const d = linePath(points);
  const children = [svgEl('path', { class: 'relation-hit', d }), svgEl('path', { class: 'relation', d })];
  if (l.cardinality) {
    const kinds = endMarkers(l);
    const [at, back] = endTransforms(points);
    children.push(svgEl('g', { class: 'marker', 'data-ends': `${kinds.from} ${kinds.to}` }, [markerGroup(kinds.from, at), markerGroup(kinds.to, back)]));
  }
  // Solid when confirmed, dashed when not, as in the drawn views.
  const style = l.kind !== 'view_source' && !isConfirmed(l.kind, l.review) ? ' unconfirmed' : '';
  // In a diff drawing, the line's change colour, as the drawn views have it.
  const status = data.changes?.lineStatus[l.id];
  return svgEl('g', { class: `relation-group kind-${l.kind} review-${l.review}${style}${status ? ` diff-${status}` : ''}${extraClass}`, 'data-id': l.id, 'data-from': from, 'data-to': to }, children);
}

/**
 * (Re)builds the neighborhood view around `center` from copies of the boxes
 * drawn in the full view, placed by radialLayout with straight lines. The
 * tables (and their lines) two relations away get the class `ring-2`.
 */
function buildNeighborhood(center, hops) {
  views.get(NEIGHBORHOOD)?.remove();
  const source = fullBoxes;
  const ringIds = rings(center, hops).map((r) => r.filter((id) => source.has(id)));
  const ids = [center, ...ringIds.flat()];
  const outer = new Set(ringIds[1] ?? []);
  const size = (id) => ({ id, w: source.get(id).box.w, h: source.get(id).box.h });
  const pos = radialLayout(size(center), ringIds.map((r) => r.map(size)), RING_GAP);

  const shown = new Set(ids);
  const offsets = new Map();
  const nodes = svgEl('g', { class: 'nodes' });
  const boxes = new Map();
  for (const id of ids) {
    const { el: g, box } = source.get(id);
    const dx = pos[id].x - box.x;
    const dy = pos[id].y - box.y;
    offsets.set(id, { dx, dy });
    boxes.set(id, { x: pos[id].x, y: pos[id].y, w: box.w, h: box.h });
    const copy = g.cloneNode(true);
    copy.classList.remove('hl', 'selected', 'flow-target', 'reached', 'oe-hidden', 'arrive');
    if (outer.has(id)) copy.classList.add('ring-2');
    nodes.append(svgEl('g', { transform: `translate(${dx} ${dy})` }, [copy]));
  }
  const relations = svgEl('g', { class: 'relations' });
  const ends = (a, b) => straightLink(boxes.get(a), boxes.get(b));
  const relationLine = (l, from, to) => straightRelation(l, from, to, boxes, outer.has(from) || outer.has(to) ? ' ring-2' : '');
  for (const l of data.links) {
    if (l.from !== l.to && shown.has(l.from) && shown.has(l.to)) relations.append(relationLine(l, l.from, l.to));
  }
  // The centre's own extras: hub relations pointing at it, or a polymorphic
  // centre's line to each target (each row's id points at one target's key).
  const poly = data.nodes[center]?.kind === 'poly' ? data.nodes[center] : null;
  for (const l of data.hubLinks) {
    if (l.to === center && l.from !== center && shown.has(l.from)) relations.append(relationLine(l, l.from, center));
  }
  for (const t of poly ? poly.targets.filter((x) => shown.has(x)) : []) {
    relations.append(relationLine({ id: `${center}->${t}`, cardinality: 'n-1', optional: poly.optional, kind: 'polymorphic', review: poly.review }, center, t));
  }
  for (const id of ids.filter((n) => n !== center && data.nodes[n]?.kind === 'poly')) {
    const targets = data.nodes[id].targets.filter((t) => shown.has(t));
    if (targets.length === 0) continue;
    relations.append(
      svgEl(
        'g',
        { class: 'poly-routes', 'data-poly': id, style: 'display:none' },
        targets.map((t) => svgEl('path', { class: `poly-route${isConfirmed('polymorphic', data.nodes[id].review) ? '' : ' unconfirmed'}`, 'data-target': t, d: linePath(ends(id, t)) })),
      ),
    );
  }
  const all = [...boxes.values()];
  const x0 = Math.min(...all.map((b) => b.x)) - NEIGHBORHOOD_MARGIN;
  const y0 = Math.min(...all.map((b) => b.y)) - NEIGHBORHOOD_MARGIN;
  const x1 = Math.max(...all.map((b) => b.x + b.w)) + NEIGHBORHOOD_MARGIN;
  const y1 = Math.max(...all.map((b) => b.y + b.h)) + NEIGHBORHOOD_MARGIN;
  const view = svgEl(
    'g',
    { class: 'view', 'data-view': NEIGHBORHOOD, 'data-bounds': `${x0} ${y0} ${x1 - x0} ${y1 - y0}`, style: 'display:none' },
    [svgEl('rect', { x: x0, y: y0, width: x1 - x0, height: y1 - y0, fill: '#ffffff' }), relations, nodes],
  );
  camera.append(view);
  views.set(NEIGHBORHOOD, view);
  indexes.set(NEIGHBORHOOD, indexView(view, offsets));
  state.center = center;
  state.hops = hops;
}

// SVG markup shared with the renderer (markers, icons) as nodes of this
// document; a marker is placed by a transform along its line.
const parsed = (markup) => [...new DOMParser().parseFromString(`<svg xmlns="${SVG_NS}">${markup}</svg>`, 'image/svg+xml').documentElement.childNodes].map((n) => document.importNode(n, true));
const markerGroup = (kind, transform) => svgEl('g', { transform }, parsed(markerSvg(kind, 0, 0, 1)));

function openNeighborhood(id, hops = state.hops) {
  if (!fullBoxes.has(id)) return;
  if (state.view !== NEIGHBORHOOD || state.center !== id) recordVisit();
  buildNeighborhood(id, hops);
  showView(NEIGHBORHOOD);
  selectNode(id);
  // Fit again now that the panel is open.
  zoomToRect(viewBounds(NEIGHBORHOOD), MAX_FIT_SCALE);
}

// ---------------------------------------------------------------- toolbar

// Left: Back and the breadcrumb, which gets whatever width is left; with
// several databases its database crumb is a switcher. Right, never
// shrinking: the hop buttons (in a neighborhood), the view tabs, the
// search and command box (⌘K), Highlight ▾ (review mode, personal data,
// schema health) and the ⋯ menu (tour, downloads, copy, folding, minimap,
// shortcuts).
// Icons are inline SVG paths drawn with the text colour; every control has
// a tooltip.
const ICONS = {
  back: 'M10 3L5 8L10 13',
  search: 'M7 2.5A4.5 4.5 0 1 1 7 11.5A4.5 4.5 0 1 1 7 2.5ZM10.3 10.3L14 14',
  join: 'M3 4.5A1.5 1.5 0 1 1 3 4.49ZM13 11.5A1.5 1.5 0 1 1 13 11.49ZM4.5 4.5H9A2.5 2.5 0 0 1 9 9.5H7A2.5 2.5 0 0 0 7 14.5',
  views: 'M2.5 2.5H7V7H2.5ZM9 2.5H13.5V7H9ZM2.5 9H7V13.5H2.5ZM9 9H13.5V13.5H9Z',
  more: 'M3.5 8H3.6M8 8H8.1M12.5 8H12.6',
  download: 'M8 2.5V10.5M4.5 7L8 10.5L11.5 7M3 13.5H13',
  caret: 'M4.5 6.5L8 10L11.5 6.5',
  check: 'M3.5 8.5L6.5 11.5L12.5 4.5',
  copy: 'M5.5 5.5H12.5V13.5H5.5ZM3.5 10.5V2.5H10.5',
  // A marker pen: the highlight modes.
  highlight: 'M9.5 2.5L13.5 6.5L7.5 12.5H3.5V8.5ZM2.5 14.5H13.5',
  // Swatches with their lines: the legend.
  legend: 'M2.5 3H4.5V5H2.5ZM2.5 7H4.5V9H2.5ZM2.5 11H4.5V13H2.5ZM7 4H13.5M7 8H13.5M7 12H13.5',
  // The three ways to see the schema: tables, the domain map, the ranking.
  table: 'M2.5 3.5H13.5V12.5H2.5ZM2.5 6.5H13.5M2.5 9.5H13.5M6.5 6.5V12.5',
  map: 'M2.5 4L6 2.5L10 4L13.5 2.5V12L10 13.5L6 12L2.5 13.5ZM6 2.5V12M10 4V13.5',
  ranking: 'M2.5 3.5H13.5V5.5H2.5ZM2.5 7H10V9H2.5ZM2.5 10.5H6.5V12.5H2.5Z',
  database: 'M3.5 4C3.5 2.6 12.5 2.6 12.5 4V12C12.5 13.4 3.5 13.4 3.5 12ZM3.5 4C3.5 5.4 12.5 5.4 12.5 4M3.5 8C3.5 9.4 12.5 9.4 12.5 8',
  // Tour controls.
  play: 'M5 3.5L12 8L5 12.5Z',
  pause: 'M5.5 3.5V12.5M10.5 3.5V12.5',
  next: 'M6 3L11 8L6 13',
  close: 'M4 4L12 12M12 4L4 12',
};
const iconSvg = (name, size = 16) =>
  svgEl('svg', { class: `oe-icon icon-${name}`, width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': 'true' }, [svgEl('path', { d: ICONS[name] })]);
// A toolbar button: icon, optional label, tooltip.
const toolButton = (iconName, label, title, onClick, extra = '') =>
  el('button', { class: `oe-btn oe-tool${label ? '' : ' icon-only'}${extra}`, title, 'aria-label': title, on: { click: onClick } }, [iconSvg(iconName), label ? el('span', { class: 'label', text: label }) : null]);

const toolbar = overlay('oe-toolbar');
const crumbs = el('div', { class: 'oe-crumbs' });
const backButton = toolButton('back', '', 'Back to the previous view', back);
function relatedButtons(open) {
  return RELATED.options.map((o) => el('button', { class: 'oe-btn', text: o.text, title: o.title, on: { click: () => open(o.hops) } }));
}
const hopButtons = relatedButtons((hops) => openNeighborhood(state.center, hops));
const hopGroup = el('div', { class: 'oe-related', title: RELATED.title }, [el('span', { text: RELATED.label }), el('div', { class: 'oe-seg' }, hopButtons)]);
// The three ways to look at the whole schema, always on the toolbar: every
// table, the domain cards (Map) and the tables ranked by references (Ranking). A
// schema too large for the view of all tables has no first one, and `views`
// in open-erd.yaml can switch the first and the last off.
// Narrow windows show the icons only (their tooltips name them).
const VIEW_TABS = [
  [ALL_VIEW, 'table', 'All tables', `Every table of every domain (${MOD_KEY}A)`, `${MOD_KEY}A`],
  [OVERVIEW, 'map', 'Map', 'Domains as cards: what each holds and what it is related to', null],
  [RANKING, 'ranking', 'Ranking', 'Tables ranked by how many relations point at them', null],
].filter(([name]) => views.has(name));
const viewTabs = VIEW_TABS.map(([name, icon, text, title]) =>
  el('button', { class: 'oe-btn oe-tab-view', title: `${text}: ${title}`, 'aria-label': text, 'data-view': name, on: { click: () => navigate(name) } }, [iconSvg(icon, 14), el('span', { class: 'label', text })]),
);
const viewGroup = el('div', { class: 'oe-seg oe-view-tabs' }, viewTabs);

// The search box opens the command palette (see the palette section).
const FIND_KEY = `${MOD_KEY}F`;
const PALETTE_KEY = `${MOD_KEY}K`;
const searchButton = el(
  'button',
  { class: 'oe-btn oe-tool oe-search-trigger', title: `Search tables and columns, or run a command (${PALETTE_KEY})`, 'aria-label': 'Search tables and columns, or run a command', on: { click: () => openSpotlight() } },
  [iconSvg('search'), el('span', { class: 'label', text: 'Search or jump…' }), el('kbd', { text: PALETTE_KEY })],
);
// The tour's steps (see the tour section): one per domain, most connected
// first. A single domain makes no tour: it is not offered.
const TOUR_STEPS = tourSteps(
  data.domainOrder,
  data.nodes,
  data.domainNotes,
);
const toggleTour = () => (tour.on ? endTour(true) : startTour());
// The starred tables (see the central tables section), counted over the tour's domains.
const CENTRAL_TOTAL = TOUR_STEPS.reduce((n, step) => n + step.centrals.length, 0);

// Dropdown menus of the toolbar; one open at a time. ↑ ↓ move between the
// items, Esc closes the menu and gives the focus back to its button; a menu
// opened from the keyboard puts the focus on its first item.
const menus = [];
const menuItems = (menu) => [...menu.querySelectorAll('.oe-item:not(:disabled)')];
function dropdown(button, cls) {
  const menu = el('div', { class: `oe-menu ${cls}`, role: 'menu', style: 'display:none' });
  const wrap = el('div', { class: 'oe-drop' }, [button, menu]);
  const entry = { button, menu, wrap, onOpen: null };
  menus.push(entry);
  button.setAttribute('aria-haspopup', 'menu');
  button.addEventListener('click', (e) => {
    const open = menu.style.display === 'none';
    setMenu(entry, open);
    if (open && e.detail === 0) menuItems(menu)[0]?.focus();
  });
  wrap.addEventListener('keydown', (e) => {
    if (menu.style.display === 'none') return;
    const items = menuItems(menu);
    const at = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1 + (at < 0 ? 1 : 0))) % items.length]?.focus();
    } else if (e.key === 'Escape') {
      closeMenus();
      button.focus();
    } else return;
    e.stopPropagation();
  });
  return entry;
}
const openMenu = () => menus.find((m) => m.menu.style.display !== 'none') ?? null;
function setMenu(entry, open) {
  for (const m of menus) {
    const on = m === entry && open;
    if (on && m.onOpen) m.onOpen();
    m.menu.style.display = on ? '' : 'none';
    m.button.classList.toggle('on', on);
    m.button.setAttribute('aria-expanded', String(on));
  }
  if (!(entry === moreMenu && open)) downloadStatus.textContent = '';
  layoutOverlays();
}
const closeMenus = () => setMenu(null, false);
// A menu row: a check mark column (shown for toggles that are on), label,
// optional second line, optional shortcut at the right.
function menuItem(label, title, onClick, { checked = null, detail = null, disabled = false, keys = null } = {}) {
  return el('button', { class: `oe-item${checked ? ' checked' : ''}`, role: checked === null ? 'menuitem' : 'menuitemcheckbox', title, ...(checked === null ? {} : { 'aria-checked': String(checked) }), ...(disabled ? { disabled: '' } : {}), on: { click: onClick } }, [
    el('span', { class: 'mark' }, [checked ? iconSvg('check', 14) : null]),
    el('span', { class: 'text' }, [el('span', { text: label }), detail ? el('span', { class: 'detail', text: detail }) : null]),
    keys ? el('kbd', { text: keys }) : null,
  ]);
}
// A small heading inside a menu.
const menuHeading = (text) => el('div', { class: 'oe-menu-sub', text });
// replaceChildren would print a null as text: optional entries are filtered.
const fillMenu = (menu, items) => menu.replaceChildren(...items.filter(Boolean));

// Databases: with several, the breadcrumb's database crumb ("All databases"
// on the views showing them all) opens a list of them; each shows its frame,
// in the view of all tables when it is on screen, else on the overview.
// The crumb's menu hangs from the toolbar itself (the breadcrumb clips what
// overflows it), left-aligned under the crumb.
const DATABASES = [...views.get(OVERVIEW).querySelectorAll('.database')].map((g) => g.getAttribute('data-database'));
const dbLabel = el('span', { class: 'label' });
const dbMenu = dropdown(el('button', { class: 'oe-link oe-db-crumb', title: 'Show one database', 'aria-label': 'Show one database' }, [dbLabel, iconSvg('caret', 12)]), 'oe-db-menu');
let crumbDb = null;
dbMenu.onOpen = () => {
  dbMenu.menu.style.left = `${dbMenu.button.offsetLeft}px`;
  const whole = state.view === ALL_VIEW ? ALL_VIEW : OVERVIEW;
  fillMenu(dbMenu.menu, [
    menuItem('All databases', 'Every database at once', () => (closeMenus(), navigate(whole), zoomToRect(viewBounds(whole), MAX_FIT_SCALE)), { checked: crumbDb === null }),
    el('div', { class: 'oe-menu-sep' }),
    ...DATABASES.map((db) =>
      menuItem(dbDisplayName(db), `Show the ${dbDisplayName(db)} database (${data.databases[db].label})`, () => (closeMenus(), showDatabase(db)), { checked: crumbDb === db, detail: data.databases[db].label }),
    ),
  ]);
};

// Highlight ▾: the modes that colour or mark the drawing in every view,
// each a toggle with its count. Offered only when one of them has something
// to show; the button reads as on while a mode is.
const highlightMenu = dropdown(
  el('button', { class: 'oe-btn oe-tool oe-highlight-btn', title: 'Highlight: review status, personal data, schema health, central tables', 'aria-label': 'Highlight' }, [
    iconSvg('highlight'),
    el('span', { class: 'label', text: 'Highlight' }),
    el('span', { class: 'oe-dot' }),
    iconSvg('caret', 12),
  ]),
  'oe-highlight-menu',
);
// Overview cards and ranking rows stand for many relations and carry no review colour.
const REVIEW_TOTAL = data.review.pending + data.review.stale;
const reviewCounts = () => `${data.review.pending} to confirm · ${data.review.stale} changed in code`;
const REVIEW_TIP = 'Color lines by review status: amber = not confirmed yet, red = code changed since review';
if (REVIEW_TOTAL === 0 && PII.total === 0 && HEALTH.length === 0 && CENTRAL_TOTAL === 0 && !CHANGES) highlightMenu.wrap.style.display = 'none';
// The modes, in the order of their chips under the toolbar; each one only
// when it has something to show (nothing to review, no personal data, no
// findings: the entry would switch on a mode that changes nothing).
function highlightModes() {
  return [
    CHANGES ? { id: 'changes', label: 'Changes', detail: CHANGES.label, tip: CHANGES_TIP, keys: 'C', keywords: ['changes', 'diff', 'added', 'removed'], on: changesOn(), toggle: () => setChangesMode(!changesOn()), off: null, listed: () => changesListShown() } : null,
    REVIEW_TOTAL > 0
      ? { id: 'review', label: 'Review mode', detail: reviewCounts(), tip: REVIEW_TIP, keys: null, keywords: ['review', 'confirm', 'stale'], on: reviewing(), toggle: () => setReviewMode(!reviewing()), off: null, listed: () => reviewListShown() }
      : null,
    PII.total > 0 ? { id: 'pii', label: 'Personal data (PII)', detail: PII_COUNTS, tip: PII_TIP, keys: 'P', keywords: ['pii', 'personal', 'privacy', 'gdpr'], on: piiOn(), toggle: () => setPiiMode(!piiOn()), off: null, listed: () => piiSummaryShown() } : null,
    HEALTH.length > 0 ? { id: 'health', label: 'Schema health', detail: HEALTH_COUNTS, tip: HEALTH_TIP, keys: 'H', keywords: ['health', 'findings', 'lint', 'index'], on: healthOn(), toggle: () => setHealthMode(!healthOn()), off: null, listed: () => healthListShown() } : null,
    CENTRAL_TOTAL > 0 ? { id: 'central', label: 'Central tables', detail: CENTRAL_COUNTS, tip: CENTRAL_TIP, keys: 'S', keywords: ['central', 'star', 'core', 'main', 'hub'], on: centralOn(), toggle: () => setCentralMode(!centralOn()), off: null, listed: () => centralListShown() } : null,
  ].filter(Boolean);
}
highlightMenu.onOpen = () =>
  fillMenu(
    highlightMenu.menu,
    highlightModes().map((m) =>
      menuItem(m.label, m.keys ? `${m.tip} (${m.keys})` : m.tip, () => {
        const focused = document.activeElement?.closest?.('.oe-item') !== null;
        const at = menuItems(highlightMenu.menu).indexOf(document.activeElement);
        m.toggle();
        highlightMenu.onOpen();
        if (focused && at >= 0) menuItems(highlightMenu.menu)[at]?.focus();
        layoutOverlays();
      }, { checked: m.on, detail: m.off && !m.on ? m.off : m.detail, disabled: Boolean(m.off) && !m.on, keys: m.keys }),
    ),
  );
function updateHighlightButton() {
  const on = highlightModes().filter((m) => m.on).length;
  highlightMenu.button.classList.toggle('active', on > 0);
  highlightMenu.button.title = on > 0 ? `Highlight: ${plural(on, 'mode')} on` : 'Highlight: review status, personal data, schema health, central tables';
  // Every mode switch ends here: the link names the modes on.
  syncHash();
}

// The ⋯ menu: occasional actions and display settings, rebuilt on every
// open so labels and checks reflect the current state. Downloads keep the
// menu open: its last line says what was saved.
const downloadStatus = el('div', { class: 'oe-status' });
const DOWNLOADS = [
  ['svg', 'SVG', 'Vector drawing of this view only, without the interactive viewer'],
  ['png', 'PNG', 'Image at twice the screen resolution, transparent outside the drawing'],
  ['jpg', 'JPEG', 'Smaller image on a white background'],
];
const moreMenu = dropdown(toolButton('more', '', 'More: tour, download, collapse or expand domains, minimap'), 'oe-more-menu');
moreMenu.onOpen = () => {
  const foldable = clusterGroups(currentView()).length > 0;
  const fold = (on) => () => {
    closeMenus();
    setCollapsed(state.view, clusterGroups(currentView()).map(keyOf), on);
  };
  const toggle = (fn) => () => {
    fn();
    moreMenu.onOpen();
    layoutOverlays();
  };
  fillMenu(moreMenu.menu, [
    TOUR_STEPS.length >= 2 ? menuItem('Tour', 'Each domain in turn, zoomed on its central table (T)', () => (closeMenus(), toggleTour()), { checked: tour.on, keys: 'T' }) : null,
    TOUR_STEPS.length >= 2 ? el('div', { class: 'oe-menu-sep' }) : null,
    menuHeading('Download this view'),
    ...DOWNLOADS.map(([format, name, title]) => menuItem(`As ${name}`, title, () => download(format))),
    downloadStatus,
    el('div', { class: 'oe-menu-sep' }),
    menuItem('Collapse all', foldable ? 'Fold every domain in this view; a click on a domain header folds just that one' : 'Nothing to fold in this view', fold(true), { disabled: !foldable }),
    menuItem('Expand all', foldable ? 'Unfold every domain in this view' : 'Nothing to fold in this view', fold(false), { disabled: !foldable }),
    menuItem('Minimap', 'Small map of the whole view, shown while it does not fit on screen', toggle(() => setMinimap(!map.on)), { checked: map.on }),
    menuItem('Tips', 'A tip about a feature while the view is left idle', toggle(() => setTipsOff(!tips.off)), { checked: !tips.off }),
  ]);
};

toolbar.div.append(
  el('div', { class: 'oe-left' }, [backButton, crumbs]),
  el('div', { class: 'oe-right' }, [hopGroup, viewGroup, searchButton, highlightMenu.wrap, moreMenu.wrap]),
);

function crumb(text, onClick) {
  return onClick ? el('button', { class: 'oe-link', text, title: text, on: { click: onClick } }) : el('span', { class: 'here', text, title: text });
}

function renderToolbar() {
  const parts = [crumb('Overview', state.view === OVERVIEW ? null : () => navigate(OVERVIEW))];
  const cluster = state.view.startsWith(DOMAIN_PREFIX)
    ? state.view.slice(DOMAIN_PREFIX.length)
    : state.view === NEIGHBORHOOD
      ? clusterOf(state.center)
      : null;
  if (state.view === ALL_VIEW) parts.push(crumb(`All tables · ${plural(tableCount(null), 'table')}`));
  if (state.view === RANKING) parts.push(crumb('Ranking'));
  const db = cluster ? cluster.split('/')[0] : null;
  // There is no database-level view: the database crumb shows a frame on the
  // overview. With several databases it lists them all, on every view.
  if (DATABASES.length > 1) {
    crumbDb = db;
    dbLabel.textContent = db ? dbDisplayName(db) : 'All databases';
    parts.splice(1, 0, dbMenu.wrap);
  } else if (cluster) parts.push(crumb(dbDisplayName(db), () => showDatabase(db)));
  if (cluster) {
    parts.push(
      state.view === NEIGHBORHOOD
        ? crumb(domainName(cluster), () => navigate(domainView(cluster), { focus: state.center }))
        : crumb(`${domainName(cluster)} · ${plural(tableCount(cluster), 'table')}`),
    );
  }
  if (state.view === NEIGHBORHOOD) parts.push(crumb(`Tables related to ${short(state.center)}`));
  if (state.view === JOIN_VIEW) parts.push(crumb(`Join path: ${short(state.joinPath.nodes[0])} → ${short(state.joinPath.nodes.at(-1))}`));
  crumbs.replaceChildren(...parts.flatMap((p, i) => (i === 0 ? [p] : [el('span', { class: 'sep', text: '›' }), p])));
  backButton.disabled = nav.back.length === 0;
  updateBackPill();
  hopGroup.style.display = state.view === NEIGHBORHOOD ? '' : 'none';
  for (const b of viewTabs) b.classList.toggle('on', b.getAttribute('data-view') === state.view);
  updateHighlightButton();
  hopButtons.forEach((b, i) => b.classList.toggle('on', state.hops === RELATED.options[i].hops));
  layoutOverlays();
}

// In a view reached by navigation, a pill at the top left of the canvas
// names where Back goes ("← All tables"); the toolbar's Back does the same.
const NAVIGATED = (name) => name.startsWith(DOMAIN_PREFIX) || [NEIGHBORHOOD, JOIN_VIEW].includes(name);
function viewLabel(snap) {
  if (snap.view === OVERVIEW) return 'Overview';
  if (snap.view === ALL_VIEW) return 'All tables';
  if (snap.view === RANKING) return 'Ranking';
  if (snap.view === NEIGHBORHOOD) return `Tables related to ${short(snap.center)}`;
  if (snap.view === JOIN_VIEW) return `Join path ${short(snap.joinPath.nodes[0])} → ${short(snap.joinPath.nodes.at(-1))}`;
  return domainName(snap.view.slice(DOMAIN_PREFIX.length));
}
const backPill = overlay('oe-back-host');
backPill.fo.style.display = 'none';
// Shown in a view reached by navigation, and wherever the step behind was a
// table: it then names that table. Never on the overview itself.
function backPillShown() {
  const prev = nav.back.at(-1);
  return !tour.on && Boolean(prev) && state.view !== OVERVIEW && (NAVIGATED(state.view) || Boolean(prev.table));
}
function updateBackPill() {
  const prev = nav.back.at(-1);
  const show = backPillShown();
  backPill.fo.style.display = show ? '' : 'none';
  if (!show) return;
  const label = prev.table ? short(prev.table) : viewLabel(prev);
  backPill.div.replaceChildren(el('button', { class: 'oe-back-pill', title: 'Back (←)', text: `← ${label}`, on: { click: back } }));
  backPill.fo.setAttribute('width', viewport().w);
  backPill.fo.setAttribute('height', 40);
  const r = backPill.div.firstChild.getBoundingClientRect();
  backPill.size = { w: Math.ceil(r.width) + 2, h: Math.ceil(r.height) + 2 };
  backPill.fo.setAttribute('width', backPill.size.w);
  backPill.fo.setAttribute('height', backPill.size.h);
  placeBackPill();
}

// The Back pill sits just above the top left corner of the drawing's white
// sheet and moves with it; it stays on the canvas, below the toolbar (and
// the mode chips), left of the panel. With that corner off screen it waits
// at the canvas's top left.
function placeBackPill() {
  if (backPill.fo.style.display === 'none' || !backPill.size) return;
  const vp = viewport();
  const { w, h } = backPill.size;
  const chip = Math.max(...modeChips().map((c) => (c.fo.style.display !== 'none' ? Number(c.fo.getAttribute('height')) + 8 : 0)));
  const minY = TOOLBAR_HEIGHT + 8 + chip;
  const b = viewBounds(state.view);
  const { x: cx, y: cy, s } = state.cam;
  const corner = { x: cx + b.x * s, y: cy + b.y * s };
  const onScreen = corner.x >= 0 && corner.x <= vp.w && corner.y >= TOOLBAR_HEIGHT && corner.y <= vp.h;
  const want = onScreen ? { x: corner.x, y: corner.y - h - 6 } : { x: PANEL_MARGIN, y: minY };
  const maxX = vp.w - w - PANEL_MARGIN - panelRoom();
  backPill.fo.setAttribute('x', Math.max(PANEL_MARGIN, Math.min(want.x, maxX)));
  backPill.fo.setAttribute('y', Math.max(minY, Math.min(want.y, vp.h - h - PANEL_MARGIN)));
}

/** Shows database `db`'s frame: in the view of all tables when on it, else on the overview. */
function showDatabase(db) {
  const name = state.view === ALL_VIEW ? ALL_VIEW : OVERVIEW;
  navigate(name);
  for (const g of views.get(name).querySelectorAll('.database')) {
    if (g.getAttribute('data-database') === db) zoomToRect(boxOf(g), MAX_FIT_SCALE);
  }
}

// ---------------------------------------------------------------- download

const isHidden = (e) => e.classList.contains('oe-hidden') || /display:\s*none/.test(e.getAttribute('style') ?? '');

/**
 * The view on screen as a standalone static SVG: that view only, in its own
 * coordinates, with the stylesheet (and so the embedded font) but no viewer
 * script, no data and no overlays. What the reader sees is what is saved:
 * folded domains stay folded, the selection and highlights stay lit.
 */
function viewAsSvg() {
  const { x, y, w, h } = viewBounds(state.view);
  const view = currentView().cloneNode(true);
  view.removeAttribute('style');
  // A static file folds nothing: no toggles, titles back where they were drawn.
  for (const e of view.querySelectorAll('.fold-toggle, .fold-hit')) e.remove();
  for (const e of view.querySelectorAll('.cluster-label[data-x]')) e.setAttribute('x', e.getAttribute('data-x'));
  for (const e of view.querySelectorAll('.database > [transform]')) e.removeAttribute('transform');
  for (const e of [...view.querySelectorAll('*')].filter(isHidden)) e.remove();
  for (const e of view.querySelectorAll('.relation-hit, .card-links')) e.remove();
  // The pulse on a table just reached is a moment on screen, not drawing.
  for (const e of view.querySelectorAll('.arrive')) e.classList.remove('arrive');
  const root = svgEl('svg', { width: w, height: h, viewBox: `${x} ${y} ${w} ${h}` }, [svg.querySelector('style').cloneNode(true), view]);
  // Review colours, the personal data map, health marks, diff colours and the Changes fade are classes on the root.
  const cls = ['review-mode', 'pii-mode', 'health-mode', 'diff-mode', 'changes-mode'].filter((c) => svg.classList.contains(c));
  if (cls.length > 0) root.setAttribute('class', cls.join(' '));
  return { text: `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(root)}\n`, w, h };
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  toolbar.div.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Safari's canvas allows far fewer pixels than Chrome's; only WebKit has GestureEvent.
const canvasLimits = () => ('GestureEvent' in window ? CANVAS_LIMITS.webkit : CANVAS_LIMITS.other);

/** Draws the static SVG on a canvas and encodes it; resolves to { blob, size }. */
async function rasterize({ text, w, h }, type) {
  const size = canvasScale(w, h, canvasLimits());
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = el('canvas', { width: size.width, height: size.height });
    const ctx = canvas.getContext('2d');
    // JPEG has no transparency: without a fill the empty parts turn black.
    if (type === 'image/jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, size.width, size.height);
    }
    ctx.drawImage(img, 0, 0, size.width, size.height);
    const blob = await new Promise((done) => canvas.toBlob(done, type, 0.92));
    if (!blob) throw new Error(`the browser could not encode a ${size.width} × ${size.height} px image`);
    return { blob, size };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// What a download did: on the last line of the ⋯ menu while it is open,
// else (a download run from the palette) as a toast.
function downloadReport(text) {
  downloadStatus.textContent = text;
  if (openMenu() === moreMenu) layoutOverlays();
  else showToast(text);
}

async function download(format) {
  const join = state.view === JOIN_VIEW ? `${short(state.joinPath.nodes[0])}-to-${short(state.joinPath.nodes.at(-1))}` : state.center;
  const name = `${exportBaseName(data.project, state.view, join)}.${format}`;
  const svgFile = viewAsSvg();
  if (format === 'svg') {
    saveBlob(new Blob([svgFile.text], { type: 'image/svg+xml' }), name);
    return downloadReport(`Saved ${name}`);
  }
  downloadReport(`Drawing ${name}…`);
  try {
    const { blob, size } = await rasterize(svgFile, format === 'png' ? 'image/png' : 'image/jpeg');
    saveBlob(blob, name);
    const px = `${size.width} × ${size.height} px`;
    downloadReport(
      size.downscaled
        ? `Saved ${name} (${px}), downscaled to ${Math.round((size.scale / PIXEL_RATIO) * 100)}% of the usual size to stay within this browser's image size limit. Download the SVG for full detail.`
        : `Saved ${name} (${px})`,
    );
  } catch (e) {
    downloadReport(`Could not save ${name}: ${e.message}`);
  }
}

// ---------------------------------------------------------------- search

// Every table and column, matched by substring. Table hits rank before
// column hits; an exact name first, then a match at the start of a name,
// then one inside it.
function search(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits = [];
  for (const [id, n] of Object.entries(data.nodes)) {
    if (n.kind !== 'table') continue;
    const name = short(id).toLowerCase();
    if (id.toLowerCase().includes(q)) hits.push({ id, rank: name === q ? 0 : name.startsWith(q) ? 1 : 2 });
    for (const c of n.columns) {
      const cn = c.name.toLowerCase();
      if (cn.includes(q)) hits.push({ id, column: c.name, rank: cn === q ? 3 : cn.startsWith(q) ? 4 : 5 });
    }
  }
  return hits.sort((a, b) => a.rank - b.rank || byId(a.id, b.id) || byId(a.column ?? '', b.column ?? '')).slice(0, SEARCH_LIMIT);
}

// The palette: ⌘K / Ctrl+K (or the toolbar's search box) opens a box in
// the middle of the screen over a dimmed drawing. Empty, it lists the views
// and databases to go to and the commands of this file, each with its
// shortcut; typed, the tables and columns matching, then the commands
// matching (commands first when only a command starts with the text).
// "a > b" (or a → b) offers the join path between the best table matches.
// ⌘F / Ctrl+F (or "/") opens the same box for tables and columns only:
// the browser's own find bar would search the toolbar's text only, so the
// shortcut is taken over. Arrow keys move through the list, Enter opens or
// runs, Escape closes and gives the focus back.
const spotlight = overlay('oe-spotlight-host');
spotlight.fo.style.display = 'none';
const PALETTE_PLACEHOLDER = 'Search tables and columns, or run a command';
const SEARCH_PLACEHOLDER = 'Search tables and columns';
const spotlightInput = el('input', { type: 'search', class: 'oe-spotlight-input', placeholder: PALETTE_PLACEHOLDER, 'aria-label': PALETTE_PLACEHOLDER, autocomplete: 'off', spellcheck: 'false' });
const spotlightList = el('div', { class: 'oe-spotlight-list', role: 'listbox' });
const spotlightHint = el('div', { class: 'oe-spotlight-hint' });
spotlight.div.append(
  el('div', { class: 'oe-spotlight-backdrop', on: { pointerdown: () => closeSpotlight(true) } }),
  el('div', { class: 'oe-spotlight', role: 'dialog', 'aria-label': 'Search' }, [el('div', { class: 'oe-spotlight-field' }, [iconSvg('search', 18), spotlightInput]), spotlightList, spotlightHint]),
);
// `rows`: what Enter or a click on each list row does, in list order.
const spot = { commands: true, rows: [], items: [], active: 0, back: null };
const spotlightOpen = () => spotlight.fo.style.display !== 'none';

/** Opens the palette; `search` keeps it to tables and columns (⌘F, /). */
function openSpotlight({ search = false } = {}) {
  closeMenus();
  closeJoinSpot();
  hideTip();
  if (!spotlightOpen()) spot.back = document.activeElement;
  spot.commands = !search;
  spotlightInput.placeholder = search ? SEARCH_PLACEHOLDER : PALETTE_PLACEHOLDER;
  spotlightInput.setAttribute('aria-label', spotlightInput.placeholder);
  spotlightHint.textContent = search ? '↑ ↓ to move · Enter to open · Esc to close' : '↑ ↓ to move · Enter to open or run · Esc to close · a > b: join path';
  spotlight.fo.style.display = '';
  layoutOverlays();
  spotlightInput.focus();
  spotlightInput.select();
  renderResults();
}

/** Closes the palette; `refocus` gives the focus back to where it was (Esc, a click outside). */
function closeSpotlight(refocus = false) {
  if (!spotlightOpen()) return;
  spotlight.fo.style.display = 'none';
  spotlightInput.blur();
  if (refocus && spot.back?.isConnected && spot.back !== document.body) spot.back.focus();
}

function pick(i) {
  const run = spot.rows[i];
  if (!run) return;
  closeSpotlight();
  run();
}

function setActive(i) {
  spot.items[spot.active]?.classList.remove('active');
  spot.active = i;
  spot.items[spot.active]?.classList.add('active');
  spot.items[spot.active]?.scrollIntoView({ block: 'nearest' });
}

// The commands of the palette, as they stand now (a mode's state, the
// selection, the view): { group, icon, label, detail?, keys?, keywords?, run }.
function paletteCommands() {
  const selected = selectedTable();
  return [
    ...VIEW_TABS.map(([name, icon, text, , keys]) => ({ group: 'Go to', icon, label: text, keys, keywords: ['view', name], run: () => navigate(name) })),
    ...(DATABASES.length > 1
      ? DATABASES.map((db) => ({ group: 'Go to', icon: 'database', label: `${dbDisplayName(db)} database`, detail: data.databases[db].label, run: () => showDatabase(db) }))
      : []),
    { group: 'Actions', icon: 'join', label: 'Join path…', detail: 'How to join two tables, or type a > b', keys: `${MOD_KEY}J`, keywords: ['route', 'between'], run: () => openJoinSpot(selected) },
    TOUR_STEPS.length >= 2 ? { group: 'Actions', icon: 'play', label: tour.on ? 'Stop the tour' : 'Tour', detail: 'Each domain in turn', keys: 'T', keywords: ['domains', 'present'], run: toggleTour } : null,
    // A mode with nothing to change in this view (review on the map) is left out.
    ...highlightModes()
      .filter((m) => m.on || !m.off)
      .map((m) => ({ group: 'Actions', icon: 'highlight', label: m.label, detail: `${m.on ? 'On' : 'Off'} · ${m.detail}`, keys: m.keys, keywords: ['highlight', ...m.keywords], run: m.toggle })),
    ...DOWNLOADS.map(([format, name]) => ({ group: 'Actions', icon: 'download', label: `Download as ${name}`, detail: 'This view', keywords: ['export', 'save', 'image'], run: () => download(format) })),
    selected ? { group: 'Actions', icon: 'copy', label: `Copy ${short(selected)} as ${copyWhat(selected)}`, detail: 'With its indexes', keys: `${MOD_KEY}C`, keywords: ['copy schema', 'sql', 'ddl'], run: copySelectedSchema } : null,
  ].filter(Boolean);
}

// "a > b": the join path between the best table match of each side, and
// the join path box for picking them by hand (From taken when it matched).
function joinRows({ from, to }) {
  const [a] = from ? tableHits(from) : [];
  const [b] = to ? tableHits(to) : [];
  const missing = [from && !a ? from : null, to && !b ? to : null].filter(Boolean);
  const rows = [];
  if (a && b && a !== b) {
    rows.push({ icon: 'join', label: `Join path ${short(a)} → ${short(b)}`, detail: `${domainName(data.nodes[a].cluster)} → ${domainName(data.nodes[b].cluster)}`, run: () => openPathThrough([a, b]) });
  }
  rows.push({
    icon: 'join',
    label: 'Join path…',
    detail: missing.length > 0 ? `No table matches ${missing.map((m) => `“${m}”`).join(' or ')}` : 'Pick both tables',
    keys: `${MOD_KEY}J`,
    run: () => {
      openJoinSpot(a ?? selectedTable());
      if (a && to && !b) {
        joinInputs.to.value = to;
        renderJoinHits();
      }
    },
  });
  return rows;
}

// One row per table or column hit: its kind, the name, then where it is.
function hitRow(hit) {
  const n = data.nodes[hit.id];
  const where = hit.column ? `column of ${short(hit.id)} · ${domainName(n.cluster)}` : `${dbDisplayName(dbOf(hit.id))} › ${domainName(n.cluster)}`;
  return [
    el('span', { class: `kind ${hit.column ? 'is-column' : 'is-table'}`, text: hit.column ? 'col' : 'table' }),
    el('span', { class: 'name', text: hit.column ? `${short(hit.id)}.${hit.column}` : short(hit.id) }),
    el('span', { class: 'where', text: where }),
  ];
}
// One row per command: its icon, the label, a detail, the shortcut.
const commandRow = (c) => [
  el('span', { class: 'kind is-command' }, [iconSvg(c.icon, 14)]),
  el('span', { class: 'name', text: c.label }),
  el('span', { class: 'where', text: c.detail ?? '' }),
  c.keys ? el('kbd', { text: c.keys }) : null,
];

function renderResults() {
  const text = spotlightInput.value;
  // Sections in list order: [heading, [[parts, run, title], ...]].
  const sections = [];
  const join = spot.commands ? parseJoinQuery(text) : null;
  if (join) sections.push(['Join path', joinRows(join).map((c) => [commandRow(c), c.run, c.label])]);
  else {
    const hits = search(text);
    const hitSection = ['Tables and columns', hits.map((hit) => [hitRow(hit), () => goToNode(hit.id, hit.column), hit.column ? `${hit.id}.${hit.column}` : hit.id])];
    const matches = spot.commands ? matchCommands(text, paletteCommands()) : [];
    const groups = [...new Set(matches.map((m) => m.command.group))].map((g) => [g, matches.filter((m) => m.command.group === g).map(({ command: c }) => [commandRow(c), c.run, c.label])]);
    const names = hits.map((h) => h.column ?? short(h.id));
    if (commandsFirst(text, matches, names)) sections.push(...groups, hitSection);
    else sections.push(hitSection, ...groups);
  }
  spot.rows = [];
  spot.items = [];
  spot.active = 0;
  const children = [];
  for (const [heading, rows] of sections.filter(([, rows]) => rows.length > 0)) {
    // A search for tables only needs no heading over its one list.
    if (spot.commands) children.push(el('div', { class: 'oe-spotlight-group', text: heading }));
    for (const [parts, run, title] of rows) {
      const i = spot.items.length;
      const item = el('button', { class: `oe-result${i === 0 ? ' active' : ''}`, role: 'option', title, on: { click: () => pick(i), pointermove: () => spot.active !== i && setActive(i) } }, parts.filter(Boolean));
      spot.rows.push(run);
      spot.items.push(item);
      children.push(item);
    }
  }
  const empty = text.trim() ? (spot.commands ? 'No table, column or command matches' : 'No table or column matches') : 'Type a table or column name';
  spotlightList.replaceChildren(...(spot.items.length > 0 ? children : [el('div', { class: 'oe-spotlight-empty', text: empty })]));
}

spotlightInput.addEventListener('input', renderResults);
spotlightInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') pick(spot.active);
  else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && spot.items.length > 0) {
    e.preventDefault();
    setActive((spot.active + (e.key === 'ArrowDown' ? 1 : spot.items.length - 1)) % spot.items.length);
  } else if (e.key === 'Escape') closeSpotlight(true);
  else return;
  e.stopPropagation();
});

// Join spotlight: Cmd+J / Ctrl+J (or Join path… in the palette) opens two
// fields, From and To, over the same kind of result list (tables only).
// Enter or Tab takes the highlighted table and moves to To; Enter on To
// finds the paths and shows them in the join panel. From starts with the
// selected table, if any.
const joinSpot = overlay('oe-spotlight-host');
joinSpot.fo.style.display = 'none';
const joinInputs = {
  from: el('input', { type: 'search', class: 'oe-spotlight-input', placeholder: 'From table', 'aria-label': 'From table', autocomplete: 'off', spellcheck: 'false' }),
  to: el('input', { type: 'search', class: 'oe-spotlight-input', placeholder: 'To table', 'aria-label': 'To table', autocomplete: 'off', spellcheck: 'false' }),
};
const joinList = el('div', { class: 'oe-spotlight-list', role: 'listbox' });
joinSpot.div.append(
  el('div', { class: 'oe-spotlight-backdrop', on: { pointerdown: () => closeJoinSpot() } }),
  el('div', { class: 'oe-spotlight oe-join-spot', role: 'dialog', 'aria-label': 'Join path' }, [
    ...['from', 'to'].map((slot) => el('div', { class: `oe-spotlight-field oe-join-${slot}` }, [el('span', { class: 'oe-field-label', text: slot === 'from' ? 'From' : 'To' }), joinInputs[slot]])),
    joinList,
    el('div', { class: 'oe-spotlight-hint', text: '↑ ↓ to move · Tab or Enter: next field · Enter on To: find the path · Esc to close' }),
  ]),
);
const joinPick = { from: null, to: null, field: 'from', hits: [], items: [], active: 0 };
const joinSpotOpen = () => joinSpot.fo.style.display !== 'none';
const tableHits = (text) => [...new Set(search(text).filter((h) => !h.column).map((h) => h.id))];

function openJoinSpot(from = null) {
  closeMenus();
  closeSpotlight();
  hideTip();
  joinPick.from = data.nodes[from]?.kind === 'table' ? from : null;
  joinPick.to = null;
  joinInputs.from.value = joinPick.from ? short(joinPick.from) : '';
  joinInputs.to.value = '';
  joinSpot.fo.style.display = '';
  layoutOverlays();
  focusJoinField(joinPick.from ? 'to' : 'from');
}
function closeJoinSpot() {
  if (!joinSpotOpen()) return;
  joinSpot.fo.style.display = 'none';
  for (const i of Object.values(joinInputs)) i.blur();
}
function focusJoinField(slot) {
  joinPick.field = slot;
  joinInputs[slot].focus();
  joinInputs[slot].select();
  renderJoinHits();
}
function setJoinActive(i) {
  joinPick.items[joinPick.active]?.classList.remove('active');
  joinPick.active = i;
  joinPick.items[i]?.classList.add('active');
  joinPick.items[i]?.scrollIntoView({ block: 'nearest' });
}
function renderJoinHits() {
  const text = joinInputs[joinPick.field].value;
  // A field showing the table it holds lists that table first.
  const chosen = joinPick[joinPick.field];
  joinPick.hits = chosen && text === short(chosen) ? [chosen, ...tableHits(text).filter((id) => id !== chosen)] : tableHits(text);
  joinPick.active = 0;
  joinPick.items = joinPick.hits.map((id, i) =>
    el('button', { class: `oe-result${i === 0 ? ' active' : ''}`, role: 'option', title: id, on: { click: () => takeJoinHit(id), pointermove: () => joinPick.active !== i && setJoinActive(i) } }, [
      el('span', { class: 'kind is-table', text: 'table' }),
      el('span', { class: 'name', text: short(id) }),
      el('span', { class: 'where', text: `${dbDisplayName(dbOf(id))} › ${domainName(data.nodes[id].cluster)}` }),
    ]),
  );
  const empty = text.trim() ? 'No table matches' : `Type the name of the ${joinPick.field === 'from' ? 'first' : 'second'} table`;
  joinList.replaceChildren(...(joinPick.items.length > 0 ? joinPick.items : [el('div', { class: 'oe-spotlight-empty', text: empty })]));
}
// Takes a table for the current field: From moves on to To, To runs.
function takeJoinHit(id) {
  joinPick[joinPick.field] = id;
  joinInputs[joinPick.field].value = short(id);
  if (joinPick.field === 'from') return focusJoinField('to');
  if (!joinPick.from) return focusJoinField('from');
  closeJoinSpot();
  join.from = joinPick.from;
  setJoinEnd('to', joinPick.to);
}
for (const slot of ['from', 'to']) {
  joinInputs[slot].addEventListener('focus', () => {
    if (joinPick.field !== slot) {
      joinPick.field = slot;
      renderJoinHits();
    }
  });
  joinInputs[slot].addEventListener('input', () => {
    joinPick[slot] = null;
    renderJoinHits();
  });
  joinInputs[slot].addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) && joinPick.hits[joinPick.active]) {
      e.preventDefault();
      takeJoinHit(joinPick.hits[joinPick.active]);
    } else if (e.key === 'Tab' && e.shiftKey && slot === 'to') {
      e.preventDefault();
      focusJoinField('from');
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && joinPick.items.length > 0) {
      e.preventDefault();
      setJoinActive((joinPick.active + (e.key === 'ArrowDown' ? 1 : joinPick.items.length - 1)) % joinPick.items.length);
    } else if (e.key === 'Escape') closeJoinSpot();
    else return;
    e.stopPropagation();
  });
}

// ---------------------------------------------------------------- deep links

// The address is a link to what is on screen (keys in deep-link.js): the
// view (with the domains folded in it), or the view of related tables or the
// join path, then the selection
// in it (several tables, a table, a column, a line, the relations between
// two domains, the severity the health list shows) and the highlight modes
// on. Every change on screen writes it again (replaceState: Back does not
// walk through selections), so the address bar can be copied as it is;
// opening a link builds the same screen back.
let lastHash = null;
// The column open in the selected table's panel, for the link.
let linkColumn = null;
// Views a link names by name: not a neighborhood or a join path, which are
// built from a table (`related=`, `path=`).
const linkableView = (name) => views.has(name) && name !== NEIGHBORHOOD && name !== JOIN_VIEW;
function linkPairs() {
  const pairs = [];
  if (join.paths.length > 0 && join.from && join.to && (join.open || state.view === JOIN_VIEW)) {
    pairs.push(['path', (join.through ?? [join.from, join.to]).join(',')]);
    if (join.index > 0) pairs.push(['option', String(join.index + 1)]);
  } else {
    if (state.view === NEIGHBORHOOD) pairs.push(['related', state.center], ['hops', String(state.hops)]);
    else if (linkableView(state.view)) {
      pairs.push(['view', state.view]);
      if (collapsedIn(state.view).size > 0) pairs.push(['folded', [...collapsedIn(state.view)].sort()]);
    }
    const view = currentView();
    const node = view.querySelector('.selected[data-id]')?.getAttribute('data-id');
    const line = view.querySelector('.relation-group.flowing, .hub-route.flowing')?.getAttribute('data-id');
    if (picked.length > 1) pairs.push(['tables', picked.join(',')]);
    else if (node && linkColumn) pairs.push(['column', `${node}.${linkColumn}`]);
    // A neighborhood opens with its centre selected: no need to say it.
    else if (node && !(state.view === NEIGHBORHOOD && node === state.center)) pairs.push(['table', node]);
    else if (line) pairs.push(['line', line]);
    else if (domainLinkShown()) pairs.push(['between', domainLink.pair]);
    else if (healthListShown()) {
      if (healthSeverity) pairs.push(['severity', healthSeverity]);
      if (healthTicked.size > 0) pairs.push(['findings', HEALTH.map(findingKey).filter((k) => healthTicked.has(k))]);
    }
  }
  if (cameraMoved) pairs.push(['at', cameraCentre().join(',')]);
  // A diff opens with Changes on: say so even when no mode is on.
  const modes = highlightModes().filter((m) => m.on).map((m) => m.id);
  if (modes.length > 0 || CHANGES) pairs.push(['highlight', modes.join(',')]);
  return pairs;
}
// Called after anything that changes the screen; several calls in one go
// write the address once, from the screen they end on.
let linkQueued = false;
function syncHash() {
  if (linkQueued) return;
  linkQueued = true;
  queueMicrotask(() => {
    linkQueued = false;
    const hash = formatHash(linkPairs());
    if (hash === location.hash) return;
    lastHash = hash;
    try {
      history.replaceState(null, '', hash);
    } catch {
      // A page that may not change its address (some file viewers) keeps it.
    }
  });
}
function setHighlights(ids) {
  for (const m of highlightModes()) if (m.on !== ids.includes(m.id) && !(m.off && !m.on)) m.toggle();
}
function openDeepLink(hash) {
  if (!hash || hash === lastHash) return false;
  const parsed = parseHash(hash);
  if (!parsed) return false;
  const p = parsed.params;
  if (p.highlight) setHighlights(p.highlight.ids);
  const opened = openLinkTarget(p);
  if (p.folded && state.view === p.view?.value) foldLinked(p.folded.ids);
  if (SEVERITIES.includes(p.severity?.value) && severityCount(p.severity.value) > 0 && healthListShown()) filterHealth(p.severity.value);
  if (p.findings && healthListShown()) {
    const known = new Set(HEALTH.map(findingKey));
    tickFindings(p.findings.ids.filter((k) => known.has(k)));
    const lit = showHealthList();
    if (lit.length > 0) zoomToRect(boundsOf(currentIndex(), lit), FOCUS_MAX_SCALE);
  }
  // Last: opening the rest framed the view; the link's camera replaces that.
  const at = (p.at?.value ?? '').split(',').map(Number);
  if (at.length === 3 && at.every(Number.isFinite) && at[2] > 0) centreCamera(at);
  return opened || Boolean(p.highlight);
}
// Folds the domains a link names in the view on screen, except those
// holding what the link selects, which stays in sight.
function foldLinked(keys) {
  const view = currentView();
  const open = new Set([...view.querySelectorAll('.selected[data-id], .table.hl[data-id]')].map((g) => clusterOf(g.getAttribute('data-id'))));
  const known = new Set(clusterGroups(view).map(keyOf));
  const shut = keys.filter((k) => known.has(k) && !open.has(k));
  if (shut.length === 0) return;
  collapsed.set(state.view, new Set(shut));
  applyCollapse(state.view);
  syncHash();
}
// The table (or polymorphic node) a link selects, and its open column.
function linkedNode(p) {
  if (p.column) {
    const parts = p.column.value.split('.');
    const id = parts.slice(0, 3).join('.');
    const column = parts.slice(3).join('.');
    if (data.nodes[id]?.columns?.some((c) => c.name === column)) return { id, column };
  }
  const id = p.table?.value;
  return data.nodes[id] ? { id, column: null } : null;
}
// Selects the linked node, column or line in the view on screen; false when
// the view does not draw it.
function selectLinked(p) {
  const node = linkedNode(p);
  if (node && currentIndex().has(node.id)) {
    focusNode(node.id, node.column);
    if (node.column) {
      showPanel(nodePanel(node.id, node.column));
      panel.div.querySelector('.oe-col.open')?.scrollIntoView({ block: 'nearest' });
    }
    return true;
  }
  const line = p.line && findAttr(currentView(), '.relation-group, .hub-route', 'data-id', p.line.value);
  if (line) {
    flowRelation(line);
    return true;
  }
  return false;
}
function openLinkTarget(p) {
  const tables = (key) => (p[key]?.ids ?? []).filter((id) => data.nodes[id]?.kind === 'table');
  const view = linkableView(p.view?.value) ? p.view.value : null;
  if (tables('path').length > 1) {
    const ids = tables('path');
    openPathThrough(ids);
    const option = Number(p.option?.value) - 1;
    if (ids.length === 2 && option > 0 && option < join.paths.length) showJoinPath(option);
    return true;
  }
  if (fullBoxes.has(p.related?.value)) {
    openNeighborhood(p.related.value, p.hops?.value === '2' ? 2 : 1);
    selectLinked(p);
    return true;
  }
  if (tables('tables').length > 0) {
    openTableSet(tables('tables'), view);
    return true;
  }
  const node = linkedNode(p);
  if (node) {
    // The view the link names when that view draws the node, else its home.
    const home = view && indexes.get(view).has(node.id) ? view : views.has(ALL_VIEW) && indexes.get(ALL_VIEW).has(node.id) ? ALL_VIEW : homeView(node.id);
    if (!home) return false;
    navigate(home);
    return selectLinked(p);
  }
  if (p.line) {
    // A line standing for several tables is drawn in its domain view only.
    const link = data.links.find((l) => l.id === p.line.value) ?? data.hubLinks.find((l) => l.id === p.line.value);
    if (!link && !view) return false;
    navigate(view ?? (views.has(ALL_VIEW) ? ALL_VIEW : homeView(link.from)));
    return selectLinked(p);
  }
  const [a, b] = p.between?.ids ?? [];
  if (data.domainLinks[pairId(a, b)]) {
    navigate(view ?? OVERVIEW);
    showDomainLink(a, b);
    return true;
  }
  if (view) {
    navigate(view);
    return true;
  }
  return false;
}

// #tables=: the view of all tables (in a schema without one, the smallest
// domain view drawing every table as a full box; failing that, the home
// view of the first table, with a note on how many are elsewhere), the
// tables lit and the rest dimmed as a selection does, fitted to them. Esc
// or a click on the empty canvas clears it like any selection.
// `view` (from the link) when it draws every table in full, else all
// tables, else the smallest domain view that does, else the first table's.
function openTableSet(ids, view = null) {
  const full = (name, id) => indexes.get(name).has(id) && !indexes.get(name).get(id).el.classList.contains('stub');
  const domains = [...views.keys()].filter((n) => n.startsWith(DOMAIN_PREFIX) && ids.every((id) => full(n, id)));
  const name = linkableView(view) && ids.every((id) => full(view, id)) ? view : views.has(ALL_VIEW) ? ALL_VIEW : (domains.sort((a, b) => indexes.get(a).size - indexes.get(b).size)[0] ?? homeView(ids[0]));
  navigate(name);
  const shown = showPicked(ids);
  // The legend sits bottom left, where the fitted tables would run under
  // it: folded in this view only, the reader's choice stays.
  legendFolded = true;
  showLegend();
  zoomToRect(boundsOf(currentIndex(), shown), FOCUS_MAX_SCALE);
  if (shown.length < ids.length) showToast(`${ids.length - shown.length} of ${plural(ids.length, 'table')} are in other domains`);
}

// Several tables lit together: a link's #tables=, or Shift-click (⌘ or Ctrl
// too) adding a table to the selection or taking it out. The panel lists
// them and the address names them, so a copied link shows the same tables.
let picked = [];
const ADD_KEY_HINT = 'Shift-click';
/** Lights the tables of `ids` drawn in the view, fades the rest; returns them. */
function showPicked(ids) {
  clearSelection();
  const index = currentIndex();
  const shown = ids.filter((id) => index.has(id));
  for (const id of shown) unfoldFor(id);
  const set = new Set(shown);
  for (const g of relationGroups()) if (set.has(g.getAttribute('data-from')) && set.has(g.getAttribute('data-to'))) g.classList.add('hl');
  for (const id of shown) index.get(id).el.classList.add('hl');
  currentView().classList.add('dimmed');
  picked = shown;
  if (shown.length > 0) showPanel(pickedPanel(shown));
  syncHash();
  return shown;
}
function togglePicked(id) {
  const base = picked.length > 0 ? picked : [selectedTable()].filter(Boolean);
  const next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
  if (next.length === 0) clearSelection();
  else if (next.length === 1) selectNode(next[0]);
  else showPicked(next);
}
function pickedPanel(ids) {
  const status = el('span', { class: 'oe-status-inline muted' });
  return [
    panelHeader({ name: `${ids.length} tables selected`, note: `${ADD_KEY_HINT} a table to add it or take it out. The address names these tables: copy it to share them.` }),
    el('div', { class: 'oe-actions' }, [
      el('button', { class: 'oe-btn', text: 'Copy link', title: 'Copy the address of these tables', on: { click: () => copyText(location.href, status, 'the link') } }),
      ids.length === 2 ? el('button', { class: 'oe-btn', text: 'Join path', title: 'How these two tables join', on: { click: () => openPathThrough(ids) } }) : null,
      status,
    ]),
    el(
      'div',
      { class: 'oe-picked' },
      ids.map((id) =>
        el('div', { class: 'oe-picked-row' }, [
          el('button', { class: 'oe-link', text: short(id), title: `Go to ${id}`, on: { click: () => goToNode(id) } }),
          domainChip(data.nodes[id].cluster),
          el('button', { class: 'oe-chip-close', text: '×', title: `Take ${short(id)} out`, 'aria-label': `Take ${short(id)} out`, on: { click: () => togglePicked(id) } }),
        ]),
      ),
    ),
  ];
}

// #path=: a join path through the tables in the order given, as the join
// panel shows it. Two tables: the panel's own search, alternatives included.
// More: the cheapest path between each pair of neighbours, end to end. A
// pair no relations join falls back to lighting the tables.
function openPathThrough(ids) {
  if (ids.length === 2) {
    openJoin(ids[0]);
    setJoinEnd('to', ids[1]);
    if (join.paths.length > 0) return;
  } else {
    const { path } = pathThrough(data, ids);
    if (path) {
      Object.assign(join, { from: ids[0], to: ids.at(-1), paths: [path], index: 0, through: ids });
      showJoinPath(0);
      return;
    }
  }
  const { gap } = pathThrough(data, ids);
  openTableSet(ids);
  showToast(`No join path from ${short(gap[0])} to ${short(gap[1])}`);
}

// ---------------------------------------------------------------- panel

const panel = overlay('oe-panel');
// The panel grows and shrinks with its content (a tab, an unfolded list):
// the overlays around it follow.
new ResizeObserver(() => {
  if (panel.fo.style.display !== 'none') layoutOverlays();
}).observe(panel.div);
function showShortcuts() {
  showPanel([
    panelHeader({ name: 'Keyboard shortcuts' }),
    ...SHORTCUTS.flatMap(([title, rows]) => [
      el('div', { class: 'oe-keys-group', text: title }),
      el('table', { class: 'oe-keys' }, rows.map(([keys, what]) => el('tr', {}, [el('td', {}, keys.map((k) => el('kbd', { text: k }))), el('td', { text: what })]))),
    ]),
  ]);
}
panel.fo.style.display = 'none';

function hidePanel() {
  const was = panel.fo.style.display !== 'none';
  panel.fo.style.display = 'none';
  join.open = false;
  syncHash();
  // The minimap and the Back pill keep clear of the panel: with it gone
  // they move back to the right edge now, not at the next pan.
  if (was) {
    updateMinimap();
    placeBackPill();
    if (focused === null) focusDomain(null);
  }
}

function showPanel(children) {
  panel.div.replaceChildren(...children.filter(Boolean));
  panel.fo.style.display = '';
  layoutOverlays();
  // A domain pair stays lit while its panel is open, and only then.
  if (focused === null) focusDomain(null);
}

const link = (text, onClick) => el('button', { class: 'oe-link', text, on: { click: onClick } });
// A view's line to its source has no cardinality.
const linkSummary = (l) => (l.kind === 'view_source' ? 'view reads this table' : `${l.cardinality} · ${l.kind}`);
// Review state as an icon whose tooltip says it in words.
const reviewIcon = (state) =>
  el('span', { class: `oe-review review-${state}`, title: REVIEW_WORDS[state], 'aria-label': REVIEW_WORDS[state], role: 'img' }, [svgEl('svg', { width: 14, height: 14, viewBox: '0 0 14 14' }, parsed(reviewIconSvg(state, 7, 7)))]);
// A fact line: identifiers and values as code, the words around as text.
const factLine = (parts, tag = 'li') => el(tag, { class: 'oe-fact' }, parts.map((p) => el(p.code ? 'code' : 'span', { class: p.code ? 'oe-code' : '', text: p.text })));
// Business note, then the team-only note and the untranslated original.
const noteLines = (n) => [
  n.note ? el('p', { text: n.note }) : null,
  n.internalNote ? el('p', { class: 'muted', text: `Internal: ${n.internalNote}` }) : null,
  n.noteSource ? el('p', { class: 'muted', text: `Original: ${n.noteSource}` }) : null,
];

// Facts of a column as small chips: type, NOT NULL, PK, unique, PII, default.
function columnChips(c) {
  const chips = [
    [c.type],
    [c.nullable === false ? 'NOT NULL' : c.nullable === true ? 'nullable' : null],
    [c.pk ? 'PK' : null],
    [c.unique ? 'unique' : null],
    [c.autoIncrement ? 'auto increment' : null],
    [c.pii ? 'PII' : null, 'pii'],
    [c.default === undefined ? null : `default ${c.default}`],
  ].filter(([text]) => text);
  return el('div', { class: 'oe-chips' }, chips.map(([text, extra]) => el('span', { class: `chip${extra ? ` ${extra}` : ''}`, text })));
}
// A possibly missing relation found by `validate`, for a column or a table.
const MISSING = 'Possibly missing relation';
const warningLine = (text) => (text ? el('div', { class: 'oe-warn', text: `${MISSING}: ${text}` }) : null);
// A generated column's expression, then the notes.
const columnText = (c) => [c.generated === undefined ? null : el('div', { class: 'muted', text: `generated as ${c.generated}` }), ...noteLines(c), warningLine(c.warning)];
// Enum values as value | meaning; a value whose meaning only restated it has none.
const enumTable = (values) =>
  el('table', { class: 'oe-enum' }, values.map(([v, meaning]) => el('tr', {}, [el('td', { class: 'value', text: v }), el('td', { text: meaning })])));

// Chips for related tables, one per table: a click goes to it. A relation
// not confirmed yet (see isConfirmed) has a dashed chip; a table in another
// database carries that database's name. More than CHIP_LIMIT collapse
// behind "Show all".
const CHIP_LIMIT = 12;
function chipGroup(title, entries, cls = '') {
  if (entries.length === 0) return null;
  const chips = entries.map(({ id, confirmed, db, tip }) =>
    el('button', { class: `oe-chip${confirmed ? '' : ' unconfirmed'}`, title: tip ?? (confirmed ? id : `${id} · not confirmed`), on: { click: () => goToNode(id) } }, [
      el('span', { text: short(id) }),
      db ? el('span', { class: 'db', text: dbDisplayName(db) }) : null,
    ]),
  );
  const box = el('div', { class: `oe-chipbox ${cls}` }, chips.slice(0, CHIP_LIMIT));
  const more =
    chips.length > CHIP_LIMIT
      ? el('button', {
          class: 'oe-link oe-more',
          text: `Show all (${chips.length})`,
          on: {
            click: (e) => {
              box.replaceChildren(...chips);
              e.currentTarget.remove();
              layoutOverlays();
            },
          },
        })
      : null;
  return el('div', { class: 'oe-chip-group' }, [el('div', { class: 'sub', text: `${title} (${entries.length})` }), box, more]);
}

// One chip per other table; a table linked several ways is confirmed when
// any of those links is.
function chipEntries(id, links, otherEnd) {
  const byTable = new Map();
  for (const l of links) {
    const other = otherEnd(l);
    const confirmed = l.kind === 'view_source' || isConfirmed(l.kind, l.review);
    byTable.set(other, (byTable.get(other) ?? false) || confirmed);
  }
  return [...byTable]
    .sort(([a], [b]) => byId(short(a), short(b)) || byId(a, b))
    .map(([other, confirmed]) => ({ id: other, confirmed, db: dbOf(other) !== dbOf(id) ? dbOf(other) : null }));
}

// Copy the table as SQL (a JSON schema-like document for MongoDB) or as a
// Markdown table, from a small menu under an icon button; `status` says
// what was copied.
// CREATE TABLE of a table with its indexes and database foreign keys (a
// JSON schema-like document for a document store).
function tableSql(id, n = data.nodes[id]) {
  const engine = data.databases[dbOf(id)].engine;
  if (isDocumentStore(engine)) return collectionDocument(id, n);
  const foreignKeys = [...data.links, ...data.hubLinks]
    .filter((l) => l.from === id && l.kind === 'db_fk' && l.fromColumns)
    .map((l) => ({ columns: l.fromColumns, to: l.to, toColumns: l.toColumns }));
  return createTableSql(id, n, engine, foreignKeys);
}

function copySchemaButton(id, n, status) {
  const engine = data.databases[dbOf(id)].engine;
  const options = isDocumentStore(engine)
    ? [['JSON schema', 'Fields, required list, enum values and indexes as a JSON schema-like document (approximate)', () => collectionDocument(id, n), 'JSON schema']]
    : [['SQL', 'CREATE TABLE incl. indexes — approximate types: NOT NULL, DEFAULT, keys, unique constraints, database foreign keys', () => tableSql(id, n), 'SQL']];
  options.push(['Markdown', 'The column grid as a Markdown table', () => markdownTable(id, n), 'Markdown']);
  // A popover over the panel's content, anchored under the button.
  const menu = el('div', { class: 'oe-menu oe-copy-menu oe-popover', style: 'display:none' });
  const toggle = toolButton('copy', '', 'Copy schema: SQL or Markdown', () => {
    menu.style.display = menu.style.display === 'none' ? '' : 'none';
    layoutOverlays();
  }, ' oe-copy-schema');
  menu.append(...options.map(([label, title, make, what]) => menuItem(label, title, () => {
    menu.style.display = 'none';
    copyText(make(), status, what);
    layoutOverlays();
  })));
  return el('div', { class: 'oe-drop' }, [toggle, menu]);
}

// Header of a panel: name (its full id in the tooltip), the domain as a
// small chip in the domain's colour, ★ for a central table, then the note on
// one line (a click shows all of it).
function domainChip(cluster) {
  const accent = indexes.get(OVERVIEW).get(cluster)?.el.querySelector('.card-accent')?.getAttribute('stroke') ?? '#56627a';
  return el('button', { class: 'oe-domain-chip', title: `Open the ${domainName(cluster)} domain`, style: `color:${accent};border-color:${accent}`, text: domainName(cluster), on: { click: () => navigate(domainView(cluster)) } });
}
function panelHeader({ name, tip, cluster, central = false, note, extra = [] }) {
  return el('div', { class: 'oe-ph' }, [
    el('div', { class: 'oe-ph-title' }, [
      central ? el('span', { class: 'oe-star', title: 'Central table: the most connected table of its domain', text: '★' }) : null,
      name ? el('b', { class: 'oe-ph-name', title: tip, text: name }) : null,
      // Two domains (the relations between them) read "A ⇄ B" as chips.
      ...(cluster ? [cluster].flat().flatMap((c, i) => [i > 0 ? el('span', { class: 'oe-ph-sep', title: tip, text: '⇄' }) : null, domainChip(c)]) : []),
    ]),
    note ? el('div', { class: 'oe-ph-note', text: note }) : null,
    ...extra,
  ]);
}

// Tabs over the body of a panel; the first one shows first unless `open`
// names another. Each tab: { id, label, count, body: () => [elements] }.
function tabbed(tabs, open = tabs[0]?.id) {
  const body = el('div', { class: 'oe-tab-body' });
  const buttons = tabs.map((t) => el('button', { class: 'oe-tab', role: 'tab', 'data-tab': t.id, on: { click: () => pick(t.id) } }, [el('span', { text: t.label }), el('span', { class: 'n', text: String(t.count) })]));
  function pick(id) {
    buttons.forEach((b) => b.classList.toggle('on', b.getAttribute('data-tab') === id));
    body.replaceChildren(...tabs.find((t) => t.id === id).body().filter(Boolean));
    layoutOverlays();
  }
  pick(tabs.some((t) => t.id === open) ? open : tabs[0].id);
  return [el('div', { class: 'oe-tabs', role: 'tablist' }, buttons), body];
}

const keyIcon = (key) => (key ? svgEl('svg', { class: 'oe-key', width: 14, height: 14, viewBox: '0 0 14 14' }, parsed((key === 'pk' ? keyIconSvg : linkIconSvg)(7, 7))) : null);

// One column: key icon, name (bold for a primary key), small chips, type
// on the right; the note under it on one line. The enum chip folds the
// values out under the row; a click on the note shows all of it.
const hintIcon = (draw, title) => el('span', { class: 'hint', title }, [svgEl('svg', { width: 10, height: 12, viewBox: '0 0 10 12' }, parsed(draw(5, 6)))]);

function columnRow(n, c, open) {
  const values = Object.entries(c.enum ?? {});
  const list = values.length > 0 ? el('div', { class: 'oe-enum-list', style: c.name === open ? '' : 'display:none' }, values.map(([v, meaning]) => el('div', {}, [el('code', { class: 'oe-code', text: v }), meaning ? el('span', { text: ` — ${meaning}` }) : null]))) : null;
  const chips = columnBadges(c).map((b) =>
    el(b.kind === 'enum' ? 'button' : 'span', { class: `oe-badge ${b.kind}`, title: b.title, text: b.text, ...(b.kind === 'enum' ? { on: { click: () => ((list.style.display = list.style.display === 'none' ? '' : 'none'), layoutOverlays()) } } : {}) }),
  );
  const key = c.pk ? 'pk' : c.fk ? 'fk' : null;
  const indexed = (n.indexes ?? []).some((i) => i.columns.includes(c.name));
  return el('div', { class: `oe-col${c.name === open ? ' open' : ''}`, 'data-column': c.name }, [
    el('div', { class: 'l1' }, [
      el('span', { class: 'gutter', title: key === 'pk' ? 'Primary key' : key === 'fk' ? 'Foreign key' : '' }, [keyIcon(key)]),
      el('span', { class: `name${c.pk ? ' pk' : ''}`, text: c.name }),
      // The marks the table box draws after a name: listed values, an index.
      values.length > 0 ? hintIcon(enumIconSvg, 'Column with listed values') : null,
      indexed ? hintIcon(indexIconSvg, 'Column in an index (see Indexes)') : null,
      ...chips,
      el('span', { class: 'type', text: c.type }),
    ]),
    // The panel is the detail view: notes in full, the team's note muted under.
    c.note ? el('div', { class: 'l2', text: c.note }) : null,
    c.internalNote ? el('div', { class: 'l2 internal', text: `Internal: ${c.internalNote}` }) : null,
    c.warning ? el('div', { class: 'l2 oe-warn', text: `${MISSING}: ${c.warning}` }) : null,
    list,
  ]);
}

// Indexes: name muted, columns in code, UNIQUE, the partial-index condition.
const indexList = (n) =>
  (n.indexes ?? []).map((i) =>
    el('div', { class: 'oe-idx', title: i.using ? `using ${i.using}` : '' }, [
      el('code', { class: 'cols', text: i.columns.join(', ') }),
      i.unique ? el('span', { class: 'oe-badge unique', text: 'UNIQUE' }) : null,
      el('span', { class: 'iname', text: i.name ?? '' }),
      i.where ? el('code', { class: 'where', text: `where ${i.where}` }) : null,
    ]),
  );

// "Related tables: Direct | +1 level", Join path and Copy schema as one row
// of compact controls.
function tableActions(id, n) {
  const status = el('span', { class: 'oe-status-inline muted' });
  return el('div', { class: 'oe-actions' }, [
    el('span', { class: 'oe-actions-label', text: 'Related', title: RELATED.title }),
    el('div', { class: 'oe-seg', title: RELATED.title }, RELATED.options.map((o) => el('button', { class: 'oe-btn', text: o.text, title: `Related tables: ${o.title}`, on: { click: () => openNeighborhood(id, o.hops) } }))),
    toolButton('join', '', 'Find a join path from this table', () => openJoin(id), ' oe-join-from'),
    copySchemaButton(id, n, status),
    status,
  ]);
}

// The last tables visited, newest at the right (cut at the left when long),
// each a link back to it, with Back and Forward.
function tableTrailRow(id) {
  const tables = tableTrail(nav, { table: id });
  if (tables.length < 2 && nav.back.length === 0 && nav.forward.length === 0) return null;
  const arrow = (text, title, go, enabled) => el('button', { class: 'oe-trail-btn', text, title, 'aria-label': title, ...(enabled ? {} : { disabled: '' }), on: { click: go } });
  const items = tables.flatMap((t, i) => [
    i > 0 ? el('span', { class: 'sep', text: '›' }) : null,
    t === id ? el('b', { class: 'here', text: short(t), title: t }) : el('button', { class: 'oe-link', text: short(t), title: t, on: { click: () => goToNode(t) } }),
  ]);
  return el('div', { class: 'oe-trail' }, [
    arrow('←', 'Back (←)', back, nav.back.length > 0),
    arrow('→', 'Forward (→)', forward, nav.forward.length > 0),
    el('div', { class: 'items' }, items),
  ]);
}

function nodePanel(id, column = null) {
  const n = data.nodes[id];
  if (!n) return [el('h3', { text: id })];
  const out = data.links.filter((l) => l.from === id && l.to !== id);
  const into = data.links.filter((l) => l.to === id && l.from !== id);
  const self = data.links.filter((l) => l.from === id && l.to === id);
  const sharedOut = data.hubLinks.filter((l) => l.from === id && l.to !== id);
  const sharedIn = data.hubLinks.filter((l) => l.to === id && l.from !== id);
  const drawnHub = [...currentView().querySelectorAll('.hub-routes')].some((g) => g.getAttribute('data-hub') === id);
  const relations = () => [
    chipGroup('References', chipEntries(id, out, (l) => l.to)),
    chipGroup('Referenced by', chipEntries(id, into, (l) => l.from)),
    self.length > 0 ? el('div', { class: 'muted', text: `Also references itself (${self.map((l) => l.fromColumns?.join(', ') ?? '').filter(Boolean).join('; ') || 'self'})` }) : null,
    // Hub relations are badges on the diagram, listed here in full.
    chipGroup('Shared references', chipEntries(id, sharedOut, (l) => l.to)),
    sharedIn.length > 0 ? chipGroup(`Referenced as a shared table${drawnHub ? ', lines shown while selected' : ''}`, chipEntries(id, sharedIn, (l) => l.from), 'shared-in') : null,
  ];
  const count = out.length + into.length + self.length + sharedOut.length + sharedIn.length;
  const bodies = { columns: () => n.columns.map((c) => columnRow(n, c, column)), relations, indexes: () => indexList(n) };
  return [
    tableTrailRow(id),
    panelHeader({
      name: short(id),
      tip: `${id}${n.tableKind ? ` (${n.tableKind.replace('_', ' ')})` : ''}`,
      cluster: n.cluster,
      central: n.central,
      note: n.note,
      extra: [
        n.internalNote ? el('div', { class: 'oe-ph-sub', text: `Internal: ${n.internalNote}` }) : null,
        n.noteSource ? el('div', { class: 'oe-ph-sub', text: `Original: ${n.noteSource}` }) : null,
        n.facts ? el('div', { class: 'oe-ph-facts' }, n.facts.map((f) => factLine(f, 'div'))) : null,
        n.sources ? el('div', { class: 'oe-ph-sub' }, [el('span', { text: 'Reads from ' }), ...n.sources.flatMap((t, i) => [i > 0 ? el('span', { text: ', ' }) : null, link(short(t), () => goToNode(t))])]) : null,
        warningLine(n.warning),
      ],
    }),
    changeList('nodes', id),
    tableActions(id, n),
    el('div', { class: 'oe-hint-row muted', text: `${ADD_KEY_HINT} other tables to select several and share them as one link.` }),
    ...tabbed(panelTabs(n, count).map((t) => ({ ...t, body: bodies[t.id] })), column ? 'columns' : undefined),
  ];
}

function polyPanel(id, poly) {
  const targets = poly.targets.map((t) => ({ id: t, confirmed: isConfirmed('polymorphic', poly.review), db: dbOf(t) !== dbOf(poly.table) ? dbOf(t) : null }));
  return [
    panelHeader({ name: `«${poly.name}»`, tip: `${poly.table}.${poly.typeColumn} / ${poly.idColumn}`, cluster: poly.cluster, note: poly.note }),
    changeList('nodes', id),
    el('div', { class: 'oe-actions' }, [
      el('code', { class: 'oe-code', title: 'Type column / id column on the owner table', text: `${poly.typeColumn} / ${poly.idColumn}` }),
      state.view === NEIGHBORHOOD && state.center === id ? null : el('button', { class: 'oe-btn oe-small', text: 'Show with targets', title: 'Show it with its owner and all its targets', on: { click: () => openNeighborhood(id, 1) } }),
    ]),
    chipGroup('Owner', [{ id: poly.table, confirmed: true, db: null }]),
    chipGroup('Targets', targets),
  ];
}

// Relations between domains `a` and `b` by direction: those whose
// referencing table is in `a` (pointing at keys in `b`), then the others.
function byDirection(a, b) {
  const relations = data.domainLinks[pairId(a, b)] ?? [];
  return [[a, b], [b, a]].map(([from, to]) => ({ from, to, relations: relations.filter((r) => clusterOf(r.from) === from) }));
}

// The relations between two domains (an overview connector), grouped
// by direction ("A → B (n)"), each a chip leading to its referencing
// column in that table's domain view; dashed while not confirmed.
function domainLinkPanel(a, b) {
  const id = pairId(a, b);
  const total = (data.domainLinks[id] ?? []).length;
  const crossDb = dbOf(a) !== dbOf(b);
  // One chip per referencing table and referenced table ("order_items →
  // orders"), its columns in the tooltip; dashed while any of them is
  // not confirmed. A click opens the referencing table.
  const chips = (relations) => {
    const byTables = new Map();
    for (const r of relations) {
      const key = `${r.from}\u0000${r.to}`;
      if (!byTables.has(key)) byTables.set(key, []);
      byTables.get(key).push(r);
    }
    return [...byTables.values()].map((list) => {
      const [r] = list;
      const confirmed = list.every((x) => isConfirmed(x.kind, x.review));
      const title = list.map((x) => [`${short(x.from)}.${x.column} → ${short(x.to)}`, x.cardinality, x.association ? `polymorphic «${x.association}»` : x.kind, x.via ? `via ${short(x.via)}` : null].filter(Boolean).join(' · ')).join('\n');
      return el('button', { class: `oe-chip${confirmed ? '' : ' unconfirmed'}`, title, on: { click: () => navigate(homeView(r.from), { focus: r.from, column: r.column }) } }, [
        el('span', { text: `${short(r.from)} → ${short(r.to)}` }),
        list.length > 1 ? el('span', { class: 'db', text: `×${list.length}` }) : null,
      ]);
    });
  };
  return [
    panelHeader({ tip: crossDb ? `Cross-DB: ${crossing(a, b, '⇄')}` : '', cluster: [a, b], note: `${plural(total, 'relation')} between these two domains${crossDb ? ` · cross-DB` : ''}` }),
    changeList('links', id),
    ...byDirection(a, b)
      .filter((d) => d.relations.length > 0)
      .map((d) => el('div', { class: 'oe-chip-group' }, [el('div', { class: 'sub', text: `${domainName(d.from)} → ${domainName(d.to)} (${d.relations.length})` }), el('div', { class: 'oe-chipbox' }, chips(d.relations))])),
  ];
}

// The domain link panel on screen, for the link: its two domains and its
// first element, to tell it from the panel that replaced it.
let domainLink = null;
function showDomainLink(a, b) {
  const children = domainLinkPanel(a, b);
  domainLink = { pair: [a, b], first: children[0] };
  showPanel(children);
  syncHash();
}
const domainLinkShown = () => domainLink !== null && panel.fo.style.display !== 'none' && panel.div.contains(domainLink.first);

// A line of a domain view standing for several tables of another domain:
// what it says, and those tables as chips.
function groupLinePanel(g) {
  const key = g.getAttribute('data-group');
  const tables = JSON.parse(g.getAttribute('data-tables'));
  return [
    panelHeader({ name: g.getAttribute('data-label'), cluster: key }),
    chipGroup('Tables', tables.map((t) => ({ id: t, confirmed: true, db: null }))),
  ];
}
const groupTables = (box) => JSON.parse(box.getAttribute('data-tables'));

// A clicked line's panel: what kind of fact it is, the relation in one
// sentence, then a card per end (table, its columns, its database); hovering
// a card pulses that table on the drawing, a click goes to it.
const CARDINALITY_WORDS = { '1-1': 'one to one', '1-n': 'one to many', 'n-1': 'many to one', 'n-n': 'many to many' };
const KIND_WORDS = { db_fk: 'Database foreign key', declared: 'Declared in code', inferred: 'Found in code', cross_db: 'Across databases', polymorphic: 'Polymorphic', view_source: 'View source' };
function relationSentence(l) {
  const [f, t] = [short(l.from), short(l.to)];
  const one = l.optional ? 'at most one' : 'one';
  if (l.kind === 'view_source') return `${f} is built from ${t}.`;
  const poly = data.nodes[l.to]?.kind === 'poly' ? data.nodes[l.to] : null;
  if (poly) return `Each ${f} row points to one row of one of ${plural(poly.targets.length, 'table')}; ${poly.typeColumn} says which.`;
  if (l.cardinality === 'n-n') return `Rows of ${f} and ${t} link many to many${l.via ? `, through ${short(l.via)}` : ''}.`;
  if (l.cardinality === '1-n') return `Each ${f} row has many ${t} rows.`;
  if (l.cardinality === '1-1') return `Each ${f} row points to ${one} ${t} row, and each ${t} row has at most one ${f} row.`;
  return `Each ${f} row points to ${one} ${t} row.`;
}
function relationEnd(side, id, columns, showDb) {
  const n = data.nodes[id];
  const table = n?.kind === 'poly' ? n.table : id;
  const name = n?.kind === 'poly' ? `«${n.name}»` : short(id);
  const cols = n?.kind === 'poly' ? [n.typeColumn, n.idColumn] : (columns ?? []);
  return el('button', { class: 'oe-rel-card', title: `Go to ${table}`, on: { click: () => goToNode(table), pointerenter: () => pulse(currentIndex().get(id)?.el) } }, [
    el('span', { class: 'side' }, [el('span', { text: side }), showDb ? el('span', { class: 'db', text: `${dbDisplayName(dbOf(table))} (${data.databases[dbOf(table)].label})` }) : null]),
    el('span', { class: 'name' }, [iconSvg('table', 13), el('span', { text: name })]),
    ...cols.map((c) => el('code', { class: 'col', text: c })),
    n?.kind === 'poly' ? el('span', { class: 'targets', text: `One of: ${n.targets.map(short).join(', ')}` }) : null,
  ]);
}
function relationPanel(g) {
  if (g.hasAttribute('data-group')) return groupLinePanel(g);
  const id = g.getAttribute('data-id');
  const [from, to] = [g.getAttribute('data-from'), g.getAttribute('data-to')];
  const l = data.links.find((x) => x.id === id) ?? data.hubLinks.find((x) => x.id === id);
  const crossDb = dbOf(from) !== dbOf(to);
  return [
    el('h3', { text: `${short(from)} → ${short(to)}` }),
    l
      ? el('div', { class: 'oe-line-facts' }, [
          l.kind === 'view_source' ? null : el('span', { class: `oe-badge review-${l.review}` }, [reviewIcon(l.review), el('span', { text: REVIEW_WORDS[l.review] })]),
          el('span', { class: 'oe-badge', text: KIND_WORDS[l.kind] ?? l.kind }),
          crossDb && l.kind !== 'cross_db' ? el('span', { class: 'oe-badge', text: 'Cross-DB' }) : null,
        ])
      : null,
    l ? el('p', { class: 'oe-rel-sentence', text: relationSentence(l) }) : null,
    relationEnd('From', from, l?.fromColumns, crossDb),
    el('div', { class: 'oe-rel-arrow', text: `↓ ${l && l.kind !== 'view_source' ? CARDINALITY_WORDS[l.cardinality] : 'reads'}${l?.via ? ` · via ${short(l.via)}` : ''}` }),
    relationEnd('To', to, l?.toColumns, crossDb),
    changeList('links', id),
  ];
}

// What changed between the two snapshots of a diff drawing; plain
// drawings have no `changes`.
function changeList(kind, id) {
  const list = data.changes?.[kind][id];
  if (!list) return null;
  return el('div', { class: 'oe-changes' }, [
    el('div', { class: 'sub', text: `Changes from ${data.changes.from} to ${data.changes.to}` }),
    el('ul', {}, list.map((text) => el('li', { text }))),
  ]);
}

// ---------------------------------------------------------------- join path

// Pick two tables, see up to three ways to join them: each hop's condition
// (`a.x_id = b.id`), what to watch out for, and the path lit up on the
// diagram, hop after hop. The conditions copy as text, or as a SQL skeleton
// (see sqlSkeleton) for a path within one database.
// `through`: the tables a path from a link runs through, in order, when more than two.
const join = { open: false, from: null, to: null, paths: [], index: 0, through: null };
const JOIN_STEP_MS = 600;
const JOIN_PICKS = 8;
// Below this scale a path drawn across a large view is too small to read.
const JOIN_MIN_SCALE = 0.45;
let flowTimers = [];
// Counts the paths shown, so a frame callback of a path replaced since
// does nothing.
let flowRun = 0;

function stopFlows() {
  for (const t of flowTimers) clearTimeout(t);
  flowTimers = [];
  flowRun += 1;
}

function openJoin(from = null) {
  join.from = data.nodes[from]?.kind === 'table' ? from : null;
  join.to = null;
  join.paths = [];
  join.through = null;
  showJoin();
}

function showJoin() {
  showPanel(joinPanel());
  join.open = true;
  panel.div.querySelector('.oe-join-field input')?.focus();
}

function setJoinEnd(slot, id) {
  // Changing an end drops the old path's highlight.
  if (id === null) clearSelection();
  join[slot] = id;
  join.through = null;
  join.paths = join.from && join.to ? findJoinPaths(data, join.from, join.to) : [];
  join.index = 0;
  if (join.paths.length > 0) showJoinPath(0);
  else showJoin();
}

// Steps of a path as the diagram draws them: the two hops through a
// collapsed join table are one line.
function joinSteps(path) {
  const steps = [];
  for (const hop of path.hops) {
    const last = steps.at(-1);
    if (last && hop.edge.line.type === 'link' && last.line.id === hop.edge.line.id) last.to = hop.to;
    else steps.push({ line: hop.edge.line, from: hop.from, to: hop.to });
  }
  return steps;
}

const findAttr = (root, selector, attr, value) => [...root.querySelectorAll(selector)].find((e) => e.getAttribute(attr) === value) ?? null;

/**
 * Where step `step` is drawn in view `name`: the line groups to light and
 * the path each flow follows, in walking order, or null when the view lacks
 * part of it.
 */
function stepSegments(name, step, i) {
  const view = views.get(name);
  const along = (g, reverse) => ({ g, d: g.querySelector('path.relation').getAttribute('d'), reverse });
  if (name === JOIN_VIEW) {
    const g = findAttr(view, '.relation-group', 'data-step', String(i));
    return g ? [along(g, g.getAttribute('data-from') !== step.from)] : null;
  }
  if (step.line.type === 'poly') {
    const g = findAttr(view, '.relation-group', 'data-id', step.line.id);
    const routes = findAttr(view, '.poly-routes', 'data-poly', step.line.poly);
    const route = routes && findAttr(routes, '.poly-route', 'data-target', step.line.target);
    if (!g || !route) return null;
    const toTarget = step.to === step.line.target;
    const owner = along(g, !toTarget);
    const target = { g: routes, d: route.getAttribute('d'), reverse: !toTarget, show: routes };
    return toTarget ? [owner, target] : [target, owner];
  }
  const g = findAttr(view, step.line.type === 'hub' ? '.hub-route' : '.relation-group', 'data-id', step.line.id);
  if (!g) return null;
  return [{ ...along(g, g.getAttribute('data-from') !== step.from), ...(step.line.type === 'hub' ? { show: g.parentNode } : {}) }];
}

// Diagram nodes a path lights: its tables (a collapsed join table is part of
// its line) and the polymorphic nodes its lines run through.
const stepNodes = (steps) => [...new Set(steps.flatMap((s) => [s.from, s.to, ...(s.line.type === 'poly' ? [s.line.poly] : [])]))];

// Box around nodes `ids` in a view, with room around it.
const joinBounds = (index, steps) => boundsOf(index, stepNodes(steps));
function boundsOf(index, ids) {
  const boxes = ids.map((id) => index.get(id)?.box).filter(Boolean);
  const x0 = Math.min(...boxes.map((b) => b.x)) - FOCUS_MARGIN / 2;
  const y0 = Math.min(...boxes.map((b) => b.y)) - FOCUS_MARGIN / 2;
  return { x: x0, y: y0, w: Math.max(...boxes.map((b) => b.x + b.w)) - x0 + FOCUS_MARGIN / 2, h: Math.max(...boxes.map((b) => b.y + b.h)) - y0 + FOCUS_MARGIN / 2 };
}

/**
 * A drawn view showing every step of the path, preferring the one on
 * screen, and only where the path, fitted beside the panel, stays large
 * enough to read; else none (the path gets a view of its own).
 */
function joinViewFor(steps) {
  const clusters = stepNodes(steps).map(clusterOf).filter(Boolean).map(domainView);
  const names = [state.view, ALL_VIEW, ...clusters, ...[...views.keys()].filter((n) => n.startsWith(DOMAIN_PREFIX))];
  const { w, h } = viewport();
  return names.find((name) => {
    if (!views.has(name) || name === OVERVIEW || name === NEIGHBORHOOD) return false;
    if (name === JOIN_VIEW && state.joinPath !== join.paths[join.index]) return false;
    if (!stepNodes(steps).every((id) => indexes.get(name).has(id)) || !steps.every((s, i) => stepSegments(name, s, i))) return false;
    const b = joinBounds(indexes.get(name), steps);
    return name === JOIN_VIEW || Math.min((w - PANEL_WIDTH - 2 * PANEL_MARGIN) / b.w, (h - TOOLBAR_HEIGHT) / b.h) >= JOIN_MIN_SCALE;
  });
}

/**
 * The fallback view of a path no drawn view holds (tables of several
 * domains in a schema too large for the view of all tables): its tables
 * in a row, joined by straight lines, one per step.
 */
function buildJoinView(path) {
  views.get(JOIN_VIEW)?.remove();
  const steps = joinSteps(path);
  const ids = [...new Set(steps.flatMap((s) => [s.from, s.to]))].filter((id) => fullBoxes.has(id));
  const boxes = new Map();
  const offsets = new Map();
  const nodes = svgEl('g', { class: 'nodes' });
  let x = 0;
  for (const id of ids) {
    const { el: g, box } = fullBoxes.get(id);
    boxes.set(id, { x, y: 0, w: box.w, h: box.h });
    offsets.set(id, { dx: x - box.x, dy: -box.y });
    const copy = g.cloneNode(true);
    copy.classList.remove('hl', 'selected', 'flow-target', 'reached', 'oe-hidden', 'arrive');
    nodes.append(svgEl('g', { transform: `translate(${x - box.x} ${-box.y})` }, [copy]));
    x += box.w + 2 * RING_GAP + 40;
  }
  const relations = svgEl('g', { class: 'relations' });
  steps.forEach((s, i) => {
    const l = s.line.type === 'poly'
      ? { id: `${s.line.poly}->${s.line.target}`, cardinality: 'n-1', optional: true, kind: 'polymorphic', review: data.nodes[s.line.poly].review, from: data.nodes[s.line.poly].table, to: s.line.target }
      : [...data.links, ...data.hubLinks].find((x) => x.id === s.line.id);
    // Drawn as the relation points, so its crow's feet stay right.
    const g = straightRelation(l, l.from, l.to, boxes);
    g.setAttribute('data-step', String(i));
    relations.append(g);
  });
  const all = [...boxes.values()];
  const x0 = -NEIGHBORHOOD_MARGIN;
  const y1 = Math.max(...all.map((b) => b.h)) + NEIGHBORHOOD_MARGIN;
  const x1 = Math.max(...all.map((b) => b.x + b.w)) + NEIGHBORHOOD_MARGIN;
  const view = svgEl('g', { class: 'view', 'data-view': JOIN_VIEW, 'data-bounds': `${x0} ${-NEIGHBORHOOD_MARGIN} ${x1 - x0} ${y1 + NEIGHBORHOOD_MARGIN}`, style: 'display:none' }, [
    svgEl('rect', { x: x0, y: -NEIGHBORHOOD_MARGIN, width: x1 - x0, height: y1 + NEIGHBORHOOD_MARGIN, fill: '#ffffff' }),
    relations,
    nodes,
  ]);
  camera.append(view);
  views.set(JOIN_VIEW, view);
  indexes.set(JOIN_VIEW, indexView(view, offsets));
  state.joinPath = path;
}

// "M1 2L3 4" walked backwards, for a flow against the line's direction.
const reversed = (d) => {
  const points = [...d.matchAll(/[ML]\s*(-?[\d.e]+)[ ,](-?[\d.e]+)/g)].map((m) => [m[1], m[2]]);
  return linePath(points.reverse());
};

/** Shows path `i`: on a view that holds it, lit hop after hop. */
function showJoinPath(i) {
  join.index = i;
  const path = join.paths[i];
  const steps = joinSteps(path);
  let name = joinViewFor(steps);
  if (!name) {
    if (state.view !== JOIN_VIEW) recordVisit();
    buildJoinView(path);
    name = JOIN_VIEW;
    showView(JOIN_VIEW);
  } else if (name !== state.view) {
    recordVisit();
    showView(name);
  }
  clearSelection();
  for (const id of stepNodes(steps)) unfoldFor(id);
  const index = currentIndex();
  const view = currentView();
  view.classList.add('dimmed');
  index.get(join.from)?.el.classList.add('hl', 'selected');
  const segments = steps.map((s, k) => stepSegments(name, s, k));
  // The path is walked hop after hop from the first table, the rest faded:
  // each step lights its line (and the polymorphic node it runs through),
  // sets its dashes off and flashes the table it reaches; the last table
  // keeps pulsing. The first step waits for the view to be drawn, and each
  // step is timed from the one before: a large view still drawing past a
  // step's time would otherwise start every step at once.
  const flowStep = (k) => {
    for (const seg of segments[k]) {
      seg.g.classList.add('hl', 'flowing');
      if (seg.show) seg.show.style.display = '';
      seg.g.append(svgEl('path', { class: 'flow', d: seg.reverse ? reversed(seg.d) : seg.d }));
    }
    if (steps[k].line.type === 'poly') index.get(steps[k].line.poly)?.el.classList.add('hl');
    const reached = index.get(steps[k].to)?.el;
    if (k === segments.length - 1) reached?.classList.add('hl', 'selected', 'flow-target');
    else {
      reached?.classList.add('hl', 'reached');
      flowTimers.push(setTimeout(() => flowStep(k + 1), JOIN_STEP_MS));
    }
  };
  const run = flowRun;
  if (segments.length > 0) requestAnimationFrame(() => run === flowRun && flowTimers.push(setTimeout(() => flowStep(0), 0)));
  showJoin();
  // The legend sits bottom left, where the fitted path would run under it.
  setLegend(false);
  zoomToRect(joinBounds(index, steps), FOCUS_MAX_SCALE);
  syncHash();
}

// A table field of the join panel: the chosen table, or a search box over
// table names (the toolbar's search, tables only).
function joinField(slot, label) {
  const chosen = join[slot];
  if (chosen) {
    return el('div', { class: 'row oe-join-end' }, [
      el('span', { class: 'label-inline', text: label }),
      el('b', { text: short(chosen), title: chosen }),
      link('change', () => setJoinEnd(slot, null)),
    ]);
  }
  const list = el('div', { class: 'oe-join-picks' });
  const input = el('input', { type: 'search', placeholder: 'Table name', 'aria-label': `${label} table` });
  const hits = () => [...new Set(search(input.value).filter((h) => !h.column).map((h) => h.id))].slice(0, JOIN_PICKS);
  input.addEventListener('input', () => {
    list.replaceChildren(...hits().map((id) => el('button', { class: 'oe-result', on: { click: () => setJoinEnd(slot, id) } }, [el('div', { text: short(id) }), el('div', { class: 'where', text: id })])));
    layoutOverlays();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && hits()[0]) setJoinEnd(slot, hits()[0]);
    e.stopPropagation();
  });
  return el('div', { class: 'oe-join-field' }, [el('div', { class: 'row' }, [el('span', { class: 'label-inline', text: label }), input]), list]);
}

const FLAG_TEXT = {
  trust: (f) => f.text,
  cross_db: () => 'cross-DB',
  polymorphic: (f) => `filter by ${f.column}`,
  multiplies: () => 'repeats rows (1 → many)',
  shared_parent: (f) => `via shared ${short(f.table)}`,
};

// Runs of at least two paths of one cost, as [first, last] numbers from 1.
function tiedPaths(paths) {
  const runs = [];
  paths.forEach((p, i) => {
    if (i > 0 && p.cost === paths[i - 1].cost) {
      if (runs.at(-1)?.[1] === i) runs.at(-1)[1] = i + 1;
      else runs.push([i, i + 1]);
    }
  });
  return runs;
}

function joinPanel() {
  const path = join.paths[join.index];
  const parts = [
    el('h3', { text: 'Join path' }),
    el('div', { class: 'sub', text: 'How two tables join: the condition of each hop.' }),
    joinField('from', 'From'),
    joinField('to', 'To'),
    !join.from || !join.to ? el('p', { class: 'muted', text: 'Type a name, or click a table on the diagram.' }) : null,
  ];
  if (join.from && join.to && !path) parts.push(el('p', { text: 'No path joins these tables through the relations in this diagram.' }));
  if (!path) return parts;
  const name = pathNames(path.nodes);
  parts.push(
    el('div', { class: 'muted', text: 'Shortest first; unconfirmed relations, hub tables and detours through a shared parent count as longer.' }),
    el('div', { class: 'oe-seg oe-paths' }, join.paths.map((p, i) => el('button', { class: `oe-btn${i === join.index ? ' on' : ''}`, text: `Path ${i + 1} · ${plural(p.hops.length, 'hop')}`, on: { click: () => showJoinPath(i) } }))),
    ...tiedPaths(join.paths).map(([a, b]) => el('div', { class: 'muted oe-ties', text: `Paths ${a}–${b} rank the same.` })),
    el(
      'ol',
      { class: 'oe-hops' },
      path.hops.map((h) =>
        el('li', {}, [
          el('code', { text: hopCondition(h, name) }),
          h.flags.length > 0
            ? el('div', { class: 'oe-chips' }, h.flags.map((f) => (f.review ? reviewIcon(f.review) : el('span', { class: `chip flag-${f.type}`, text: FLAG_TEXT[f.type](f) }))))
            : null,
          // Other relations between the same two tables: the referencing
          // columns here, the full conditions in the tooltip.
          h.alternatives?.length > 0
            ? el('div', { class: 'muted oe-alt', title: h.alternatives.map((a) => hopCondition(a, name)).join('\n'), text: `also joins on ${h.alternatives.map((a) => a.edge.aColumns.join(' + ')).join(', ')}` })
            : null,
        ]),
      ),
    ),
  );
  const dbs = [...new Set(path.nodes.map((id) => id.split('.')[0]))];
  const hubs = path.hops.filter((h, i) => h.hub && i < path.hops.length - 1).map((h) => short(h.to));
  const warnings = [
    dbs.length > 1 ? `Spans ${dbs.length} databases (${dbs.join(', ')}): this cannot be one query; join the results in the application.` : null,
    path.hops.some((h) => h.flags.some((f) => f.type === 'trust')) ? 'Some hops are not confirmed yet (inferred or pending review): check them in the code first.' : null,
    path.hops.some((h) => h.flags.some((f) => f.type === 'multiplies')) ? 'A hop going from one row to many repeats the rows before it: count or deduplicate with care.' : null,
    path.hops.some((h) => h.flags.some((f) => f.type === 'shared_parent')) ? 'Goes up to a parent table and back down: it joins rows only because they share that parent row. Check that this is the link you mean.' : null,
    hubs.length > 0 ? `Passes through ${hubs.join(', ')}, a table shared by everything: rows meet only because they share it.` : null,
  ].filter(Boolean);
  const status = el('span', { class: 'muted' });
  const skeleton = sqlSkeleton(path);
  const sqlButton = el('button', {
    class: 'oe-btn',
    text: 'Copy SQL',
    title: skeleton.blocked ?? 'SELECT * with one JOIN per hop and a comment above each hop to check; review it before running',
    ...(skeleton.blocked ? { disabled: '' } : {}),
    on: { click: () => copyText(skeleton.sql, status, 'SQL') },
  });
  parts.push(
    ...warnings.map((w) => el('p', { class: 'oe-warn', text: w })),
    el('div', { class: 'row' }, [sqlButton, status]),
    skeleton.blocked ? el('p', { class: 'muted', text: `No SQL: ${skeleton.blocked}` }) : null,
  );
  return parts;
}

// Copies `text`; `status` then says what was copied and keeps saying it
// until another copy or until its panel is redrawn.
function copyText(text, status, what, then = () => {}) {
  const done = () => {
    status.textContent = `Copied ${what}`;
    then();
  };
  // A page opened from disk may have no clipboard API: select the text in a
  // field and copy that instead.
  const fallback = () => {
    const area = el('textarea', { style: 'position:absolute;left:-9999px' });
    area.value = text;
    panel.div.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    if (ok) done();
    else status.textContent = 'Copy is blocked in this browser.';
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, fallback);
  else fallback();
}

// ---------------------------------------------------------------- legend

// Samples drawn with the diagram's own classes and marker shapes, so the
// legend always looks like what it explains. It lists only what the view on
// screen draws (review colours only in review mode), rebuilt whenever the
// view or the mode changes. Open by default, folded to its pill in the
// views it would cover part of from its corner: the overview (cards reach
// the bottom left) and a neighbourhood (rings fitted to the whole screen).
const legend = overlay('oe-legend-host');
const LEGEND_ROOM = 8;
const LEGEND_FOLDED_VIEWS = [OVERVIEW, NEIGHBORHOOD];
legend.fo.style.display = 'none';
// The reader's choice, and whether the view on screen folds it anyway
// (until the reader opens or hides it there).
let legendOpen = true;
let legendFolded = false;

const sample = (children) => svgEl('svg', { width: 64, height: 18, viewBox: '0 0 64 18' }, children);
// A line arriving at a box edge on the right, with end marker `kind`.
const endSample = (kind) =>
  sample([
    svgEl('g', { class: 'relation-group kind-db_fk review-reviewed' }, [
      svgEl('path', { class: 'relation', d: 'M2 9H52' }),
      svgEl('g', { class: 'marker' }, [markerGroup(kind, 'translate(52 9) rotate(180)')]),
    ]),
    svgEl('rect', { class: 'table-box', x: 52, y: 1, width: 10, height: 16 }),
  ]);
const lineSample = (classes, width) =>
  sample([svgEl('g', { class: `relation-group ${classes}` }, [svgEl('path', { class: 'relation', d: 'M2 9H44', ...(width ? { style: `stroke-width:${width}` } : {}) })])]);
// A review-mode line sample followed by the review state's icon.
const reviewSample = (classes, state) => sample([...lineSample(classes).childNodes, svgEl('g', {}, parsed(reviewIconSvg(state, 54, 9)))]);
const iconSample = (markup) => sample(parsed(markup));
const has = (view, selector) => view.querySelector(selector) !== null;
// End marker kinds the view draws, as its marker groups list them.
const endKinds = (view) => new Set([...view.querySelectorAll('.marker[data-ends]')].flatMap((g) => g.getAttribute('data-ends').split(' ')));
const reviewing = () => svg.classList.contains('review-mode');
// What lines and boxes mean: card strength bars and connectors, solid and
// dashed lines, line ends, the icons and marks in boxes, and, in review
// mode only, the review colours and icons. Each entry is listed only while
// the view on screen draws it.
const strengthSample = () => sample([0, 1, 2, 3, 4].map((i) => svgEl('rect', { class: `seg${i < 3 ? ' on' : ''}`, x: 2 + i * 11, y: 6, width: 9, height: 6, rx: 1 })));
const connectorSample = (count, crossDb) => sample([connectorEl('M2 14C20 14 26 4 44 4', count, crossDb)]);
// A table box as the Changes mode fades it (opacities from render.js).
const fadedSample = (opacity) =>
  sample([svgEl('g', { opacity }, [svgEl('rect', { class: 'table-box', x: 1, y: 1, width: 62, height: 16, rx: 3 }), svgEl('text', { class: 'table-title', x: 6, y: 9, 'dominant-baseline': 'central', text: 'orders' })])]);
const LEGEND = [
  ['Domain cards', [
    [strengthSample, 'Relations with that domain: more filled, more relations', (v) => has(v, '.card-related')],
    [() => connectorSample(1, false), 'Hover a card: few relations', (v) => has(v, '.domain')],
    [() => connectorSample(5, false), 'some relations', (v) => has(v, '.domain')],
    [() => connectorSample(12, false), 'many relations', (v) => has(v, '.domain')],
    [() => connectorSample(3, true), 'Domain in another database', (v) => has(v, '.card-db')],
  ]],
  ['Changes', [
    ...['added', 'changed', 'renamed', 'removed'].map((status) => [
      () => sample([svgEl('rect', { class: `legend-swatch diff-${status}`, x: 1, y: 3, width: 12, height: 12, rx: 2 })]),
      `${status[0].toUpperCase()}${status.slice(1)}`,
      // The banner's own swatches are in every view: only drawn elements count.
      (v) => has(v, `.diff-${status}:not(.legend-swatch), .col-${status}`),
    ]),
    [() => fadedSample(0.55), 'Unchanged, at the end of a changed line', (v) => changesOn() && has(v, '.near-change')],
    [() => fadedSample(0.16), 'Unchanged (C shows it at full strength)', (v) => changesOn()],
  ]],
  ['Review mode', [
    [() => reviewSample('kind-db_fk review-reviewed', 'reviewed'), REVIEW_WORDS.reviewed, (v) => reviewing() && has(v, '.relation-group.review-reviewed')],
    [() => reviewSample('kind-declared review-pending', 'pending'), REVIEW_WORDS.pending, (v) => reviewing() && has(v, '.relation-group.review-pending')],
    [() => reviewSample('kind-declared review-stale unconfirmed', 'stale'), REVIEW_WORDS.stale, (v) => reviewing() && has(v, '.relation-group.review-stale')],
  ]],
  ['Personal data', [
    [() => sample([svgEl('rect', { class: 'legend-pii', x: 1, y: 2, width: 62, height: 14, rx: 2 }), svgEl('text', { class: 'legend-pii-text', x: 6, y: 9, 'dominant-baseline': 'central', text: 'email' })]), 'Column marked as personal data (PII)', (v) => piiOn() && has(v, '.column.pii')],
    [() => sample([svgEl('rect', { class: 'legend-pii-card', x: 1, y: 1, width: 62, height: 16, rx: 4 })]), 'Domain with personal data', (v) => piiOn() && has(v, '.domain.has-pii')],
  ]],
  ['Schema health', [
    [() => sample([svgEl('rect', { class: 'stub-box', x: 1, y: 6, width: 54, height: 11, rx: 3 }), svgEl('path', { class: 'col-warn', d: 'M49 12L55 1L61 12Z' })]), 'Table with a health finding', (v) => healthOn() && has(v, '.has-health')],
  ]],
  ['Lines', [
    [() => lineSample('kind-db_fk'), 'Confirmed relation', (v) => !reviewing() && has(v, '.relation-group:not(.unconfirmed, .kind-view_source)')],
    [() => lineSample('kind-declared unconfirmed'), 'Found in code, not confirmed yet', (v) => !reviewing() && has(v, '.relation-group.unconfirmed, .poly-route.unconfirmed')],
    [() => lineSample('kind-view_source'), 'Read by a database view', (v) => has(v, '.kind-view_source')],
  ]],
  ['Line ends', [
    ['one', 'Exactly one'],
    ['zeroOrOne', 'Zero or one'],
    ['many', 'One or more'],
    ['zeroOrMany', 'Zero or more'],
  ].map(([kind, text]) => [() => endSample(kind), text, (v) => endKinds(v).has(kind)])],
  ['In boxes', [
    [() => sample([svgEl('rect', { class: 'legend-central', x: 1, y: 2, width: 62, height: 14, rx: 3 }), ...parsed(starIconSvg(9, 9))]), 'Most connected table of its domain', (v) => has(v, '.table.central')],
    [() => iconSample(keyIconSvg(10, 9)), 'Primary key', (v) => has(v, '.icon-pk')],
    [() => iconSample(linkIconSvg(9, 9)), 'Foreign key', (v) => has(v, '.icon-fk')],
    [() => iconSample(indexIconSvg(8, 9)), 'Column in an index', (v) => has(v, '.icon-index')],
    [() => iconSample(enumIconSvg(8, 9)), 'Column with listed values', (v) => has(v, '.hint-enum')],
    [() => sample([svgEl('path', { class: 'col-warn', d: 'M4 13L8 5L12 13Z' })]), 'Possible missing relation', (v) => has(v, '.col-warn')],
    [() => sample([svgEl('path', { class: 'badge-arrow', d: 'M2 9H14M10 6L14 9L10 12' }), svgEl('text', { class: 'badge-text', x: 18, y: 9, 'dominant-baseline': 'central', text: 'users' })]), 'Reference to a hub table, no line drawn', (v) => has(v, '.hub-badge')],
    [() => sample([svgEl('rect', { class: 'table-box', x: 1, y: 1, width: 62, height: 16, rx: 3, style: 'stroke-dasharray:5 3' }), svgEl('text', { class: 'table-title', x: 6, y: 9, 'dominant-baseline': 'central', text: 'report' })]), 'Database view', (v) => has(v, '.table.is-view')],
    [() => sample([svgEl('rect', { class: 'stub-box', x: 1, y: 1, width: 62, height: 16, rx: 4 }), svgEl('text', { class: 'stub-title', x: 6, y: 9, 'dominant-baseline': 'central', text: 'tables' })]), 'Linked table in another domain: click to open', (v) => has(v, '.stub')],
    [() => sample([svgEl('rect', { class: 'poly-box', x: 1, y: 1, width: 62, height: 16, rx: 4 }), svgEl('text', { class: 'poly-title', x: 6, y: 9, 'dominant-baseline': 'central', text: '«able»' })]), 'Polymorphic: one column pair points at several tables', (v) => has(v, '.poly')],
  ]],
];

// Legend sections with something the view on screen draws.
const legendSections = (view = currentView()) => LEGEND.map(([title, items]) => [title, items.filter(([, , present]) => present(view))]).filter(([, items]) => items.length > 0);
function renderLegend() {
  const sections = legendSections();
  legend.div.replaceChildren(
    el('div', { class: 'oe-legend' }, [
      el('div', { class: 'head' }, [el('b', { text: 'Legend' }), el('button', { class: 'oe-link', text: 'Hide', on: { click: () => setLegend(false) } })]),
      ...sections.flatMap(([title, items]) => [el('div', { class: 'sub', text: title }), ...items.map(([draw, text]) => el('div', { class: 'item' }, [draw(), el('span', { text })]))]),
    ]),
  );
}

// Folded, the legend is a small card in the same corner, a pair with the
// minimap across the bottom: the toolbar's legend icon, "Legend", and a
// chevron saying it opens upwards.
function legendPill() {
  return el('button', { class: 'oe-legend-pill', title: 'What the marks in this view mean (L)', 'aria-label': 'Show the legend', on: { click: () => setLegend(true) } }, [
    iconSvg('legend'),
    el('span', { text: 'Legend' }),
    svgEl('svg', { class: 'oe-icon oe-chevron', width: 12, height: 12, viewBox: '0 0 16 16', 'aria-hidden': 'true' }, [svgEl('path', { d: 'M4.5 10L8 6.5L11.5 10' })]),
  ]);
}

// A "?" beside the legend (or alone in its corner), so a first-time reader
// finds the keyboard shortcuts without opening a menu.
const help = overlay('oe-help-host');
help.div.append(
  el('button', { class: 'oe-help', title: 'Keyboard shortcuts (?)', 'aria-label': 'Keyboard shortcuts', on: { click: () => showShortcuts() } }, [el('span', { text: '?' })]),
);

// The reader opens or hides the legend: kept for the next views.
function setLegend(open) {
  legendOpen = open;
  legendFolded = false;
  showLegend();
}
const legendShown = () => legendOpen && !legendFolded;

// A view with nothing to explain shows neither the legend nor its pill.
function showLegend() {
  const empty = legendSections().length === 0;
  if (empty) legend.div.replaceChildren();
  else if (legendShown()) renderLegend();
  else legend.div.replaceChildren(legendPill());
  // The tour clears the corner for its caption.
  legend.fo.style.display = empty || tour.on ? 'none' : '';
  help.fo.style.display = tour.on ? 'none' : '';
  layoutOverlays();
}

// While review mode is on, a chip under the toolbar says so and how much
// waits for review: List reopens the list of what waits, × turns the mode off.
const reviewChip = overlay('oe-review-chip-host');
reviewChip.fo.style.display = 'none';
reviewChip.div.append(
  el('div', { class: 'oe-review-chip', title: 'Lines are coloured by review status: amber = not confirmed yet, red = code changed since review' }, [
    el('span', { text: `Review mode: ${data.review.pending} to confirm, ${data.review.stale} changed` }),
    el('button', { class: 'oe-link', text: 'List', title: 'List what waits for review, by domain', on: { click: () => showReviewList() } }),
    el('button', { class: 'oe-chip-close', text: '×', title: 'Turn review mode off', 'aria-label': 'Turn review mode off', on: { click: () => setReviewMode(false) } }),
  ]),
);

// What waits for review in every view at once: the lines and polymorphic
// associations not confirmed yet (pending) or changed in code since
// (stale), grouped by the domain of their referencing table, most
// connected domain first, stale first. A click opens the line (or the
// polymorphic node) in its domain view and keeps the list open. On the
// overview, the cards of those domains carry an amber border and the
// others fade.
const REVIEW_STATES = ['stale', 'pending'];
const REVIEW_ITEMS = [
  ...[...data.links, ...data.hubLinks].filter((l) => REVIEW_STATES.includes(l.review)).map((l) => ({ id: l.id, from: l.from, to: l.to, columns: l.fromColumns ?? [], review: l.review, cluster: clusterOf(l.from) })),
  ...Object.entries(data.nodes)
    .filter(([, n]) => n.kind === 'poly' && REVIEW_STATES.includes(n.review))
    .map(([id, n]) => ({ id, poly: n, from: n.table, columns: [n.typeColumn, n.idColumn], review: n.review, cluster: n.cluster })),
].sort((a, b) => data.domainOrder.indexOf(a.cluster) - data.domainOrder.indexOf(b.cluster) || REVIEW_STATES.indexOf(a.review) - REVIEW_STATES.indexOf(b.review) || byId(a.from, b.from) || byId(a.id, b.id));
const reviewedDomains = new Set(REVIEW_ITEMS.map((i) => i.cluster));
for (const [key, { el: card }] of indexes.get(OVERVIEW)) if (reviewedDomains.has(key)) card.classList.add('has-review');

let reviewPanel = null;
function reviewListPanel() {
  if (reviewPanel) return reviewPanel;
  const go = (item) => () => {
    const scroll = panel.div.scrollTop;
    if (item.poly) goToNode(item.id);
    else {
      if (!findAttr(currentView(), '.relation-group, .hub-route', 'data-id', item.id)) navigate(homeView(item.from));
      if (!selectLinked({ line: { value: item.id } })) goToNode(item.from, item.columns[0]);
    }
    showReviewList(scroll);
  };
  const groups = new Map();
  for (const item of REVIEW_ITEMS) groups.set(item.cluster, [...(groups.get(item.cluster) ?? []), item]);
  reviewPanel = [
    panelHeader({ name: 'To review', note: `${reviewCounts()}. A click opens the line in its domain; /open-erd:review goes through them with the evidence from the code.` }),
    ...[...groups].map(([cluster, items]) =>
      el('div', { class: 'oe-chip-group' }, [
        el('div', { class: 'oe-review-domain' }, [domainChip(cluster), el('span', { class: 'muted', text: String(items.length) })]),
        ...items.map((item) =>
          el('button', { class: 'oe-review-item', title: `${REVIEW_WORDS[item.review]}: go to ${item.id}`, on: { click: go(item) } }, [
            reviewIcon(item.review),
            el('span', { text: item.poly ? `${short(item.from)} «${item.poly.name}» (${item.columns.join(', ')})` : `${short(item.from)}.${item.columns.join(', ')} → ${short(item.to)}` }),
          ]),
        ),
      ]),
    ),
  ];
  return reviewPanel;
}
function showReviewList(scroll = 0) {
  showPanel(reviewListPanel());
  panel.div.scrollTop = scroll;
}
const reviewListShown = () => reviewPanel !== null && panel.fo.style.display !== 'none' && panel.div.contains(reviewPanel[0]);

function setReviewMode(on) {
  svg.classList.toggle('review-mode', on);
  reviewChip.fo.style.display = on ? '' : 'none';
  if (on) showReviewList();
  else if (reviewListShown()) hidePanel();
  updateHighlightButton();
  showLegend();
  layoutOverlays();
}

// ---------------------------------------------------------------- PII mode

// The personal data map (Highlight › Personal data, or P; offered only when some
// column is marked `pii`, see PII): tables holding such columns stay
// readable with those rows tinted, everything else fades, in every view
// until turned off. A selection takes over the fading while it lasts. A
// chip under the toolbar says the mode is on: List reopens the summary, ×
// turns it off. The summary panel counts the columns per domain, then per
// table, most first; a click goes to the table or column and keeps the
// list open. Esc turns the mode off (see the Escape handler). The
// mode is a class on the root, so a download keeps it, like review mode.
const piiOn = () => svg.classList.contains('pii-mode');
const PII_COUNTS = `${plural(PII.total, 'column')} in ${plural(PII.tables, 'table')}`;
const PII_TIP = 'Tint the columns marked as personal data and fade everything else';
const piiChip = overlay('oe-pii-chip-host');
piiChip.fo.style.display = 'none';
piiChip.div.append(
  el('div', { class: 'oe-review-chip oe-pii-chip', title: 'Columns marked as personal data are tinted; everything else fades' }, [
    el('span', { text: `PII: ${PII_COUNTS}` }),
    el('button', { class: 'oe-link', text: 'List', title: 'Show the personal data columns by domain and table', on: { click: () => showPiiSummary() } }),
    el('button', { class: 'oe-chip-close', text: '×', title: 'Turn the personal data map off (P)', 'aria-label': 'Turn the personal data map off', on: { click: () => setPiiMode(false) } }),
  ]),
);

// Built once and reused, so a domain folded by the reader stays folded
// when the list comes back after a jump.
let piiPanel = null;
function piiSummaryPanel() {
  if (piiPanel) return piiPanel;
  const go = (id, column) => () => {
    const scroll = panel.div.scrollTop;
    goToNode(id, column);
    showPiiSummary(scroll);
  };
  // A tree: domain (folds), its tables, each table's columns one per line.
  piiPanel = [
    panelHeader({ name: 'Personal data (PII)', note: `${PII_COUNTS} in ${plural(PII.domains.length, 'domain')}` }),
    ...PII.domains.map((d) =>
      el('details', { class: 'oe-pii-domain', open: '' }, [
        el('summary', { title: d.cluster }, [
          el('span', { class: 'name' }, [DATABASES.length > 1 ? el('span', { class: 'db', text: `${dbDisplayName(dbOf(d.cluster))} · ` }) : null, el('span', { text: domainName(d.cluster) })]),
          el('span', { class: 'n', text: String(d.count) }),
        ]),
        ...d.tables.map((t) =>
          el('div', { class: 'oe-pii-table' }, [
            el('button', { class: 'oe-pii-tname', title: `Go to ${t.id}`, on: { click: go(t.id) } }, [iconSvg('table', 13), el('span', { class: 'name', text: short(t.id) }), el('span', { class: 'n', text: plural(t.columns.length, 'column') })]),
            ...t.columns.map((c) => el('button', { class: 'oe-pii-col', title: `Go to ${short(t.id)}.${c}`, text: c, on: { click: go(t.id, c) } })),
          ]),
        ),
      ]),
    ),
  ];
  return piiPanel;
}
function showPiiSummary(scroll = 0) {
  showPanel(piiSummaryPanel());
  panel.div.scrollTop = scroll;
}
const piiSummaryShown = () => piiPanel !== null && panel.fo.style.display !== 'none' && panel.div.contains(piiPanel[0]);

function setPiiMode(on) {
  if (PII.total === 0) return;
  svg.classList.toggle('pii-mode', on);
  piiChip.fo.style.display = on ? '' : 'none';
  // A selection would fade the map it was asked for.
  if (on) {
    clearSelection();
    // A view seen whole is fitted again left of the panel, as when a panel opens on a neighborhood.
    const whole = fitsInside(viewBounds(state.view), visibleRect(state.cam, viewport(), TOOLBAR_HEIGHT, 0));
    showPiiSummary();
    if (whole) zoomToRect(viewBounds(state.view), MAX_FIT_SCALE);
  } else if (piiSummaryShown()) hidePanel();
  updateHighlightButton();
  showLegend();
  layoutOverlays();
  placeBackPill();
}

// ---------------------------------------------------------------- changes mode

// The Changes mode of a diff drawing (Highlight › Changes, or C; offered
// only in a diff that marks something, see CHANGES): tables, lines and
// domain cards the diff did not change fade, as around a selection, in
// every view until turned off; the tables at the end of a changed line fade
// only half (render.js styles both). It is on when the file opens: the
// renderer puts the class in the static markup. A selection takes over the
// fading while it lasts, and clearing it brings the fade back. A chip under
// the toolbar says the mode is on: List shows the changed tables with what
// changed in each, a click goes to the table and keeps the list open; ×
// turns the mode off. The mode is a class on the root, so a download keeps it.
const changesOn = () => svg.classList.contains('changes-mode');
const CHANGES_TIP = 'Fade the tables and lines this diff did not change';
const changesChip = overlay('oe-changes-chip-host');
changesChip.fo.style.display = 'none';
if (CHANGES) {
  changesChip.div.append(
    el('div', { class: 'oe-review-chip oe-changes-chip', title: 'What did not change is faded' }, [
      el('span', { text: `Changes: ${CHANGES.label}` }),
      el('button', { class: 'oe-link', text: 'List', title: 'Show the changed tables and what changed in each', on: { click: () => showChangesList() } }),
      el('button', { class: 'oe-chip-close', text: '×', title: 'Show everything at full strength (C)', 'aria-label': 'Turn the changes highlight off', on: { click: () => setChangesMode(false) } }),
    ]),
  );
}

// Built once and reused, so the scroll position comes back after a jump.
let changesPanel = null;
function changesListPanel() {
  if (changesPanel) return changesPanel;
  const go = (id) => () => {
    const scroll = panel.div.scrollTop;
    goToNode(id);
    showChangesList(scroll);
  };
  changesPanel = [
    panelHeader({ name: 'Changes', note: `From ${data.changes.from} to ${data.changes.to}: ${CHANGES.label}` }),
    ...CHANGES.tables.map((t) =>
      el('div', { class: 'oe-change-table' }, [
        el('div', { class: 'oe-health-head' }, [
          el('span', { class: `oe-badge diff-${t.status ?? 'none'}`, text: t.status ?? 'relation', title: t.status ? `Table ${t.status}` : 'Only a relation at this table changed' }),
          el('button', { class: 'oe-link', text: short(t.id), title: `Go to ${t.id}`, on: { click: go(t.id) } }),
        ]),
        el('ul', {}, t.sentences.map((text) => el('li', { text }))),
      ]),
    ),
  ];
  return changesPanel;
}
function showChangesList(scroll = 0) {
  showPanel(changesListPanel());
  panel.div.scrollTop = scroll;
}
const changesListShown = () => changesPanel !== null && panel.fo.style.display !== 'none' && panel.div.contains(changesPanel[0]);

function setChangesMode(on) {
  if (!CHANGES) return;
  svg.classList.toggle('changes-mode', on);
  changesChip.fo.style.display = on ? '' : 'none';
  // A selection would hide the fade that was asked for.
  if (on) clearSelection();
  else if (changesListShown()) hidePanel();
  updateHighlightButton();
  showLegend();
  layoutOverlays();
  placeBackPill();
}

// ---------------------------------------------------------------- health mode

// Schema health (Highlight › Schema health, or H; offered only when the render has
// findings, see model/health.js): each table with a finding gets a small
// amber triangle and its columns in a finding a tint, in every view until
// turned off. A chip under the toolbar says the mode is on: List reopens
// the findings, × turns it off. The list shows every finding in the
// engine's order (medium first), filterable by severity; a click on the
// table or a column goes there and keeps the list open. Ticked findings
// light their tables and columns, the rest faded, and the address names
// them, to point a colleague at the same problems. The mode is a class on
// the root, so a download keeps the marks.
const healthOn = () => svg.classList.contains('health-mode');
const SEVERITIES = ['medium', 'low'];
const severityCount = (s) => HEALTH.filter((f) => f.severity === s).length;
const HEALTH_COUNTS = `${plural(HEALTH.length, 'finding')} (${SEVERITIES.filter(severityCount).map((s) => `${severityCount(s)} ${s}`).join(', ')})`;
const HEALTH_TIP = 'Mark the tables with schema health findings and list them with suggested fixes';
// Rules in words; the rule id (for health.ignore) is the tooltip.
const RULE_WORDS = {
  missing_fk: 'No foreign key in the database',
  unindexed_fk: 'Reference without an index',
  polymorphic_unindexed: 'Polymorphic pair without an index',
  orphan_table: 'Unconnected table',
  redundant_index: 'Redundant index',
};
const healthChip = overlay('oe-health-chip-host');
healthChip.fo.style.display = 'none';
healthChip.div.append(
  el('div', { class: 'oe-review-chip oe-health-chip', title: 'Tables with schema health findings carry an amber triangle' }, [
    el('span', { text: `Health: ${HEALTH_COUNTS}` }),
    el('button', { class: 'oe-link', text: 'List', title: 'Show the schema health findings', on: { click: () => showHealthList() } }),
    el('button', { class: 'oe-chip-close', text: '×', title: 'Turn the health marks off (H)', 'aria-label': 'Turn the health marks off', on: { click: () => setHealthMode(false) } }),
  ]),
);
// Chips of the modes, in the order they sit under the toolbar.
const modeChips = () => [changesChip, reviewChip, piiChip, healthChip, centralChip];

// Built once and reused, so the severity filter stays as the reader set it.
let healthPanel = null;
// The severity the list is filtered to (null: all), for the link, and the
// list's filter, for a link to set.
let healthSeverity = null;
let filterHealth = null;
// A finding in the link: its rule, table and columns, as health.ignore
// names it (`rule:table.column`, columns joined by +).
const findingKey = (f) => `${f.rule}:${f.table}${f.columns?.length ? `.${f.columns.join('+')}` : ''}`;
// The ticked findings, by key, and the list's way to tick them from a link.
let healthTicked = new Set();
let tickFindings = null;
function healthListPanel() {
  if (healthPanel) return healthPanel;
  const go = (id, column) => () => {
    const scroll = panel.div.scrollTop;
    goToNode(id, column);
    showHealthList(scroll);
  };
  const status = el('span', { class: 'oe-status-inline muted' });
  const count = el('span', { class: 'oe-health-count' });
  const ticked = el('div', { class: 'oe-actions oe-health-ticked' }, [
    count,
    el('button', { class: 'oe-btn', text: 'Copy link', title: 'Copy the address of these findings', on: { click: () => copyText(location.href, status, 'the link') } }),
    el('button', { class: 'oe-btn', text: 'Clear', title: 'Untick every finding', on: { click: () => tick([]) } }),
    status,
  ]);
  const boxes = HEALTH.map((f) =>
    el('input', { type: 'checkbox', class: 'oe-health-tick', title: 'Tick to light this finding on the diagram and name it in the address', 'aria-label': `Select: ${RULE_WORDS[f.rule] ?? f.rule} at ${short(f.table)}`, on: { change: () => tick(HEALTH.filter((g, i) => boxes[i].checked).map(findingKey)) } }),
  );
  const items = HEALTH.map((f, i) =>
    el('div', { class: 'oe-health-item', 'data-severity': f.severity, 'data-finding': findingKey(f) }, [
      el('div', { class: 'oe-health-head' }, [
        boxes[i],
        el('span', { class: `oe-badge sev-${f.severity}`, text: f.severity }),
        el('span', { class: 'rule', text: RULE_WORDS[f.rule] ?? f.rule, title: `Rule ${f.rule}` }),
      ]),
      el('div', { class: 'oe-health-where' }, [
        el('button', { class: 'oe-link', text: short(f.table), title: `Go to ${f.table}`, on: { click: go(f.table, f.columns?.[0]) } }),
        ...(f.columns ?? []).map((c) => el('button', { class: 'oe-chip', title: `Go to ${short(f.table)}.${c}`, text: c, on: { click: go(f.table, c) } })),
      ]),
      el('p', { text: f.message }),
      el('p', { class: 'muted', text: f.suggestion }),
      f.sql ? el('pre', { class: 'oe-health-sql', text: f.sql }) : null,
    ]),
  );
  const filters = [null, ...SEVERITIES.filter(severityCount)].map((s) =>
    el('button', { class: `oe-btn oe-health-filter${s === null ? ' on' : ''}`, 'data-severity': s ?? 'all', text: s === null ? `All ${HEALTH.length}` : `${s[0].toUpperCase()}${s.slice(1)} ${severityCount(s)}`, on: { click: () => filter(s) } }),
  );
  function filter(severity) {
    for (const b of filters) b.classList.toggle('on', b.getAttribute('data-severity') === (severity ?? 'all'));
    for (const item of items) item.style.display = severity === null || item.getAttribute('data-severity') === severity ? '' : 'none';
    healthSeverity = severity;
    syncHash();
  }
  filterHealth = filter;
  function tick(keys) {
    healthTicked = new Set(keys);
    HEALTH.forEach((f, i) => {
      boxes[i].checked = healthTicked.has(findingKey(f));
      items[i].classList.toggle('ticked', boxes[i].checked);
    });
    ticked.style.display = healthTicked.size > 0 ? '' : 'none';
    count.textContent = `${plural(healthTicked.size, 'finding')} ticked`;
    status.textContent = '';
    // The findings unticked go dark with the rest of what was lit.
    const scroll = panel.div.scrollTop;
    clearSelection();
    showHealthList(scroll);
  }
  tickFindings = tick;
  ticked.style.display = 'none';
  healthPanel = [
    panelHeader({ name: 'Schema health', note: `${HEALTH_COUNTS}. No score: each finding is something to look at, with SQL to review before use. Tick findings to light them and share them by the address.` }),
    // One severity only: nothing to filter.
    filters.length > 2 ? el('div', { class: 'oe-health-filters', role: 'group', 'aria-label': 'Filter by severity' }, filters) : null,
    ticked,
    ...items,
  ];
  return healthPanel;
}
// The list, with the ticked findings lit in the view on screen: their
// tables and columns, the rest faded (none ticked: the view as it was).
// Returns the tables lit.
function showHealthList(scroll = 0) {
  const findings = HEALTH.filter((f) => healthTicked.has(findingKey(f)));
  const index = currentIndex();
  const tables = [...new Set(findings.map((f) => f.table))].filter((id) => index.has(id));
  if (findings.length > 0) {
    clearSelection();
    for (const id of tables) unfoldFor(id);
    for (const f of findings) {
      const g = index.get(f.table)?.el;
      if (!g) continue;
      g.classList.add('hl');
      for (const c of g.querySelectorAll('.column')) if (f.columns?.includes(c.getAttribute('data-column'))) c.classList.add('hl-column');
    }
    currentView().classList.add('dimmed');
  }
  showPanel(healthListPanel());
  panel.div.scrollTop = scroll;
  syncHash();
  return tables;
}
const healthListShown = () => healthPanel !== null && panel.fo.style.display !== 'none' && panel.div.contains(healthPanel[0]);

function setHealthMode(on) {
  if (HEALTH.length === 0) return;
  svg.classList.toggle('health-mode', on);
  healthChip.fo.style.display = on ? '' : 'none';
  if (on) {
    // A view seen whole is fitted again left of the panel, as for the personal data list.
    const whole = fitsInside(viewBounds(state.view), visibleRect(state.cam, viewport(), TOOLBAR_HEIGHT, 0));
    showHealthList();
    if (whole) zoomToRect(viewBounds(state.view), MAX_FIT_SCALE);
  } else if (healthListShown()) hidePanel();
  updateHighlightButton();
  showLegend();
  layoutOverlays();
  placeBackPill();
}

// ---------------------------------------------------------------- central tables mode

// The starred tables (Highlight › Central tables, or S; offered when some
// domain has one): the most connected table of each domain keeps a gold
// border, everything else fades, in every view until turned off. A
// selection takes over the fading while it lasts. A chip under the toolbar
// says the mode is on: List shows each domain with its central tables in
// the overview's order, a click goes to the table and keeps the list open;
// × turns it off. The mode is a class on the root, so a download keeps it.
const centralOn = () => svg.classList.contains('central-mode');
const CENTRAL_STEPS = TOUR_STEPS.filter((step) => step.centrals.length > 0);
const CENTRAL_COUNTS = `${plural(CENTRAL_TOTAL, 'table')} in ${plural(CENTRAL_STEPS.length, 'domain')}`;
const CENTRAL_TIP = 'Mark the most connected table of each domain (the starred ones) and fade everything else';
const centralChip = overlay('oe-central-chip-host');
centralChip.fo.style.display = 'none';
centralChip.div.append(
  el('div', { class: 'oe-review-chip oe-central-chip', title: 'The starred tables keep a gold border; everything else fades' }, [
    el('span', { text: `Central: ${CENTRAL_COUNTS}` }),
    el('button', { class: 'oe-link', text: 'List', title: 'Show the central table of each domain', on: { click: () => showCentralList() } }),
    el('button', { class: 'oe-chip-close', text: '×', title: 'Turn the central tables highlight off (S)', 'aria-label': 'Turn the central tables highlight off', on: { click: () => setCentralMode(false) } }),
  ]),
);

// Built once and reused, so the scroll position comes back after a jump.
let centralPanel = null;
function centralListPanel() {
  if (centralPanel) return centralPanel;
  const go = (id) => () => {
    const scroll = panel.div.scrollTop;
    goToNode(id);
    showCentralList(scroll);
  };
  const named = (cluster) => (DATABASES.length > 1 ? `${dbDisplayName(dbOf(cluster))} · ${domainName(cluster)}` : domainName(cluster));
  centralPanel = [
    panelHeader({ name: 'Central tables', note: `${CENTRAL_COUNTS}: the most connected table of each domain` }),
    ...CENTRAL_STEPS.map((step) =>
      el('div', { class: 'oe-central-domain' }, [
        el('div', { class: 'name', text: named(step.cluster), title: step.cluster }),
        el('div', { class: 'oe-chipbox' }, step.centrals.map((id) => el('button', { class: 'oe-chip', title: `Go to ${id}`, text: short(id), on: { click: go(id) } }))),
      ]),
    ),
  ];
  return centralPanel;
}
function showCentralList(scroll = 0) {
  showPanel(centralListPanel());
  panel.div.scrollTop = scroll;
}
const centralListShown = () => centralPanel !== null && panel.fo.style.display !== 'none' && panel.div.contains(centralPanel[0]);

function setCentralMode(on) {
  if (CENTRAL_TOTAL === 0) return;
  svg.classList.toggle('central-mode', on);
  centralChip.fo.style.display = on ? '' : 'none';
  if (on) {
    // A selection would fade the tables that were asked for.
    clearSelection();
    // A view seen whole is fitted again left of the panel, as for the personal data list.
    const whole = fitsInside(viewBounds(state.view), visibleRect(state.cam, viewport(), TOOLBAR_HEIGHT, 0));
    showCentralList();
    if (whole) zoomToRect(viewBounds(state.view), MAX_FIT_SCALE);
  } else if (centralListShown()) hidePanel();
  updateHighlightButton();
  showLegend();
  layoutOverlays();
  placeBackPill();
}

// ---------------------------------------------------------------- tour

// The tour (⋯ › Tour, the palette, or T) shows the domains one after
// another (TOUR_STEPS): each in its view, opened as the view of all tables opens (whole when readable,
// else around the central table), fading in while the domain's frame and its
// central table pulse, with a caption at the
// bottom: its name, table count and business note. The next domain comes
// after TOUR_STEP_MS, the last one is followed by the first. The legend,
// minimap and Back pill step aside meanwhile. Esc (or the caption's ×)
// puts back the view the reader was on; going anywhere else ends the tour
// there. Nothing is added to the history, and the caption lives outside the
// drawing, so a download never holds it.
// Wide enough for a business note of a sentence or two on one line, so the
// caption stays low and leaves the central table room above it.
const TOUR_WIDTH = 800;
// Room around the caption card inside its area, for the card's shadow.
const TOUR_ROOM = 8;
const tourBox = overlay('oe-tour-host');
tourBox.fo.style.display = 'none';
const tour = { on: false, i: 0, paused: false, timer: 0, from: null, height: 0 };
// Screen height the caption takes at the bottom while the tour runs.
const tourRoom = () => (tour.on ? tour.height + PANEL_MARGIN : 0);

function startTour() {
  if (tour.on || TOUR_STEPS.length < 2) return;
  closeMenus();
  closeSpotlight();
  closeJoinSpot();
  // Space pauses the tour, but presses a focused button (⋯, from which it may have started).
  if (document.activeElement?.closest?.('.oe-toolbar')) document.activeElement.blur();
  tour.from = { step: snapshot(), cam: { ...state.cam } };
  tour.on = true;
  tour.paused = false;
  tourBox.fo.style.display = '';
  showTourStep(0);
}

/** Ends the tour; `back` puts back the view (and table) it started from. */
function endTour(back) {
  if (!tour.on) return;
  clearTimeout(tour.timer);
  tour.on = false;
  tourBox.fo.style.display = 'none';
  if (back) {
    restore(tour.from.step);
    state.cam = tour.from.cam;
    applyCamera();
  }
  showLegend();
  updateBackPill();
}

function showTourStep(i) {
  tour.i = i;
  const step = TOUR_STEPS[i];
  // The caption first: the view is fitted above it.
  renderTour();
  showView(domainView(step.cluster));
  frameTourStep();
  // Each step announces itself, also when the domain is seen whole: the view
  // fades in and the domain's frame pulses, then its central table.
  const view = currentView();
  view.classList.remove('oe-enter');
  void view.getBoundingClientRect();
  view.classList.add('oe-enter');
  pulse([...view.querySelectorAll('.cluster')].find((g) => keyOf(g) === step.cluster));
  if (step.central && currentIndex().has(step.central)) arrive(step.central);
  scheduleTour();
}
function frameTourStep() {
  const id = TOUR_STEPS[tour.i].central;
  readableStart(viewBounds(state.view), (id && currentIndex().get(id)?.box) ?? null);
}
const tourStep = (by) => showTourStep(tourIndex(tour.i, by, TOUR_STEPS.length));
function scheduleTour() {
  clearTimeout(tour.timer);
  if (!tour.paused) tour.timer = setTimeout(() => tourStep(1), TOUR_STEP_MS);
}
// Resuming waits a whole step again; the camera stays where the reader left it.
function toggleTourPause() {
  tour.paused = !tour.paused;
  renderTour();
  scheduleTour();
}

function renderTour() {
  const step = TOUR_STEPS[tour.i];
  const control = (icon, title, onClick) => el('button', { class: 'oe-btn oe-tool icon-only', title, 'aria-label': title, on: { click: onClick } }, [iconSvg(icon)]);
  tourBox.div.replaceChildren(
    el('div', { class: 'oe-tour', role: 'status' }, [
      el('div', { class: 'oe-tour-text' }, [
        el('div', { class: 'oe-tour-head' }, [el('span', { class: 'oe-tour-count', text: `${tour.i + 1} / ${TOUR_STEPS.length}` }), el('b', { text: step.title })]),
        step.note ? el('div', { class: 'oe-tour-note', text: step.note }) : null,
      ]),
      el('div', { class: 'oe-tour-controls' }, [
        control('back', 'Previous domain (←)', () => tourStep(-1)),
        control(tour.paused ? 'play' : 'pause', tour.paused ? 'Resume (Space)' : 'Pause (Space)', toggleTourPause),
        control('next', 'Next domain (→)', () => tourStep(1)),
        control('close', 'End the tour and go back (Esc)', () => endTour(true)),
      ]),
    ]),
  );
  layoutOverlays();
}

// ---------------------------------------------------------------- minimap

// The whole current view in small, bottom right, with a rectangle for the
// part on screen; a click or a drag on it moves the view there. Shown only
// while the view does not fit on screen, unless turned off in the toolbar.
// It lives outside the drawing, so downloads never include it.
const MINIMAP_WIDTH = 180;
const MINIMAP_MAX_HEIGHT = 140;
const MINIMAP_PAD = 4;
const minimap = overlay('oe-minimap-host');
minimap.fo.style.display = 'none';
const map = { on: true, view: null, size: null, seen: null, svg: null };

// Group frames tinted as drawn, every box a grey block; no text.
function buildMinimap() {
  const bounds = viewBounds(state.view);
  const size = minimapSize(bounds, MINIMAP_WIDTH, MINIMAP_MAX_HEIGHT);
  const frames = [...currentView().querySelectorAll('.cluster, .database')].map((g) => {
    const b = boxOf(g);
    const fill = g.classList.contains('cluster') ? g.querySelector(':scope > rect').getAttribute('fill') : '#eef1f5';
    return svgEl('rect', { class: 'frame', x: b.x, y: b.y, width: b.w, height: b.h, rx: 8, fill });
  });
  const boxes = [...currentIndex().values()].filter((e) => !e.el.classList.contains('oe-hidden')).map(({ box: b }) => svgEl('rect', { class: 'node', x: b.x, y: b.y, width: b.w, height: b.h }));
  map.seen = svgEl('rect', { class: 'seen' });
  map.svg = svgEl('svg', { width: size.w, height: size.h, viewBox: `${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}` }, [...frames, ...boxes, map.seen]);
  minimap.div.replaceChildren(el('div', { class: 'oe-minimap' }, [map.svg]));
  map.view = state.view;
  map.size = size;
  map.bounds = bounds;
}

const panelRoom = () => (panel.fo.style.display !== 'none' ? PANEL_WIDTH + 2 * PANEL_MARGIN : 0);

function updateMinimap() {
  if (map.view !== state.view) buildMinimap();
  const vp = viewport();
  const seen = visibleRect(state.cam, vp, TOOLBAR_HEIGHT, panelRoom());
  // A ranked list needs no map of itself.
  const show = map.on && !tour.on && state.view !== RANKING && !fitsInside(map.bounds, seen);
  minimap.fo.style.display = show ? '' : 'none';
  if (!show) return;
  for (const [k, v] of Object.entries(seen)) map.seen.setAttribute({ x: 'x', y: 'y', w: 'width', h: 'height' }[k], v);
  const w = map.size.w + 2 * MINIMAP_PAD + 2;
  const h = map.size.h + 2 * MINIMAP_PAD + 2;
  minimap.fo.setAttribute('width', w);
  minimap.fo.setAttribute('height', h);
  minimap.fo.setAttribute('x', vp.w - w - PANEL_MARGIN - (panelReaches(vp.h - h - PANEL_MARGIN) ? panelRoom() : 0));
  minimap.fo.setAttribute('y', vp.h - h - PANEL_MARGIN);
}

// Whether the open panel comes down to `top` (screen y, with a small gap):
// a short panel leaves the minimap in its corner.
const MINIMAP_PANEL_GAP = 8;
function panelReaches(top) {
  if (panel.fo.style.display === 'none') return false;
  const bottom = Number(panel.fo.getAttribute('y')) + Number(panel.fo.getAttribute('height'));
  return bottom + MINIMAP_PANEL_GAP > top;
}

// A press on the minimap centres the view on that point; dragging follows.
function minimapPan(e) {
  const r = map.svg.getBoundingClientRect();
  const p = { x: map.bounds.x + (e.clientX - r.left) / map.size.scale, y: map.bounds.y + (e.clientY - r.top) / map.size.scale };
  state.cam = centreOn(p, state.cam, viewport(), TOOLBAR_HEIGHT, panelRoom());
  scheduleCamera();
}
minimap.div.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  minimap.div.setPointerCapture(e.pointerId);
  minimapPan(e);
});
minimap.div.addEventListener('pointermove', (e) => {
  if (minimap.div.hasPointerCapture(e.pointerId)) minimapPan(e);
});

function setMinimap(on) {
  map.on = on;
  updateMinimap();
}

// ---------------------------------------------------------------- tooltip

const tip = overlay('oe-tip-host');
tip.fo.style.display = 'none';
tip.fo.style.pointerEvents = 'none';

// An overview connector: one line, the list only in the panel.
// A ranking row: the table, how many relations point at it and from it.
function rankTip(tile) {
  const id = tile.getAttribute('data-id');
  const [into, from] = [Number(tile.getAttribute('data-in')), Number(tile.getAttribute('data-out'))];
  return [el('b', { text: short(id) }), el('div', { text: `${plural(into, 'relation')} point${into === 1 ? 's' : ''} at it · ${from} from it` }), el('div', { class: 'muted', text: `${domainName(clusterOf(id))} · click to open the table` })];
}

// Every tooltip about the relations between two domains (a connector, a
// card's related domain) is one line, "A → B · N relations
// · M back", named in the direction the relations point (the stronger one
// first when they point both ways); the list is only in the panel.
function connectorTip(a, b, hint = 'Click to see the list') {
  const [main, other] = byDirection(a, b).sort((x, y) => y.relations.length - x.relations.length);
  const backText = other.relations.length > 0 ? ` · ${other.relations.length} back` : '';
  return [el('div', {}, [el('b', { text: `${domainName(main.from)} → ${domainName(main.to)}` }), el('span', { text: ` · ${plural(main.relations.length, 'relation')}${backText}` })]), el('div', { class: 'muted', text: hint })];
}
// Lines of the table views: their two ends and kind.
function lineTip(g) {
  const [id, from, to] = [g.getAttribute('data-id'), g.getAttribute('data-from'), g.getAttribute('data-to')];
  const l = data.links.find((x) => x.id === id) ?? data.hubLinks.find((x) => x.id === id);
  return [el('b', { text: `${short(from)} → ${short(to)}` }), l ? el('div', { class: 'muted oe-line-facts' }, [el('span', { text: linkSummary(l) }), l.kind === 'view_source' ? null : reviewIcon(l.review), l.kind === 'view_source' ? null : el('span', { text: REVIEW_WORDS[l.review] })]) : null];
}

function tipLines(target) {
  const connector = target.closest('.card-link');
  if (connector) return connectorTip(connector.getAttribute('data-from'), connector.getAttribute('data-to'));
  const tile = target.closest('.rk-item');
  if (tile) return rankTip(tile);
  const related = target.closest('.card-related');
  if (related) {
    const [a, b] = [target.closest('.domain').getAttribute('data-domain'), related.getAttribute('data-domain')];
    return connectorTip(a, b, `Click to open ${domainName(b)}`);
  }
  const line = target.closest('.relation-group, .hub-route');
  if (line?.hasAttribute('data-group')) return [el('b', { text: line.getAttribute('data-label') }), el('div', { class: 'muted', text: JSON.parse(line.getAttribute('data-tables')).map(short).join(', ') })];
  if (line) return lineTip(line);
  const groupRow = target.closest('.group-row[data-table]');
  if (groupRow) return [el('b', { text: groupRow.getAttribute('data-table') }), el('div', { class: 'muted', text: 'Outside this domain · click to open its domain' })];
  const groupBoxEl = target.closest('.group-stub');
  if (groupBoxEl) {
    const tables = groupTables(groupBoxEl);
    return [el('b', { text: `${domainName(groupBoxEl.getAttribute('data-domain'))} · ${plural(tables.length, 'table')}` }), el('div', { text: tables.map(short).join(', ') }), el('div', { class: 'muted', text: 'Click a table to open it · click the name to open the domain' })];
  }
  const columnEl = target.closest('.column');
  const nodeEl = target.closest(NODE_SELECTOR);
  if (!nodeEl) return null;
  const id = nodeIdOf(nodeEl);
  const n = data.nodes[id];
  const badge = target.closest('.hub-badge');
  if (badge) {
    const columns = JSON.parse(badge.getAttribute('data-columns'));
    return [el('div', {}, [el('b', { text: columns.join(', ') }), el('span', { text: ` → ${badge.getAttribute('data-target')}` })]), el('div', { class: 'muted', text: 'Hub reference, drawn as a badge instead of lines' })];
  }
  if (columnEl && n?.kind === 'table') {
    const c = n.columns.find((x) => x.name === columnEl.getAttribute('data-column'));
    if (!c) return null;
    const values = Object.entries(c.enum ?? {});
    return [
      el('b', { text: c.name }),
      columnChips(c),
      ...columnText(c),
      values.length > 0 ? enumTable(values.slice(0, TIP_ENUM_ROWS)) : null,
      values.length > TIP_ENUM_ROWS ? el('div', { class: 'muted', text: `+${values.length - TIP_ENUM_ROWS} more — click the column for the full list` }) : null,
    ];
  }
  // A card shows everything itself; the tooltip only completes a cut name or note.
  if (nodeEl.classList.contains('domain')) {
    const cut = [...nodeEl.querySelectorAll(':scope > .card-title, :scope > .card-note')].some((t) => t.textContent.endsWith('…'));
    if (!cut) return null;
    const note = data.domainNotes?.[id];
    return [el('b', { text: domainName(id) }), note ? el('div', { text: note }) : null, el('div', { class: 'muted', text: 'Click to open the domain' })];
  }
  if (nodeEl.classList.contains('stub')) {
    return [el('b', { text: id }), el('div', { class: 'muted', text: 'Outside this domain · click to open its domain' })];
  }
  if (n?.kind === 'poly') {
    return [
      el('b', { text: `«${n.name}» polymorphic node` }),
      n.note ? el('div', { text: n.note }) : null,
      el('div', { text: n.targets.map(short).join(', ') }),
      el('div', { class: 'muted', text: 'Click to show its targets · double-click to see it with its owner and all targets' }),
    ];
  }
  return [
    el('b', { text: id }),
    n?.note ? el('div', { text: n.note }) : null,
    ...(n?.facts ?? []).map((f) => factLine(f, 'div')),
    warningLine(n?.warning),
    el('div', { class: 'muted', text: `Click to highlight · ${ADD_KEY_HINT} to select several · double-click for its neighborhood` }),
  ];
}

function hideTip() {
  tip.fo.style.display = 'none';
}

function showTip(e) {
  const lines = inUi(e) ? null : tipLines(e.target);
  if (!lines) {
    tip.fo.style.display = 'none';
    return;
  }
  tip.div.replaceChildren(el('div', { class: 'oe-tip' }, lines.filter(Boolean)));
  tip.fo.style.display = '';
  const { w, h } = viewport();
  tip.fo.setAttribute('width', 360);
  tip.fo.setAttribute('height', h);
  // Never taller than the space under the toolbar, never past an edge.
  tip.div.firstChild.style.maxHeight = `${h - TOOLBAR_HEIGHT - 2 * PANEL_MARGIN}px`;
  const r = tip.div.firstChild.getBoundingClientRect();
  const x = e.clientX + TIP_OFFSET + r.width > w ? e.clientX - TIP_OFFSET - r.width : e.clientX + TIP_OFFSET;
  const y = e.clientY + TIP_OFFSET + r.height > h ? e.clientY - TIP_OFFSET - r.height : e.clientY + TIP_OFFSET;
  tip.fo.setAttribute('x', Math.max(0, Math.min(x, w - r.width - 1)));
  tip.fo.setAttribute('y', Math.max(TOOLBAR_HEIGHT, Math.min(y, h - r.height - 1)));
  tip.fo.setAttribute('width', Math.ceil(r.width) + 1);
  tip.fo.setAttribute('height', Math.ceil(r.height) + 1);
}

// ---------------------------------------------------------------- layout of overlays

// A foreignObject needs an explicit size: each overlay is sized to its
// content after it changes.
function layoutOverlays() {
  const { w, h } = viewport();
  toolbar.fo.setAttribute('width', w);
  toolbar.fo.setAttribute('height', h);
  // An open dropdown hangs below the toolbar: the toolbar's area grows to
  // hold it, so clicks on its lower items reach it.
  const drop = openMenu()?.menu;
  toolbar.fo.setAttribute('height', drop ? Math.ceil(drop.getBoundingClientRect().bottom + 8) : TOOLBAR_HEIGHT);
  for (const spot of [spotlight, joinSpot]) {
    if (spot.fo.style.display === 'none') continue;
    spot.fo.setAttribute('width', w);
    spot.fo.setAttribute('height', h);
  }
  // The chips of the modes on float under the toolbar, top left, one after
  // the other; the Back pill follows the drawing (see placeBackPill).
  const pillY = TOOLBAR_HEIGHT + 8;
  let chipX = PANEL_MARGIN;
  for (const chip of modeChips()) {
    if (chip.fo.style.display === 'none') continue;
    chip.fo.setAttribute('width', w);
    chip.fo.setAttribute('height', 40);
    const r = chip.div.firstChild.getBoundingClientRect();
    chip.fo.setAttribute('x', chipX);
    chip.fo.setAttribute('y', pillY);
    chip.fo.setAttribute('width', Math.ceil(r.width) + 2);
    chip.fo.setAttribute('height', Math.ceil(r.height) + 2);
    chipX += Math.ceil(r.width) + 2 + 8;
  }
  if (legend.fo.style.display !== 'none') {
    // The area is LEGEND_ROOM larger than the card on every side, so its
    // shadow and the hover lift are never cut off at the area's edge.
    legend.fo.setAttribute('y', 0);
    legend.fo.setAttribute('width', 300 + 2 * LEGEND_ROOM);
    legend.fo.setAttribute('height', h);
    legend.div.style.padding = `${LEGEND_ROOM}px`;
    const r = legend.div.firstChild.getBoundingClientRect();
    legend.fo.setAttribute('x', PANEL_MARGIN - LEGEND_ROOM);
    legend.fo.setAttribute('y', Math.max(TOOLBAR_HEIGHT + PANEL_MARGIN, h - r.height - PANEL_MARGIN) - LEGEND_ROOM);
    legend.fo.setAttribute('height', Math.ceil(r.height) + 1 + 2 * LEGEND_ROOM);
  }
  if (help.fo.style.display !== 'none') {
    // Bottom-aligned just right of the legend card, or in its place.
    const card = legend.fo.style.display !== 'none' ? legend.div.firstChild.getBoundingClientRect().width + 8 : 0;
    help.fo.setAttribute('width', 100);
    help.fo.setAttribute('height', 100);
    help.div.style.padding = `${LEGEND_ROOM}px`;
    const r = help.div.firstChild.getBoundingClientRect();
    help.fo.setAttribute('x', PANEL_MARGIN + Math.ceil(card) - LEGEND_ROOM);
    help.fo.setAttribute('y', h - r.height - PANEL_MARGIN - LEGEND_ROOM);
    help.fo.setAttribute('width', Math.ceil(r.width) + 1 + 2 * LEGEND_ROOM);
    help.fo.setAttribute('height', Math.ceil(r.height) + 1 + 2 * LEGEND_ROOM);
  }
  if (hintShown()) placeHint(w);
  if (tour.on) {
    // Centred at the bottom of the canvas left of the panel.
    const cardW = Math.min(TOUR_WIDTH, w - panelRoom() - 2 * PANEL_MARGIN);
    tourBox.div.style.padding = `${TOUR_ROOM}px`;
    tourBox.div.style.width = `${cardW + 2 * TOUR_ROOM}px`;
    tourBox.fo.setAttribute('width', cardW + 2 * TOUR_ROOM);
    tourBox.fo.setAttribute('height', h);
    tour.height = Math.ceil(tourBox.div.firstChild.getBoundingClientRect().height) + 1;
    tourBox.fo.setAttribute('x', Math.round((w - panelRoom() - cardW) / 2) - TOUR_ROOM);
    tourBox.fo.setAttribute('y', h - tour.height - PANEL_MARGIN - TOUR_ROOM);
    tourBox.fo.setAttribute('height', tour.height + 2 * TOUR_ROOM);
  }
  if (panel.fo.style.display !== 'none') {
    const room = h - TOOLBAR_HEIGHT - 2 * PANEL_MARGIN;
    panel.fo.setAttribute('x', w - PANEL_WIDTH - PANEL_MARGIN);
    panel.fo.setAttribute('y', TOOLBAR_HEIGHT + PANEL_MARGIN);
    panel.fo.setAttribute('width', PANEL_WIDTH);
    panel.div.style.maxHeight = `${room}px`;
    panel.fo.setAttribute('height', room);
    panel.fo.setAttribute('height', Math.ceil(panel.div.getBoundingClientRect().height) + 1);
  }
  // The panel takes the right edge: the minimap moves left of it.
  updateMinimap();
}

// ---------------------------------------------------------------- input

let press = null;
let dragged = false;
// The event path, not the target's ancestors: a panel link may have been
// replaced (detached) by its own handler before the event bubbles here.
const inUi = (e) => e.composedPath().some((n) => n.localName === 'foreignObject');

svg.addEventListener('pointerdown', (e) => {
  if (inUi(e) || e.button !== 0) return;
  // A press on the drawing starts a pan, never a text selection; the search
  // field loses focus as it would on any other click outside it.
  e.preventDefault();
  window.getSelection()?.removeAllRanges();
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  press = { x: e.clientX, y: e.clientY, cam: { ...state.cam }, id: e.pointerId };
  dragged = false;
});
svg.addEventListener('pointermove', (e) => {
  if (!press) {
    showTip(e);
    return;
  }
  const dx = e.clientX - press.x;
  const dy = e.clientY - press.y;
  if (!dragged && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
  if (!dragged) {
    svg.setPointerCapture(press.id);
    hideTip();
  }
  dragged = true;
  state.cam = { ...press.cam, x: press.cam.x + dx, y: press.cam.y + dy };
  scheduleCamera();
});
svg.addEventListener('pointerup', () => {
  press = null;
});
svg.addEventListener('pointerleave', hideTip);

// Hovering (or keyboard-focusing) a card on the overview draws curved
// connectors from it to every domain it has relations with, as thick as
// they are many, and fades the other cards. Connectors leave a side of the
// card spread out, nearest target first, and end at the middle of the
// facing side of the other card.
let focused = null;
let unfocusTimer = 0;
const CONNECTOR_BEND = 0.45;
function sideOf(from, to) {
  const [dx, dy] = [to.x + to.w / 2 - (from.x + from.w / 2), to.y + to.h / 2 - (from.y + from.h / 2)];
  if (Math.abs(dx) * from.h >= Math.abs(dy) * from.w) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}
const facing = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
const outward = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };
function sidePoint(b, side, t = 0.5) {
  if (side === 'left') return [b.x, b.y + b.h * t];
  if (side === 'right') return [b.x + b.w, b.y + b.h * t];
  if (side === 'top') return [b.x + b.w * t, b.y];
  return [b.x + b.w * t, b.y + b.h];
}
function connectors(id) {
  const index = indexes.get(OVERVIEW);
  const box = index.get(id).box;
  const ends = Object.entries(data.domainLinks)
    .map(([key, relations]) => {
      const [a, b] = key.split('<->');
      if (a === b || (a !== id && b !== id)) return null;
      const other = a === id ? b : a;
      return index.has(other) ? { other, count: relations.length, box: index.get(other).box, side: sideOf(box, index.get(other).box) } : null;
    })
    .filter(Boolean);
  const paths = [];
  for (const side of ['left', 'right', 'top', 'bottom']) {
    const mine = ends.filter((e) => e.side === side);
    const along = (e) => (side === 'left' || side === 'right' ? e.box.y + e.box.h / 2 : e.box.x + e.box.w / 2);
    mine.sort((p, q) => along(p) - along(q) || byId(p.other, q.other));
    mine.forEach((e, i) => {
      const [x1, y1] = sidePoint(box, side, (i + 1) / (mine.length + 1));
      const [x2, y2] = sidePoint(e.box, facing[side]);
      const reach = CONNECTOR_BEND * Math.hypot(x2 - x1, y2 - y1);
      const [ox, oy] = outward[side];
      const d = `M${x1} ${y1}C${x1 + ox * reach} ${y1 + oy * reach} ${x2 - ox * reach} ${y2 - oy * reach} ${x2} ${y2}`;
      paths.push(connectorEl(d, e.count, dbOf(id) !== dbOf(e.other), { 'data-from': id, 'data-to': e.other }));
    });
  }
  return svgEl('g', { class: 'card-links' }, paths);
}
// One overview connector, as drawn on hover and in the legend: as thick
// as its relations are many, dashed between databases. A wide transparent
// twin makes the thin line easy to point at.
function connectorEl(d, count, crossDb, attrs = {}) {
  return svgEl('g', { class: `card-link${crossDb ? ' cross_db' : ''}`, ...attrs }, [
    svgEl('path', { class: 'card-link-hit', d }),
    svgEl('path', { class: 'card-link-line', d, style: `stroke-width:${overviewStrokeWidth(count) * 1.5}` }),
  ]);
}

// With no card hovered, the overview shows the domain pair whose panel is
// open, as a selection stays lit: its two cards and the connector between
// them, the other cards faded.
function focusDomain(id) {
  clearTimeout(unfocusTimer);
  if (focused === id && id !== null) return;
  focused = id;
  const view = views.get(OVERVIEW);
  for (const e of view.querySelectorAll('.focus-node')) e.classList.remove('focus-node');
  for (const e of view.querySelectorAll('.card-links')) e.remove();
  const pair = id === null && domainLinkShown() ? domainLink.pair : null;
  view.classList.toggle('domain-focus', id !== null || pair !== null);
  if (pair) {
    const [a, b] = pair;
    const links = connectors(a);
    for (const p of [...links.children]) {
      if (p.getAttribute('data-to') === b) p.classList.add('selected');
      else p.remove();
    }
    for (const d of pair) indexes.get(OVERVIEW).get(d)?.el.classList.add('focus-node');
    view.querySelector('.relations').append(links);
  }
  if (id === null) return;
  const card = indexes.get(OVERVIEW).get(id)?.el;
  if (!card) return;
  card.classList.add('focus-node');
  const links = connectors(id);
  for (const p of links.children) indexes.get(OVERVIEW).get(p.getAttribute('data-to'))?.el.classList.add('focus-node');
  // Under the cards: a line runs behind the cards it passes, which stay
  // readable, and shows through the faded ones.
  view.querySelector('.relations').append(links);
}
// Leaving a card keeps its connectors a moment, for the pointer to reach one.
function unfocusSoon() {
  clearTimeout(unfocusTimer);
  if (focused !== null) unfocusTimer = setTimeout(() => focusDomain(null), UNFOCUS_DELAY);
}
svg.addEventListener('pointerover', (e) => {
  if (state.view !== OVERVIEW || press) return;
  if (inUi(e)) return unfocusSoon();
  if (e.target.closest('.card-link')) return clearTimeout(unfocusTimer);
  const domain = e.target.closest('.domain');
  if (domain) focusDomain(domain.getAttribute('data-domain'));
  else unfocusSoon();
});
// Cards take keyboard focus (Tab); Enter or Space opens the focused one.
for (const card of views.get(OVERVIEW).querySelectorAll('.domain')) {
  card.setAttribute('tabindex', '0');
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `${domainName(card.getAttribute('data-domain'))}: open the domain`);
}
svg.addEventListener('focusin', (e) => {
  const card = e.target.closest?.('.domain');
  if (card && state.view === OVERVIEW) focusDomain(card.getAttribute('data-domain'));
});
svg.addEventListener('focusout', (e) => {
  if (e.target.closest?.('.domain')) unfocusSoon();
});
svg.addEventListener('click', (e) => {
  if (inUi(e)) return;
  if (dragged) {
    dragged = false;
    return;
  }
  const t = e.target;
  // With the join panel waiting for a table, a click on one picks it.
  const picked = t.closest('.group-row[data-table]')?.getAttribute('data-table') ?? t.closest('.table, .stub')?.getAttribute('data-id');
  if (join.open && (!join.from || !join.to) && data.nodes[picked]?.kind === 'table') return setJoinEnd(join.from ? 'to' : 'from', picked);
  const tile = t.closest('.rk-item');
  if (tile) return navigate(homeView(tile.getAttribute('data-id')), { focus: tile.getAttribute('data-id') });
  const related = t.closest('.card-related');
  if (related) return navigate(domainView(related.getAttribute('data-domain')));
  const domain = t.closest('.domain');
  if (domain) return navigate(domainView(domain.getAttribute('data-domain')));
  const pair = t.closest('.card-link');
  if (pair) return showDomainLink(pair.getAttribute('data-from'), pair.getAttribute('data-to'));
  const groupRow = t.closest('.group-row[data-table]');
  if (groupRow) return navigate(homeView(groupRow.getAttribute('data-table')), { focus: groupRow.getAttribute('data-table') });
  const group = t.closest('.group-stub');
  if (group) return navigate(domainView(group.getAttribute('data-domain')));
  const stub = t.closest('.stub');
  if (stub) return navigate(homeView(stub.getAttribute('data-id')), { focus: stub.getAttribute('data-id') });
  const node = t.closest('.table, .poly');
  if (node && (e.shiftKey || e.metaKey || e.ctrlKey) && data.nodes[node.getAttribute('data-id')]?.kind === 'table') return togglePicked(node.getAttribute('data-id'));
  const column = t.closest('.column');
  if (node && column && data.nodes[node.getAttribute('data-id')]?.kind === 'table') {
    const id = node.getAttribute('data-id');
    selectNode(id);
    column.classList.add('hl-column');
    linkColumn = column.getAttribute('data-column');
    showPanel(nodePanel(id, linkColumn));
    syncHash();
    panel.div.querySelector('.oe-col.open')?.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (node) return selectNode(node.getAttribute('data-id'));
  const relation = t.closest('.relation-group, .hub-route');
  const header = headerClick(e);
  if (header) return header();
  if (relation) return flowRelation(relation);
  clearSelection();
});

svg.addEventListener('dblclick', (e) => {
  if (inUi(e)) return;
  const node = e.target.closest('.table, .poly');
  if (node) openNeighborhood(node.getAttribute('data-id'));
});

svg.addEventListener(
  'wheel',
  (e) => {
    if (inUi(e)) return;
    e.preventDefault();
    hideTip();
    const unit = e.deltaMode === 1 ? LINE_PIXELS : e.deltaMode === 2 ? viewport().h : 1;
    // A trackpad pinch arrives as a wheel event with ctrlKey set; ctrl or
    // cmd with a mouse wheel zooms too. Anything else scrolls the drawing,
    // as two-finger scrolling does everywhere on a Mac.
    if (e.ctrlKey || e.metaKey) {
      // Some Safari versions send ctrl+wheel alongside the gesture events of
      // the same pinch; the gesture handlers already zoom, so skip these.
      if (inGesture) return;
      const delta = Math.max(-ZOOM_MAX_PIXELS, Math.min(ZOOM_MAX_PIXELS, e.deltaY * unit));
      zoomAt(e.clientX, e.clientY, Math.exp(-delta * ZOOM_PER_PIXEL));
    } else {
      panBy(-e.deltaX * unit, -e.deltaY * unit);
    }
  },
  { passive: false },
);

// Safari reports a trackpad pinch as gesture events with a cumulative scale.
let gestureScale = 1;
let inGesture = false;
svg.addEventListener('gesturestart', (e) => {
  e.preventDefault();
  gestureScale = 1;
  inGesture = true;
});
svg.addEventListener('gestureend', () => {
  inGesture = false;
});
svg.addEventListener('gesturechange', (e) => {
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, e.scale / gestureScale);
  gestureScale = e.scale;
});

// A press anywhere outside a dropdown closes the toolbar's open menu.
document.addEventListener(
  'pointerdown',
  (e) => {
    const drop = openMenu();
    if (drop && !e.composedPath().includes(drop.wrap)) closeMenus();
    // A popover in the panel closes on any press outside its own dropdown.
    for (const pop of panel.div.querySelectorAll('.oe-popover')) {
      if (pop.style.display !== 'none' && !e.composedPath().includes(pop.parentNode)) pop.style.display = 'none';
    }
  },
  true,
);

// Cmd+K / Ctrl+K opens the palette; Cmd+F / Ctrl+F, or "/" outside a text
// field, opens it for tables and columns only. Escape closes the innermost
// thing open: the palette, a menu, the tour, the selection, a highlight
// mode's own list (turning that mode off), the panel, then the highlight
// modes still on.
// A ticked checkbox keeps the focus but takes no letters.
const typing = () => (document.activeElement instanceof HTMLInputElement && document.activeElement.type !== 'checkbox') || document.activeElement instanceof HTMLTextAreaElement;
// Keyboard shortcuts, also listed under ⋯ › Keyboard shortcuts: groups of
// [keys (one or several, any of them works), what they do].
const SHORTCUTS = [
  ['Find and move', [
    [[PALETTE_KEY], 'Search, or run a command'],
    [[FIND_KEY, '/'], 'Search tables and columns'],
    [[`${MOD_KEY}J`], 'Join path between two tables'],
    [[`${MOD_KEY}A`], 'Show all tables'],
    [[ADD_KEY_HINT], 'Add a table to the selection or take it out; the address shares them'],
    [['←', '→'], 'Back, forward'],
  ]],
  ['Highlight', [
    PII.total > 0 ? [['P'], 'Personal data'] : null,
    HEALTH.length > 0 ? [['H'], 'Schema health'] : null,
    CENTRAL_TOTAL > 0 ? [['S'], 'Central tables'] : null,
    CHANGES ? [['C'], 'Changes'] : null,
    [['L'], 'Legend on or off'],
  ]],
  ['Other', [
    [['T'], 'Tour the domains (← → step, Space pauses)'],
    [[`${MOD_KEY}C`], 'Copy the selected table’s schema'],
    [['?'], 'This list'],
    [['Esc'], 'Close search, menu or panel, then turn highlights off'],
  ]],
].map(([title, rows]) => [title, rows.filter(Boolean)]);
const selectedTable = () => {
  const id = currentView().querySelector('.table.selected')?.getAttribute('data-id');
  return data.nodes[id]?.kind === 'table' ? id : null;
};
// What a copy of table `id` holds: a JSON schema for a document store, else SQL.
const copyWhat = (id) => (isDocumentStore(data.databases[dbOf(id)].engine) ? 'JSON schema' : 'SQL');
// The selected table's CREATE TABLE with indexes (⌘C, ⋯ or the palette).
function copySelectedSchema() {
  const id = selectedTable();
  if (!id) return;
  const what = copyWhat(id);
  copyText(tableSql(id), { textContent: '' }, what, () => showToast(`Copied ${what} for ${short(id)}`));
}

// A short message at the bottom of the screen, gone after a moment.
const toast = overlay('oe-toast-host');
toast.fo.style.display = 'none';
toast.fo.style.pointerEvents = 'none';
let toastTimer = 0;
function showToast(text) {
  toast.div.replaceChildren(el('div', { class: 'oe-toast', role: 'status', text }));
  toast.fo.style.display = '';
  const vp = viewport();
  toast.fo.setAttribute('width', vp.w);
  toast.fo.setAttribute('height', 60);
  const r = toast.div.firstChild.getBoundingClientRect();
  toast.fo.setAttribute('x', Math.round((vp.w - r.width) / 2));
  toast.fo.setAttribute('y', vp.h - r.height - 28);
  toast.fo.setAttribute('width', Math.ceil(r.width) + 2);
  toast.fo.setAttribute('height', Math.ceil(r.height) + 2);
  clearTimeout(toastTimer);
  // Long messages stay longer, to be read.
  toastTimer = setTimeout(() => (toast.fo.style.display = 'none'), Math.max(2500, text.length * 60));
}
const hasTextSelection = () => (window.getSelection()?.toString() ?? '') !== '';

// ---------------------------------------------------------------- tips

// A tip about a feature (tips.js), in a small pill beside the "?" at the
// bottom left, where help already is, so it reads as an aside rather than
// news. One comes TIP_OPEN_MS after the file opens and when the reader
// moves to another view, at most one every TIP_GAP_MS, and goes after
// TIP_SHOW_MS: unseen tips first, then round the list. None during the
// tour, the palette, the join box or an open menu. × turns tips off
// (⋯ › Tips turns them on again). Which tips were seen, the last one shown
// and whether tips are off are kept in this browser's storage, so a visit
// goes on round the list where the last one stopped; without storage tips
// still work.
const TIP_OPEN_MS = 1500;
const TIP_GAP_MS = 60000;
const TIP_SHOW_MS = 10000;
const TIPS_KEY = 'open-erd:tips';
const TIP_FEATURES = { tour: TOUR_STEPS.length >= 2, pii: PII.total > 0, health: HEALTH.length > 0, central: CENTRAL_TOTAL > 0, ranking: views.has(RANKING) };
const TIPS = tipList(MOD_KEY).filter((t) => t.needs === null || TIP_FEATURES[t.needs]);
const tipsSaved = (() => {
  try {
    return JSON.parse(localStorage.getItem(TIPS_KEY)) ?? {};
  } catch {
    return {};
  }
})();
const tips = { off: tipsSaved.off === true, seen: Array.isArray(tipsSaved.seen) ? tipsSaved.seen : [], last: typeof tipsSaved.last === 'string' ? tipsSaved.last : null, shownAt: -Infinity, hide: 0 };
function saveTips() {
  try {
    localStorage.setItem(TIPS_KEY, JSON.stringify({ off: tips.off, seen: tips.seen, last: tips.last }));
  } catch {
    // No storage (a private window, blocked site data): tips start over next time.
  }
}
const hint = overlay('oe-hint-host');
hint.fo.style.display = 'none';
const hintShown = () => hint.fo.style.display !== 'none';
function showHint() {
  if (tips.off || tour.on || spotlightOpen() || joinSpotOpen() || openMenu() || document.hidden) return;
  if (performance.now() - tips.shownAt < TIP_GAP_MS) return;
  const t = nextTip(TIPS, tips.seen, tips.last);
  if (!t) return;
  tips.shownAt = performance.now();
  tips.last = t.id;
  if (!tips.seen.includes(t.id)) tips.seen.push(t.id);
  saveTips();
  hint.div.replaceChildren(
    el('div', { class: 'oe-hint', role: 'status' }, [
      el('span', { class: 'oe-hint-label', text: 'Tip' }),
      el('span', {}, t.parts.map((p) => (typeof p === 'string' ? document.createTextNode(p) : el('kbd', { text: p.key })))),
      el('button', { class: 'oe-hint-close', text: '×', title: 'Turn tips off', 'aria-label': 'Turn tips off', on: { click: () => setTipsOff(true) } }),
    ]),
  );
  hint.fo.style.display = '';
  layoutOverlays();
  clearTimeout(tips.hide);
  tips.hide = setTimeout(hideHint, TIP_SHOW_MS);
}
function hideHint() {
  clearTimeout(tips.hide);
  hint.fo.style.display = 'none';
}
function setTipsOff(off) {
  tips.off = off;
  saveTips();
  hideHint();
  if (off) showToast('Tips are off: ⋯ › Tips turns them on again');
}
// Beside the "?", vertically centred on it (see layoutOverlays).
function placeHint(w) {
  hint.fo.setAttribute('width', w);
  hint.fo.setAttribute('height', 60);
  const r = hint.div.firstChild.getBoundingClientRect();
  const button = help.div.firstChild.getBoundingClientRect();
  hint.fo.setAttribute('x', Math.round(button.right + 8));
  hint.fo.setAttribute('y', Math.round(button.top + button.height / 2 - r.height / 2));
  hint.fo.setAttribute('width', Math.ceil(r.width) + 2);
  hint.fo.setAttribute('height', Math.ceil(r.height) + 2);
}
setTimeout(showHint, TIP_OPEN_MS);

document.addEventListener('keydown', (e) => {
  const find = (e.key === 'f' || e.key === 'F') && (IS_MAC ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey;
  if (find || (e.key === '/' && !typing() && !e.metaKey && !e.ctrlKey)) {
    e.preventDefault();
    openSpotlight({ search: true });
    return;
  }
  const mod = (IS_MAC ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey;
  const letter = e.key.length === 1 ? e.key.toLowerCase() : '';
  // Cmd+K / Ctrl+K: the palette (Ctrl+K would otherwise go to the browser's address bar).
  if (mod && letter === 'k') {
    e.preventDefault();
    if (spotlightOpen() && spot.commands) closeSpotlight(true);
    else openSpotlight();
    return;
  }
  // Cmd+J / Ctrl+J: the join spotlight. Chrome and Safari let a page take
  // it over; where a browser keeps it, Join path… in the palette does the same.
  if (mod && letter === 'j') {
    e.preventDefault();
    if (joinSpotOpen()) closeJoinSpot();
    else openJoinSpot(selectedTable());
    return;
  }
  // Cmd+A / Ctrl+A: all tables, except in a text field where it selects.
  if (mod && letter === 'a' && !typing() && views.has(ALL_VIEW)) {
    e.preventDefault();
    closeSpotlight();
    closeJoinSpot();
    navigate(ALL_VIEW);
    return;
  }
  // Cmd+C / Ctrl+C with a table selected and no text selected: its SQL.
  if (mod && letter === 'c' && !typing() && !hasTextSelection() && selectedTable()) {
    e.preventDefault();
    copySelectedSchema();
    return;
  }
  const card = document.activeElement?.closest?.('.domain');
  if ((e.key === 'Enter' || e.key === ' ') && card && state.view === OVERVIEW && !typing()) {
    e.preventDefault();
    navigate(domainView(card.getAttribute('data-domain')));
    return;
  }
  const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !typing();
  if (letter === 't' && plain) {
    if (tour.on) endTour(true);
    else startTour();
    return;
  }
  // While touring, ← → step and Space pauses (unless a button has focus:
  // Space then presses it).
  if (tour.on && plain && !spotlightOpen() && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
    e.preventDefault();
    tourStep(e.key === 'ArrowRight' ? 1 : -1);
    return;
  }
  if (tour.on && plain && e.key === ' ' && !e.target.closest?.('button')) {
    e.preventDefault();
    toggleTourPause();
    return;
  }
  if (letter === 'c' && plain) {
    setChangesMode(!changesOn());
    return;
  }
  if (letter === 'p' && plain) {
    setPiiMode(!piiOn());
    return;
  }
  if (letter === 'h' && plain) {
    setHealthMode(!healthOn());
    return;
  }
  if (letter === 's' && plain) {
    setCentralMode(!centralOn());
    return;
  }
  if (e.key === '?' && !e.metaKey && !e.ctrlKey && !typing()) {
    showShortcuts();
    return;
  }
  if (letter === 'l' && !e.metaKey && !e.ctrlKey && !e.altKey && !typing()) {
    if (legendSections().length > 0) setLegend(!legendShown());
    return;
  }
  // ← (or Backspace) outside a text field and a menu goes back like the
  // toolbar's Back, → goes forward again. Alt is allowed so the browser's
  // own Alt+← does not leave the file.
  const free = !typing() && !e.metaKey && !e.ctrlKey && !openMenu();
  if (free && e.key === 'ArrowRight') {
    e.preventDefault();
    if (!spotlightOpen()) forward();
    return;
  }
  if (free && (e.key === 'ArrowLeft' || e.key === 'Backspace')) {
    e.preventDefault();
    if (!spotlightOpen()) back();
    return;
  }
  if (e.key !== 'Escape') return;
  if (spotlightOpen()) return closeSpotlight(true);
  if (joinSpotOpen()) return closeJoinSpot();
  if (openMenu()) return closeMenus();
  if (tour.on) return endTour(true);
  const modes = highlightModes().filter((m) => m.on);
  if (modes.length === 0 || svg.querySelector('g.view.dimmed, .selected, .hl')) return clearSelection();
  const listed = modes.find((m) => m.listed());
  if (listed) return listed.toggle();
  if (panel.fo.style.display !== 'none') return hidePanel();
  for (const m of modes) m.toggle();
});

window.addEventListener('resize', () => {
  layoutOverlays();
  if (tour.on) frameTourStep();
  else zoomToRect(viewBounds(state.view), MAX_FIT_SCALE);
});

// Later overlays paint on top: the toolbar's menus over the panel, the
// search over everything but the tooltip.
svg.append(legend.fo, help.fo, minimap.fo, backPill.fo, reviewChip.fo, piiChip.fo, healthChip.fo, centralChip.fo, changesChip.fo, panel.fo, tourBox.fo, toolbar.fo, spotlight.fo, joinSpot.fo, hint.fo, toast.fo, tip.fo);
// The view drawn visible without script is where the reader starts (all
// tables unless the workspace configured another view). All tables open at
// a readable size around the most central table; a diff drawing shows its
// whole view, banner included.
const start = [...views].find(([, v]) => v.style.display !== 'none')?.[0] ?? OVERVIEW;
showView(start);
// The renderer opens a diff with the Changes mode on (class in the markup): show its chip.
if (changesOn()) setChangesMode(true);
if (!openDeepLink(location.hash) && start === ALL_VIEW && !data.changes) readableStart(viewBounds(ALL_VIEW), indexes.get(ALL_VIEW).get(data.mostCentral)?.box ?? null);
// Another link opened in the same tab (a hash change only) goes there too.
window.addEventListener('hashchange', () => openDeepLink(location.hash));
// Overlays sized from their text (the mode chips) were measured before the
// inlined font had loaded; measure them again once it has.
document.fonts?.ready.then(() => layoutOverlays());
