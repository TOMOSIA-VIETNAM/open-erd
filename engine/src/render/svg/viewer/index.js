// Viewer embedded in erd.svg. It runs when the SVG is opened directly in a
// browser; it turns the static drawing (overview visible, other views hidden)
// into an explorable diagram. Everything it adds is created here at runtime,
// so a viewer without script still shows the plain overview.
import { endMarkers, markerSvg } from '../markers.js';
import { endTransforms, radialLayout, straightLink } from './radial.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const HTML_NS = 'http://www.w3.org/1999/xhtml';
const OVERVIEW = 'overview';
const ALL_VIEW = 'all';
const DOMAIN_PREFIX = 'domain:';
const NEIGHBORHOOD = 'neighborhood';
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
// "shop (PostgreSQL) → events (MongoDB)" for the databases of two names.
const dbOf = (name) => name.split(/[./]/)[0];
const crossing = (from, to) => `${dbOf(from)} (${data.databases[dbOf(from)]}) → ${dbOf(to)} (${data.databases[dbOf(to)]})`;
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

const state = { view: OVERVIEW, hops: 1, center: null, history: [], cam: { x: 0, y: 0, s: 1 } };

// ---------------------------------------------------------------- camera

const viewport = () => ({ w: window.innerWidth, h: window.innerHeight });

let cameraFrame = 0;
function applyCamera() {
  if (cameraFrame) cancelAnimationFrame(cameraFrame);
  cameraFrame = 0;
  const { x, y, s } = state.cam;
  camera.setAttribute('transform', `translate(${x} ${y}) scale(${s})`);
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
  zoomToRect(viewBounds(name), MAX_FIT_SCALE);
  renderToolbar();
  setLegend(name === ALL_VIEW);
}

function snapshot() {
  return { view: state.view, center: state.center, hops: state.hops };
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
  if (db && state.view !== OVERVIEW && within(db.querySelector('.db-frame'), 60)) {
    const keys = clusterGroups(currentView()).map(keyOf).filter((k) => k.split('/')[0] === db.getAttribute('data-database'));
    if (keys.length === 0) return null;
    return () => setCollapsed(state.view, keys, keys.some((k) => !collapsedIn(state.view).has(k)));
  }
  return null;
}

// ---------------------------------------------------------------- selection

function clearSelection() {
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
  const line = (points) => `M${points[0][0]} ${points[0][1]}L${points[1][0]} ${points[1][1]}`;
  // One line with the crow's feet of its cardinality, as in the drawn views
  // (a view's line to its source has none).
  const relationLine = (l, from, to) => {
    const points = ends(from, to);
    const d = line(points);
    const children = [svgEl('path', { class: 'relation-hit', d }), svgEl('path', { class: 'relation', d })];
    if (l.cardinality) {
      const kinds = endMarkers(l);
      const [at, back] = endTransforms(points);
      children.push(svgEl('g', { class: 'marker' }, [markerGroup(kinds.from, at), markerGroup(kinds.to, back)]));
    }
    const hop2 = outer.has(from) || outer.has(to) ? ' hop-2' : '';
    return svgEl('g', { class: `relation-group kind-${l.kind} review-${l.review}${hop2}`, 'data-id': l.id, 'data-from': from, 'data-to': to }, children);
  };
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
    relations.append(relationLine({ id: `${center}->${t}`, cardinality: 'n-1', optional: poly.optional, kind: 'polymorphic', review: 'reviewed' }, center, t));
  }
  for (const id of ids.filter((n) => n !== center && data.nodes[n]?.kind === 'poly')) {
    const targets = data.nodes[id].targets.filter((t) => shown.has(t));
    if (targets.length === 0) continue;
    relations.append(
      svgEl(
        'g',
        { class: 'poly-routes', 'data-poly': id, style: 'display:none' },
        targets.map((t) => svgEl('path', { class: 'poly-route', 'data-target': t, d: line(ends(id, t)) })),
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

// The marker shapes of the drawn views, parsed once per kind and placed by
// a transform along the line.
const markerShapes = new Map();
function markerGroup(kind, transform) {
  if (!markerShapes.has(kind)) {
    const doc = new DOMParser().parseFromString(`<svg xmlns="${SVG_NS}">${markerSvg(kind, 0, 0, 1)}</svg>`, 'image/svg+xml');
    markerShapes.set(kind, [...doc.documentElement.childNodes]);
  }
  return svgEl('g', { transform }, markerShapes.get(kind).map((n) => document.importNode(n, true)));
}

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
const legendButton = el('button', { class: 'oe-btn', text: 'Legend', title: 'What the line ends, line styles and marks mean', on: { click: () => setLegend(!legendOpen) } });
if (!views.has(ALL_VIEW)) allButton.style.display = 'none';
const searchInput = el('input', { type: 'search', placeholder: 'Search tables and columns', 'aria-label': 'Search tables and columns' });
const results = el('div', { class: 'oe-results', style: 'display:none' });
const modeButtons = ['Business', 'Technical'].map((label) =>
  el('button', { class: 'oe-btn', text: label, on: { click: () => setBusiness(label === 'Business') } }),
);
toolbar.div.append(
  backButton,
  crumbs,
  hopGroup,
  foldGroup,
  legendButton,
  allButton,
  el('div', { class: 'oe-search' }, [searchInput, results]),
  el('div', { class: 'oe-seg' }, modeButtons),
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
  crumbs.replaceChildren(...parts.flatMap((p, i) => (i === 0 ? [p] : [el('span', { class: 'sep', text: '›' }), p])));
  backButton.disabled = state.history.length === 0;
  hopGroup.style.display = state.view === NEIGHBORHOOD ? '' : 'none';
  hopButtons.forEach((b, i) => b.classList.toggle('on', state.hops === RELATED.options[i].hops));
  allButton.classList.toggle('on', state.view === ALL_VIEW);
  foldGroup.style.display = clusterGroups(currentView()).length > 0 ? '' : 'none';
  legendButton.style.display = state.view === OVERVIEW ? 'none' : '';
  layoutOverlays();
}

function showDatabase(db) {
  navigate(OVERVIEW);
  for (const g of views.get(OVERVIEW).querySelectorAll('.database')) {
    if (g.getAttribute('data-database') === db) zoomToRect(boxOf(g), MAX_FIT_SCALE);
  }
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
// A generated column's expression, then the notes.
const columnText = (c) => [c.generated === undefined ? null : el('div', { class: 'muted', text: `generated as ${c.generated}` }), ...noteLines(c)];
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
    if (!comment && !details) return [row];
    const cls = `more${c.name === open ? ' open' : ''}`;
    return [row, el('tr', { class: cls }, [el('td', {}), el('td', { colspan: '5' }, [comment ? el('div', { class: 'comment', text: comment }) : null, details])])];
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
    n.facts ? el('ul', {}, n.facts.map((f) => el('li', { text: f }))) : null,
    n.sources ? el('p', {}, [el('span', { text: 'Reads from ' }), ...n.sources.flatMap((t, i) => [i > 0 ? el('span', { text: ', ' }) : null, link(short(t), () => goToNode(t))])]) : null,
    relatedRow(id),
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

// An overview line: the relations it stands for, each leading to the domain
// view of its referencing table.
function domainLinkPanel(id, from, to) {
  const relations = data.domainLinks[id] ?? [];
  const reverse = `${to}->${from}`;
  const reverseGroup = data.domainLinks[reverse] ? [...currentView().querySelectorAll('.relation-group')].find((g) => g.getAttribute('data-id') === reverse) : null;
  const crossDb = from.split('/')[0] !== to.split('/')[0];
  return [
    el('h3', { text: `${domainName(from)} → ${domainName(to)}` }),
    el('div', { class: 'sub', text: `${plural(relations.length, 'relation')}: tables in ${domainName(from)} reference keys in ${domainName(to)}` }),
    crossDb ? el('p', { text: `Cross-DB: ${crossing(from, to)}` }) : null,
    changeList('links', id),
    el(
      'ul',
      {},
      relations.map((r) =>
        el('li', {}, [
          link(`${short(r.from)}.${r.column}`, () => navigate(homeView(r.from), { focus: r.from, column: r.column })),
          el('span', { text: ` → ${short(r.to)}` }),
          // A polymorphic entry names its association instead of its kind.
          el('span', { class: 'detail', text: [r.cardinality, r.association ? `polymorphic «${r.association}»` : r.kind, r.via ? `via ${short(r.via)}` : null].filter(Boolean).join(' · ') }),
        ]),
      ),
    ),
    reverseGroup ? el('div', { class: 'row' }, [link(`Opposite direction: ${plural(data.domainLinks[reverse].length, 'relation')}`, () => flowRelation(reverseGroup))]) : null,
    el('div', { class: 'row' }, [link(`Open ${domainName(from)}`, () => navigate(domainView(from))), el('span', { text: '·' }), link(`Open ${domainName(to)}`, () => navigate(domainView(to)))]),
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

// ---------------------------------------------------------------- legend

// Samples drawn with the diagram's own classes and marker shapes, so the
// legend always looks like what it explains. Open by default in the view of
// all tables, closed elsewhere; never on the overview, whose lines only
// carry an arrow and a count.
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
const lineSample = (classes) => sample([svgEl('g', { class: `relation-group ${classes}` }, [svgEl('path', { class: 'relation', d: 'M2 9H62' })])]);
const LEGEND = [
  ['Line ends', [
    [endSample('one'), 'exactly one'],
    [endSample('zeroOrOne'), 'zero or one'],
    [endSample('many'), 'one or more'],
    [endSample('zeroOrMany'), 'zero or more'],
  ]],
  ['Lines', [
    [lineSample('kind-db_fk review-reviewed'), 'foreign key or declared'],
    [lineSample('kind-inferred review-pending'), 'inferred from code'],
    [lineSample('kind-cross_db review-reviewed'), 'cross-DB'],
    [lineSample('kind-polymorphic review-reviewed'), 'polymorphic'],
    [lineSample('kind-view_source review-reviewed'), 'view reads table'],
  ]],
  ['Review', [
    [lineSample('kind-db_fk review-reviewed'), 'reviewed'],
    [lineSample('kind-db_fk review-pending'), 'pending review'],
    [lineSample('kind-db_fk review-stale'), 'stale: code changed'],
  ]],
  ['In boxes', [
    [sample([svgEl('path', { class: 'badge-arrow', d: 'M2 9H12M8 6L12 9L8 12' }), svgEl('text', { class: 'badge-text', x: 16, y: 9, 'dominant-baseline': 'central', text: 'users ×3' })]), 'hub reference (badge)'],
    [sample([svgEl('circle', { class: 'hint-note', cx: 8, cy: 9, r: 2.5 })]), 'column has a note'],
    [sample([svgEl('rect', { class: 'hint-enum', x: 5.5, y: 6.5, width: 5, height: 5, rx: 1 })]), 'column has enum values'],
    [sample([svgEl('rect', { class: 'stub-box', x: 1, y: 1, width: 62, height: 16, rx: 4 }), svgEl('text', { class: 'stub-title', x: 6, y: 9, 'dominant-baseline': 'central', text: 'orders' })]), 'table of another domain'],
  ]],
];
legend.div.append(
  el('div', { class: 'oe-legend' }, [
    el('div', { class: 'head' }, [el('b', { text: 'Legend' }), el('button', { class: 'oe-link', text: 'Hide', on: { click: () => setLegend(false) } })]),
    ...LEGEND.flatMap(([title, items]) => [el('div', { class: 'sub', text: title }), ...items.map(([svgSample, text]) => el('div', { class: 'item' }, [svgSample, el('span', { text })]))]),
  ]),
);

function setLegend(open) {
  legendOpen = open;
  legend.fo.style.display = open && state.view !== OVERVIEW ? '' : 'none';
  legendButton.classList.toggle('on', open);
  layoutOverlays();
}

// ---------------------------------------------------------------- tooltip

const tip = overlay('oe-tip-host');
tip.fo.style.display = 'none';
tip.fo.style.pointerEvents = 'none';

// Lines: an overview line says which way its relations point and lists
// the first few; any other line names its two ends and kind.
function lineTip(g) {
  const [id, from, to] = [g.getAttribute('data-id'), g.getAttribute('data-from'), g.getAttribute('data-to')];
  if (state.view === OVERVIEW) {
    const relations = data.domainLinks[id] ?? [];
    return [
      el('div', {}, [el('b', { text: `${domainName(from)} → ${domainName(to)}` })]),
      el('div', { text: `${plural(relations.length, 'relation')}: tables in ${domainName(from)} reference ${domainName(to)}` }),
      ...relations.slice(0, TIP_RELATIONS).map((r) => el('div', { class: 'muted', text: `${short(r.from)}.${r.column} → ${short(r.to)}` })),
      relations.length > TIP_RELATIONS ? el('div', { class: 'muted', text: `… ${relations.length - TIP_RELATIONS} more` }) : null,
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
  toolbar.fo.setAttribute('height', results.style.display === 'none' ? TOOLBAR_HEIGHT : Math.ceil(TOOLBAR_HEIGHT + results.getBoundingClientRect().height + 8));
  if (legend.fo.style.display !== 'none') {
    legend.fo.setAttribute('width', 260);
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
  const t = e.target;
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
  if (results.style.display !== 'none') {
    closeResults();
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
svg.append(legend.fo, panel.fo, toolbar.fo, tip.fo);
setBusiness(false);
// The view drawn visible without script is where the reader starts: the
// overview, or all tables in a diff drawing.
showView([...views].find(([, v]) => v.style.display !== 'none')?.[0] ?? OVERVIEW);
