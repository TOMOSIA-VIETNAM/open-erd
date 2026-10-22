// Viewer embedded in erd.svg. It runs when the SVG is opened directly in a
// browser; it turns the static drawing (overview visible, other views hidden)
// into an explorable diagram. Everything it adds is created here at runtime,
// so a viewer without script still shows the plain overview.
import { endMarkers, enumIconSvg, isConfirmed, markerSvg } from '../markers.js';
import { CANVAS_LIMITS, PIXEL_RATIO, canvasScale, exportBaseName } from './download.js';
import { conditionsText, findJoinPaths, hopCondition, pathNames, sqlSkeleton } from './join-path.js';
import { centreOn, fitsInside, minimapSize, visibleRect } from './minimap.js';
import { endTransforms, radialLayout, straightLink } from './radial.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const HTML_NS = 'http://www.w3.org/1999/xhtml';
const OVERVIEW = 'overview';
const ALL_VIEW = 'all';
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
// Overview line tooltips list this many relations, the panel lists them all.
const TIP_RELATIONS = 6;
// Column tooltips list this many enum values; a click on the column shows all.
const TIP_ENUM_ROWS = 8;
// A collapsed domain frame keeps only its header bar.
const COLLAPSED_HEIGHT = 48;
// The two sizes of neighborhood, worded for readers who do not think in
// graph hops. Toolbar and panel use the same words.
const RELATED = {
  label: 'Related tables:',
  title: 'Shows this table with the tables it is related to, in a ring around it.',
  options: [
    { hops: 1, text: 'Direct', title: 'Tables linked to this one by a relation.' },
    { hops: 2, text: 'Direct + next level', title: 'Tables linked to this one, and the tables linked to those.' },
  ],
};

const svg = document.documentElement;
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
// "qlear (PostgreSQL) → qlear_mongo (MongoDB)" for the databases of two
// names; `⇄` for an overview line, which stands for both directions.
const dbOf = (name) => name.split(/[./]/)[0];
const crossing = (from, to, arrow = '→') => `${dbOf(from)} (${data.databases[dbOf(from)]}) ${arrow} ${dbOf(to)} (${data.databases[dbOf(to)]})`;
const domainName = (cluster) => cluster.split('/').slice(1).join('/');
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
for (const t of svg.querySelectorAll('.nodes title, .relations title')) t.remove();

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

const state = { view: OVERVIEW, hops: 1, center: null, joinPath: null, history: [], cam: { x: 0, y: 0, s: 1 } };

// ---------------------------------------------------------------- camera

const viewport = () => ({ w: window.innerWidth, h: window.innerHeight });

let cameraFrame = 0;
function applyCamera() {
  if (cameraFrame) cancelAnimationFrame(cameraFrame);
  cameraFrame = 0;
  const { x, y, s } = state.cam;
  camera.setAttribute('transform', `translate(${x} ${y}) scale(${s})`);
  updateMinimap();
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
  const area = { w: panelOpen ? w - PANEL_WIDTH - 2 * PANEL_MARGIN : w, h: h - TOOLBAR_HEIGHT };
  const s = Math.min((area.w - 2 * FIT_PADDING) / r.w, (area.h - 2 * FIT_PADDING) / r.h, maxScale);
  state.cam = { s, x: (area.w - r.w * s) / 2 - r.x * s, y: TOOLBAR_HEIGHT + (area.h - r.h * s) / 2 - r.y * s };
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
  for (const [n, v] of views) v.style.display = n === name ? '' : 'none';
  state.view = name;
  // A neighborhood or join view of the same name may hold other tables now.
  map.view = null;
  zoomToRect(viewBounds(name), MAX_FIT_SCALE);
  renderToolbar();
  setLegend(name === ALL_VIEW);
}

function snapshot() {
  return { view: state.view, center: state.center, hops: state.hops, joinPath: state.joinPath };
}

/** Switches view, remembering where we came from; then focuses `focus`. */
function navigate(name, { focus, column } = {}) {
  if (name !== state.view) {
    state.history.push(snapshot());
    showView(name);
  }
  if (focus) focusNode(focus, column);
}

function back() {
  const prev = state.history.pop();
  if (!prev) return;
  if (prev.view === NEIGHBORHOOD) buildNeighborhood(prev.center, prev.hops);
  if (prev.view === JOIN_VIEW) buildJoinView(prev.joinPath);
  showView(prev.view);
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
  else if (currentIndex().has(id) && state.view !== OVERVIEW && !currentIndex().get(id).el.classList.contains('stub')) focusNode(id, column);
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
  if (state.view !== NEIGHBORHOOD) state.history.push(snapshot());
  buildNeighborhood(id, hops);
  showView(NEIGHBORHOOD);
  selectNode(id);
  // Fit again now that the panel is open.
  zoomToRect(viewBounds(NEIGHBORHOOD), MAX_FIT_SCALE);
}

// ---------------------------------------------------------------- toolbar

const toolbar = overlay('oe-toolbar');
const crumbs = el('div', { class: 'oe-crumbs' });
const backButton = el('button', { class: 'oe-btn', text: '‹ Back', title: 'Previous view', on: { click: back } });
function relatedButtons(open) {
  return RELATED.options.map((o) => el('button', { class: 'oe-btn', text: o.text, title: o.title, on: { click: () => open(o.hops) } }));
}
const hopButtons = relatedButtons((hops) => openNeighborhood(state.center, hops));
const hopGroup = el('div', { class: 'oe-related', title: RELATED.title }, [el('span', { text: RELATED.label }), el('div', { class: 'oe-seg' }, hopButtons)]);
const allButton = el('button', { class: 'oe-btn', text: 'All tables', on: { click: () => navigate(ALL_VIEW) } });
const foldButtons = [
  ['Collapse all', true],
  ['Expand all', false],
].map(([text, fold]) => el('button', { class: 'oe-btn', text, title: `${fold ? 'Fold' : 'Unfold'} every domain in this view; a click on a domain's header folds just that one`, on: { click: () => setCollapsed(state.view, clusterGroups(currentView()).map(keyOf), fold) } }));
const foldGroup = el('div', { class: 'oe-seg' }, foldButtons);
const joinButton = el('button', { class: 'oe-btn', text: 'Join path', title: 'How to join two tables: the condition of each hop', on: { click: () => (join.open ? clearSelection() : openJoin()) } });
const legendButton = el('button', { class: 'oe-btn', text: 'Legend', title: 'What the lines and marks in this view mean', on: { click: () => setLegend(!legendOpen) } });
// Review colours are for reviewers: off by default, so every line has one
// neutral colour and only solid (confirmed) or dashed (not confirmed).
const minimapButton = el('button', { class: 'oe-btn', text: 'Minimap', title: 'Small map of the whole view, shown while it does not fit on screen', on: { click: () => setMinimap(!map.on) } });
const reviewButton = el('button', {
  class: 'oe-btn',
  text: 'Review mode',
  title: 'Colour lines by review state: amber waits for review, red changed in the code since it was reviewed',
  on: { click: () => setReviewMode(!svg.classList.contains('review-mode')) },
});
if (!views.has(ALL_VIEW)) allButton.style.display = 'none';
const searchInput = el('input', { type: 'search', placeholder: 'Search tables and columns', 'aria-label': 'Search tables and columns' });
const results = el('div', { class: 'oe-results', style: 'display:none' });
const modeButtons = ['Business', 'Technical'].map((label) =>
  el('button', { class: 'oe-btn', text: label, on: { click: () => setBusiness(label === 'Business') } }),
);
const downloadButton = el('button', { class: 'oe-btn', text: 'Download ▾', title: 'Save the view on screen as a file', on: { click: () => setMenu(menu.style.display === 'none') } });
const keepHighlight = el('input', { type: 'checkbox' });
const downloadStatus = el('div', { class: 'oe-status' });
const menu = el('div', { class: 'oe-menu', style: 'display:none' }, [
  ...[
    ['This view as SVG', 'svg', 'Vector drawing of this view only, without the interactive viewer'],
    ['This view as PNG', 'png', 'Image at twice the screen resolution, transparent outside the drawing'],
    ['This view as JPEG', 'jpg', 'Smaller image on a white background'],
  ].map(([text, format, title]) => el('button', { class: 'oe-result', text, title, on: { click: () => download(format) } })),
  el('label', { class: 'oe-check' }, [keepHighlight, el('span', { text: 'Keep highlight and selection' })]),
  downloadStatus,
]);
toolbar.div.append(
  backButton,
  crumbs,
  hopGroup,
  foldGroup,
  joinButton,
  legendButton,
  reviewButton,
  minimapButton,
  allButton,
  el('div', { class: 'oe-search' }, [searchInput, results]),
  el('div', { class: 'oe-seg' }, modeButtons),
  el('div', { class: 'oe-download' }, [downloadButton, menu]),
);

function setBusiness(on) {
  svg.classList.toggle('business', on);
  modeButtons[0].classList.toggle('on', on);
  modeButtons[1].classList.toggle('on', !on);
}

function crumb(text, onClick) {
  return onClick ? el('button', { class: 'oe-link', text, on: { click: onClick } }) : el('span', { class: 'here', text });
}

function renderToolbar() {
  const parts = [crumb('Overview', state.view === OVERVIEW ? null : () => navigate(OVERVIEW))];
  const cluster = state.view.startsWith(DOMAIN_PREFIX)
    ? state.view.slice(DOMAIN_PREFIX.length)
    : state.view === NEIGHBORHOOD
      ? clusterOf(state.center)
      : null;
  if (state.view === ALL_VIEW) parts.push(crumb(`All tables · ${plural(tableCount(null), 'table')}`));
  if (cluster) {
    const db = cluster.split('/')[0];
    // There is no database-level view; the database crumb shows its frame on the overview.
    parts.push(crumb(db, () => showDatabase(db)));
    parts.push(
      state.view === NEIGHBORHOOD
        ? crumb(domainName(cluster), () => navigate(domainView(cluster), { focus: state.center }))
        : crumb(`${domainName(cluster)} · ${plural(tableCount(cluster), 'table')}`),
    );
  }
  if (state.view === NEIGHBORHOOD) parts.push(crumb(`Tables related to ${short(state.center)}`));
  if (state.view === JOIN_VIEW) parts.push(crumb(`Join path: ${short(state.joinPath.nodes[0])} → ${short(state.joinPath.nodes.at(-1))}`));
  crumbs.replaceChildren(...parts.flatMap((p, i) => (i === 0 ? [p] : [el('span', { class: 'sep', text: '›' }), p])));
  backButton.disabled = state.history.length === 0;
  hopGroup.style.display = state.view === NEIGHBORHOOD ? '' : 'none';
  hopButtons.forEach((b, i) => b.classList.toggle('on', state.hops === RELATED.options[i].hops));
  allButton.classList.toggle('on', state.view === ALL_VIEW);
  foldGroup.style.display = clusterGroups(currentView()).length > 0 ? '' : 'none';
  // Overview lines stand for many relations and carry no review colour.
  reviewButton.style.display = state.view === OVERVIEW ? 'none' : '';
  layoutOverlays();
}

function showDatabase(db) {
  navigate(OVERVIEW);
  for (const g of views.get(OVERVIEW).querySelectorAll('.database')) {
    if (g.getAttribute('data-database') === db) zoomToRect(boxOf(g), MAX_FIT_SCALE);
  }
}

// ---------------------------------------------------------------- download

function setMenu(open) {
  if (open) closeResults();
  menu.style.display = open ? '' : 'none';
  if (!open) downloadStatus.textContent = '';
  downloadButton.classList.toggle('on', open);
  layoutOverlays();
}

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
  for (const e of view.querySelectorAll('.relation-hit')) e.remove();
  const root = svgEl('svg', { width: w, height: h, viewBox: `${x} ${y} ${w} ${h}` }, [svg.querySelector('style').cloneNode(true), view]);
  // Business mode, review colours and diff colours are classes on the root.
  const cls = ['business', 'review-mode', 'diff-mode'].filter((c) => svg.classList.contains(c));
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
// column hits, a match at the start of a name before one inside it.
function search(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits = [];
  for (const [id, n] of Object.entries(data.nodes)) {
    if (n.kind !== 'table') continue;
    const name = short(id).toLowerCase();
    if (id.toLowerCase().includes(q)) hits.push({ id, rank: name.startsWith(q) ? 0 : 1 });
    for (const c of n.columns) {
      const cn = c.name.toLowerCase();
      if (cn.includes(q)) hits.push({ id, column: c.name, rank: cn.startsWith(q) ? 2 : 3 });
    }
  }
  return hits.sort((a, b) => a.rank - b.rank || byId(a.id, b.id) || byId(a.column ?? '', b.column ?? '')).slice(0, SEARCH_LIMIT);
}

let resultHits = [];
let resultItems = [];
let activeResult = 0;

function closeResults() {
  results.style.display = 'none';
  resultHits = [];
  resultItems = [];
  layoutOverlays();
}

function pick(hit) {
  closeResults();
  searchInput.blur();
  goToNode(hit.id, hit.column);
}

function renderResults() {
  const hits = search(searchInput.value);
  activeResult = 0;
  if (!searchInput.value.trim()) return closeResults();
  resultItems = hits.map((hit, i) =>
    el('button', { class: `oe-result${i === 0 ? ' active' : ''}`, on: { click: () => pick(hit) } }, [
      el('div', { text: hit.column ? `${short(hit.id)}.${hit.column}` : short(hit.id) }),
      el('div', { class: 'where', text: `${hit.column ? 'column' : 'table'} · ${hit.id}` }),
    ]),
  );
  results.replaceChildren(...(resultItems.length > 0 ? resultItems : [el('div', { class: 'oe-result', text: 'No match' })]));
  setMenu(false);
  results.style.display = '';
  resultHits = hits;
  layoutOverlays();
}

searchInput.addEventListener('input', renderResults);
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && resultHits[activeResult]) pick(resultHits[activeResult]);
  else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && resultItems.length > 0) {
    e.preventDefault();
    resultItems[activeResult].classList.remove('active');
    activeResult = (activeResult + (e.key === 'ArrowDown' ? 1 : resultItems.length - 1)) % resultItems.length;
    resultItems[activeResult].classList.add('active');
    resultItems[activeResult].scrollIntoView({ block: 'nearest' });
  } else return;
  e.stopPropagation();
});

// ---------------------------------------------------------------- panel

const panel = overlay('oe-panel');
panel.fo.style.display = 'none';

function hidePanel() {
  panel.fo.style.display = 'none';
  join.open = false;
  joinButton.classList.remove('on');
}

function showPanel(children) {
  panel.div.replaceChildren(...children.filter(Boolean));
  panel.fo.style.display = '';
  layoutOverlays();
}

const link = (text, onClick) => el('button', { class: 'oe-link', text, on: { click: onClick } });
// A view's line to its source has no cardinality.
const linkSummary = (l) => (l.kind === 'view_source' ? 'view reads this table' : `${l.cardinality} · ${l.kind}`);
// Evidence is for reviewers; it stays folded so the business facts lead.
const evidenceList = (evidence) =>
  evidence ? el('details', { class: 'oe-evidence' }, [el('summary', { text: `Evidence (${evidence.length})` }), el('ul', {}, evidence.map((e) => el('li', { text: e })))]) : null;
const relatedRow = (id) =>
  el('div', { class: 'row', title: RELATED.title }, [el('span', { class: 'label', text: RELATED.label }), ...relatedButtons((hops) => openNeighborhood(id, hops))]);
const linkItem = (arrow, other, detail) => el('li', {}, [el('span', { text: `${arrow} ` }), link(short(other), () => goToNode(other)), el('span', { class: 'where', text: ` ${detail}` })]);
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

// The column grid of a table, as its Excel sheet has it: # | Name | Type |
// Null | Default | PK, with the Comment (the note) on a line of its own
// under each column, since a panel is too narrow for it as a seventh cell.
// Enum values fold under their column as "N values"; the column `open` (the
// one clicked) starts unfolded.
function columnGrid(n, open) {
  const head = el('tr', {}, ['#', 'Name / Comment', 'Type', 'Null', 'Default', 'PK'].map((h) => el('th', { text: h })));
  const rows = n.columns.flatMap((c, i) => {
    const values = Object.entries(c.enum ?? {});
    const row = el('tr', { class: `${c.name === open ? 'open' : ''}${c.technical ? ' technical' : ''}`, 'data-column': c.name }, [
      el('td', { class: 'num', text: String(i + 1) }),
      el('td', { class: 'name' }, [el('span', { text: c.name }), c.pii ? el('span', { class: 'chip pii', text: 'PII' }) : null]),
      el('td', { class: 'type', text: c.type }),
      el('td', { text: c.nullable === true ? 'yes' : c.nullable === false ? 'no' : '' }),
      el('td', { text: c.default ?? (c.autoIncrement ? 'auto' : c.generated !== undefined ? 'generated' : '') }),
      el('td', { text: c.pk ? 'PK' : '' }),
    ]);
    const comment = [c.note, c.internalNote && `Internal: ${c.internalNote}`].filter(Boolean).join(' · ');
    const details = values.length > 0 ? el('details', c.name === open ? { open: '' } : {}, [el('summary', { text: plural(values.length, 'value') }), enumTable(values)]) : null;
    if (!comment && !details && !c.warning) return [row];
    const cls = `more${c.name === open ? ' open' : ''}`;
    return [row, el('tr', { class: cls }, [el('td', {}), el('td', { colspan: '5' }, [comment ? el('div', { class: 'comment', text: comment }) : null, warningLine(c.warning), details])])];
  });
  return el('div', { class: 'oe-grid-wrap' }, [el('table', { class: 'oe-grid' }, [head, ...rows])]);
}

function nodePanel(id, column = null) {
  const n = data.nodes[id];
  if (!n) return [el('h3', { text: id })];
  const lines = data.links.filter((l) => l.from === id || l.to === id);
  const shared = data.hubLinks.filter((l) => l.from === id || l.to === id).length;
  return [
    el('h3', { text: short(id) }),
    el('div', { class: 'sub', text: `${id} · ${n.cluster.split('/').slice(1).join('/')}${n.tableKind ? ` · ${n.tableKind.replace('_', ' ')}` : ''}` }),
    changeList('nodes', id),
    ...noteLines(n),
    warningLine(n.warning),
    n.facts ? el('ul', {}, n.facts.map((f) => el('li', { text: f }))) : null,
    n.sources ? el('p', {}, [el('span', { text: 'Reads from ' }), ...n.sources.flatMap((t, i) => [i > 0 ? el('span', { text: ', ' }) : null, link(short(t), () => goToNode(t))])]) : null,
    relatedRow(id),
    el('div', { class: 'row' }, [el('button', { class: 'oe-btn', text: 'Find join path from here', on: { click: () => openJoin(id) } })]),
    el('div', { class: 'sub', text: plural(n.columns.length, 'column') }),
    columnGrid(n, column),
    // Hub relations count too: a table whose only link is a badge is not unrelated.
    el('div', { class: 'sub', text: `${plural(lines.length, 'relation')}${lines.length > 0 ? ' drawn as lines' : ''}${shared > 0 ? ` · ${plural(shared, 'shared link')} (badges)` : ''}` }),
    lines.length > 0
      ? el(
          'ul',
          {},
          lines.map((l) => (l.from === id ? linkItem('→', l.to, linkSummary(l)) : linkItem('←', l.from, linkSummary(l)))),
        )
      : null,
    ...hubSections(id),
  ];
}

// Hub relations of a table: the ones pointing at it (it is a hub table) and
// the ones it holds (its badges). Drawn as badges, so listed here in full.
function hubSections(id) {
  const into = data.hubLinks.filter((l) => l.to === id);
  const out = data.hubLinks.filter((l) => l.from === id);
  const sections = [];
  if (into.length > 0) {
    const tables = new Set(into.map((l) => l.from)).size;
    const drawn = [...currentView().querySelectorAll('.hub-routes')].some((g) => g.getAttribute('data-hub') === id);
    sections.push(
      el('div', { class: 'sub', text: `Referenced by ${plural(tables, 'table')} (shown as badges${drawn ? '; lines in this view while selected' : ''})` }),
      el('ul', {}, into.map((l) => linkItem('←', l.from, `${l.column} · ${linkSummary(l)}`))),
    );
  }
  if (out.length > 0) {
    sections.push(
      el('div', { class: 'sub', text: `${plural(out.length, 'hub reference')} (shown as badges)` }),
      el('ul', {}, out.map((l) => linkItem('→', l.to, `${l.column} · ${linkSummary(l)}`))),
    );
  }
  return sections;
}

function polyPanel(id, poly) {
  return [
    el('h3', { text: `«${poly.name}»` }),
    el('div', { class: 'sub', text: `${poly.table}.${poly.typeColumn} / ${poly.idColumn}` }),
    changeList('nodes', id),
    ...noteLines(poly),
    el('div', { class: 'sub', text: `${plural(poly.targets.length, 'target')}` }),
    el(
      'ul',
      {},
      poly.targets.map((t) => el('li', {}, [link(t, () => navigate(homeView(t), { focus: t }))])),
    ),
    state.view === NEIGHBORHOOD && state.center === id
      ? null
      : el('div', { class: 'row' }, [el('button', { class: 'oe-btn', text: 'Show with owner and all targets', on: { click: () => openNeighborhood(id, 1) } })]),
    evidenceList(poly.evidence),
  ];
}

// Relations of an overview line by direction: those whose referencing
// table is in domain `a` (pointing at keys in `b`), then the others.
function byDirection(id, a, b) {
  const relations = data.domainLinks[id] ?? [];
  return [
    [a, b],
    [b, a],
  ].map(([from, to]) => ({ from, to, relations: relations.filter((r) => clusterOf(r.from) === from) }));
}

// An overview line: the relations it stands for, grouped by direction
// ("A → B (n)"), each leading to the domain view of its referencing table.
function domainLinkPanel(id, a, b) {
  const total = (data.domainLinks[id] ?? []).length;
  const crossDb = dbOf(a) !== dbOf(b);
  return [
    el('h3', { text: `${domainName(a)} ⇄ ${domainName(b)}` }),
    el('div', { class: 'sub', text: `${plural(total, 'relation')} between these two domains` }),
    crossDb ? el('p', { text: `Cross-DB: ${crossing(a, b, '⇄')}` }) : null,
    changeList('links', id),
    ...byDirection(id, a, b)
      .filter((d) => d.relations.length > 0)
      .flatMap((d) => [
        el('div', { class: 'sub', text: `${domainName(d.from)} → ${domainName(d.to)} (${d.relations.length})` }),
        el(
          'ul',
          {},
          d.relations.map((r) =>
            el('li', {}, [
              link(`${short(r.from)}.${r.column}`, () => navigate(homeView(r.from), { focus: r.from, column: r.column })),
              el('span', { text: ` → ${short(r.to)}` }),
              // A polymorphic entry names its association instead of its kind.
              el('span', { class: 'detail', text: [r.cardinality, r.association ? `polymorphic «${r.association}»` : r.kind, r.via ? `via ${short(r.via)}` : null].filter(Boolean).join(' · ') }),
            ]),
          ),
        ),
      ]),
    el('div', { class: 'row' }, [link(`Open ${domainName(a)}`, () => navigate(domainView(a))), el('span', { text: '·' }), link(`Open ${domainName(b)}`, () => navigate(domainView(b)))]),
  ];
}

function relationPanel(g) {
  const id = g.getAttribute('data-id');
  const [from, to] = [g.getAttribute('data-from'), g.getAttribute('data-to')];
  if (state.view === OVERVIEW) return domainLinkPanel(id, from, to);
  const l = data.links.find((x) => x.id === id) ?? data.hubLinks.find((x) => x.id === id);
  return [
    el('h3', { text: `${short(from)} → ${short(to)}` }),
    el('div', { class: 'sub', text: id }),
    l ? el('p', { text: `${linkSummary(l)} · ${l.review}${l.via ? ` · via ${l.via}` : ''}` }) : null,
    dbOf(from) !== dbOf(to) ? el('p', { text: `Cross-DB: ${crossing(from, to)}` }) : null,
    changeList('links', id),
    evidenceList(l?.evidence),
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
    if (state.view !== JOIN_VIEW) state.history.push(snapshot());
    buildJoinView(path);
    name = JOIN_VIEW;
    showView(JOIN_VIEW);
  } else if (name !== state.view) {
    state.history.push(snapshot());
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
          h.flags.length > 0 ? el('div', { class: 'oe-chips' }, h.flags.map((f) => el('span', { class: `chip flag-${f.type}`, text: FLAG_TEXT[f.type](f) }))) : null,
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
    text: 'Copy as SQL skeleton',
    title: skeleton.blocked ?? 'SELECT * with one JOIN per hop and a comment above each hop to check; review it before running',
    ...(skeleton.blocked ? { disabled: '' } : {}),
    on: { click: () => copyText(skeleton.sql, status, 'SQL skeleton') },
  });
  parts.push(
    ...warnings.map((w) => el('p', { class: 'oe-warn', text: w })),
    el('div', { class: 'row' }, [el('button', { class: 'oe-btn', text: 'Copy conditions', on: { click: () => copyText(conditionsText(path), status, plural(path.hops.length, 'condition')) } }), sqlButton, status]),
    skeleton.blocked ? el('p', { class: 'muted', text: `No SQL skeleton: ${skeleton.blocked}` }) : null,
  );
  return parts;
}

function copyText(text, status, what) {
  const done = () => {
    status.textContent = `Copied ${what}`;
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
    else status.textContent = 'Copy is blocked here; select the conditions above instead.';
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
legend.fo.style.display = 'none';
let legendOpen = false;

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
  sample([svgEl('g', { class: `relation-group ${classes}` }, [svgEl('path', { class: 'relation', d: 'M2 9H62', ...(width ? { style: `stroke-width:${width}` } : {}) })])]);
const has = (view, selector) => view.querySelector(selector) !== null;
// End marker kinds the view draws, as its marker groups list them.
const endKinds = (view) => new Set([...view.querySelectorAll('.marker[data-ends]')].flatMap((g) => g.getAttribute('data-ends').split(' ')));
const reviewing = () => svg.classList.contains('review-mode');
const LEGEND = [
  ['Lines', [
    [() => lineSample('overview-link kind-domain', 3), 'Relations between two domains; the thicker, the more', (v) => has(v, '.overview-link')],
    [() => sample([svgEl('g', { class: 'count-badge' }, [svgEl('rect', { x: 2, y: 1, width: 16, height: 16, rx: 8 }), svgEl('text', { x: 10, y: 9, 'dominant-baseline': 'central', 'text-anchor': 'middle', text: '4' })])]), 'Number of relations the line stands for', (v) => has(v, '.count-badge')],
    [() => lineSample('overview-link kind-cross_db', 2), 'Domains in different databases', (v) => has(v, '.overview-link.kind-cross_db')],
    [() => lineSample(''), 'Confirmed: database foreign key or declared in code', (v) => has(v, '.relation-group:not(.overview-link, .unconfirmed, .kind-view_source)')],
    [() => lineSample('unconfirmed'), 'Found in code, not confirmed', (v) => has(v, '.relation-group.unconfirmed')],
    [() => lineSample('kind-view_source review-reviewed'), 'A view reads this table', (v) => has(v, '.relation-group.kind-view_source')],
  ]],
  ['Review mode', [
    [() => lineSample('kind-declared review-pending'), 'Waiting for review', (v) => reviewing() && has(v, '.relation-group.review-pending:not(.overview-link)')],
    [() => lineSample('kind-declared review-stale unconfirmed'), 'Changed in the code since it was reviewed', (v) => reviewing() && has(v, '.relation-group.review-stale')],
  ]],
  ['Line ends', [
    ['one', 'Exactly one'],
    ['zeroOrOne', 'Zero or one'],
    ['many', 'One or more'],
    ['zeroOrMany', 'Zero or more'],
  ].map(([kind, text]) => [() => endSample(kind), text, (v) => endKinds(v).has(kind)])],
  ['In boxes', [
    [() => sample(parsed(enumIconSvg(8, 9))), 'Column with listed values', (v) => has(v, '.hint-enum')],
    [() => sample([svgEl('path', { class: 'col-warn', d: 'M4 13L8 5L12 13Z' })]), 'Possible missing relation', (v) => has(v, '.col-warn')],
    [() => sample([svgEl('rect', { class: 'stub-box', x: 1, y: 1, width: 62, height: 16, rx: 4 }), svgEl('text', { class: 'stub-title', x: 6, y: 9, 'dominant-baseline': 'central', text: 'orders' })]), 'Linked table in another domain: click to open', (v) => has(v, '.stub')],
    [() => sample([svgEl('path', { class: 'badge-arrow', d: 'M2 9H12M8 6L12 9L8 12' }), svgEl('text', { class: 'badge-text', x: 16, y: 9, 'dominant-baseline': 'central', text: 'users ×3' })]), 'Reference to a common table, shown as text instead of a line', (v) => has(v, '.hub-badge')],
    [() => sample([svgEl('rect', { class: 'poly-box', x: 1, y: 1, width: 62, height: 16, rx: 4 }), svgEl('text', { class: 'poly-title', x: 6, y: 9, 'dominant-baseline': 'central', text: '«able»' })]), 'Polymorphic: one column pair points at several tables', (v) => has(v, '.poly')],
  ]],
];

function renderLegend() {
  const view = currentView();
  const sections = LEGEND.map(([title, items]) => [title, items.filter(([, , present]) => present(view))]).filter(([, items]) => items.length > 0);
  legend.div.replaceChildren(
    el('div', { class: 'oe-legend' }, [
      el('div', { class: 'head' }, [el('b', { text: 'Legend' }), el('button', { class: 'oe-link', text: 'Hide', on: { click: () => setLegend(false) } })]),
      ...(sections.length > 0 ? [] : [el('div', { class: 'sub', text: 'Nothing to explain in this view.' })]),
      ...sections.flatMap(([title, items]) => [el('div', { class: 'sub', text: title }), ...items.map(([draw, text]) => el('div', { class: 'item' }, [draw(), el('span', { text })]))]),
    ]),
  );
}

function setLegend(open) {
  legendOpen = open;
  if (open) renderLegend();
  legend.fo.style.display = open ? '' : 'none';
  legendButton.classList.toggle('on', open);
  layoutOverlays();
}

function setReviewMode(on) {
  svg.classList.toggle('review-mode', on);
  reviewButton.classList.toggle('on', on);
  if (legendOpen) setLegend(true);
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
  const show = map.on && !fitsInside(map.bounds, seen);
  minimapButton.classList.toggle('on', map.on);
  minimap.fo.style.display = show ? '' : 'none';
  if (!show) return;
  for (const [k, v] of Object.entries(seen)) map.seen.setAttribute({ x: 'x', y: 'y', w: 'width', h: 'height' }[k], v);
  const w = map.size.w + 2 * MINIMAP_PAD + 2;
  const h = map.size.h + 2 * MINIMAP_PAD + 2;
  minimap.fo.setAttribute('width', w);
  minimap.fo.setAttribute('height', h);
  minimap.fo.setAttribute('x', vp.w - w - PANEL_MARGIN - panelRoom());
  minimap.fo.setAttribute('y', vp.h - h - PANEL_MARGIN);
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

// Lines: an overview line names its two domains and lists the first few
// relations each way; any other line names its two ends and kind.
function lineTip(g) {
  const [id, from, to] = [g.getAttribute('data-id'), g.getAttribute('data-from'), g.getAttribute('data-to')];
  if (state.view === OVERVIEW) {
    const directions = byDirection(id, from, to).filter((d) => d.relations.length > 0);
    const total = directions.reduce((n, d) => n + d.relations.length, 0);
    return [
      el('div', {}, [el('b', { text: `${domainName(from)} ⇄ ${domainName(to)}` })]),
      el('div', { text: plural(total, 'relation') }),
      dbOf(from) !== dbOf(to) ? el('div', { text: `Cross-DB: ${dbOf(from)} ⇄ ${dbOf(to)}` }) : null,
      ...directions.flatMap((d) => [
        el('div', { text: `${domainName(d.from)} → ${domainName(d.to)} (${d.relations.length})` }),
        ...d.relations.slice(0, TIP_RELATIONS).map((r) => el('div', { class: 'muted', text: `${short(r.from)}.${r.column} → ${short(r.to)}` })),
        d.relations.length > TIP_RELATIONS ? el('div', { class: 'muted', text: `… ${d.relations.length - TIP_RELATIONS} more` }) : null,
      ]),
      el('div', { class: 'muted', text: 'Click to list them all' }),
    ];
  }
  const l = data.links.find((x) => x.id === id) ?? data.hubLinks.find((x) => x.id === id);
  return [el('b', { text: `${short(from)} → ${short(to)}` }), l ? el('div', { class: 'muted', text: `${linkSummary(l)} · ${l.review}` }) : null];
}

function tipLines(target) {
  const line = target.closest('.relation-group, .hub-route');
  if (line) return lineTip(line);
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
  if (nodeEl.classList.contains('domain')) {
    return [el('b', { text: id.split('/').slice(1).join('/') }), el('div', { class: 'muted', text: `${id.split('/')[0]} · click to open the domain` })];
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
    ...(n?.facts ?? []).map((f) => el('div', { class: 'muted', text: f })),
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
  const drop = [results, menu].find((d) => d.style.display !== 'none');
  toolbar.fo.setAttribute('height', drop ? Math.ceil(TOOLBAR_HEIGHT + drop.getBoundingClientRect().height + 8) : TOOLBAR_HEIGHT);
  if (legend.fo.style.display !== 'none') {
    legend.fo.setAttribute('width', 300);
    legend.fo.setAttribute('height', h);
    const r = legend.div.firstChild.getBoundingClientRect();
    legend.fo.setAttribute('x', PANEL_MARGIN);
    legend.fo.setAttribute('y', Math.max(TOOLBAR_HEIGHT + PANEL_MARGIN, h - r.height - PANEL_MARGIN));
    legend.fo.setAttribute('height', Math.ceil(r.height) + 1);
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

svg.addEventListener('click', (e) => {
  if (inUi(e)) return;
  if (dragged) {
    dragged = false;
    return;
  }
  closeResults();
  setMenu(false);
  const t = e.target;
  // With the join panel waiting for a table, a click on one picks it.
  const picked = t.closest('.table, .stub')?.getAttribute('data-id');
  if (join.open && (!join.from || !join.to) && data.nodes[picked]?.kind === 'table') return setJoinEnd(join.from ? 'to' : 'from', picked);
  const domain = t.closest('.domain');
  if (domain) return navigate(domainView(domain.getAttribute('data-domain')));
  const stub = t.closest('.stub');
  if (stub) return navigate(homeView(stub.getAttribute('data-id')), { focus: stub.getAttribute('data-id') });
  const node = t.closest('.table, .poly');
  const column = t.closest('.column');
  if (node && column && data.nodes[node.getAttribute('data-id')]?.kind === 'table') {
    const id = node.getAttribute('data-id');
    selectNode(id);
    column.classList.add('hl-column');
    showPanel(nodePanel(id, column.getAttribute('data-column')));
    panel.div.querySelector('.oe-grid tr.open')?.scrollIntoView({ block: 'nearest' });
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

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (results.style.display !== 'none' || menu.style.display !== 'none') {
    closeResults();
    setMenu(false);
    return;
  }
  clearSelection();
});

window.addEventListener('resize', () => {
  layoutOverlays();
  zoomToRect(viewBounds(state.view), MAX_FIT_SCALE);
});

// Later overlays paint on top: the search results over the panel, the
// tooltip over everything.
svg.append(legend.fo, minimap.fo, panel.fo, toolbar.fo, tip.fo);
setBusiness(false);
// The view drawn visible without script is where the reader starts: the
// overview, or all tables in a diff drawing.
showView([...views].find(([, v]) => v.style.display !== 'none')?.[0] ?? OVERVIEW);
