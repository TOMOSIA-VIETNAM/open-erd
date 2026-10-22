// Viewer embedded in erd.svg. It runs when the SVG is opened directly in a
// browser; it turns the static drawing (the opening view visible, other
// views hidden) into an explorable diagram. Everything it adds is created
// here at runtime, so a viewer without script still shows the plain
// opening view.
import { dbDisplayName } from '../../../display-name.js';
import { REVIEW_WORDS, endMarkers, enumIconSvg, indexIconSvg, isConfirmed, keyIconSvg, linkIconSvg, markerSvg, overviewStrokeWidth, reviewIconSvg, starIconSvg } from '../markers.js';
import { CANVAS_LIMITS, PIXEL_RATIO, canvasScale, exportBaseName } from './download.js';
import { findJoinPaths, hopCondition, pathNames, sqlSkeleton } from './join-path.js';
import { collectionDocument, createTableSql, isDocumentStore, markdownTable } from './schema-copy.js';
import { centreOn, fitsInside, minimapSize, visibleRect } from './minimap.js';
import { columnBadges, panelTabs } from './panel-parts.js';
import { emptyHistory, goBack, goForward, tableTrail, visit } from './history.js';
import { endTransforms, radialLayout, straightLink } from './radial.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const HTML_NS = 'http://www.w3.org/1999/xhtml';
const OVERVIEW = 'overview';
const ALL_VIEW = 'all';
const CONNECTIONS = 'connections';
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
const RING_GAP = 40;
const NEIGHBORHOOD_MARGIN = 60;
const SEARCH_LIMIT = 40;
const TIP_OFFSET = 14;
// Smallest text in table boxes and matrix headers, and the size it should
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
for (const t of svg.querySelectorAll('.nodes title, .relations title, .mx-cells title')) t.remove();

// Lines are 1.4 px wide; a wide transparent twin makes them clickable.
function addHitPaths(root) {
  for (const p of root.querySelectorAll('.relation-group > path.relation, .hub-route > path.relation')) {
    p.before(svgEl('path', { class: 'relation-hit', d: p.getAttribute('d') }));
  }
}
addHitPaths(svg);

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
function applyCamera() {
  if (cameraFrame) cancelAnimationFrame(cameraFrame);
  cameraFrame = 0;
  const { x, y, s } = state.cam;
  camera.setAttribute('transform', `translate(${x} ${y}) scale(${s})`);
  if (state.view === CONNECTIONS) stickHeaders();
  placeBackPill();
  updateMinimap();
}

// The connections view keeps its header column and header row on screen
// while the matrix is panned: they slide along with the visible edge but
// never past where they are drawn.
function stickHeaders() {
  const { x, y, s } = state.cam;
  const dx = Math.max(0, -x / s);
  const dy = Math.max(0, (TOOLBAR_HEIGHT - y) / s);
  for (const g of views.get(CONNECTIONS).querySelectorAll('.mx-sticky-x, .mx-sticky-y')) {
    const sx = g.classList.contains('mx-sticky-x') ? dx : 0;
    // A header row drawn below the top edge sticks once it reaches it.
    const sy = g.classList.contains('mx-sticky-y') ? Math.max(0, dy - Number(g.getAttribute('data-top') ?? 0)) : 0;
    g.setAttribute('transform', `translate(${sx} ${sy})`);
  }
}
// Pan and zoom gestures fire many events per frame: write the transform once
// per frame, with the latest camera.
function scheduleCamera() {
  if (!cameraFrame) cameraFrame = requestAnimationFrame(applyCamera);
}

// The panel covers the right edge of the screen; fitting leaves that strip free.
function zoomToRect(r, maxScale) {
  const { w, h } = viewport();
  const panelOpen = panel.fo.style.display !== 'none';
  // The Back pill floats under the toolbar in a navigated view: keep clear of it.
  const top = TOOLBAR_HEIGHT + (backPillShown() ? BACK_PILL_ROOM : 0);
  const area = { w: panelOpen ? w - PANEL_WIDTH - 2 * PANEL_MARGIN : w, h: h - top };
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
  state.view = name;
  // A neighborhood or join view of the same name may hold other tables now.
  map.view = null;
  if (name === CONNECTIONS) readableStart(viewBounds(name), null, 1);
  else zoomToRect(viewBounds(name), MAX_FIT_SCALE);
  renderToolbar();
  // The legend keeps the reader's choice (open or folded to its pill); its
  // content follows the view.
  setLegend(legendOpen);
}

// A large view opens where its text can be read: the whole view when it
// fits at a readable size, else at scale 1 centred on `focus` (a box), or
// from the top left corner when there is none.
function readableStart(bounds, focus, maxScale = MAX_FIT_SCALE) {
  const { w, h } = viewport();
  const fit = Math.min((w - 2 * FIT_PADDING) / bounds.w, (h - TOOLBAR_HEIGHT - 2 * FIT_PADDING) / bounds.h, maxScale);
  if (fit * SMALLEST_TEXT >= READABLE_TEXT) return zoomToRect(bounds, maxScale);
  const s = 1;
  state.cam = focus
    ? { s, x: w / 2 - (focus.x + focus.w / 2) * s, y: TOOLBAR_HEIGHT + (h - TOOLBAR_HEIGHT) / 2 - (focus.y + focus.h / 2) * s }
    : { s, x: FIT_PADDING - bounds.x * s, y: TOOLBAR_HEIGHT + FIT_PADDING - bounds.y * s };
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
  const { history, target } = goBack(nav, snapshot());
  if (!target) return;
  nav = history;
  restore(target);
}
function forward() {
  const { history, target } = goForward(nav, snapshot());
  if (!target) return;
  nav = history;
  restore(target);
}

// A table reached by a jump pulses briefly, so the eye finds it.
const ARRIVE_MS = 1600;
function arrive(id) {
  const g = currentIndex().get(id)?.el;
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
  stopFlows();
  for (const v of views.values()) {
    v.classList.remove('dimmed', 'center-selected');
    for (const e of v.querySelectorAll('.hl, .selected, .flow-target, .flowing, .hl-column')) {
      e.classList.remove('hl', 'selected', 'flow-target', 'flowing', 'hl-column');
    }
    for (const e of v.querySelectorAll('.flow')) e.remove();
    for (const e of v.querySelectorAll('.poly-routes, .hub-routes')) e.style.display = 'none';
  }
  hidePanel();
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
  if (!poly) shareHash(`table=${id}`);
}

function focusNode(id, column) {
  const entry = currentIndex().get(id);
  if (!entry) return;
  unfoldFor(id);
  selectNode(id);
  if (column) {
    for (const c of entry.el.querySelectorAll('.column')) if (c.getAttribute('data-column') === column) c.classList.add('hl-column');
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
  return svgEl('g', { class: `relation-group kind-${l.kind} review-${l.review}${style}${extraClass}`, 'data-id': l.id, 'data-from': from, 'data-to': to }, children);
}

/**
 * (Re)builds the neighborhood view around `center` from copies of the boxes
 * drawn in the full view, placed by radialLayout with straight lines.
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
    copy.classList.remove('hl', 'selected', 'flow-target', 'oe-hidden');
    if (outer.has(id)) copy.classList.add('hop-2');
    nodes.append(svgEl('g', { transform: `translate(${dx} ${dy})` }, [copy]));
  }
  const relations = svgEl('g', { class: 'relations' });
  const ends = (a, b) => straightLink(boxes.get(a), boxes.get(b));
  const relationLine = (l, from, to) => straightRelation(l, from, to, boxes, outer.has(from) || outer.has(to) ? ' hop-2' : '');
  for (const l of data.links) {
    if (l.from === l.to || !shown.has(l.from) || !shown.has(l.to)) continue;
    relations.append(relationLine(l, l.from, l.to));
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

// Left: Back and the breadcrumb, which gets whatever width is left. Right,
// never shrinking: the Map | Connections switch (on those two views), the
// search trigger, Join path, the view switcher, the ⋯ menu (folding,
// legend, minimap, review mode) and Download.
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
  // Swatches with their lines: the legend.
  legend: 'M2.5 3H4.5V5H2.5ZM2.5 7H4.5V9H2.5ZM2.5 11H4.5V13H2.5ZM7 4H13.5M7 8H13.5M7 12H13.5',
  // The three ways to see the schema: tables, the domain map, the matrix.
  table: 'M2.5 3.5H13.5V12.5H2.5ZM2.5 6.5H13.5M2.5 9.5H13.5M6.5 6.5V12.5',
  map: 'M2.5 4L6 2.5L10 4L13.5 2.5V12L10 13.5L6 12L2.5 13.5ZM6 2.5V12M10 4V13.5',
  matrix: 'M2.5 2.5H13.5V13.5H2.5ZM6.2 2.5V13.5M9.8 2.5V13.5M2.5 6.2H13.5M2.5 9.8H13.5',
  database: 'M3.5 4C3.5 2.6 12.5 2.6 12.5 4V12C12.5 13.4 3.5 13.4 3.5 12ZM3.5 4C3.5 5.4 12.5 5.4 12.5 4M3.5 8C3.5 9.4 12.5 9.4 12.5 8',
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
// table, the domain cards (Map) and the domain matrix (Connections). A
// schema too large for the view of all tables has no first one.
// Narrow windows show the icons only (their tooltips name them).
const viewTabs = [
  [ALL_VIEW, 'table', 'All tables', `Every table of every domain (${MOD_KEY}A)`],
  [OVERVIEW, 'map', 'Map', 'Domains as cards: what each holds and what it is related to'],
  [CONNECTIONS, 'matrix', 'Connections', 'Domain × domain matrix: how many relations go from each domain to each other'],
]
  .filter(([name]) => views.has(name))
  .map(([name, icon, text, title]) =>
    el('button', { class: 'oe-btn oe-tab-view', title: `${text}: ${title}`, 'aria-label': text, 'data-view': name, on: { click: () => navigate(name) } }, [iconSvg(icon, 14), el('span', { class: 'label', text })]),
  );
const viewGroup = el('div', { class: 'oe-seg oe-view-tabs' }, viewTabs);

const FIND_KEY = `${MOD_KEY}F`;
const searchButton = el('button', { class: 'oe-btn oe-tool oe-search-trigger', title: `Search tables and columns (${FIND_KEY} or /)`, 'aria-label': 'Search tables and columns', on: { click: () => openSpotlight() } }, [
  iconSvg('search'),
  el('span', { class: 'label', text: 'Search' }),
  el('kbd', { text: FIND_KEY }),
]);
const joinButton = toolButton('join', 'Join path', `How to join two tables: the condition of each hop (${MOD_KEY}J)`, () => (join.open ? clearSelection() : openJoinSpot(selectedTable())));
joinButton.append(el('kbd', { text: `${MOD_KEY}J` }));

// Dropdown menus of the toolbar; one open at a time.
const menus = [];
function dropdown(button, cls) {
  const menu = el('div', { class: `oe-menu ${cls}`, role: 'menu', style: 'display:none' });
  const wrap = el('div', { class: 'oe-drop' }, [button, menu]);
  const entry = { button, menu, wrap, onOpen: null };
  menus.push(entry);
  button.addEventListener('click', () => setMenu(entry, menu.style.display === 'none'));
  return entry;
}
const openMenu = () => menus.find((m) => m.menu.style.display !== 'none') ?? null;
function setMenu(entry, open) {
  for (const m of menus) {
    const on = m === entry && open;
    if (on && m.onOpen) m.onOpen();
    m.menu.style.display = on ? '' : 'none';
    m.button.classList.toggle('on', on);
  }
  if (!(entry === downloadMenu && open)) downloadStatus.textContent = '';
  layoutOverlays();
}
const closeMenus = () => setMenu(null, false);
// A menu row: a check mark column (shown for toggles that are on), label,
// optional second line.
function menuItem(label, title, onClick, { checked = null, detail = null, disabled = false } = {}) {
  return el('button', { class: `oe-item${checked ? ' checked' : ''}`, role: checked === null ? 'menuitem' : 'menuitemcheckbox', title, ...(disabled ? { disabled: '' } : {}), on: { click: onClick } }, [
    el('span', { class: 'mark' }, [checked ? iconSvg('check', 14) : null]),
    el('span', { class: 'text' }, [el('span', { text: label }), detail ? el('span', { class: 'detail', text: detail }) : null]),
  ]);
}

// Databases: each one's frame, in the view of all tables when it is on
// screen, else on the overview. The views themselves are the toolbar tabs.
const viewsMenu = dropdown(
  el('button', { class: 'oe-btn oe-tool', title: 'Show one database', 'aria-label': 'Show one database' }, [iconSvg('database'), el('span', { class: 'label', text: 'Databases' }), iconSvg('caret', 12)]),
  'oe-views-menu',
);
const DATABASES = [...views.get(OVERVIEW).querySelectorAll('.database')].map((g) => g.getAttribute('data-database'));
// replaceChildren would print a null as text: optional entries are filtered.
const fillMenu = (menu, items) => menu.replaceChildren(...items.filter(Boolean));
viewsMenu.onOpen = () =>
  fillMenu(
    viewsMenu.menu,
    DATABASES.map((db) => menuItem(dbDisplayName(db), `Show the ${dbDisplayName(db)} database (${data.databases[db].label})`, () => (closeMenus(), showDatabase(db)), { detail: data.databases[db].label })),
  );

// The ⋯ menu: view and display settings, rebuilt on every open so labels
// and checks reflect the current state.
const moreMenu = dropdown(toolButton('more', '', 'More: collapse or expand domains, legend, minimap, review mode'), 'oe-more-menu');
// Overview cards and the matrix stand for many relations and carry no review colour.
const reviewable = () => state.view !== OVERVIEW && state.view !== CONNECTIONS;
const REVIEW_TOTAL = data.review.pending + data.review.stale;
const reviewCounts = () => `${data.review.pending} to confirm · ${data.review.stale} changed in code`;
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
    menuItem('Collapse all', foldable ? 'Fold every domain in this view; a click on a domain header folds just that one' : 'Nothing to fold in this view', fold(true), { disabled: !foldable }),
    menuItem('Expand all', foldable ? 'Unfold every domain in this view' : 'Nothing to fold in this view', fold(false), { disabled: !foldable }),
    el('div', { class: 'oe-menu-sep' }),
    menuItem('Minimap', 'Small map of the whole view, shown while it does not fit on screen', toggle(() => setMinimap(!map.on)), { checked: map.on }),
    menuItem('Keyboard shortcuts', 'Keys that work in this file', () => (closeMenus(), showShortcuts())),
    // Nothing to review: the entry would switch on a mode that changes nothing.
    REVIEW_TOTAL > 0 && reviewable()
      ? menuItem(`Review mode · ${reviewCounts()}`, 'Color lines by review status: amber = not confirmed yet, red = code changed since review', toggle(() => setReviewMode(!reviewing())), {
          checked: reviewing(),
          detail: 'Color lines by review status: amber = not confirmed yet, red = code changed since review',
        })
      : null,
  ]);
};

const downloadStatus = el('div', { class: 'oe-status' });
const keepHighlight = el('input', { type: 'checkbox' });
const downloadMenu = dropdown(toolButton('download', '', 'Download the view on screen as SVG, PNG or JPEG'), 'oe-download-menu');
downloadMenu.menu.append(
  ...[
    ['This view as SVG', 'svg', 'Vector drawing of this view only, without the interactive viewer'],
    ['This view as PNG', 'png', 'Image at twice the screen resolution, transparent outside the drawing'],
    ['This view as JPEG', 'jpg', 'Smaller image on a white background'],
  ].map(([text, format, title]) => menuItem(text, title, () => download(format))),
  el('label', { class: 'oe-check', title: 'Keep the highlighted tables and lines in the file' }, [keepHighlight, el('span', { text: 'Keep highlight and selection' })]),
  downloadStatus,
);

toolbar.div.append(
  el('div', { class: 'oe-left' }, [backButton, crumbs]),
  el('div', { class: 'oe-right' }, [hopGroup, viewGroup, searchButton, joinButton, viewsMenu.wrap, moreMenu.wrap, downloadMenu.wrap]),
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
  if (state.view === CONNECTIONS) parts.push(crumb('Connections'));
  if (cluster) {
    const db = cluster.split('/')[0];
    // There is no database-level view; the database crumb shows its frame on the overview.
    parts.push(crumb(dbDisplayName(db), () => showDatabase(db)));
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
  hopButtons.forEach((b, i) => b.classList.toggle('on', state.hops === RELATED.options[i].hops));
  layoutOverlays();
}

// In a view reached by navigation, a pill at the top left of the canvas
// names where Back goes ("← All tables"); the toolbar's Back does the same.
const NAVIGATED = (name) => name.startsWith(DOMAIN_PREFIX) || [NEIGHBORHOOD, JOIN_VIEW, CONNECTIONS].includes(name);
function viewLabel(snap) {
  if (snap.view === OVERVIEW) return 'Overview';
  if (snap.view === ALL_VIEW) return 'All tables';
  if (snap.view === CONNECTIONS) return 'Connections';
  if (snap.view === NEIGHBORHOOD) return `Tables related to ${short(snap.center)}`;
  if (snap.view === JOIN_VIEW) return `Join path ${short(snap.joinPath.nodes[0])} → ${short(snap.joinPath.nodes.at(-1))}`;
  return domainName(snap.view.slice(DOMAIN_PREFIX.length));
}
const backPill = overlay('oe-back-host');
backPill.fo.style.display = 'none';
// Shown in a view reached by navigation, and wherever the step behind was a
// table: it then names that table.
// Never on the overview, never pointing back to it: the overview is one
// click away on the toolbar's Map tab.
function backPillShown() {
  const prev = nav.back.at(-1);
  return Boolean(prev) && state.view !== OVERVIEW && prev.view !== OVERVIEW && (NAVIGATED(state.view) || Boolean(prev.table));
}
function updateBackPill() {
  const prev = nav.back.at(-1);
  const show = backPillShown();
  backPill.fo.style.display = show ? '' : 'none';
  if (!show) return;
  const label = prev.table ? short(prev.table) : viewLabel(prev);
  backPill.div.replaceChildren(el('button', { class: 'oe-back-pill', title: 'Back (Backspace or Alt+←)', text: `← ${label}`, on: { click: back } }));
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
// the review chip), left of the panel. With that corner off screen it waits
// at the canvas's top left.
function placeBackPill() {
  if (backPill.fo.style.display === 'none' || !backPill.size) return;
  const vp = viewport();
  const { w, h } = backPill.size;
  const chip = reviewChip.fo.style.display !== 'none' ? Number(reviewChip.fo.getAttribute('height')) + 8 : 0;
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

const HIGHLIGHT_CLASSES = ['hl', 'selected', 'flow-target', 'flowing', 'hl-column', 'dimmed', 'center-selected'];
const isHidden = (e) => e.classList.contains('oe-hidden') || /display:\s*none/.test(e.getAttribute('style') ?? '');

/**
 * The view on screen as a standalone static SVG: that view only, in its own
 * coordinates, with the stylesheet (and so the embedded font) but no viewer
 * script, no data and no overlays. Folded domains stay folded; the
 * highlight and selection are kept only when asked.
 */
function viewAsSvg(keep) {
  const { x, y, w, h } = viewBounds(state.view);
  const view = currentView().cloneNode(true);
  view.removeAttribute('style');
  if (!keep) {
    for (const e of [view, ...view.querySelectorAll('*')]) e.classList.remove(...HIGHLIGHT_CLASSES);
    for (const e of view.querySelectorAll('.flow')) e.remove();
    for (const e of view.querySelectorAll('.poly-routes, .hub-routes')) e.style.display = 'none';
  }
  // A static file folds nothing: no toggles, titles back where they were drawn.
  for (const e of view.querySelectorAll('.fold-toggle, .fold-hit')) e.remove();
  for (const e of view.querySelectorAll('.cluster-label[data-x]')) e.setAttribute('x', e.getAttribute('data-x'));
  for (const e of view.querySelectorAll('.database > [transform]')) e.removeAttribute('transform');
  for (const e of [...view.querySelectorAll('*')].filter(isHidden)) e.remove();
  for (const e of view.querySelectorAll('.relation-hit, .card-links')) e.remove();
  for (const e of view.querySelectorAll('.mx-sticky-x, .mx-sticky-y')) e.removeAttribute('transform');
  const root = svgEl('svg', { width: w, height: h, viewBox: `${x} ${y} ${w} ${h}` }, [svg.querySelector('style').cloneNode(true), view]);
  // Review colours and diff colours are classes on the root.
  const cls = ['review-mode', 'diff-mode'].filter((c) => svg.classList.contains(c));
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

async function download(format) {
  const join = state.view === JOIN_VIEW ? `${short(state.joinPath.nodes[0])}-to-${short(state.joinPath.nodes.at(-1))}` : state.center;
  const name = `${exportBaseName(data.project, state.view, join)}.${format}`;
  const svgFile = viewAsSvg(keepHighlight.checked);
  if (format === 'svg') {
    saveBlob(new Blob([svgFile.text], { type: 'image/svg+xml' }), name);
    downloadStatus.textContent = `Saved ${name}`;
    return layoutOverlays();
  }
  downloadStatus.textContent = `Drawing ${name}…`;
  layoutOverlays();
  try {
    const { blob, size } = await rasterize(svgFile, format === 'png' ? 'image/png' : 'image/jpeg');
    saveBlob(blob, name);
    const px = `${size.width} × ${size.height} px`;
    downloadStatus.textContent = size.downscaled
      ? `Saved ${name} (${px}), downscaled to ${Math.round((size.scale / PIXEL_RATIO) * 100)}% of the usual size to stay within this browser's image size limit. Download the SVG for full detail.`
      : `Saved ${name} (${px})`;
  } catch (e) {
    downloadStatus.textContent = `Could not save ${name}: ${e.message}`;
  }
  layoutOverlays();
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

// Spotlight: Cmd+F / Ctrl+F (or "/") opens a search box in the middle of
// the screen over a dimmed drawing, with tables and columns listed as you
// type. Arrow keys move through the list, Enter jumps, Escape closes. The
// browser's own find bar would search the toolbar's text only, so the
// shortcut is taken over.
const spotlight = overlay('oe-spotlight-host');
spotlight.fo.style.display = 'none';
const spotlightInput = el('input', { type: 'search', class: 'oe-spotlight-input', placeholder: 'Search tables and columns', 'aria-label': 'Search tables and columns', autocomplete: 'off', spellcheck: 'false' });
const spotlightList = el('div', { class: 'oe-spotlight-list', role: 'listbox' });
const spotlightHint = el('div', { class: 'oe-spotlight-hint', text: '↑ ↓ to move · Enter to open · Esc to close' });
spotlight.div.append(
  el('div', { class: 'oe-spotlight-backdrop', on: { pointerdown: () => closeSpotlight() } }),
  el('div', { class: 'oe-spotlight', role: 'dialog', 'aria-label': 'Search' }, [el('div', { class: 'oe-spotlight-field' }, [iconSvg('search', 18), spotlightInput]), spotlightList, spotlightHint]),
);
let resultHits = [];
let resultItems = [];
let activeResult = 0;
const spotlightOpen = () => spotlight.fo.style.display !== 'none';

function openSpotlight() {
  closeMenus();
  closeJoinSpot();
  hideTip();
  spotlight.fo.style.display = '';
  layoutOverlays();
  spotlightInput.focus();
  spotlightInput.select();
  renderResults();
}

function closeSpotlight() {
  if (!spotlightOpen()) return;
  spotlight.fo.style.display = 'none';
  spotlightInput.blur();
}

function pick(hit) {
  closeSpotlight();
  goToNode(hit.id, hit.column);
}

function setActive(i) {
  resultItems[activeResult]?.classList.remove('active');
  activeResult = i;
  resultItems[activeResult]?.classList.add('active');
  resultItems[activeResult]?.scrollIntoView({ block: 'nearest' });
}

// One row per hit: a table or column icon, the name, then where it is.
function renderResults() {
  const hits = search(spotlightInput.value);
  activeResult = 0;
  resultHits = hits;
  resultItems = hits.map((hit, i) => {
    const n = data.nodes[hit.id];
    const where = hit.column ? `column of ${short(hit.id)} · ${domainName(n.cluster)}` : `${dbDisplayName(dbOf(hit.id))} › ${domainName(n.cluster)}`;
    return el('button', { class: `oe-result${i === 0 ? ' active' : ''}`, role: 'option', title: hit.column ? `${hit.id}.${hit.column}` : hit.id, on: { click: () => pick(hit), pointermove: () => activeResult !== i && setActive(i) } }, [
      el('span', { class: `kind ${hit.column ? 'is-column' : 'is-table'}`, text: hit.column ? 'col' : 'table' }),
      el('span', { class: 'name', text: hit.column ? `${short(hit.id)}.${hit.column}` : short(hit.id) }),
      el('span', { class: 'where', text: where }),
    ]);
  });
  const empty = spotlightInput.value.trim() ? 'No table or column matches' : 'Type a table or column name';
  spotlightList.replaceChildren(...(resultItems.length > 0 ? resultItems : [el('div', { class: 'oe-spotlight-empty', text: empty })]));
}

spotlightInput.addEventListener('input', renderResults);
spotlightInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && resultHits[activeResult]) pick(resultHits[activeResult]);
  else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && resultItems.length > 0) {
    e.preventDefault();
    setActive((activeResult + (e.key === 'ArrowDown' ? 1 : resultItems.length - 1)) % resultItems.length);
  } else if (e.key === 'Escape') closeSpotlight();
  else return;
  e.stopPropagation();
});

// Join spotlight: Cmd+J / Ctrl+J (or the toolbar's Join path) opens two
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

// erd.svg#table=<table id>, #column=<table id>.<column> or #view=<view>
// opens there: a table in the view of all tables (its domain view in a
// schema without one), selected, with its panel; a column also unfolds in
// the panel. Selecting a table writes its link back into the address
// (replaceState: Back does not walk through selections), so the address bar
// is always a link to what is on screen.
let lastHash = null;
function shareHash(value) {
  const hash = `#${value.replace(/[^A-Za-z0-9_./:-]/g, encodeURIComponent)}`;
  if (hash === location.hash) return;
  lastHash = hash;
  try {
    history.replaceState(null, '', hash);
  } catch {
    // A page that may not change its address (some file viewers) keeps it.
  }
}
function openDeepLink(hash) {
  if (!hash || hash === lastHash) return false;
  const [key, ...rest] = hash.slice(1).split('=');
  const value = decodeURIComponent(rest.join('='));
  if (key === 'view' && views.has(value) && value !== NEIGHBORHOOD && value !== JOIN_VIEW) {
    navigate(value);
    return true;
  }
  if (key !== 'table' && key !== 'column') return false;
  const parts = value.split('.');
  const id = parts.slice(0, 3).join('.');
  const column = key === 'column' ? parts.slice(3).join('.') : null;
  if (data.nodes[id]?.kind !== 'table') return false;
  const home = views.has(ALL_VIEW) ? ALL_VIEW : homeView(id);
  navigate(home, { focus: id, column });
  if (column && data.nodes[id].columns.some((c) => c.name === column)) {
    showPanel(nodePanel(id, column));
    panel.div.querySelector('.oe-col.open')?.scrollIntoView({ block: 'nearest' });
    shareHash(`column=${id}.${column}`);
  }
  return true;
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
    el('table', { class: 'oe-keys' }, SHORTCUTS.map(([keys, what]) => el('tr', {}, [el('td', {}, [el('kbd', { text: keys })]), el('td', { text: what })]))),
  ]);
}
panel.fo.style.display = 'none';

function hidePanel() {
  const was = panel.fo.style.display !== 'none';
  panel.fo.style.display = 'none';
  join.open = false;
  joinButton.classList.remove('on');
  // The minimap and the Back pill keep clear of the panel: with it gone
  // they move back to the right edge now, not at the next pan.
  if (was) {
    updateMinimap();
    placeBackPill();
  }
}

function showPanel(children) {
  panel.div.replaceChildren(...children.filter(Boolean));
  panel.fo.style.display = '';
  layoutOverlays();
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
      el('span', { class: 'gutter', title: key === 'pk' ? 'Primary key' : key === 'fk' ? 'References another table' : '' }, [keyIcon(key)]),
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
    arrow('←', 'Back (Backspace or Alt+←)', back, nav.back.length > 0),
    arrow('→', 'Forward (Shift+Backspace or Alt+→)', forward, nav.forward.length > 0),
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
// referencing table is in `a` (pointing at keys in `b`), then the others;
// one direction only for a domain with itself.
function byDirection(a, b) {
  const relations = data.domainLinks[pairId(a, b)] ?? [];
  const directions = a === b ? [[a, a]] : [[a, b], [b, a]];
  return directions.map(([from, to]) => ({ from, to, relations: relations.filter((r) => clusterOf(r.from) === from) }));
}

// The relations between two domains (a connector, a matrix cell), grouped
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
    panelHeader({ name: a === b ? 'Inside' : null, tip: crossDb ? `Cross-DB: ${crossing(a, b, '⇄')}` : '', cluster: a === b ? [a] : [a, b], note: a === b ? `${plural(total, 'relation')} inside this domain` : `${plural(total, 'relation')} between these two domains${crossDb ? ` · cross-DB` : ''}` }),
    changeList('links', id),
    ...byDirection(a, b)
      .filter((d) => d.relations.length > 0)
      .map((d) => el('div', { class: 'oe-chip-group' }, [el('div', { class: 'sub', text: a === b ? `${domainName(a)} (${d.relations.length})` : `${domainName(d.from)} → ${domainName(d.to)} (${d.relations.length})` }), el('div', { class: 'oe-chipbox' }, chips(d.relations))])),
  ];
}

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

function relationPanel(g) {
  if (g.hasAttribute('data-group')) return groupLinePanel(g);
  const id = g.getAttribute('data-id');
  const [from, to] = [g.getAttribute('data-from'), g.getAttribute('data-to')];
  const l = data.links.find((x) => x.id === id) ?? data.hubLinks.find((x) => x.id === id);
  return [
    el('h3', { text: `${short(from)} → ${short(to)}` }),
    el('div', { class: 'sub', text: id }),
    l ? el('p', { class: 'oe-line-facts' }, [el('span', { text: `${linkSummary(l)}${l.via ? ` · via ${l.via}` : ''}` }), l.kind === 'view_source' ? null : reviewIcon(l.review)]) : null,
    dbOf(from) !== dbOf(to) ? el('p', { text: `Cross-DB: ${crossing(from, to)}` }) : null,
    changeList('links', id),
    el('div', { class: 'row' }, [link(`Go to ${short(to)}`, () => goToNode(to))]),
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
const join = { open: false, from: null, to: null, paths: [], index: 0 };
const JOIN_STEP_MS = 450;
const JOIN_PICKS = 8;
// Below this scale a path drawn across a large view is too small to read.
const JOIN_MIN_SCALE = 0.45;
let flowTimers = [];

function stopFlows() {
  for (const t of flowTimers) clearTimeout(t);
  flowTimers = [];
}

function openJoin(from = null) {
  join.from = data.nodes[from]?.kind === 'table' ? from : null;
  join.to = null;
  join.paths = [];
  showJoin();
}

function showJoin() {
  showPanel(joinPanel());
  join.open = true;
  joinButton.classList.add('on');
  panel.div.querySelector('.oe-join-field input')?.focus();
}

function setJoinEnd(slot, id) {
  // Changing an end drops the old path's highlight.
  if (id === null) clearSelection();
  join[slot] = id;
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

// Box around the path's nodes in a view, with room around it.
function joinBounds(index, steps) {
  const boxes = stepNodes(steps).map((id) => index.get(id)?.box).filter(Boolean);
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
    copy.classList.remove('hl', 'selected', 'flow-target', 'oe-hidden');
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
  for (const id of stepNodes(steps)) index.get(id)?.el.classList.add('hl');
  for (const id of [join.from, join.to]) index.get(id)?.el.classList.add('selected');
  const segments = steps.map((s, k) => stepSegments(name, s, k));
  for (const seg of segments.flat()) {
    seg.g.classList.add('hl', 'flowing');
    if (seg.show) seg.show.style.display = '';
  }
  // Each step's dashes start once the previous step's have set off.
  segments.forEach((list, k) => {
    flowTimers.push(
      setTimeout(() => {
        for (const seg of list) seg.g.append(svgEl('path', { class: 'flow', d: seg.reverse ? reversed(seg.d) : seg.d }));
        if (k === segments.length - 1) index.get(join.to)?.el.classList.add('flow-target');
      }, k * JOIN_STEP_MS),
    );
  });
  showJoin();
  // The legend sits bottom left, where the fitted path would run under it.
  setLegend(false);
  zoomToRect(joinBounds(index, steps), FOCUS_MAX_SCALE);
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
};

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
    el('div', { class: 'muted', text: 'Shortest first; unconfirmed relations and hub tables count as longer.' }),
    el('div', { class: 'oe-seg oe-paths' }, join.paths.map((p, i) => el('button', { class: `oe-btn${i === join.index ? ' on' : ''}`, text: `Path ${i + 1} · ${plural(p.hops.length, 'hop')}`, on: { click: () => showJoinPath(i) } }))),
    el(
      'ol',
      { class: 'oe-hops' },
      path.hops.map((h) =>
        el('li', {}, [
          el('code', { text: hopCondition(h, name) }),
          h.flags.length > 0
            ? el('div', { class: 'oe-chips' }, h.flags.map((f) => (f.review ? reviewIcon(f.review) : el('span', { class: `chip flag-${f.type}`, text: FLAG_TEXT[f.type](f) }))))
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
// view or the mode changes. Open by default in the view of all tables,
// closed elsewhere.
const legend = overlay('oe-legend-host');
const LEGEND_ROOM = 8;
legend.fo.style.display = 'none';
let legendOpen = true;

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
// What lines and boxes mean. Solid and dashed lines explain themselves;
// the legend covers what a reader cannot guess: card strength bars and
// connectors, line ends, the icons in boxes, and, in review mode only, the
// review colours and icons.
const strengthSample = () => sample([0, 1, 2, 3, 4].map((i) => svgEl('rect', { class: `seg${i < 3 ? ' on' : ''}`, x: 2 + i * 11, y: 6, width: 9, height: 6, rx: 1 })));
const connectorSample = (count, crossDb) => sample([connectorEl('M2 14C20 14 26 4 44 4', count, crossDb)]);
const LEGEND = [
  ['Domain cards', [
    [strengthSample, 'Relations with that domain: more filled, more relations', (v) => has(v, '.card-related')],
    [() => connectorSample(1, false), 'Hover a card: few relations', (v) => has(v, '.domain')],
    [() => connectorSample(5, false), 'some relations', (v) => has(v, '.domain')],
    [() => connectorSample(12, false), 'many relations', (v) => has(v, '.domain')],
    [() => connectorSample(3, true), 'Domain in another database', (v) => has(v, '.card-db')],
  ]],
  ['Review mode', [
    [() => reviewSample('kind-db_fk review-reviewed', 'reviewed'), REVIEW_WORDS.reviewed, (v) => reviewing() && has(v, '.relation-group.review-reviewed')],
    [() => reviewSample('kind-declared review-pending', 'pending'), REVIEW_WORDS.pending, (v) => reviewing() && has(v, '.relation-group.review-pending')],
    [() => reviewSample('kind-declared review-stale unconfirmed', 'stale'), REVIEW_WORDS.stale, (v) => reviewing() && has(v, '.relation-group.review-stale')],
  ]],
  ['Line ends', [
    ['one', 'Exactly one'],
    ['zeroOrOne', 'Zero or one'],
    ['many', 'One or more'],
    ['zeroOrMany', 'Zero or more'],
  ].map(([kind, text]) => [() => endSample(kind), text, (v) => endKinds(v).has(kind)])],
  ['In boxes', [
    [() => sample([svgEl('rect', { class: 'legend-central', x: 1, y: 2, width: 62, height: 14, rx: 3 }), ...parsed(starIconSvg(9, 9))]), 'Central table (most connected)', (v) => has(v, '.table.central')],
    [() => iconSample(keyIconSvg(10, 9)), 'Primary key', (v) => has(v, '.icon-pk')],
    [() => iconSample(linkIconSvg(9, 9)), 'References another table', (v) => has(v, '.icon-fk')],
    [() => iconSample(indexIconSvg(8, 9)), 'Column in an index', (v) => has(v, '.icon-index')],
    [() => iconSample(enumIconSvg(8, 9)), 'Column with listed values', (v) => has(v, '.hint-enum')],
    [() => sample([svgEl('path', { class: 'col-warn', d: 'M4 13L8 5L12 13Z' })]), 'Possible missing relation', (v) => has(v, '.col-warn')],
    [() => sample([svgEl('rect', { class: 'stub-box', x: 1, y: 1, width: 62, height: 16, rx: 4 }), svgEl('text', { class: 'stub-title', x: 6, y: 9, 'dominant-baseline': 'central', text: 'orders' })]), 'Linked table in another domain: click to open', (v) => has(v, '.stub')],
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

// A view with nothing to explain shows neither the legend nor its pill;
// the reader's choice is kept for the next view.
function setLegend(open) {
  legendOpen = open;
  const empty = legendSections().length === 0;
  if (empty) legend.div.replaceChildren();
  else if (open) renderLegend();
  else legend.div.replaceChildren(legendPill());
  legend.fo.style.display = empty ? 'none' : '';
  layoutOverlays();
}

// While review mode is on, a chip under the toolbar says so and how much
// waits for review; its × turns the mode off.
const reviewChip = overlay('oe-review-chip-host');
reviewChip.fo.style.display = 'none';
reviewChip.div.append(
  el('div', { class: 'oe-review-chip', title: 'Lines are coloured by review status: amber = not confirmed yet, red = code changed since review' }, [
    el('span', { text: `Review mode: ${data.review.pending} to confirm, ${data.review.stale} changed` }),
    el('button', { class: 'oe-chip-close', text: '×', title: 'Turn review mode off', 'aria-label': 'Turn review mode off', on: { click: () => setReviewMode(false) } }),
  ]),
);

function setReviewMode(on) {
  svg.classList.toggle('review-mode', on);
  reviewChip.fo.style.display = on ? '' : 'none';
  if (legendOpen) setLegend(true);
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
  // The matrix keeps its headers on screen itself; a map of cells says nothing.
  const show = map.on && state.view !== CONNECTIONS && !fitsInside(map.bounds, seen);
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
// A matrix cell: one line in the direction of its row and column, the list
// only in the panel.
function cellTip(row, col) {
  const [there, back] = byDirection(row, col);
  const head = row === col ? `${domainName(row)} · ${plural(there.relations.length, 'relation')} inside` : `${domainName(row)} → ${domainName(col)} · ${plural(there.relations.length, 'relation')}${back.relations.length > 0 ? ` · ${back.relations.length} back` : ''}`;
  return [el('b', { text: head }), el('div', { class: 'muted', text: 'Click to see the list' })];
}

// Every tooltip about the relations between two domains (a connector, a
// card's related domain, a matrix cell) is one line, "A → B · N relations
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
  const cell = target.closest('.mx-cell');
  if (cell) return cellTip(cell.getAttribute('data-from'), cell.getAttribute('data-to'));
  const head = target.closest('.mx-head');
  if (head) return [el('b', { text: domainName(head.getAttribute('data-domain')) }), el('div', { class: 'muted', text: `${dbDisplayName(dbOf(head.getAttribute('data-domain')))} · click to open the domain` })];
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
    el('div', { class: 'muted', text: 'Click to highlight · double-click for its neighborhood' }),
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
  // The review chip floats under the toolbar, top left; the Back pill
  // follows the drawing (see placeBackPill).
  const pillY = TOOLBAR_HEIGHT + 8;
  if (reviewChip.fo.style.display !== 'none') {
    reviewChip.fo.setAttribute('width', w);
    reviewChip.fo.setAttribute('height', 40);
    const r = reviewChip.div.firstChild.getBoundingClientRect();
    reviewChip.fo.setAttribute('x', PANEL_MARGIN);
    reviewChip.fo.setAttribute('y', pillY);
    reviewChip.fo.setAttribute('width', Math.ceil(r.width) + 2);
    reviewChip.fo.setAttribute('height', Math.ceil(r.height) + 2);
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

function focusDomain(id) {
  clearTimeout(unfocusTimer);
  if (focused === id) return;
  focused = id;
  const view = views.get(OVERVIEW);
  for (const e of view.querySelectorAll('.focus-node')) e.classList.remove('focus-node');
  for (const e of view.querySelectorAll('.card-links')) e.remove();
  view.classList.toggle('domain-focus', id !== null);
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
// Matrix: hovering a cell marks it and its two headers.
function markCell(cell) {
  const view = views.get(CONNECTIONS);
  for (const e of view.querySelectorAll('.mx-cell.hl, .mx-head.hl, .mx-cell.cross')) e.classList.remove('hl', 'cross');
  if (!cell) return;
  cell.classList.add('hl');
  const ends = [cell.getAttribute('data-from'), cell.getAttribute('data-to')];
  // Crosshair: the cell's whole row and column.
  for (const c of view.querySelectorAll('.mx-cell')) if (c !== cell && (c.getAttribute('data-from') === ends[0] || c.getAttribute('data-to') === ends[1])) c.classList.add('cross');
  for (const h of view.querySelectorAll('.mx-head')) if (ends.includes(h.getAttribute('data-domain'))) h.classList.add('hl');
}
svg.addEventListener('pointerover', (e) => {
  if (state.view === CONNECTIONS && !press) markCell(inUi(e) ? null : e.target.closest('.mx-cell'));
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
  const related = t.closest('.card-related, .mx-head');
  if (related) return navigate(domainView(related.getAttribute('data-domain')));
  const domain = t.closest('.domain');
  if (domain) return navigate(domainView(domain.getAttribute('data-domain')));
  const pair = t.closest('.card-link, .mx-cell');
  if (pair) return showPanel(domainLinkPanel(pair.getAttribute('data-from'), pair.getAttribute('data-to')));
  const groupRow = t.closest('.group-row[data-table]');
  if (groupRow) return navigate(homeView(groupRow.getAttribute('data-table')), { focus: groupRow.getAttribute('data-table') });
  const group = t.closest('.group-stub');
  if (group) return navigate(domainView(group.getAttribute('data-domain')));
  const stub = t.closest('.stub');
  if (stub) return navigate(homeView(stub.getAttribute('data-id')), { focus: stub.getAttribute('data-id') });
  const node = t.closest('.table, .poly');
  const column = t.closest('.column');
  if (node && column && data.nodes[node.getAttribute('data-id')]?.kind === 'table') {
    const id = node.getAttribute('data-id');
    selectNode(id);
    column.classList.add('hl-column');
    showPanel(nodePanel(id, column.getAttribute('data-column')));
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

// Cmd+F / Ctrl+F, or "/" outside a text field, opens the search; Escape
// closes the innermost thing open: search, a menu, then the selection.
const typing = () => document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement;
// Keyboard shortcuts, also listed under ⋯ › Keyboard shortcuts.
const SHORTCUTS = [
  [`${MOD_KEY}F or /`, 'Search tables and columns'],
  [`${MOD_KEY}J`, 'Join path between two tables'],
  [`${MOD_KEY}A`, 'All tables'],
  [`${MOD_KEY}C`, 'Copy the selected table as SQL (with its indexes)'],
  ['L', 'Show or hide the legend'],
  ['Backspace or Alt+←', 'Back to the previous table or view'],
  ['Shift+Backspace or Alt+→', 'Forward again'],
  ['Esc', 'Close search, menu or panel'],
];
const selectedTable = () => {
  const id = currentView().querySelector('.table.selected')?.getAttribute('data-id');
  return data.nodes[id]?.kind === 'table' ? id : null;
};

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
  toastTimer = setTimeout(() => (toast.fo.style.display = 'none'), 2500);
}
const hasTextSelection = () => (window.getSelection()?.toString() ?? '') !== '';

document.addEventListener('keydown', (e) => {
  const find = (e.key === 'f' || e.key === 'F') && (IS_MAC ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey;
  if (find || (e.key === '/' && !typing() && !e.metaKey && !e.ctrlKey)) {
    e.preventDefault();
    openSpotlight();
    return;
  }
  const mod = (IS_MAC ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey;
  const letter = e.key.length === 1 ? e.key.toLowerCase() : '';
  // Cmd+J / Ctrl+J: the join spotlight. Chrome and Safari let a page take
  // it over; where a browser keeps it, the toolbar's Join path does the same.
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
    const id = selectedTable();
    const status = { textContent: '' };
    const what = isDocumentStore(data.databases[dbOf(id)].engine) ? 'JSON schema' : 'SQL';
    copyText(tableSql(id), status, what, () => showToast(`Copied ${what} for ${short(id)}`));
    return;
  }
  const card = document.activeElement?.closest?.('.domain');
  if ((e.key === 'Enter' || e.key === ' ') && card && state.view === OVERVIEW && !typing()) {
    e.preventDefault();
    navigate(domainView(card.getAttribute('data-domain')));
    return;
  }
  if (letter === 'l' && !e.metaKey && !e.ctrlKey && !e.altKey && !typing()) {
    if (legendSections().length > 0) setLegend(!legendOpen);
    return;
  }
  // Backspace outside a text field, or Alt+←, goes back like the toolbar's Back.
  // Shift+Backspace or Alt+→ goes forward again.
  const backspace = e.key === 'Backspace' && !typing() && !e.metaKey && !e.ctrlKey;
  if ((backspace && e.shiftKey) || (e.key === 'ArrowRight' && e.altKey && !typing())) {
    e.preventDefault();
    if (!spotlightOpen()) forward();
    return;
  }
  if (backspace || (e.key === 'ArrowLeft' && e.altKey && !typing())) {
    e.preventDefault();
    if (!spotlightOpen()) back();
    return;
  }
  if (e.key !== 'Escape') return;
  if (spotlightOpen()) return closeSpotlight();
  if (joinSpotOpen()) return closeJoinSpot();
  if (openMenu()) return closeMenus();
  clearSelection();
});

window.addEventListener('resize', () => {
  layoutOverlays();
  zoomToRect(viewBounds(state.view), MAX_FIT_SCALE);
});

// Later overlays paint on top: the toolbar's menus over the panel, the
// search over everything but the tooltip.
svg.append(legend.fo, minimap.fo, backPill.fo, reviewChip.fo, panel.fo, toolbar.fo, spotlight.fo, joinSpot.fo, toast.fo, tip.fo);
// The view drawn visible without script is where the reader starts (all
// tables unless the workspace configured another view). All tables open at
// a readable size around the most central table; a diff drawing shows its
// whole view, banner included.
const start = [...views].find(([, v]) => v.style.display !== 'none')?.[0] ?? OVERVIEW;
showView(start);
if (!openDeepLink(location.hash) && start === ALL_VIEW && !data.changes) readableStart(viewBounds(ALL_VIEW), indexes.get(ALL_VIEW).get(data.mostCentral)?.box ?? null);
// Another link opened in the same tab (a hash change only) goes there too.
window.addEventListener('hashchange', () => openDeepLink(location.hash));
