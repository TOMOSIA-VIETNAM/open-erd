// Viewer embedded in erd.svg. It runs when the SVG is opened directly in a
// browser; it turns the static drawing (overview visible, other views hidden)
// into an explorable diagram. Everything it adds is created here at runtime,
// so a viewer without script still shows the plain overview.
import { radialLayout, straightLink } from './radial.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const HTML_NS = 'http://www.w3.org/1999/xhtml';
const OVERVIEW = 'overview';
const ALL_VIEW = 'all';
const DOMAIN_PREFIX = 'domain:';
const NEIGHBORHOOD = 'neighborhood';
const TOOLBAR_HEIGHT = 44;
const PANEL_WIDTH = 300;
const PANEL_MARGIN = 12;
const FIT_PADDING = 24;
// Small views are not blown up beyond this when fitted.
const MAX_FIT_SCALE = 1.5;
const MIN_SCALE = 0.03;
const MAX_SCALE = 4;
// A press that moves less than this is a click, more is a pan.
const DRAG_THRESHOLD = 4;
const FOCUS_MARGIN = 160;
const FOCUS_MAX_SCALE = 1.2;
const RING_GAP = 40;
const NEIGHBORHOOD_MARGIN = 60;
const SEARCH_LIMIT = 40;
const TIP_OFFSET = 14;

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
// The viewer draws its own tooltips; native ones would show on top of them.
for (const t of svg.querySelectorAll('.nodes title')) t.remove();

// Lines are 1.4 px wide; a wide transparent twin makes them clickable.
function addHitPaths(root) {
  for (const p of root.querySelectorAll('.relation-group > path.relation')) {
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

function applyCamera() {
  const { x, y, s } = state.cam;
  camera.setAttribute('transform', `translate(${x} ${y}) scale(${s})`);
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
  applyCamera();
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

// ---------------------------------------------------------------- selection

function clearSelection() {
  for (const v of views.values()) {
    v.classList.remove('dimmed', 'center-selected');
    for (const e of v.querySelectorAll('.hl, .selected, .flow-target, .flowing, .hl-column')) {
      e.classList.remove('hl', 'selected', 'flow-target', 'flowing', 'hl-column');
    }
    for (const e of v.querySelectorAll('.flow')) e.remove();
    for (const e of v.querySelectorAll('.poly-routes')) e.style.display = 'none';
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
      for (const n of [...(ADJACENCY.get(p) ?? [])].sort(byId)) {
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
  const source = indexes.get(ALL_VIEW);
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
    copy.classList.remove('hl', 'selected', 'flow-target');
    if (outer.has(id)) copy.classList.add('hop-2');
    nodes.append(svgEl('g', { transform: `translate(${dx} ${dy})` }, [copy]));
  }
  const relations = svgEl('g', { class: 'relations' });
  const line = (a, b) => {
    const [[x1, y1], [x2, y2]] = straightLink(boxes.get(a), boxes.get(b));
    return `M${x1} ${y1}L${x2} ${y2}`;
  };
  for (const l of data.links) {
    if (l.from === l.to || !shown.has(l.from) || !shown.has(l.to)) continue;
    const d = line(l.from, l.to);
    relations.append(
      svgEl('g', { class: `relation-group kind-${l.kind} review-${l.review}${outer.has(l.from) || outer.has(l.to) ? ' hop-2' : ''}`, 'data-id': l.id, 'data-from': l.from, 'data-to': l.to }, [
        svgEl('path', { class: 'relation-hit', d }),
        svgEl('path', { class: 'relation', d }),
      ]),
    );
  }
  for (const id of ids.filter((n) => data.nodes[n]?.kind === 'poly')) {
    const targets = data.nodes[id].targets.filter((t) => shown.has(t));
    if (targets.length === 0) continue;
    relations.append(
      svgEl(
        'g',
        { class: 'poly-routes', 'data-poly': id, style: 'display:none' },
        targets.map((t) => svgEl('path', { class: 'poly-route', 'data-target': t, d: line(id, t) })),
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

function openNeighborhood(id, hops = state.hops) {
  if (!indexes.get(ALL_VIEW).has(id)) return;
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
const hopButtons = [1, 2].map((n) =>
  el('button', { class: 'oe-btn', text: `${n} hop${n > 1 ? 's' : ''}`, on: { click: () => openNeighborhood(state.center, n) } }),
);
const hopGroup = el('div', { class: 'oe-seg' }, hopButtons);
const allButton = el('button', { class: 'oe-btn', text: 'All tables', on: { click: () => navigate(ALL_VIEW) } });
const searchInput = el('input', { type: 'search', placeholder: 'Search tables and columns', 'aria-label': 'Search tables and columns' });
const results = el('div', { class: 'oe-results', style: 'display:none' });
const modeButtons = ['Business', 'Technical'].map((label) =>
  el('button', { class: 'oe-btn', text: label, on: { click: () => setBusiness(label === 'Business') } }),
);
toolbar.div.append(
  backButton,
  crumbs,
  hopGroup,
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
  if (state.view === ALL_VIEW) parts.push(crumb('All tables'));
  if (cluster) {
    const [db, ...domain] = cluster.split('/');
    // There is no database-level view; the database crumb shows its frame on the overview.
    parts.push(crumb(db, () => showDatabase(db)));
    parts.push(crumb(domain.join('/'), state.view === NEIGHBORHOOD ? () => navigate(domainView(cluster), { focus: state.center }) : null));
  }
  if (state.view === NEIGHBORHOOD) parts.push(crumb(`Neighborhood of ${short(state.center)}`));
  crumbs.replaceChildren(...parts.flatMap((p, i) => (i === 0 ? [p] : [el('span', { class: 'sep', text: '›' }), p])));
  backButton.disabled = state.history.length === 0;
  hopGroup.style.display = state.view === NEIGHBORHOOD ? '' : 'none';
  hopButtons.forEach((b, i) => b.classList.toggle('on', state.hops === i + 1));
  allButton.classList.toggle('on', state.view === ALL_VIEW);
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
const evidenceList = (evidence) =>
  evidence ? el('div', {}, [el('div', { class: 'sub', text: 'Evidence' }), el('ul', {}, evidence.map((e) => el('li', { text: e })))]) : null;
// Business note, then the team-only note and the untranslated original.
const noteLines = (n) => [
  n.note ? el('p', { text: n.note }) : null,
  n.internalNote ? el('p', { class: 'muted', text: `Internal: ${n.internalNote}` }) : null,
  n.noteSource ? el('p', { class: 'muted', text: `Original: ${n.noteSource}` }) : null,
];

function nodePanel(id) {
  const n = data.nodes[id];
  if (!n) return [el('h3', { text: id })];
  const lines = data.links.filter((l) => l.from === id || l.to === id);
  return [
    el('h3', { text: short(id) }),
    el('div', { class: 'sub', text: `${id} · ${n.cluster.split('/').slice(1).join('/')}${n.tableKind ? ` · ${n.tableKind.replace('_', ' ')}` : ''}` }),
    ...noteLines(n),
    n.facts ? el('ul', {}, n.facts.map((f) => el('li', { text: f }))) : null,
    n.sources ? el('p', {}, [el('span', { text: 'Reads from ' }), ...n.sources.flatMap((t, i) => [i > 0 ? el('span', { text: ', ' }) : null, link(short(t), () => goToNode(t))])]) : null,
    el('div', { class: 'row' }, [
      el('span', { text: 'Neighborhood' }),
      ...[1, 2].map((h) => el('button', { class: 'oe-btn', text: `${h} hop${h > 1 ? 's' : ''}`, on: { click: () => openNeighborhood(id, h) } })),
    ]),
    el('div', { class: 'sub', text: `${lines.length} relation${lines.length === 1 ? '' : 's'}` }),
    el(
      'ul',
      {},
      lines.map((l) => {
        const other = l.from === id ? l.to : l.from;
        const arrow = l.from === id ? '→' : '←';
        return el('li', {}, [el('span', { text: `${arrow} ` }), link(short(other), () => goToNode(other)), el('span', { class: 'where', text: ` ${linkSummary(l)}` })]);
      }),
    ),
  ];
}

function polyPanel(id, poly) {
  return [
    el('h3', { text: `«${poly.name}»` }),
    el('div', { class: 'sub', text: `${poly.table}.${poly.typeColumn} / ${poly.idColumn}` }),
    el('p', { text: `Polymorphic: each row points at one of ${poly.targets.length} tables. Lines show the targets in this view.` }),
    evidenceList(poly.evidence),
    el(
      'ul',
      {},
      poly.targets.map((t) => el('li', {}, [link(t, () => navigate(homeView(t), { focus: t }))])),
    ),
  ];
}

function relationPanel(g) {
  const id = g.getAttribute('data-id');
  const l = data.links.find((x) => x.id === id);
  const [from, to] = [g.getAttribute('data-from'), g.getAttribute('data-to')];
  return [
    el('h3', { text: `${short(from)} → ${short(to)}` }),
    el('div', { class: 'sub', text: id }),
    l ? el('p', { text: `${linkSummary(l)} · ${l.review}${l.via ? ` · via ${l.via}` : ''}` }) : null,
    evidenceList(l?.evidence),
    el('div', { class: 'row' }, [link(`Go to ${short(to)}`, () => goToNode(to))]),
  ];
}

// ---------------------------------------------------------------- tooltip

const tip = overlay('oe-tip-host');
tip.fo.style.display = 'none';
tip.fo.style.pointerEvents = 'none';

function tipLines(target) {
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
    const flags = [c.type, c.nullable === true ? 'nullable' : c.nullable === false ? 'NOT NULL' : null, c.pk ? 'primary key' : null, c.unique ? 'unique' : null].filter(Boolean);
    return [
      el('div', {}, [el('b', { text: c.name }), c.pii ? el('span', { class: 'pii', text: '  PII' }) : null]),
      el('div', { class: 'muted', text: flags.join(' · ') }),
      ...noteLines(c).map((e) => e && el('div', { class: e.className, text: e.textContent })),
      ...(c.enum ? Object.entries(c.enum).map(([v, meaning]) => el('div', {}, [el('b', { text: v }), el('span', { text: `: ${meaning}` })])) : []),
    ];
  }
  if (nodeEl.classList.contains('domain')) {
    return [el('b', { text: id.split('/').slice(1).join('/') }), el('div', { class: 'muted', text: `${id.split('/')[0]} · click to open the domain` })];
  }
  if (nodeEl.classList.contains('stub')) {
    return [el('b', { text: id }), el('div', { class: 'muted', text: 'Outside this domain · click to open its domain' })];
  }
  if (n?.kind === 'poly') {
    return [el('b', { text: `«${n.name}»` }), el('div', { text: n.targets.join(', ') }), el('div', { class: 'muted', text: 'Click to show its targets' })];
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
  const r = tip.div.firstChild.getBoundingClientRect();
  const x = e.clientX + TIP_OFFSET + r.width > w ? e.clientX - TIP_OFFSET - r.width : e.clientX + TIP_OFFSET;
  const y = e.clientY + TIP_OFFSET + r.height > h ? e.clientY - TIP_OFFSET - r.height : e.clientY + TIP_OFFSET;
  tip.fo.setAttribute('x', Math.max(0, x));
  tip.fo.setAttribute('y', Math.max(TOOLBAR_HEIGHT, y));
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
  press = { x: e.clientX, y: e.clientY, cam: { ...state.cam }, id: e.pointerId };
  dragged = false;
});
svg.addEventListener('pointermove', (e) => {
  showTip(e);
  if (!press) return;
  const dx = e.clientX - press.x;
  const dy = e.clientY - press.y;
  if (!dragged && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
  if (!dragged) svg.setPointerCapture(press.id);
  dragged = true;
  state.cam = { ...press.cam, x: press.cam.x + dx, y: press.cam.y + dy };
  applyCamera();
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
  if (node) return selectNode(node.getAttribute('data-id'));
  const relation = t.closest('.relation-group');
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
    // Pixel deltas from trackpads and line deltas from mouse wheels.
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoomAt(e.clientX, e.clientY, Math.exp(-delta * 0.0015));
  },
  { passive: false },
);

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
svg.append(panel.fo, toolbar.fo, tip.fo);
setBusiness(false);
showView(OVERVIEW);
