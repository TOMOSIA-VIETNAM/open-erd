// Dev-only: drives the viewer embedded in a rendered erd.svg through headless
// Chrome (DevTools protocol over Node's built-in WebSocket) with real mouse
// and keyboard events, screenshots every step, checks what each step should
// have changed, and fails on any console error or failed check.
// Usage: node scripts/verify-viewer.js <erd.svg> <out dir>   (CHROME_PATH overrides the binary)
// The steps pick their targets from the drawing itself (the first domain
// with tables, a table with lines, a stub, a polymorphic node, ...), so any
// workspace with relations works. A diff drawing (diff.svg) starts on the
// view of all tables; it first gets a step clicking a changed table, whose
// panel must list its changes, then goes through the same steps.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchChrome } from './cdp.js';
import { findJoinPaths, pathThrough } from '../src/render/svg/viewer/join-path.js';

const VIEWPORT = { width: 1400, height: 900 };
const [input, outDir] = process.argv.slice(2);
if (!input || !outDir) {
  console.error('Usage: node scripts/verify-viewer.js <erd.svg> <out dir>');
  process.exit(1);
}

// The view the file shows without script, which is also where the viewer starts.
const startView = /<g class="view" data-view="([^"]+)" data-bounds="[^"]+">/.exec(await readFile(input, 'utf8'))[1];

const { send, once, listeners, close } = await launchChrome();

const errors = [];
listeners.push((m) => {
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
});

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
const loaded = once('Page.loadEventFired');
await send('Page.navigate', { url: pathToFileURL(resolve(input)).href });
await loaded;

async function evaluate(expression) {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) throw new Error(`${expression}: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  return result.value;
}
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

// Centre of the element `find` (JS expression returning an element) on
// screen; for a line, the middle of its length, since the centre of a bent
// line's bounding box is usually off the line.
async function centre(find, where = 'centre') {
  const p = await evaluate(`(() => { const e = ${find}; if (!e) return null;
    if (e.localName === 'path') { const m = e.getPointAtLength(e.getTotalLength() / 2).matrixTransform(e.getScreenCTM()); return { x: m.x, y: m.y }; }
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: ${where === 'top' ? 'r.y + 12' : 'r.y + r.height / 2'} }; })()`);
  if (!p) throw new Error(`no element for ${find}`);
  return p;
}
async function mouse(type, { x, y }, clickCount = 1) {
  await send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount });
}
async function click(find, { where, count = 1 } = {}) {
  const p = await centre(find, where);
  await mouse('mouseMoved', p);
  for (let i = 1; i <= count; i++) {
    await mouse('mousePressed', p, i);
    await mouse('mouseReleased', p, i);
  }
  await pause(150);
}
// Pans so the centre of element `find` is in the middle of the canvas, left
// of the side panel: overlays (panel, minimap, legend, Back pill) may cover
// a box where a fitted view put it.
async function bringIntoView(find) {
  const p = await centre(find);
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 400, y: 400, deltaX: Math.round(p.x - 460), deltaY: Math.round(p.y - 470) });
  await pause(200);
}
async function key(k, code = k) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: k === 'Escape' ? 27 : k === 'Enter' ? 13 : 0 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code });
  await pause(150);
}

await mkdir(outDir, { recursive: true });
let step = 0;
const failures = [];
async function shot(name, check) {
  step += 1;
  const file = join(resolve(outDir), `${String(step).padStart(2, '0')}-${name}.png`);
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(file, Buffer.from(data, 'base64'));
  const ok = check ? await evaluate(check) : true;
  if (ok !== true) failures.push(`${name}: ${check} -> ${JSON.stringify(ok)}`);
  console.log(`${ok === true ? 'ok  ' : 'FAIL'} ${file}`);
}

const visible = `[...document.querySelectorAll('g.view')].find((v) => v.style.display !== 'none')`;
const inView = (sel) => `${visible}.querySelector(${JSON.stringify(sel)})`;
const viewIs = (name) => `${visible}.getAttribute('data-view') === ${JSON.stringify(name)}`;

// Toolbar menus: the button of a dropdown and an item of its menu by the
// start of its label (`db` for the breadcrumb's database switcher,
// `highlight`, `more`).
const menuButton = (menu) => `document.querySelector('.oe-drop:has(.oe-${menu}-menu) > button')`;
const menuItem = (menu, label) => `[...document.querySelectorAll('.oe-${menu}-menu .oe-item')].find((b) => b.textContent.startsWith(${JSON.stringify(label)}))`;
const menuOpen = (menu) => `getComputedStyle(document.querySelector('.oe-${menu}-menu')).display !== 'none'`;
async function choose(menu, label) {
  if (!(await evaluate(menuOpen(menu)))) await click(menuButton(menu));
  await click(menuItem(menu, label));
}
// A tab of the side panel (columns, relations, indexes).
const tab = (id) => click(`document.querySelector('.oe-panel .oe-tab[data-tab="${id}"]')`);
const closeMenu = (menu) => evaluate(`${menuOpen(menu)} && ${menuButton(menu)}.click()`);
const backButton = `document.querySelector('.oe-left > button')`;
// Cmd+F on macOS (CDP modifier 4 = Meta), Ctrl+F elsewhere (2).
const FIND_MODIFIER = process.platform === 'darwin' ? 4 : 2;
// Cmd+<letter> on macOS, Ctrl+<letter> elsewhere.
async function modKey(letter) {
  const code = `Key${letter.toUpperCase()}`;
  const vk = letter.toUpperCase().charCodeAt(0);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: letter, code, windowsVirtualKeyCode: vk, modifiers: FIND_MODIFIER });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: letter, code, windowsVirtualKeyCode: vk, modifiers: FIND_MODIFIER });
  await pause(200);
}
// The toolbar's view tabs: all, overview (Map), ranking.
const viewTab = (name) => click(`document.querySelector('.oe-view-tabs [data-view="${name}"]')`);
async function findKey() {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: FIND_MODIFIER });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, modifiers: FIND_MODIFIER });
  await pause(150);
}
const spotlightShown = `document.querySelector('.oe-spotlight').closest('foreignObject').style.display !== 'none'`;
/** Opens the search with the shortcut, types `text`, picks the first hit. */
async function searchFor(text) {
  await findKey();
  await evaluate(`(() => { const i = document.querySelector('.oe-spotlight-input'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);
  await send('Input.insertText', { text });
  await pause(200);
  await key('Enter');
}
// Copies go to a stub clipboard, so a check can read what was copied.
const stubClipboard = `(() => { window.__copied = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__copied = t; } } }); })()`;

await pause(300);
await shot(startView.replace(/[:/]/g, '-'), `${viewIs(startView)} && document.querySelector('.oe-toolbar') !== null`);
// A plain drawing too large to read whole opens the view of all tables at
// scale 1 around the most central table, with the minimap.
if (startView === 'all' && (await evaluate(`JSON.parse(document.getElementById('open-erd-data').textContent).changes === undefined`))) {
  await shot(
    'all-opens-readable',
    `(() => { const d = JSON.parse(document.getElementById('open-erd-data').textContent);
      const m = /scale\\(([\\d.]+)\\)/.exec(document.querySelector('.camera').getAttribute('transform')); const s = Number(m[1]);
      const v = document.querySelector('g.view[data-view="all"]'); const [, , w, h] = v.getAttribute('data-bounds').split(' ').map(Number);
      const fits = Math.min((innerWidth - 48) / w, (innerHeight - 44 - 48) / h) * 12 >= 11;
      if (fits) return true;
      const t = d.mostCentral && v.querySelector('.table[data-id="' + CSS.escape(d.mostCentral) + '"]');
      const r = t?.getBoundingClientRect(); const mid = r && Math.abs(r.x + r.width / 2 - innerWidth / 2) < 2 && Math.abs(r.y + r.height / 2 - (44 + (innerHeight - 44) / 2)) < 2;
      const map = document.querySelector('.oe-minimap')?.closest('foreignObject');
      return (s === 1 && (!d.mostCentral || mid) && map && map.style.display !== 'none') || { s, mid, map: map?.style.display }; })()`,
  );
}
// Changes mode: a diff opens with it on (chip with the counts, unchanged
// tables and lines faded, changed ones at full strength); List shows the
// changed tables and a click there goes to one; a selection takes over the
// fading and Esc brings it back; the chip's × and C turn it off and on. A
// plain drawing has no entry, chip or key. It is left off for the steps
// after, which check the other modes' fading.
{
  const changesHost = `document.querySelector('.oe-changes-chip-host').closest('foreignObject')`;
  const changesOn = `document.documentElement.classList.contains('changes-mode')`;
  const faded = (sel) => `(() => { const e = ${inView(sel)}; return e === null || getComputedStyle(e).opacity === '0.16' || getComputedStyle(e).opacity; })()`;
  const full = (sel) => `(() => { const e = ${inView(sel)}; return e === null || getComputedStyle(e).opacity === '1' || getComputedStyle(e).opacity; })()`;
  const unchanged = '.table:not([class*="diff-"]):not(.near-change)';
  const changedSel = '.table:is(.diff-added, .diff-changed, .diff-renamed)';
  if (await evaluate(`JSON.parse(document.getElementById('open-erd-data').textContent).changes !== undefined`)) {
    const counts = await evaluate(`JSON.parse(document.getElementById('open-erd-data').textContent).changes.counts`);
    const listed = await evaluate(`Object.keys(JSON.parse(document.getElementById('open-erd-data').textContent).changes.nodes).filter((id) => document.querySelector('.table[data-id="' + CSS.escape(id) + '"]')).length`);
    await shot(
      'changes-default-on',
      `${changesOn} && ${changesHost}.style.display !== 'none' && document.querySelector('.oe-changes-chip').textContent.includes(${JSON.stringify(`${counts.tables} table`)})
        && ${faded(unchanged)} === true && ${full(changedSel)} === true`,
    );
    // Sized once the inlined font has loaded, not with the fallback font of the first layout.
    await shot('changes-chip-fits', `(() => { const c = document.querySelector('.oe-changes-chip'); const w = Number(c.closest('foreignObject').getAttribute('width')); return c.scrollWidth <= w || { chip: c.scrollWidth, room: w }; })()`);
    await click(menuButton('highlight'));
    await shot('changes-menu-entry', `${menuItem('highlight', 'Changes')}?.getAttribute('aria-checked') === 'true'`);
    await closeMenu('highlight');
    await click(`document.querySelector('.oe-changes-chip .oe-link')`);
    await shot('changes-list', `document.querySelectorAll('.oe-panel .oe-change-table').length === ${listed} && document.querySelectorAll('.oe-panel .oe-change-table li').length > 0`);
    const target = await evaluate(`document.querySelector('.oe-panel .oe-change-table .oe-link').title.replace(/^Go to /, '')`);
    await click(`document.querySelector('.oe-panel .oe-change-table .oe-link')`);
    await pause(400);
    await shot('changes-list-jump', `document.querySelectorAll('.oe-panel .oe-change-table').length === ${listed} && (() => { const r = ${inView(`.table[data-id="${target}"]`)}.getBoundingClientRect(); return r.right > 0 && r.left < innerWidth && r.bottom > 44 && r.top < innerHeight; })()`);
    await key('Escape');
    await click(inView(changedSel), { where: 'top' });
    await shot('changes-selection-takes-over', `${changesOn} && ${visible}.classList.contains('dimmed')`);
    await key('Escape');
    await shot('changes-fade-back', `${changesOn} && !${visible}.classList.contains('dimmed') && ${faded(unchanged)} === true`);
    // The neighborhood of a changed table fades the same way once its selection is cleared.
    await click(inView(changedSel), { where: 'top', count: 2 });
    await key('Escape');
    await shot('changes-neighborhood', `${viewIs('neighborhood')} && ${changesOn} && ${faded(unchanged)} === true && ${full(changedSel)} === true
      && (() => { const status = JSON.parse(document.getElementById('open-erd-data').textContent).changes.lineStatus;
        return [...${visible}.querySelectorAll('.relation-group')].filter((g) => status[g.getAttribute('data-id')]).every((g) => g.classList.contains('diff-' + status[g.getAttribute('data-id')]) && getComputedStyle(g).opacity === '1'); })()`);
    await viewTab('all');
    await click(`document.querySelector('.oe-changes-chip .oe-chip-close')`);
    await shot('changes-off-chip', `!${changesOn} && ${changesHost}.style.display === 'none' && ${full(unchanged)} === true`);
    await key('c', 'KeyC');
    await shot('changes-on-key', `${changesOn} && ${changesHost}.style.display !== 'none' && ${faded(unchanged)} === true`);
    await key('c', 'KeyC');
  } else {
    if (await evaluate(`getComputedStyle(${menuButton('highlight')}.parentNode).display !== 'none'`)) await click(menuButton('highlight'));
    await shot('changes-absent', `${menuItem('highlight', 'Changes')} === undefined && ${changesHost}.style.display === 'none'`);
    await closeMenu('highlight');
    await key('c', 'KeyC');
    await shot('changes-key-does-nothing', `!${changesOn} && ${changesHost}.style.display === 'none'`);
  }
}
if (await evaluate(`JSON.parse(document.getElementById('open-erd-data').textContent).changes !== undefined`)) {
  for (const status of ['changed', 'renamed', 'added', 'removed']) {
    const changed = await evaluate(`${inView(`.table.diff-${status}`)}?.getAttribute('data-id') ?? null`);
    if (!changed) continue;
    await click(inView(`.table[data-id="${changed}"]`), { where: 'top' });
    await shot(`diff-${status}-table`, `${inView('.table.selected')} !== null && document.querySelectorAll('.oe-panel .oe-changes li').length > 0`);
  }
  await key('Escape');
  await click(`document.querySelector('.oe-crumbs .oe-link')`);
  await shot('overview', viewIs('overview'));
}

// Overview: one card per domain and no lines. Hovering the card with most
// related domains draws a connector to each and fades the others; a
// connector's tooltip and panel give the relations; a related entry opens
// that domain; keyboard focus does what hovering does.
const data = `JSON.parse(document.getElementById('open-erd-data').textContent)`;
await key('Escape');
await click(`document.querySelector('.oe-crumbs .oe-link') ?? document.querySelector('.oe-crumbs .here')`);
const ov = `document.querySelector('g.view[data-view="overview"]')`;
const relatedOf = (id) => `Object.keys(${data}.domainLinks).filter((k) => { const [a, b] = k.split('<->'); return a !== b && (a === ${JSON.stringify(id)} || b === ${JSON.stringify(id)}); })`;
await shot(
  'overview-cards',
  `${viewIs('overview')} && ${ov}.querySelectorAll('.domain').length === new Set(Object.values(${data}.nodes).map((n) => n.cluster)).size && ${ov}.querySelector('.relation-group, .card-links') === null && [...${ov}.querySelectorAll('.domain')].every((c) => c.querySelector('.card-related, .card-none'))`,
);
// The legend opens folded to its pill here: open, it would cover the cards
// in the bottom left corner.
await shot('overview-legend-folded', `document.querySelector('.oe-legend') === null && document.querySelector('.oe-legend-pill') !== null`);
const busiest = await evaluate(`(() => { const d = ${data}; const n = (id) => Object.keys(d.domainLinks).filter((k) => { const [a, b] = k.split('<->'); return a !== b && (a === id || b === id); }).length;
  return [...${ov}.querySelectorAll('.domain')].map((c) => c.getAttribute('data-domain')).sort((a, b) => n(b) - n(a))[0]; })()`);
const hubCard = `${ov}.querySelector('.domain[data-domain=${JSON.stringify(busiest)}]')`;
await mouse('mouseMoved', await centre(`${hubCard}.querySelector('.card-box')`, 'top'));
await pause(150);
await shot(
  'overview-card-hover',
  `(() => { const links = [...${ov}.querySelectorAll('.card-links .card-link')]; const want = ${relatedOf(busiest)}.length;
    const faded = [...${ov}.querySelectorAll('.domain:not(.focus-node)')];
    return ${ov}.classList.contains('domain-focus') && links.length === want && want > 0 && faded.every((c) => getComputedStyle(c).opacity === '0.3') || { links: links.length, want }; })()`,
);
// A connector runs under the cards: take one with a free spot along it.
const { pairEnds, onConnector } = await evaluate(`(() => { for (const g of ${ov}.querySelectorAll('.card-links .card-link')) { const p = g.querySelector('.card-link-hit');
  for (const t of [0.5, 0.4, 0.6, 0.3, 0.7]) { const m = p.getPointAtLength(p.getTotalLength() * t).matrixTransform(p.getScreenCTM());
    if (g.contains(document.elementFromPoint(m.x, m.y))) return { pairEnds: [g.getAttribute('data-from'), g.getAttribute('data-to')], onConnector: { x: m.x, y: m.y } }; } } return {}; })()`);
const pairKey = pairEnds[0] <= pairEnds[1] ? `${pairEnds[0]}<->${pairEnds[1]}` : `${pairEnds[1]}<->${pairEnds[0]}`;
await mouse('mouseMoved', onConnector);
await pause(200);
await shot(
  'overview-connector-tooltip',
  `${ov}.querySelector('.card-links') !== null && [...document.querySelectorAll('.oe-tip')].some((t) => / → .+ · \\d+ relations?( · \\d+ back)?Click to see the list$/.test(t.textContent) && t.querySelectorAll('.muted').length === 1)`,
);
await mouse('mousePressed', onConnector);
await mouse('mouseReleased', onConnector);
await pause(150);
await shot('overview-connector-panel', `document.querySelectorAll('.oe-panel .oe-chip').length === new Set(${data}.domainLinks[${JSON.stringify(pairKey)}].map((r) => r.from + ' ' + r.to)).size && document.querySelector('.oe-panel .oe-ph-sep')?.textContent === '⇄' && document.querySelectorAll('.oe-panel .oe-domain-chip').length === 2`);
await key('Escape');
const relatedKey = await evaluate(`${hubCard}.querySelector('.card-related').getAttribute('data-domain')`);
// Its tooltip says what a click does.
await mouse('mouseMoved', await centre(`${hubCard}.querySelector('.card-related .card-related-name')`));
await pause(150);
await shot('overview-related-tip', `[...document.querySelectorAll('.oe-tip')].some((t) => t.textContent.endsWith('Click to open ' + ${hubCard}.querySelector('.card-related .card-related-name').textContent))`);
await click(`${hubCard}.querySelector('.card-related .card-related-name')`);
await shot('overview-related-opens-domain', viewIs(`domain:${relatedKey}`));
await click(`document.querySelector('.oe-crumbs .oe-link')`);
await mouse('mouseMoved', { x: 5, y: 890 });
await pause(400);
await evaluate(`${hubCard}.focus()`);
await pause(100);
await shot('overview-card-keyboard-focus', `${ov}.querySelectorAll('.card-links .card-link').length === ${relatedOf(busiest)}.length`);
await key('Enter');
await shot('overview-card-enter-opens', viewIs(`domain:${busiest}`));
// A domain opened from the overview has a Back pill naming it; Backspace,
// ← and the toolbar's Back go back to it too.
const backPill = `document.querySelector('.oe-back-pill')`;
const pillShown = `(${backPill}?.closest('foreignObject').style.display ?? 'none') !== 'none'`;
await shot('back-pill-to-overview', `${pillShown} && ${backPill}.textContent === '← Overview'`);
await key('Backspace');
await shot('backspace-goes-back', `${viewIs('overview')} && !${pillShown}`);
await evaluate(`${hubCard}.focus()`);
await key('Enter');
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
await pause(150);
await shot('left-arrow-goes-back', viewIs('overview'));
await mouse('mouseMoved', { x: 5, y: 890 });
await click(`document.querySelector('.domain[data-domain=${JSON.stringify(busiest)}] .card-box')`, { where: 'top' });
await click(backButton);
await shot('toolbar-back-to-overview', `${viewIs('overview')} && !${pillShown}`);
// The overview's cards: a related domain's tooltip is one line too.
await mouse('mouseMoved', await centre(`${hubCard}.querySelector('.card-related .card-related-name')`));
await pause(150);
await shot('related-row-tooltip', `[...document.querySelectorAll('.oe-tip')].some((t) => t.closest('foreignObject').style.display !== 'none' && t.children.length === 2 && / → .+ · \\d+ relations?( · \\d+ back)?$/.test(t.firstChild.textContent) && /^Click to open /.test(t.lastChild.textContent))`);
await mouse('mouseMoved', { x: 5, y: 890 });

// Ranking: one row or name per table, its tooltip counts the relations both ways,
// no legend; a click opens the table in its domain, with a Back pill to it.
await viewTab('ranking');
const hx = `document.querySelector('g.view[data-view="ranking"]')`;
await shot('ranking', `!${pillShown} && ${viewIs('ranking')} && ${hx}.querySelectorAll('.rk-item').length === Object.values(${data}.nodes).filter((n) => n.kind === 'table').length && document.querySelector('.oe-view-tabs [data-view="ranking"]').classList.contains('on')`);
// It opens centred across the screen when narrower than it.
await shot('ranking-centred', `(() => { const r = ${hx}.querySelector('rect').getBoundingClientRect(); return r.width > innerWidth || Math.abs(r.left + r.width / 2 - innerWidth / 2) < 2 || { left: r.left, w: r.width }; })()`);
const hot = `${hx}.querySelector('.rk-item:not(.rk-zero)')`;
const hotId = await evaluate(`${hot}.getAttribute('data-id')`);
await mouse('mouseMoved', await centre(hot));
await pause(150);
await shot('ranking-row-hover', `[...document.querySelectorAll('.oe-tip')].some((t) => t.closest('foreignObject').style.display !== 'none' && /\\d+ relations? points? at it · \\d+ from it/.test(t.textContent))`);
await key('l', 'KeyL');
await shot('ranking-no-legend', `[...document.querySelectorAll('foreignObject')].every((f) => !f.querySelector('.oe-legend, .oe-legend-pill') || f.style.display === 'none')`);
await click(hot);
await shot('ranking-row-opens-table', `${viewIs(`domain:${await evaluate(`${data}.nodes[${JSON.stringify(hotId)}].cluster`)}`)} && ${pillShown} && ${backPill}.textContent === '← Ranking'`);
await click(`document.querySelector('.oe-crumbs .oe-link')`);

// The column with the most enum values: its tooltip stays compact (chips,
// note, at most 8 values, never past the window) and a click on it lists
// every value in the panel. Rows with a note or enum carry a mark.
const longEnum = await evaluate(`(() => { const d = ${data}; let best = null;
  for (const [id, n] of Object.entries(d.nodes)) for (const c of n.columns ?? []) { const k = Object.keys(c.enum ?? {}).length; if (k > 0 && (!best || k > best[2])) best = [id, c.name, k, n.cluster]; }
  return best; })()`);
if (longEnum) {
  const [enumTable, enumColumn, enumCount, enumDomain] = longEnum;
  await click(`document.querySelector('.domain[data-domain=${JSON.stringify(enumDomain)}]')`);
  await click(inView(`.table[data-id="${enumTable}"]`), { where: 'top' });
  await key('Escape');
  const row = inView(`.table[data-id="${enumTable}"] .column[data-column="${enumColumn}"]`);
  await mouse('mouseMoved', await centre(row));
  await pause(150);
  await shot(
    'long-enum-tooltip',
    `(() => { const t = [...document.querySelectorAll('.oe-tip')].find((x) => x.closest('foreignObject').style.display !== 'none'); if (!t) return 'no tip';
      const r = t.getBoundingClientRect(); const rows = t.querySelectorAll('.oe-enum tr').length;
      return rows === Math.min(${enumCount}, 8) && t.querySelector('.oe-chips') !== null && r.width <= 362 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight
        && (${enumCount} <= 8 || t.textContent.includes('+${enumCount - 8} more')) && ${row}.querySelector('.hint-enum') !== null || { rows, w: r.width, bottom: r.bottom }; })()`,
  );
  await click(row);
  // The panel holds the column grid with this column's values unfolded.
  await shot('long-enum-panel', `(() => { const open = document.querySelector('.oe-panel .oe-col.open'); const list = open?.querySelector('.oe-enum-list');
    return open?.getAttribute('data-column') === ${JSON.stringify(enumColumn)} && list && getComputedStyle(list).display !== 'none' && list.children.length === ${enumCount} && ${row}.classList.contains('hl-column'); })()`);
  await key('Escape');
  await click(`document.querySelector('.oe-crumbs .oe-link')`);
}

// A column validate warns about (a reference nothing uses): its row carries
// the warning mark, and its tooltip and the table's panel say why.
const warned = await evaluate(`(() => { const d = ${data};
  for (const [id, n] of Object.entries(d.nodes)) for (const c of n.columns ?? []) if (c.warning) return [id, c.name, n.cluster];
  return null; })()`);
if (warned) {
  const [warnTable, warnColumn, warnDomain] = warned;
  await click(`document.querySelector('.domain[data-domain=${JSON.stringify(warnDomain)}]')`);
  const row = inView(`.table[data-id="${warnTable}"] .column[data-column="${warnColumn}"]`);
  await mouse('mouseMoved', await centre(row));
  await pause(150);
  await shot(
    'missing-relation-mark',
    `${row}.querySelector('.col-warn') !== null && [...document.querySelectorAll('.oe-tip .oe-warn')].some((t) => t.textContent.startsWith('Possibly missing relation: '))`,
  );
  await click(row);
  await shot('missing-relation-panel', `document.querySelector('.oe-panel .oe-col .oe-warn') !== null`);
  await key('Escape');
  await click(`document.querySelector('.oe-crumbs .oe-link')`);
}

// A domain whose view has a table with lines and a stub, preferring one
// with an enum column so the tooltip step shows enum values.
const domain = await evaluate(`(() => {
  const d = JSON.parse(document.getElementById('open-erd-data').textContent);
  const usable = [...document.querySelectorAll('g.view')].filter((v) => v.getAttribute('data-view').startsWith('domain:') && v.querySelector('.stub:not(.group-stub)') && v.querySelector('.table') && v.querySelector('.relation-group'));
  const withEnum = usable.find((v) => [...v.querySelectorAll('.table')].some((g) => d.nodes[g.getAttribute('data-id')].columns.some((c) => c.enum)));
  return (withEnum ?? usable[0]).getAttribute('data-view').slice(7);
})()`);
await click(`document.querySelector('.domain[data-domain=${JSON.stringify(domain)}]')`);
// The breadcrumb names the domain with its table count.
await shot(
  'domain-view',
  `${viewIs(`domain:${domain}`)} && (() => { const n = Object.values(${data}.nodes).filter((x) => x.kind === 'table' && x.cluster === ${JSON.stringify(domain)}).length;
    return document.querySelector('.oe-crumbs .here').textContent.endsWith(' · ' + n + ' table' + (n === 1 ? '' : 's')) || document.querySelector('.oe-crumbs .here').textContent; })()`,
);

// The database crumb centres that database's whole frame on the overview. Small
// frames hit the zoom cap, so "centred and fully visible" is the check, not size.
// With several databases the crumb is a switcher: its menu, left-aligned
// under it, lists them all with this one checked.
const dbName = domain.split('/')[0];
const dbLabel = dbName[0].toUpperCase() + dbName.slice(1);
const dbCrumb = `document.querySelector('.oe-db-crumb')`;
const multiDb = await evaluate(`${dbCrumb} !== null`);
if (multiDb) {
  await click(dbCrumb);
  await shot(
    'database-crumb-menu',
    `${menuOpen('db')} && ${menuItem('db', dbLabel)}.classList.contains('checked') && ${menuItem('db', 'All databases')} !== undefined && !${menuItem('db', 'All databases')}.classList.contains('checked')
      && (() => { const m = document.querySelector('.oe-db-menu').getBoundingClientRect(); const b = ${dbCrumb}.getBoundingClientRect(); return (Math.abs(m.left - b.left) < 6 && m.top >= b.bottom && m.right <= innerWidth) || { m: m.left, b: b.left }; })() === true`,
  );
  await click(menuItem('db', dbLabel));
} else await click(`document.querySelectorAll('.oe-crumbs .oe-link')[1]`);
await shot('database-crumb', `${viewIs('overview')} && (() => {
  const r = document.querySelector('.database[data-database=${JSON.stringify(domain.split('/')[0])}] .db-frame').getBoundingClientRect();
  const top = document.querySelector('.oe-toolbar')?.getBoundingClientRect().bottom ?? 0;
  const visible = r.left >= 0 && r.right <= innerWidth && r.top >= top && r.bottom <= innerHeight;
  const centred = Math.abs((r.left + r.right) / 2 - innerWidth / 2) < innerWidth * 0.2;
  return visible && centred;
})()`);
// On the views showing every database the switcher reads "All databases"
// and jumps to a database's frame too, named as on the frame (first letter
// upper case; ids keep their case). There is no Databases button.
if (multiDb) {
  await click(dbCrumb);
  await shot(
    'database-crumb-all',
    `${dbCrumb}.textContent === 'All databases' && ${menuItem('db', 'All databases')}.classList.contains('checked') && ${menuItem('db', dbLabel)} !== undefined
      && ![...document.querySelectorAll('.oe-toolbar button')].some((b) => b.textContent.trim() === 'Databases')`,
  );
  await click(menuItem('db', dbLabel));
  await shot('database-crumb-switch', `${viewIs('overview')} && !${menuOpen('db')} && (() => {
    const r = document.querySelector('.database[data-database=${JSON.stringify(dbName)}] .db-frame').getBoundingClientRect();
    return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })()`);
}
await click(`document.querySelector('.domain[data-domain=${JSON.stringify(domain)}]')`);
await shot('database-crumb-name', `document.querySelectorAll('.oe-crumbs .oe-link')[1].textContent === ${JSON.stringify(dbLabel)}`);

const table = await evaluate(`(() => { const g = ${visible}.querySelector('.relation-group'); return ${visible}.querySelector('.table[data-id="' + g.getAttribute('data-from') + '"]') ? g.getAttribute('data-from') : g.getAttribute('data-to'); })()`);
await click(inView(`.table[data-id="${table}"]`), { where: 'top' });
// The panel: name (full id in its tooltip), domain chip, compact actions,
// tabs, one row per column.
await shot(
  'table-highlight',
  `${visible}.classList.contains('dimmed') && ${inView('.table.selected')} !== null && ${inView('.relation-group.hl')} !== null && document.querySelectorAll('.oe-panel .oe-col[data-column]').length === ${data}.nodes[${JSON.stringify(table)}].columns.length`,
);
await shot(
  'table-panel-header',
  `(() => { const p = document.querySelector('.oe-panel'); const n = ${data}.nodes[${JSON.stringify(table)}]; const tabs = [...p.querySelectorAll('.oe-tab')].map((t) => t.getAttribute('data-tab'));
    return p.querySelector('.oe-ph-name').title.startsWith(${JSON.stringify(table)}) && p.querySelector('.oe-domain-chip').textContent === n.cluster.split('/').slice(1).join('/')
      && p.querySelector('.oe-actions .oe-seg') && p.querySelector('.oe-actions .oe-join-from') && p.querySelector('.oe-actions .oe-copy-schema') && tabs[0] === 'columns' && tabs.includes('relations') === true
      && tabs.includes('indexes') === Boolean(n.indexes) && !/Find join path from here|Copy schema ▾/.test(p.textContent) || tabs; })()`,
);
// The detail view: notes in full (no ellipsis), the bolt on indexed columns
// and the list icon on columns with values, as in the table box; the
// toolbar has no Join path button (the palette and the panel have it).
await shot(
  'panel-full-notes-icons',
  `(() => { const n = ${data}.nodes[${JSON.stringify(table)}]; const p = document.querySelector('.oe-panel'); const note = p.querySelector('.oe-ph-note');
    const full = (e) => !e || (getComputedStyle(e).whiteSpace !== 'nowrap' && getComputedStyle(e).textOverflow !== 'ellipsis' && e.scrollWidth <= e.clientWidth + 1);
    const rows = [...p.querySelectorAll('.oe-col')];
    const icons = rows.every((r) => { const c = n.columns.find((x) => x.name === r.getAttribute('data-column')); const idx = (n.indexes ?? []).some((i) => i.columns.includes(c.name));
      return (r.querySelector('.hint .icon-index') !== null) === idx && (r.querySelector('.hint .hint-enum') !== null) === Boolean(c.enum); });
    const notes = rows.every((r) => { const c = n.columns.find((x) => x.name === r.getAttribute('data-column')); const l2 = r.querySelector('.l2:not(.internal):not(.oe-warn)'); return (c.note ? l2?.textContent === c.note : l2 === null) && full(l2); });
    const button = [...document.querySelectorAll('.oe-toolbar button')].some((b) => b.textContent.startsWith('Join path'));
    return full(note) && icons && notes && !button || { icons, notes, button }; })()`,
);
// Column rows: NULL only on nullable columns, "= default" when a default exists.
await shot(
  'column-null-default-chips',
  `(() => { const n = ${data}.nodes[${JSON.stringify(table)}];
    return [...document.querySelectorAll('.oe-panel .oe-col')].every((r) => { const c = n.columns.find((x) => x.name === r.getAttribute('data-column'));
      return (r.querySelector('.oe-badge.null') !== null) === (c.nullable === true) && (r.querySelector('.oe-badge.default')?.textContent ?? null) === (c.default !== undefined ? '= ' + c.default : c.autoIncrement ? '= auto' : null)
        && (r.querySelector('.name.pk') !== null) === Boolean(c.pk); }); })()`,
);
await tab('relations');
// Its relations are chips by direction, a table name each, no kind words;
// a not-confirmed one is dashed and says so in its tooltip; no evidence.
await shot(
  'table-relation-chips',
  `(() => { const d = ${data}; const id = ${JSON.stringify(table)}; const panel = document.querySelector('.oe-panel');
    const group = (title) => [...panel.querySelectorAll('.oe-chip-group')].find((g) => g.querySelector('.sub').textContent.startsWith(title + ' ('));
    const out = new Set(d.links.filter((l) => l.from === id && l.to !== id).map((l) => l.to)); const into = new Set(d.links.filter((l) => l.to === id && l.from !== id).map((l) => l.from));
    const count = (g) => (g ? Number(/\\((\\d+)\\)$/.exec(g.querySelector('.sub').textContent)[1]) : 0);
    const dashed = [...panel.querySelectorAll('.oe-chip.unconfirmed')];
    return count(group('References')) === out.size && count(group('Referenced by')) === into.size && !/\\b(n-1|1-n|db_fk|declared|inferred)\\b/.test([...panel.querySelectorAll('.oe-chip-group')].map((g) => g.textContent).join())
      && dashed.every((c) => c.title.endsWith('not confirmed') && getComputedStyle(c).borderStyle === 'dashed') && !/Evidence/.test(panel.textContent) || { out: out.size, into: into.size }; })()`,
);
await tab('columns');
// Key icons in the box: a key on primary keys, a link on referencing columns, a table icon (star when central) in the header.
await shot(
  'table-box-icons',
  `(() => { const g = ${inView(`.table[data-id="${table}"]`)}; const n = ${data}.nodes[${JSON.stringify(table)}];
    const rows = [...g.querySelectorAll('.column')];
    return rows.every((r) => { const c = n.columns.find((x) => x.name === r.getAttribute('data-column')); return (r.querySelector('.icon-pk') !== null) === Boolean(c.pk) && (r.querySelector('.icon-fk') !== null) === Boolean(!c.pk && c.fk); })
      && g.querySelector(n.central ? '.icon-central' : '.icon-table') !== null; })()`,
);
// Copy schema: SQL (JSON for MongoDB) or Markdown, from a menu in the panel.
await evaluate(stubClipboard);
const tabsTop = await evaluate(`document.querySelector('.oe-panel .oe-tabs').getBoundingClientRect().top`);
await click(`document.querySelector('.oe-panel .oe-copy-schema')`);
// A popover over the panel: short labels, nothing below it moves.
await shot('copy-schema-menu', `[...document.querySelectorAll('.oe-copy-menu .oe-item')].map((b) => b.textContent).join('|') === (${data}.databases[${JSON.stringify(table.split('.')[0])}].engine === 'mongodb' ? 'JSON schema|Markdown' : 'SQL|Markdown')
  && getComputedStyle(document.querySelector('.oe-copy-menu')).position === 'absolute' && document.querySelector('.oe-copy-menu .oe-item').title.length > 20 && document.querySelector('.oe-panel .oe-tabs').getBoundingClientRect().top === ${tabsTop}`);
await click(`document.querySelector('.oe-copy-menu .oe-item')`);
await shot('copy-schema-sql', `/^Copied (SQL|JSON schema)$/.test(document.querySelector('.oe-panel .oe-status-inline').textContent) && (window.__copied.startsWith('-- Generated from the ERD; types as recorded, review before use') || JSON.parse(window.__copied).$comment !== undefined)`);
await click(`document.querySelector('.oe-panel .oe-copy-schema')`);
await click(`[...document.querySelectorAll('.oe-copy-menu .oe-item')].find((b) => b.textContent === 'Markdown')`);
await pause(3000);
// The label stays until the next copy or another panel.
await shot('copy-schema-markdown', `window.__copied.startsWith('### ${table.split('.')[2]}') && window.__copied.includes('| # | Column | Type |') && document.querySelector('.oe-panel .oe-status-inline').textContent === 'Copied Markdown'`);
// Cmd+C (Ctrl+C) with the table selected: its SQL with indexes, and a toast.
await evaluate(`window.getSelection().removeAllRanges(); document.activeElement?.blur?.()`);
await modKey('c');
await shot('cmd-c-copies-table', `/^Copied (SQL|JSON schema) for ${table.split('.')[2]}$/.test(document.querySelector('.oe-toast')?.textContent) && document.querySelector('.oe-toast').closest('foreignObject').style.display !== 'none' && (window.__copied.startsWith('-- Generated from the ERD') || JSON.parse(window.__copied).$comment !== undefined)`);

// Hover a column with an enum when there is one, else the first column.
const column = await evaluate(`(() => { const d = JSON.parse(document.getElementById('open-erd-data').textContent);
  for (const g of ${visible}.querySelectorAll('.table')) { const n = d.nodes[g.getAttribute('data-id')]; const c = n.columns.find((x) => x.enum); if (c) return [g.getAttribute('data-id'), c.name]; }
  const g = ${visible}.querySelector('.table'); return [g.getAttribute('data-id'), d.nodes[g.getAttribute('data-id')].columns[0].name]; })()`);
await bringIntoView(inView(`.table[data-id="${column[0]}"] .column[data-column="${column[1]}"]`));
await mouse('mouseMoved', await centre(inView(`.table[data-id="${column[0]}"] .column[data-column="${column[1]}"]`)));
await pause(150);
await shot('column-tooltip', `[...document.querySelectorAll('foreignObject')].some((f) => f.style.display !== 'none' && f.querySelector('.oe-tip'))`);

// Pick a line whose middle is actually clickable: on big views the middle of
// the first line can sit under the side panel or another box.
await click(`[...${visible}.querySelectorAll('.relation-group:not(.kind-polymorphic) path.relation-hit')].find((e) => {
  const m = e.getPointAtLength(e.getTotalLength() / 2).matrixTransform(e.getScreenCTM());
  return e.closest('.relation-group').contains(document.elementFromPoint(m.x, m.y));
})`);
// The flow animates; two frames apart the dash offset must differ.
await shot('line-flow', `${inView('.flow')} !== null && ${inView('.flow-target')} !== null`);
const offsets = await evaluate(`new Promise((done) => { const f = ${inView('.flow')}; const a = getComputedStyle(f).strokeDashoffset; setTimeout(() => done([a, getComputedStyle(f).strokeDashoffset]), 250); })`);
if (offsets[0] === offsets[1]) failures.push(`flow does not move: ${offsets}`);

// Download menu, with the flow still running: the SVG holds this view only,
// without script, as it is on screen (the flow and the dimming kept); PNG is twice the view's
// size (or downscaled, and the menu says so); JPEG is a JPEG.
{
  // One folder per download, so a repeated name is not renamed by Chrome.
  let downloads;
  let count = 0;
  const pick = async (label) => {
    count += 1;
    downloads = join(resolve(outDir), 'downloads', String(count));
    await mkdir(downloads, { recursive: true });
    await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    await choose('more', label);
  };
  const saved = async (name) => {
    for (let i = 0; i < 100; i++) {
      if ((await readdir(downloads)).includes(name)) {
        await pause(200);
        return readFile(join(downloads, name));
      }
      await pause(100);
    }
    throw new Error(`download ${name} never arrived`);
  };
  const bounds = await evaluate(`${visible}.getAttribute('data-bounds').split(' ').map(Number)`);
  const base = `${domain.split('/')[0]}-${domain.split('/').slice(1).join('/')}`.toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, '-').replace(/^-+|-+$/g, '');
  // Downloads sit in the ⋯ menu, under their heading.
  await click(menuButton('more'));
  await shot(
    'download-menu',
    `['As SVG', 'As PNG', 'As JPEG'].every((l) => [...document.querySelectorAll('.oe-more-menu .oe-item')].some((b) => b.textContent === l)) && ${inView('.flow')} !== null
      && ${menuButton('more')}.title.includes('download') && document.querySelector('.oe-more-menu .oe-menu-sub').textContent === 'Download this view'`,
  );
  await pick('As SVG');
  const plain = (await saved(`${base}.svg`)).toString();
  const views = (plain.match(/<g class="view[ "]/g) ?? []).length;
  const kept = /class="[^"]*\bflowing\b/.test(plain) && /class="view[^"]*\bdimmed\b/.test(plain);
  if (views !== 1 || plain.includes('<script') || plain.includes('foreignObject') || plain.includes('class="fold-toggle') || !kept || !plain.includes('@font-face')) {
    failures.push(`download svg: ${JSON.stringify({ views, script: plain.includes('<script'), kept })}`);
  }
  await pick('As PNG');
  const png = await saved(`${base}.png`);
  const [pw, ph] = [png.readUInt32BE(16), png.readUInt32BE(20)];
  const status = await evaluate(`document.querySelector('.oe-status').textContent`);
  const full = pw === Math.floor(bounds[2] * 2) && ph === Math.floor(bounds[3] * 2);
  if (!(full ? !status.includes('downscaled') : status.includes('downscaled'))) failures.push(`download png ${pw}x${ph} for ${bounds}: ${status}`);
  await pick('As JPEG');
  const jpg = await saved(`${base}.jpg`);
  await shot('download-saved', `${jpg[0] === 0xff && jpg[1] === 0xd8} && document.querySelector('.oe-status').textContent.startsWith('Saved ${base}.jpg')`);
  await key('Escape');
  await shot('download-menu-closed', `!${menuOpen('more')}`);
}

await click(`${visible}.querySelector(':scope > rect')`, { where: 'top' });
await shot('cleared', `!${visible}.classList.contains('dimmed') && ${inView('.flow')} === null`);

const stub = await evaluate(`${inView('.stub:not(.group-stub)')}.getAttribute('data-id')`);
await bringIntoView(inView(`.stub[data-id="${stub}"]`));
await click(inView(`.stub[data-id="${stub}"]`));
await shot('stub-jump', `${visible}.getAttribute('data-view') !== ${JSON.stringify(`domain:${domain}`)} && ${inView(`.table.selected[data-id="${stub}"]`)} !== null`);

// A table with indexes: the panel lists them, indexed columns carry the bolt.
const indexed = await evaluate(`(() => { const d = ${data}; for (const [id, n] of Object.entries(d.nodes)) if (n.indexes) return [id, n.cluster]; return null; })()`);
if (indexed) {
  const [indexTable, indexDomain] = indexed;
  await click(`document.querySelector('.oe-crumbs .oe-link')`);
  await click(`document.querySelector('.domain[data-domain=${JSON.stringify(indexDomain)}]')`);
  await click(inView(`.table[data-id="${indexTable}"]`), { where: 'top' });
  await tab('indexes');
  await shot(
    'indexes-panel',
    `(() => { const n = ${data}.nodes[${JSON.stringify(indexTable)}]; const rows = document.querySelectorAll('.oe-panel .oe-idx').length;
      const marked = [...${inView(`.table[data-id="${indexTable}"]`)}.querySelectorAll('.column')].filter((r) => r.querySelector('.icon-index')).map((r) => r.getAttribute('data-column')).sort();
      const expected = [...new Set(n.indexes.flatMap((i) => i.columns))].filter((c) => n.columns.some((x) => x.name === c)).sort();
      return rows === n.indexes.length && JSON.stringify(marked) === JSON.stringify(expected) || { rows, marked, expected }; })()`,
  );
  await key('Escape');
}

// A clicked line's panel shows its review state as an icon with the words as tooltip.
{
  const anyLine = await evaluate(`[...${visible}.querySelectorAll('.relation-group:not(.kind-view_source):not(.kind-polymorphic):not([data-group]) path.relation-hit')].find((e) => { const m = e.getPointAtLength(e.getTotalLength() / 2).matrixTransform(e.getScreenCTM()); return m.x < innerWidth - 470 && e.closest('.relation-group').contains(document.elementFromPoint(m.x, m.y)); }) ? true : false`);
  if (anyLine) {
    await click(`[...${visible}.querySelectorAll('.relation-group:not(.kind-view_source):not(.kind-polymorphic):not([data-group]) path.relation-hit')].find((e) => { const m = e.getPointAtLength(e.getTotalLength() / 2).matrixTransform(e.getScreenCTM()); return m.x < innerWidth - 470 && e.closest('.relation-group').contains(document.elementFromPoint(m.x, m.y)); })`);
    await shot(
      'line-review-icon',
      `(() => { const f = document.querySelector('.oe-panel .oe-line-facts'); const icon = f?.querySelector('.oe-review');
        return icon && ['Confirmed', 'Not confirmed yet', 'Code changed since confirmed'].includes(icon.title) && f.textContent.includes(icon.title) && !/\\b(pending|reviewed|stale)\\b/.test(f.textContent)
          && document.querySelectorAll('.oe-panel .oe-rel-card').length === 2 && /^Each |^Rows of /.test(document.querySelector('.oe-panel .oe-rel-sentence')?.textContent ?? ''); })()`,
    );
    await key('Escape');
  }
}

const polyView = await evaluate(`(() => { for (const v of document.querySelectorAll('g.view')) { const n = v.getAttribute('data-view'); if (n.startsWith('domain:') && v.querySelector('.poly-routes')) return n.slice(7); } })()`);
if (polyView) {
  await click(`document.querySelector('.oe-crumbs .oe-link')`);
  await click(`document.querySelector('.domain[data-domain=${JSON.stringify(polyView)}]')`);
  const poly = await evaluate(`${inView('.poly-routes')}.getAttribute('data-poly')`);
  // A polymorphic line's panel: one end card names the association with its type and id columns.
  const polyLine = `[...${visible}.querySelectorAll('.relation-group.kind-polymorphic path.relation-hit')].find((e) => { const m = e.getPointAtLength(e.getTotalLength() / 2).matrixTransform(e.getScreenCTM()); return m.x < innerWidth - 470 && e.closest('.relation-group').contains(document.elementFromPoint(m.x, m.y)); })`;
  if (await evaluate(`${polyLine} ? true : false`)) {
    await click(polyLine);
    await shot('polymorphic-line-panel', `(() => { const cards = [...document.querySelectorAll('.oe-panel .oe-rel-card')]; const p = cards.find((c) => c.querySelector('.name').textContent.includes('«'));
      return cards.length === 2 && p && p.querySelectorAll('.col').length === 2 && /^One of: /.test(p.querySelector('.targets')?.textContent ?? '') && document.querySelector('.oe-panel .oe-line-facts').textContent.includes('Polymorphic')
        && /one of \\d+ tables?;/.test(document.querySelector('.oe-panel .oe-rel-sentence').textContent); })()`);
    await key('Escape');
  }
  await click(inView(`.poly[data-id="${poly}"]`), { where: 'top' });
  // Its panel: the business note when there is one, never a generic sentence,
  // and the evidence folded.
  await shot(
    'polymorphic-targets',
    `(() => { const p = ${data}.nodes[${JSON.stringify(poly)}]; const groups = [...document.querySelectorAll('.oe-panel .oe-chip-group')];
      const targets = groups.find((g) => g.querySelector('.sub').textContent === 'Targets (' + p.targets.length + ')');
      return [...${visible}.querySelectorAll('.poly-routes')].some((g) => g.style.display !== 'none') && targets && targets.querySelectorAll('.oe-chip').length === Math.min(p.targets.length, 12)
        && !document.querySelector('.oe-panel').textContent.includes('each row points at') && !/Evidence/.test(document.querySelector('.oe-panel').textContent) && document.querySelector('.oe-panel details') === null || { groups: groups.length }; })()`,
  );
  await click(`[...document.querySelectorAll('.oe-panel .oe-chip-group')].find((g) => g.querySelector('.sub').textContent.startsWith('Targets')).querySelector('.oe-chip')`);
  await shot('polymorphic-target-jump', `${inView('.table.selected')} !== null`);
}

// Search: Cmd+F (Ctrl+F) opens a spotlight box instead of the browser's
// find bar (the key event's default is prevented), "/" too; arrows move
// through table and column rows, Enter jumps, Escape closes.
const query = column[1].slice(0, 4);
const prevented = await evaluate(`(() => { const e = new KeyboardEvent('keydown', { key: 'f', ${FIND_MODIFIER === 4 ? 'metaKey' : 'ctrlKey'}: true, bubbles: true, cancelable: true }); document.dispatchEvent(e); const r = e.defaultPrevented; document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return r; })()`);
if (prevented !== true) failures.push('the find shortcut does not prevent the browser find bar');
await findKey();
await send('Input.insertText', { text: query });
await pause(200);
await shot(
  'spotlight',
  `(() => { const box = document.querySelector('.oe-spotlight').getBoundingClientRect(); const rows = [...document.querySelectorAll('.oe-spotlight-list .oe-result')];
    return ${spotlightShown} && document.activeElement === document.querySelector('.oe-spotlight-input') && rows.length > 0 && rows[0].classList.contains('active')
      && rows.some((r) => r.querySelector('.kind').textContent === 'col') && Math.abs(box.left + box.width / 2 - innerWidth / 2) < 2 && box.width >= 480 || { rows: rows.length }; })()`,
);
await key('ArrowDown', 'ArrowDown');
await shot('spotlight-arrow', `document.querySelectorAll('.oe-spotlight-list .oe-result')[1]?.classList.contains('active') ?? true`);
await key('Escape');
await shot('spotlight-escape', `!${spotlightShown}`);
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: '/', code: 'Slash', text: '/' });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: '/', code: 'Slash' });
await pause(150);
await shot('spotlight-slash', `${spotlightShown} && document.querySelector('.oe-spotlight-input').value === ''`);
await key('Escape');
await searchFor(query);
await shot('search-jump', `${inView('.table.selected')} !== null && !${spotlightShown}`);
// Columns marked as personal data and schema health findings: the palette,
// the Highlight menu and the shortcut list offer their modes only when some exist.
const piiTotal = await evaluate(`Object.values(${data}.nodes).reduce((n, x) => n + (x.columns ?? []).filter((c) => c.pii).length, 0)`);
const healthTotal = await evaluate(`(${data}.health ?? []).length`);

// The toolbar's search is a compact trigger naming the palette's shortcut.
await shot('search-trigger', `/^Search or jump…(⌘K|Ctrl\\+K)$/.test(document.querySelector('.oe-search-trigger').textContent) && document.querySelector('.oe-toolbar input[type="search"]') === null || document.querySelector('.oe-search-trigger').textContent`);

// Business/Technical mode is gone.
await shot('no-business-mode', `![...document.querySelectorAll('button')].some((b) => /^(Business|Technical)$/.test(b.textContent)) && !document.documentElement.classList.contains('business')`);

// The table highlighted earlier has lines; open its neighborhood from the
// full view, or from its domain view in a schema too large for a full view.
if (await evaluate(`document.querySelector('g.view[data-view="all"]') !== null`)) {
  await viewTab('all');
  await shot('all-tables', `${viewIs('all')} && document.querySelector('.oe-crumbs .here').textContent === 'All tables · ' + Object.values(${data}.nodes).filter((x) => x.kind === 'table').length + ' tables'`);
  // The legend is open here, drawn with the diagram's own line and marker
  // classes, listing only what this view draws: no review colours outside
  // review mode, an end-marker entry per kind drawn.
  await evaluate(`document.querySelector('.oe-legend-pill')?.click()`);
  const legendHost = `[...document.querySelectorAll('foreignObject')].find((x) => x.querySelector('.oe-legend'))`;
  const drawnEnds = `new Set([...${visible}.querySelectorAll('.marker[data-ends]')].flatMap((g) => g.getAttribute('data-ends').split(' ')).filter((k) => k !== 'none')).size`;
  await shot(
    'legend',
    `(() => { const f = ${legendHost}; const r = f.querySelector('.oe-legend').getBoundingClientRect(); const ends = f.querySelectorAll('.oe-legend .item .marker').length;
      const same = (sel) => (f.querySelector('.oe-legend ' + sel) !== null) === (${visible}.querySelector(sel) !== null);
      const subs = [...f.querySelectorAll('.oe-legend .sub')].map((x) => x.textContent);
      return f.style.display !== 'none' && ends === ${drawnEnds} && ['.hint-enum', '.icon-pk', '.icon-fk', '.icon-index', '.icon-central'].every(same) && f.querySelector('.oe-legend .review-icon') === null
        && !subs.includes('Lines') && f.querySelector('.oe-legend .badge-arrow') === null && r.bottom <= innerHeight && r.left >= 0 || { ends, drawn: ${drawnEnds}, subs }; })()`,
  );
  // Hide folds the legend to a small pill in the same corner, not in any
  // menu; the pill opens it again.
  await click(`[...document.querySelectorAll('.oe-legend .oe-link')].find((b) => b.textContent === 'Hide')`);
  await shot('legend-pill', `(() => { const p = document.querySelector('.oe-legend-pill'); const r = p?.getBoundingClientRect();
    return p && document.querySelector('.oe-legend') === null && r.left < 40 && r.bottom > innerHeight - 40 && ![...document.querySelectorAll('.oe-more-menu .oe-item')].some((b) => b.textContent.startsWith('Legend')); })()`);
  // A card like the minimap (radius 8, its bottom margin), a notation glimpse.
  // Hovered, it lifts but keeps all four borders inside its area.
  await mouse('mouseMoved', await centre(`document.querySelector('.oe-legend-pill')`));
  await pause(250);
  await shot('legend-pill-hover', `(() => { const p = document.querySelector('.oe-legend-pill').getBoundingClientRect(); const f = document.querySelector('.oe-legend-pill').closest('foreignObject').getBoundingClientRect();
    return p.top - f.top >= 2 && f.bottom - p.bottom >= 2 && p.left - f.left >= 2 && f.right - p.right >= 2 || { p: [p.top, p.bottom], f: [f.top, f.bottom] }; })()`);
  await mouse('mouseMoved', { x: 700, y: 400 });
  await shot('legend-pill-style', `(() => { const p = document.querySelector('.oe-legend-pill'); const r = p.getBoundingClientRect(); const cs = getComputedStyle(p);
    const map = document.querySelector('.oe-minimap'); const m = map?.closest('foreignObject').style.display !== 'none' ? map.getBoundingClientRect() : null;
    return cs.borderRadius === '8px' && p.querySelector('.icon-legend') && p.querySelector('.oe-chevron') && p.textContent === 'Legend' && (!m || Math.abs(m.bottom - r.bottom) < 3) || { radius: cs.borderRadius, bottom: r.bottom, map: m?.bottom }; })()`);
  await click(`document.querySelector('.oe-legend-pill')`);
  await shot('legend-reopened', `document.querySelector('.oe-legend') !== null && document.querySelector('.oe-legend-pill') === null`);
  // L folds and unfolds it.
  await key('l', 'KeyL');
  await shot('legend-l-key', `document.querySelector('.oe-legend') === null && document.querySelector('.oe-legend-pill') !== null`);
  await key('l', 'KeyL');
  await shot('legend-l-key-again', `document.querySelector('.oe-legend') !== null`);
  // Review mode, in the Highlight menu with the counts, only when something
  // waits for review: pending lines turn amber, the legend shows the review
  // icons and a chip says the mode is on; its × turns it off. With no mode
  // to offer at all there is no Highlight button.
  const counts = await evaluate(`${data}.review`);
  const highlightShown = await evaluate(`getComputedStyle(${menuButton('highlight')}.parentNode).display !== 'none'`);
  const modesTotal = await evaluate(`(() => { const d = ${data}; return d.review.pending + d.review.stale + (d.health ?? []).length + Object.values(d.nodes).reduce((n, x) => n + (x.columns ?? []).filter((c) => c.pii).length + (x.central ? 1 : 0), 0); })()`);
  if (highlightShown !== modesTotal > 0) failures.push(`Highlight button shown: ${highlightShown}, modes: ${modesTotal}`);
  if (counts.pending + counts.stale === 0) {
    if (highlightShown) await click(menuButton('highlight'));
    await shot('review-mode-hidden', `${menuItem('highlight', 'Review mode')} === undefined && !/null|undefined/.test(document.querySelector('.oe-highlight-menu').textContent) && document.querySelector('.oe-review-chip').closest('foreignObject').style.display === 'none'`);
    await closeMenu('highlight');
  } else {
    await click(menuButton('highlight'));
    const pending = await evaluate(`${inView('.relation-group.review-pending:not(.kind-view_source) path.relation')} !== null`);
    await shot(
      'review-mode-item',
      `${menuItem('highlight', 'Review mode')}.textContent === 'Review mode${counts.pending} to confirm · ${counts.stale} changed in code' && ${menuItem('highlight', 'Review mode')}.title.includes('amber = not confirmed yet')
        && !/null|undefined/.test(document.querySelector('.oe-highlight-menu').textContent) && !${menuButton('highlight')}.classList.contains('active')`,
    );
    await click(menuItem('highlight', 'Review mode'));
    // The menu stays open with the mode checked; the button reads as on.
    await shot('review-mode-checked', `${menuOpen('highlight')} && ${menuItem('highlight', 'Review mode')}.getAttribute('aria-checked') === 'true' && ${menuButton('highlight')}.classList.contains('active')`);
    await closeMenu('highlight');
    await shot(
      'review-mode',
      `document.documentElement.classList.contains('review-mode') && document.querySelector('.oe-review-chip').closest('foreignObject').style.display !== 'none'
        && document.querySelector('.oe-review-chip').textContent.startsWith('Review mode: ${counts.pending} to confirm, ${counts.stale} changed')
        && (!${pending} || (getComputedStyle(${inView('.relation-group.review-pending:not(.kind-view_source) path.relation')}).stroke === 'rgb(194, 124, 14)' && ${legendHost}.querySelector('.oe-legend .review-icon-pending') !== null))`,
    );
    await click(`document.querySelector('.oe-review-chip .oe-chip-close')`);
    await shot('review-mode-off', `!document.documentElement.classList.contains('review-mode') && document.querySelector('.oe-review-chip').closest('foreignObject').style.display === 'none' && ${legendHost}.querySelector('.oe-legend .review-icon') === null`);
    if (pending) failures.push(...(await evaluate(`getComputedStyle(${inView('.relation-group.review-pending:not(.kind-view_source) path.relation')}).stroke === 'rgb(107, 119, 138)'`) ? [] : ['review mode off: pending line is not neutral']));
  }
  // A cross-DB line names both databases; its panel names both with their engines.
  const cross = await evaluate(`${inView('.relation-group.kind-cross_db')}?.getAttribute('data-id') ?? null`);
  if (cross) {
    await click(inView(`.relation-group[data-id="${cross}"] path.relation-hit`));
    await shot(
      'cross-db-line',
      `/^\\S+ → \\S+$/.test(${inView(`.relation-group[data-id="${cross}"] .edge-label text`)}.textContent) && [...document.querySelectorAll('.oe-panel .oe-rel-card .db')].every((d) => /^\\S+ \\(.+\\)$/.test(d.textContent)) && document.querySelectorAll('.oe-panel .oe-rel-card .db').length === 2`,
    );
    await key('Escape');
  }
  // Minimap: zoomed in, the view no longer fits, so the minimap shows; a
  // click on it moves the view there. Fitting the view again hides it.
  const minimapHost = `document.querySelector('.oe-minimap')?.closest('foreignObject')`;
  for (let i = 0; i < 8; i++) await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 500, y: 500, deltaX: 0, deltaY: -30, modifiers: 2 });
  await pause(200);
  const beforeMap = await evaluate(`document.querySelector('.camera').getAttribute('transform')`);
  await shot('minimap-visible', `${minimapHost}?.style.display === '' && (() => { const r = ${minimapHost}.getBoundingClientRect(); return r.right <= innerWidth && r.bottom <= innerHeight; })()`);
  const mapBox = await evaluate(`(() => { const r = document.querySelector('.oe-minimap svg').getBoundingClientRect(); return { x: r.left + r.width * 0.85, y: r.top + r.height * 0.8 }; })()`);
  await mouse('mouseMoved', mapBox);
  await mouse('mousePressed', mapBox);
  await mouse('mouseReleased', mapBox);
  await pause(200);
  await shot('minimap-click-pans', `document.querySelector('.camera').getAttribute('transform') !== ${JSON.stringify(beforeMap)} && ${visible}.getAttribute('data-view') === 'all'`);
  await choose('more', 'Minimap');
  await closeMenu('more');
  await shot('minimap-off', `${minimapHost}.style.display === 'none'`);
  await choose('more', 'Minimap');
  await closeMenu('more');
  // A resize fits the view again: everything visible, no minimap.
  await evaluate(`window.dispatchEvent(new Event('resize'))`);
  await pause(100);
  await shot('minimap-hidden-when-fitted', `${minimapHost}.style.display === 'none'`);
  await evaluate(`document.querySelector('.oe-legend-pill')?.click()`);
} else {
  await click(`document.querySelector('.oe-crumbs .oe-link')`);
  await click(`document.querySelector('.domain[data-domain=${JSON.stringify(domain)}]')`);
  await shot('no-all-tables', `${viewIs(`domain:${domain}`)} && document.querySelector('.oe-view-tabs [data-view="all"]') === null`);
}
// The legend, open again, may cover the table where the fitted view put it.
await bringIntoView(inView(`.table[data-id="${table}"]`));
await click(inView(`.table[data-id="${table}"]`), { where: 'top', count: 2 });
// Its lines carry crow's feet like the drawn views.
await shot(
  'neighborhood-1-hop',
  `${viewIs('neighborhood')} && ${visible}.querySelectorAll('.table, .poly').length > 1 && [...${visible}.querySelectorAll('.relation-group')].filter((g) => g.getAttribute('class').includes('kind-view_source') === false).every((g) => g.querySelector('.marker path, .marker circle'))`,
);
const oneHop = await evaluate(`${visible}.querySelectorAll('.table, .poly').length`);
// At 1280 px wide, with the most the toolbar ever holds (the neighborhood's
// hop buttons and a long breadcrumb), nothing overflows and the breadcrumb
// keeps room; every control has a tooltip.
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await evaluate(`window.dispatchEvent(new Event('resize'))`);
await pause(200);
await shot(
  'toolbar-1280',
  `(() => { const bar = document.querySelector('.oe-toolbar'); const right = document.querySelector('.oe-right'); const crumbs = document.querySelector('.oe-crumbs');
    const controls = [...bar.querySelectorAll('button')].filter((b) => b.offsetParent !== null && !b.closest('.oe-menu') && !b.closest('.oe-crumbs'));
    return bar.scrollWidth <= bar.clientWidth && right.getBoundingClientRect().right <= 1280 && crumbs.getBoundingClientRect().width >= 200
      && controls.every((b) => b.title || b.getAttribute('aria-label') || b.textContent.trim()) && controls.filter((b) => b.classList.contains('oe-tool')).every((b) => b.title) || { scroll: bar.scrollWidth, client: bar.clientWidth, crumbs: crumbs.getBoundingClientRect().width }; })()`,
);
// At 760 px the view tabs and the search shrink to icons and Highlight to
// its icon and caret; still nothing overflows and every control is on screen.
await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 640, deviceScaleFactor: 1, mobile: false });
await evaluate(`window.dispatchEvent(new Event('resize'))`);
await pause(200);
await shot(
  'toolbar-760',
  `(() => { const bar = document.querySelector('.oe-toolbar'); const crumbs = document.querySelector('.oe-crumbs');
    const controls = [...bar.querySelectorAll('button')].filter((b) => b.offsetParent !== null && !b.closest('.oe-menu') && !b.closest('.oe-crumbs'));
    const hidden = (sel) => [...bar.querySelectorAll(sel)].every((e) => e.offsetParent === null);
    return bar.scrollWidth <= bar.clientWidth && controls.every((b) => { const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= 760; }) && crumbs.getBoundingClientRect().width >= 100
      && hidden('.oe-view-tabs .label') && hidden('.oe-search-trigger .label') && hidden('.oe-search-trigger kbd') && hidden('.oe-highlight-btn .label') || { scroll: bar.scrollWidth, client: bar.clientWidth, crumbs: crumbs.getBoundingClientRect().width }; })()`,
);
await send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
await evaluate(`window.dispatchEvent(new Event('resize'))`);
await pause(200);
await click(`[...document.querySelectorAll('.oe-toolbar .oe-btn')].find((b) => b.textContent === '+1 level')`);
await shot('neighborhood-2-hops', `${viewIs('neighborhood')} && ${visible}.querySelectorAll('.table, .poly').length >= ${oneHop}`);
// The second ring stays fully readable while the centre is selected, and the
// fitted drawing ends left of the open panel.
await shot(
  'neighborhood-2-hops-readable',
  `(() => { const outer = [...${visible}.querySelectorAll('.table.ring-2, .poly.ring-2')];
    const panel = [...document.querySelectorAll('foreignObject')].find((f) => f.querySelector('.oe-panel'));
    const drawn = ${visible}.querySelector(':scope > rect').getBoundingClientRect();
    return outer.length === 0 || (outer.every((g) => getComputedStyle(g).opacity === '1') && drawn.right <= panel.getBoundingClientRect().left + 1); })()`,
);
await click(`${visible}.querySelector('.relation-group path.relation-hit')`);
await shot('neighborhood-line-flow', `${inView('.flow')} !== null`);
await key('Escape');
await shot('escape-clears', `!${visible}.classList.contains('dimmed')`);
await click(backButton);
await shot('back', `!(${viewIs('neighborhood')})`);

// A hub table: selecting it draws the hub lines pointing at it in this view,
// its panel lists every table referencing it, and its neighborhood holds
// them. Picks the hub with the most lines in the first view that has any.
const hub = await evaluate(`(() => { for (const v of document.querySelectorAll('g.view')) {
  const groups = [...v.querySelectorAll('.hub-routes')].sort((a, b) => b.children.length - a.children.length);
  if (groups.length > 0) return [v.getAttribute('data-view'), groups[0].getAttribute('data-hub')]; } return null; })()`);
if (hub) {
  const [hubView, hubTable] = hub;
  if (hubView === 'all') await viewTab('all');
  else {
    await click(`document.querySelector('.oe-crumbs .oe-link')`);
    await click(`document.querySelector('.domain[data-domain=${JSON.stringify(hubView.slice(7))}]')`);
  }
  // The legend sits bottom left and may cover the hub table.
  await evaluate(`[...document.querySelectorAll('.oe-legend .oe-link')].find((b) => b.textContent === 'Hide')?.click()`);
  await bringIntoView(inView(`.table[data-id="${hubTable}"]`));
  await click(inView(`.table[data-id="${hubTable}"]`), { where: 'top' });
  await tab('relations');
  const referrers = await evaluate(`new Set(${data}.hubLinks.filter((l) => l.to === ${JSON.stringify(hubTable)} && l.from !== l.to).map((l) => l.from)).size`);
  await shot(
    'hub-table-selected',
    `[...${visible}.querySelectorAll('.hub-routes')].some((g) => g.getAttribute('data-hub') === ${JSON.stringify(hubTable)} && g.style.display !== 'none') && [...document.querySelectorAll('.oe-panel .oe-chip-group')].some((g) => g.querySelector('.sub').textContent.startsWith('Referenced as a shared table') && g.querySelector('.sub').textContent.endsWith('(${referrers})'))`,
  );
  // The panel's own neighborhood button: on a wide schema the open panel may
  // cover the table, so a double-click there would land on the panel.
  await click(`[...document.querySelectorAll('.oe-panel .oe-btn')].find((b) => b.textContent === 'Direct')`);
  await shot('hub-neighborhood', `${viewIs('neighborhood')} && ${visible}.querySelectorAll('.table').length >= ${referrers} + 1`);
  await key('Escape');
  await click(backButton);
}

// Group stubs: in a domain view, the tables of another domain that has
// several of them are one box; a bundled line says how many tables it
// stands for, a row opens its table, the name opens that domain.
const grouped = await evaluate(`(() => { for (const v of document.querySelectorAll('g.view')) { const n = v.getAttribute('data-view'); const g = v.querySelector('.group-stub'); if (n.startsWith('domain:') && g) return [n.slice(7), g.getAttribute('data-id')]; } return null; })()`);
if (grouped) {
  const [groupHome, groupId] = grouped;
  await key('Escape');
  await click(`document.querySelector('.oe-crumbs .oe-link')`);
  await click(`document.querySelector('.domain[data-domain=${JSON.stringify(groupHome)}] .card-box')`, { where: 'top' });
  const groupBoxSel = inView(`.group-stub[data-id="${groupId}"]`);
  const bundle = `[...${visible}.querySelectorAll('.relation-group[data-group]')].find((g) => g.getAttribute('data-from') === ${JSON.stringify(groupId)} || g.getAttribute('data-to') === ${JSON.stringify(groupId)})`;
  const onLine = await evaluate(`(() => { const p = ${bundle}.querySelector('path.relation-hit'); for (const t of [0.5, 0.3, 0.7, 0.2, 0.8]) { const m = p.getPointAtLength(p.getTotalLength() * t).matrixTransform(p.getScreenCTM()); if (${bundle}.contains(document.elementFromPoint(m.x, m.y))) return { x: m.x, y: m.y }; } return null; })()`);
  if (onLine) {
    await mouse('mouseMoved', onLine);
    await pause(150);
    await shot('group-line-tooltip', `[...document.querySelectorAll('.oe-tip')].some((t) => t.textContent === ${bundle}.getAttribute('data-label') + JSON.parse(${bundle}.getAttribute('data-tables')).map((id) => id.split('.')[2]).join(', ')) && /^\\d+ tables? in .+ (reference|references)/.test(${bundle}.getAttribute('data-label'))`);
  }
  const rowTable = await evaluate(`${groupBoxSel}.querySelector('.group-row[data-table]').getAttribute('data-table')`);
  await click(`${groupBoxSel}.querySelector('.group-row[data-table]')`);
  await shot('group-row-opens-table', `${inView(`.table.selected[data-id="${rowTable}"]`)} !== null && document.querySelector('.oe-back-pill')?.textContent.startsWith('← ')`);
  await click(backButton);
  await click(`${groupBoxSel}.querySelector('.group-head')`);
  await shot('group-head-opens-domain', viewIs(`domain:${groupId.slice('group:'.length)}`));
  await click(`document.querySelector('.oe-crumbs .oe-link')`);
}

// Folding domains: a click on a domain's header folds it (tables and their
// lines hidden, the header counts them), nothing else moves; Expand all
// restores it.
{
  if (await evaluate(`document.querySelector('g.view[data-view="all"]') !== null`)) await viewTab('all');
  else {
    await click(`document.querySelector('.oe-crumbs .oe-link')`);
    await click(`document.querySelector('.domain[data-domain=${JSON.stringify(domain)}]')`);
  }
  const fold = await evaluate(`(() => { const d = ${data}; const v = ${visible};
    const withLines = [...v.querySelectorAll('.cluster')].map((c) => c.getAttribute('data-cluster')).find((k) => [...v.querySelectorAll('.relation-group')].some((g) => d.nodes[g.getAttribute('data-from')]?.cluster === k || d.nodes[g.getAttribute('data-to')]?.cluster === k));
    return withLines ?? null; })()`);
  const others = `[...${visible}.querySelectorAll('.nodes .table')].filter((g) => ${data}.nodes[g.getAttribute('data-id')].cluster !== ${JSON.stringify(fold)}).map((g) => g.getBoundingClientRect().x).join()`;
  await evaluate(`window.dispatchEvent(new Event('resize'))`);
  await bringIntoView(inView(`.cluster[data-cluster="${fold}"] .cluster-label`));
  const before = await evaluate(others);
  await click(inView(`.cluster[data-cluster="${fold}"] .cluster-label`));
  await shot(
    'domain-collapsed',
    `(() => { const c = ${inView(`.cluster[data-cluster="${fold}"]`)}; const tables = [...${visible}.querySelectorAll('.nodes .table')].filter((g) => ${data}.nodes[g.getAttribute('data-id')].cluster === ${JSON.stringify(fold)});
      return c.querySelector('.cluster-label').textContent.endsWith('(collapsed)') && tables.every((g) => getComputedStyle(g).display === 'none') && /\\d+ links? hidden/.test(c.querySelector('.fold-badge')?.textContent ?? '') && ${others} === ${JSON.stringify(before)}
        && /V/.test(c.querySelector('.fold-toggle .fold-sign').getAttribute('d')) && c.querySelector('.fold-hit title').textContent === 'Expand group' && getComputedStyle(c.querySelector('.fold-hit')).cursor === 'pointer'; })()`,
  );
  await choose('more', 'Expand all');
  await shot('domains-expanded', `${visible}.querySelectorAll('.oe-hidden').length === 0 && ${visible}.querySelector('.fold-badge') === null && [...${visible}.querySelectorAll('.fold-sign')].every((p) => !/V/.test(p.getAttribute('d')))`);
  await choose('more', 'Collapse all');
  await shot('domains-all-collapsed', `${visible}.querySelectorAll('.nodes .table:not(.oe-hidden)').length === ${visible}.querySelectorAll('.nodes .table').length - ${visible}.querySelectorAll('.nodes .table.oe-hidden').length && ${visible}.querySelectorAll('.cluster.folded').length === ${visible}.querySelectorAll('.cluster').length`);
  await choose('more', 'Expand all');
}

// A table whose only links are hub badges still counts them in its panel.
const badgeOnly = await evaluate(`(() => { const d = ${data}; const drawn = new Set(d.links.flatMap((l) => [l.from, l.to]));
  return d.hubLinks.map((l) => l.from).find((id) => !drawn.has(id)) ?? null; })()`);
if (badgeOnly) {
  await click(`document.querySelector('.oe-crumbs .oe-link')`);
  await click(`document.querySelector('.domain[data-domain=${JSON.stringify(badgeOnly.split('.')[0])}]') ?? document.querySelector('.domain')`);
  await searchFor(badgeOnly.split('.')[2]);
  await tab('relations');
  await shot(
    'badge-only-table',
    `(() => { const titles = [...document.querySelectorAll('.oe-panel .oe-chip-group .sub')].map((x) => x.textContent);
      return titles.some((t) => /^Shared references \\(\\d+\\)$/.test(t)) && !titles.some((t) => /^(References|Referenced by) /.test(t)) || titles; })()`,
  );
  await key('Escape');
}

// A polymorphic node, double-clicked: a neighborhood centred on it with its
// owning table and every target, each line with its markers.
const polyHome = await evaluate(`(() => { for (const v of document.querySelectorAll('g.view')) { const n = v.getAttribute('data-view'); if (n.startsWith('domain:') && v.querySelector('.poly')) return n.slice(7); } return null; })()`);
if (polyHome) {
  await click(`document.querySelector('.oe-crumbs .oe-link')`);
  await click(`document.querySelector('.domain[data-domain=${JSON.stringify(polyHome)}]')`);
  const poly = await evaluate(`${inView('.poly')}.getAttribute('data-id')`);
  await bringIntoView(inView(`.poly[data-id="${poly}"]`));
  await click(inView(`.poly[data-id="${poly}"]`), { where: 'top', count: 2 });
  await shot(
    'polymorphic-neighborhood',
    `(() => { const p = ${data}.nodes[${JSON.stringify(poly)}]; const shown = new Set([...${visible}.querySelectorAll('.table, .poly')].map((g) => g.getAttribute('data-id')));
      const lines = [...${visible}.querySelectorAll('.relation-group')].filter((g) => g.getAttribute('data-from') === ${JSON.stringify(poly)} || g.getAttribute('data-to') === ${JSON.stringify(poly)});
      return ${viewIs('neighborhood')} && [p.table, ...p.targets].every((t) => shown.has(t)) && lines.length === p.targets.length + 1 && lines.every((g) => g.querySelector('.marker path'))
        && document.querySelector('.oe-crumbs .here').textContent.includes('«') || { shown: [...shown], lines: lines.length }; })()`,
  );
  await key('Escape');
  await click(backButton);
}

// Join path: two tables two hops apart, picked from the panel's fields; the
// path is lit hop after hop, the panel lists one condition per hop, and the
// copy button copies them. Then the table panel's own button and a click on
// the diagram fill the fields.
const joinPair = await evaluate(`(() => { const d = ${data}; const plain = d.links.filter((l) => l.kind !== 'view_source' && l.kind !== 'polymorphic' && !l.via && l.from !== l.to);
  for (const a of plain) for (const b of plain) { const mid = [a.from, a.to].find((x) => x === b.from || x === b.to); if (!mid || a === b) continue;
    const ends = [a.from === mid ? a.to : a.from, b.from === mid ? b.to : b.from]; if (ends[0] !== ends[1] && d.nodes[ends[0]].kind === 'table' && d.nodes[ends[1]].kind === 'table') return ends; }
  return null; })()`);
if (joinPair) {
  // Cmd+J (Ctrl+J): the join spotlight, From then To.
  await key('Escape');
  await modKey('j');
  const joinSpot = `document.querySelector('.oe-join-spot')`;
  await shot('join-spotlight', `${joinSpot}.closest('foreignObject').style.display !== 'none' && document.activeElement === ${joinSpot}.querySelector('.oe-join-from input') && ${joinSpot}.getBoundingClientRect().width >= Math.min(900, innerWidth * 0.9) - 1`);
  const pickJoin = async (slot, id) => {
    await send('Input.insertText', { text: id.split('.')[2] });
    await pause(150);
    // The highlighted hit is the table when it comes first; else move to it.
    const index = await evaluate(`[...document.querySelectorAll('.oe-join-spot .oe-result')].findIndex((b) => b.title === ${JSON.stringify(id)})`);
    for (let i = 0; i < index; i++) await key('ArrowDown');
    await key(slot === 'from' ? 'Tab' : 'Enter');
  };
  await pickJoin('from', joinPair[0]);
  await shot('join-spotlight-to', `document.activeElement === ${joinSpot}.querySelector('.oe-join-to input') && ${joinSpot}.querySelector('.oe-join-from input').value === ${JSON.stringify(joinPair[0].split('.')[2])}
    && [...document.querySelectorAll('.oe-join-spot .oe-result .name')].every((n) => n.scrollWidth <= n.clientWidth + 1 || getComputedStyle(n).textOverflow === 'ellipsis') && [...document.querySelectorAll('.oe-join-spot .oe-result')].every((r) => r.getBoundingClientRect().height < 30)`);
  await pickJoin('to', joinPair[1]);
  const flowsAt = (ms) => evaluate(`new Promise((done) => setTimeout(() => done(${visible}.querySelectorAll('.flow').length), ${ms}))`);
  const early = await flowsAt(0);
  const late = await flowsAt(1500);
  await shot(
    'join-path',
    `(() => { const hops = document.querySelectorAll('.oe-panel .oe-hops li'); const lit = ${visible}.querySelectorAll('.relation-group.hl, .hub-route.hl').length;
      const words = [...document.querySelectorAll('.oe-panel .oe-hops .chip')].some((c) => /pending review|^stale$/.test(c.textContent));
      const icons = [...document.querySelectorAll('.oe-panel .oe-hops .oe-review')].every((i) => ['Not confirmed yet', 'Code changed since confirmed'].includes(i.title));
      return hops.length >= 2 && !words && icons && [...hops].every((li) => / = /.test(li.querySelector('code').textContent)) && lit >= 1 && ${early} < ${late} && ${visible}.querySelectorAll(':is(.table, .stub).selected').length === 2
        || { hops: hops.length, lit, early: ${early}, late: ${late} }; })()`,
  );
  // One copy button: the SQL, for a path within one database; disabled with
  // its reason for a path across databases. No "Copy conditions".
  const sqlButton = `[...document.querySelectorAll('.oe-panel .oe-btn')].find((b) => b.textContent === 'Copy SQL')`;
  await shot('join-path-buttons', `${sqlButton} !== undefined && ![...document.querySelectorAll('.oe-panel .oe-btn')].some((b) => /conditions|skeleton/i.test(b.textContent))`);
  if (await evaluate(`!${sqlButton}.disabled`)) {
    await evaluate(stubClipboard);
    await click(sqlButton);
    await pause(3000);
    await shot('join-path-sql-copied', `document.querySelector('.oe-panel .row .muted').textContent === 'Copied SQL' && window.__copied.startsWith('-- Generated from the ERD: review before running')`);
  } else {
    await shot('join-path-sql-disabled', `/^No SQL: The path spans \\d+ databases/.test([...document.querySelectorAll('.oe-panel p.muted')].map((p) => p.textContent).join())`);
  }
  await key('Escape');
  await click(`document.querySelector('.oe-crumbs .oe-link')`);
  await searchFor(joinPair[0].split('.')[2]);
  await click(`document.querySelector('.oe-panel .oe-join-from')`);
  await shot('join-path-from-table', `document.querySelector('.oe-panel .oe-join-end b')?.getAttribute('title') === ${JSON.stringify(joinPair[0])} && document.querySelector('.oe-join-field input') !== null`);
  const other = await evaluate(`[...${visible}.querySelectorAll('.table')].map((g) => g.getAttribute('data-id')).find((id) => id !== ${JSON.stringify(joinPair[0])}) ?? null`);
  if (other) {
    await click(inView(`.table[data-id="${other}"]`), { where: 'top' });
    await shot('join-path-pick-on-diagram', `[...document.querySelectorAll('.oe-panel .oe-join-end b')].map((b) => b.getAttribute('title')).join() === ${JSON.stringify(`${joinPair[0]},${other}`)}`);
  }
  await key('Escape');
}

// Shortcuts: Cmd+A (Ctrl+A) opens all tables; the ⋯ menu lists every key.
await key('Escape');
if (await evaluate(`document.querySelector('g.view[data-view="all"]') !== null`)) {
  await click(`document.querySelector('.oe-crumbs .oe-link')`);
  await modKey('a');
  await shot('cmd-a-all-tables', `${viewIs('all')} && document.querySelector('.oe-view-tabs [data-view="all"]').classList.contains('on')`);
}
// The "?" in the legend's corner opens the same list: bottom-aligned with
// the legend card (or its pill) and clear of it.
await click(`document.querySelector('.oe-help')`);
await shot(
  'help-button-shortcuts',
  `(() => { const b = document.querySelector('.oe-help').getBoundingClientRect(); const l = document.querySelector('.oe-legend, .oe-legend-pill')?.getBoundingClientRect();
    return document.querySelector('.oe-panel .oe-keys') !== null && Math.abs(b.bottom - (innerHeight - 12)) < 3 && (!l || (b.left >= l.right + 4 && Math.abs(b.bottom - l.bottom) < 3)); })()`,
);
await key('Escape');
await key('?', 'Slash');
// P is listed only when some column is marked as personal data, H only
// when the render has schema health findings, S only when a table is starred.
await shot('keyboard-shortcuts', `document.querySelectorAll('.oe-panel .oe-keys-group').length === 3 && document.querySelectorAll('.oe-panel .oe-keys tr').length === ${10 + (piiTotal > 0) + (healthTotal > 0) + (await evaluate(`Object.values(${data}.nodes).some((x) => x.central)`)) + (await evaluate(`document.querySelector('.oe-changes-chip') !== null`))} && /J/.test(document.querySelector('.oe-panel .oe-keys').textContent) && /K$/.test(document.querySelector('.oe-panel .oe-keys kbd').textContent) && document.querySelector('.oe-panel .oe-keys').textContent.includes('←')`);
// A short panel leaves the minimap in its corner; a tall one pushes it left.
{
  const mm = `(() => { const f = document.querySelector('.oe-minimap')?.closest('foreignObject'); return f && f.style.display !== 'none' ? document.querySelector('.oe-minimap').getBoundingClientRect() : null; })()`;
  const short = await evaluate(`(() => { const m = ${mm}; const p = document.querySelector('.oe-panel').getBoundingClientRect(); return m ? { right: m.right, panelBottom: p.bottom, top: m.top } : null; })()`);
  if (short && short.panelBottom + 8 <= short.top) await shot('minimap-short-panel', `Math.abs(${mm}.right - (innerWidth - 12)) < 4`);
  const tall = await evaluate(`(() => { const d = ${data}; return Object.entries(d.nodes).filter(([, n]) => n.kind === 'table').sort(([, a], [, b]) => b.columns.length - a.columns.length)[0][0]; })()`);
  await key('Escape');
  await searchFor(tall.split('.')[2]);
  await pause(200);
  if (await evaluate(`(() => { const m = ${mm}; return m !== null && document.querySelector('.oe-panel').getBoundingClientRect().bottom + 8 > m.top; })()`)) await shot('minimap-tall-panel', `(() => { const m = ${mm}; const p = document.querySelector('.oe-panel').getBoundingClientRect(); return p.bottom + 8 > m.top && Math.abs(m.right - (innerWidth - 12 - 464)) < 4 || { m: m.right, pb: p.bottom, mt: m.top }; })()`);
}
await key('Escape');

// The minimap stays bottom right, left of an open panel: after a relation
// chip opens another table, and at once when the panel closes.
{
  const chipTable = await evaluate(`(() => { const d = ${data}; const l = d.links.find((x) => x.kind !== 'view_source' && x.from !== x.to && d.nodes[x.from]?.kind === 'table' && d.nodes[x.to]?.kind === 'table'); return l ? l.from : null; })()`);
  if (chipTable) {
    await searchFor(chipTable.split('.')[2]);
    await tab('relations');
    await click(`document.querySelector('.oe-panel .oe-chip')`);
    await pause(200);
    const mapRight = `(() => { const f = document.querySelector('.oe-minimap')?.closest('foreignObject'); if (!f || f.style.display === 'none') return null; return document.querySelector('.oe-minimap').getBoundingClientRect().right; })()`;
    // Left of the panel only when the panel comes down to the minimap.
    const expectedRight = `(() => { const f = document.querySelector('.oe-panel').closest('foreignObject'); const m = document.querySelector('.oe-minimap').closest('foreignObject');
      const reaches = f.style.display !== 'none' && f.getBoundingClientRect().bottom + 8 > m.getBoundingClientRect().top; return innerWidth - 12 - (reaches ? 464 : 0); })()`;
    await shot('minimap-after-chip', `(() => { const r = ${mapRight}; return r === null || Math.abs(r - ${expectedRight}) < 4 || { r, want: ${expectedRight} }; })()`);
    await key('Escape');
    await shot('minimap-after-panel-close', `(() => { const r = ${mapRight}; return r === null || Math.abs(r - (innerWidth - 12)) < 4 || { r }; })()`);
  }
}

// Table to table: chips A → B → C leave a trail in the panel; Back returns
// to B then to A (selected, panel open), Forward to B again; the table
// reached pulses.
{
  const chain = await evaluate(`(() => { const d = ${data}; const ok = (l) => l.kind !== 'view_source' && l.from !== l.to && d.nodes[l.from]?.kind === 'table' && d.nodes[l.to]?.kind === 'table';
    for (const a of d.links.filter(ok)) for (const b of d.links.filter(ok)) if (b.from === a.to && b.to !== a.from) return [a.from, a.to, b.to]; return null; })()`);
  if (chain) {
    const [ta, tb, tc] = chain;
    const chipTo = async (id) => {
      await tab('relations');
      await click(`[...document.querySelectorAll('.oe-panel .oe-chip')].find((c) => c.title === ${JSON.stringify(id)} || c.title.startsWith(${JSON.stringify(id + ' ·')}))`);
      await pause(200);
    };
    await key('Escape');
    await searchFor(ta.split('.')[2]);
    await chipTo(tb);
    await shot('table-arrives-pulsing', `${inView(`.table.selected.arrive[data-id="${tb}"]`)} !== null`);
    await chipTo(tc);
    const selected = (id) => `${inView(`.table.selected[data-id="${id}"]`)} !== null && document.querySelector('.oe-panel .oe-ph-name')?.textContent === ${JSON.stringify(id.split('.')[2])}`;
    await shot('table-trail', `${selected(tc)} && [...document.querySelectorAll('.oe-panel .oe-trail .items > *')].map((e) => e.textContent).filter((t) => t !== '›').slice(-3).join() === ${JSON.stringify([ta, tb, tc].map((t) => t.split('.')[2]).join())}
      && document.querySelector('.oe-back-pill')?.textContent === ${JSON.stringify(`← ${tb.split('.')[2]}`)}`);
    await key('Backspace');
    await shot('table-back-once', selected(tb));
    await click(`document.querySelector('.oe-panel .oe-trail-btn')`);
    await shot('table-back-twice', `${selected(ta)} && document.querySelector('.oe-panel .oe-tab.on')?.getAttribute('data-tab') === 'relations'`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await pause(200);
    await shot('table-forward', selected(tb));
    await key('Escape');
  }
}

// The Back pill sits just above the top left corner of the drawing's sheet:
// from a domain view to another domain through a stub.
await click(`document.querySelector('.oe-crumbs .oe-link')`);
await click(`document.querySelector('.domain[data-domain=${JSON.stringify(domain)}] .card-box')`, { where: 'top' });
await bringIntoView(inView('.stub:not(.group-stub)'));
await click(inView('.stub:not(.group-stub)'));
await key('Escape');
await evaluate(`window.dispatchEvent(new Event('resize'))`);
await pause(100);
await shot('back-pill-on-sheet', `(() => { const p = document.querySelector('.oe-back-pill').getBoundingClientRect(); const s = ${visible}.querySelector(':scope > rect').getBoundingClientRect();
  const corner = s.left >= 0 && s.top >= 44; return !corner || (Math.abs(p.left - Math.max(12, s.left)) < 3 && p.bottom <= s.top + 1 && s.top - p.bottom < 12) || { p: [p.left, p.bottom], s: [s.left, s.top] }; })()`);
await mouse('mouseMoved', { x: 700, y: 500 });
await wheel(0, { deltaX: -120 });
await pause(100);
await shot('back-pill-follows-sheet', `(() => { const p = document.querySelector('.oe-back-pill').getBoundingClientRect(); const s = ${visible}.querySelector(':scope > rect').getBoundingClientRect();
  return s.left < 0 || s.top < 44 || Math.abs(p.left - Math.max(12, s.left)) < 3 || { p: p.left, s: s.left }; })()`);
await click(`document.querySelector('.oe-crumbs .oe-link')`);

// Camera as { x, y, s } from the transform the viewer writes.
const camera = () =>
  evaluate(`(() => { const m = /translate\\(([-\\d.e]+) ([-\\d.e]+)\\) scale\\(([-\\d.e]+)\\)/.exec(document.querySelector('.camera').getAttribute('transform'));
    return { x: Number(m[1]), y: Number(m[2]), s: Number(m[3]) }; })()`);
// CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8.
const CTRL = 2;
async function wheel(deltaY, { modifiers = 0, deltaX = 0 } = {}) {
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 500, deltaX, deltaY, modifiers });
}

// A click followed by a press-and-drag on a label (a double press, which
// selects a word in a plain document) pans and leaves nothing selected.
// A label on the drawing, not under an overlay (toolbar, Back pill, legend),
// with the whole view fitted on screen again.
await key('Escape');
await evaluate(`window.dispatchEvent(new Event('resize'))`);
await pause(100);
const label = await centre(`[...${visible}.querySelectorAll('text')].find((t) => { if (t.closest('.table, .poly, .stub, .domain, .relation-group')) return false;
  const r = t.getBoundingClientRect(); const hit = r.width > 0 && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return hit && !hit.closest('foreignObject') && hit.closest('g.view') !== null && r.y > 44; })`);
const press2 = (type, p, clickCount) => send('Input.dispatchMouseEvent', { type, ...p, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount });
await mouse('mouseMoved', label);
await press2('mousePressed', label, 1);
await press2('mouseReleased', label, 1);
const beforeDrag = await camera();
await press2('mousePressed', label, 2);
for (let i = 1; i <= 8; i++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: label.x + i * 15, y: label.y + i * 10, button: 'left', buttons: 1 });
await press2('mouseReleased', { x: label.x + 120, y: label.y + 80 }, 2);
await pause(100);
const afterDrag = await camera();
const panned = Math.abs(afterDrag.x - beforeDrag.x - 120) < 1 && Math.abs(afterDrag.y - beforeDrag.y - 80) < 1;
await shot('drag-pan-no-selection', `window.getSelection().toString() === '' && ${panned} || { selection: window.getSelection().toString().slice(0, 80), panned: ${panned} }`);

// A trackpad pinch: Chrome sends wheel events with ctrlKey and small deltas.
// Ten of them must at least nearly double the scale. Zoom out first so the
// scale cap cannot stop it.
for (let i = 0; i < 10 && (await camera()).s > 1; i++) await wheel(100, { modifiers: CTRL });
await pause(100);
const beforePinch = await camera();
for (let i = 0; i < 10; i++) await wheel(-5, { modifiers: CTRL });
await pause(100);
const afterPinch = await camera();
await shot('pinch-zoom', `${afterPinch.s / beforePinch.s} >= 1.8 || ${JSON.stringify({ before: beforePinch.s, after: afterPinch.s })}`);

// Two-finger scroll without ctrl pans and keeps the scale.
await wheel(120, { deltaX: 40 });
await pause(100);
const afterScroll = await camera();
await shot(
  'scroll-pans',
  `${afterScroll.s === afterPinch.s && Math.abs(afterScroll.x - (afterPinch.x - 40)) < 0.01 && Math.abs(afterScroll.y - (afterPinch.y - 120)) < 0.01} || ${JSON.stringify({ afterPinch, afterScroll })}`,
);

// Personal data map: ⋯ › Personal data (and P) tints the pii columns of the
// tables on screen and fades the rest, with a chip and a summary panel whose
// counts add up to every pii column; a click in the list goes to the column
// and keeps the list open; the map stays on in other views, Esc clears that
// selection and closes the panel, a download keeps it, P, Esc with its list
// open or the chip's × turns it off. Without
// personal data (a public profile) there is no entry, chip or key.
{
  const piiHost = `document.querySelector('.oe-pii-chip').closest('foreignObject')`;
  const piiOn = `document.documentElement.classList.contains('pii-mode')`;
  await key('Escape');
  if (await evaluate(`document.querySelector('g.view[data-view="all"]') !== null`)) await viewTab('all');
  if (await evaluate(`getComputedStyle(${menuButton('highlight')}.parentNode).display !== 'none'`)) await click(menuButton('highlight'));
  if (piiTotal === 0) {
    await shot('pii-hidden', `${menuItem('highlight', 'Personal data')} === undefined && ${piiHost}.style.display === 'none'`);
    await closeMenu('highlight');
    await key('p', 'KeyP');
    await shot('pii-key-does-nothing', `!${piiOn} && ${piiHost}.style.display === 'none'`);
  } else {
    await shot('pii-menu', `${menuItem('highlight', 'Personal data')}.textContent.startsWith('Personal data (PII)${piiTotal} column') && ${menuItem('highlight', 'Personal data')}.querySelector('kbd').textContent === 'P'`);
    await click(menuItem('highlight', 'Personal data'));
    await closeMenu('highlight');
    // Every pii row of a full table on screen is tinted; a table without any fades.
    const tinted = `(() => { const d = ${data}; const v = ${visible};
      const want = [...v.querySelectorAll('.table')].reduce((n, g) => n + (d.nodes[g.getAttribute('data-id')]?.columns ?? []).filter((c) => c.pii && g.querySelector('.column[data-column="' + CSS.escape(c.name) + '"]')).length, 0);
      const got = [...v.querySelectorAll('.column.pii')].filter((c) => getComputedStyle(c.querySelector('.row-hit')).fill === 'rgb(255, 217, 204)').length;
      const faded = v.querySelector('.table:not(.has-pii)');
      return (got === want && (!faded || getComputedStyle(faded).opacity === '0.2')) || { got, want, faded: faded && getComputedStyle(faded).opacity }; })()`;
    const listed = `[...document.querySelectorAll('.oe-panel .oe-pii-domain > summary .n')].reduce((n, e) => n + Number(e.textContent), 0)`;
    await shot('pii-on-menu', `${piiOn} && ${piiHost}.style.display !== 'none' && document.querySelector('.oe-pii-chip').textContent.startsWith('PII: ${piiTotal} column') && ${tinted} === true
      && document.querySelector('.oe-panel .oe-ph-name')?.textContent === 'Personal data (PII)' && ${listed} === ${piiTotal}`);
    const target = await evaluate(`(() => { const t = document.querySelector('.oe-panel .oe-pii-table'); return [t.querySelector('.oe-pii-tname').title.slice('Go to '.length), t.querySelector('.oe-pii-col').textContent]; })()`);
    await click(`document.querySelector('.oe-panel .oe-pii-table .oe-pii-col')`);
    await pause(200);
    await shot('pii-list-jumps', `${inView(`.table.selected[data-id="${target[0]}"] .column.hl-column[data-column="${target[1]}"]`)} !== null && document.querySelector('.oe-panel .oe-ph-name')?.textContent === 'Personal data (PII)' && ${piiOn}`);
    await key('Escape');
    await viewTab('overview');
    const domains = await evaluate(`document.querySelectorAll('.oe-panel .oe-pii-domain').length || new Set(Object.values(${data}.nodes).filter((n) => (n.columns ?? []).some((c) => c.pii)).map((n) => n.cluster)).size`);
    await shot('pii-overview', `${piiOn} && document.querySelector('.oe-panel').closest('foreignObject').style.display === 'none' && ${inView('.domain.has-pii')} !== null
      && ${visible}.querySelectorAll('.domain.has-pii').length === ${domains} && [...${visible}.querySelectorAll('.domain:not(.has-pii)')].every((g) => getComputedStyle(g).opacity === '0.2')`);
    const piiDomain = await evaluate(`${inView('.domain.has-pii')}.getAttribute('data-domain')`);
    await click(`document.querySelector('.domain[data-domain=${JSON.stringify(piiDomain)}] .card-box')`, { where: 'top' });
    await shot('pii-domain-view', `${viewIs(`domain:${piiDomain}`)} && ${piiOn} && ${tinted} === true`);
    // A download of the view keeps the map.
    const downloads = join(resolve(outDir), 'downloads', 'pii');
    await mkdir(downloads, { recursive: true });
    await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    await choose('more', 'As SVG');
    let file = null;
    for (let i = 0; i < 100 && !file; i++) {
      file = (await readdir(downloads)).find((f) => f.endsWith('.svg'));
      await pause(100);
    }
    await pause(200);
    const saved = file ? (await readFile(join(downloads, file))).toString() : '';
    // The root may hold other modes too (diff-mode in a diff drawing).
    if (!/<svg [^>]*class="[^"]*\bpii-mode\b/.test(saved) || !/class="column pii"/.test(saved) || /foreignObject/.test(saved)) failures.push(`download with the personal data map: ${file}`);
    await closeMenu('more');
    await key('p', 'KeyP');
    const plainTable = `${inView('.table:not(.has-pii)')}`;
    await shot('pii-off-key', `!${piiOn} && ${piiHost}.style.display === 'none' && (${plainTable} === null || getComputedStyle(${plainTable}).opacity === '1') && getComputedStyle(${inView('.column.pii .row-hit')}).fill !== 'rgb(255, 217, 204)'`);
    await key('p', 'KeyP');
    // A view seen whole is fitted again left of the summary panel.
    const clearOfPanel = `(() => { const s = ${visible}.querySelector(':scope > rect').getBoundingClientRect(); const p = document.querySelector('.oe-panel').getBoundingClientRect();
      return s.right <= p.left + 1 || { sheet: s.right, panel: p.left }; })()`;
    await shot('pii-on-key', `${piiOn} && ${listed} === ${piiTotal} && ${tinted} === true && ${clearOfPanel} === true`);
    await key('Escape');
    await shot('pii-off-esc', `!${piiOn} && ${piiHost}.style.display === 'none' && document.querySelector('.oe-panel').closest('foreignObject').style.display === 'none'`);
    await key('p', 'KeyP');
    await click(`document.querySelector('.oe-pii-chip .oe-chip-close')`);
    await shot('pii-off-chip', `!${piiOn} && ${piiHost}.style.display === 'none' && document.querySelector('.oe-panel').closest('foreignObject').style.display === 'none'`);
  }
  // A toolbar button keeps the focus after a click, and Space would press it.
  await evaluate('document.activeElement?.blur()');
}

// Schema health: Highlight › Schema health (and H) marks every table with a finding
// with a triangle, shows a chip and the list of findings; the severity
// filter (shown with two severities or more) hides the others; a click on a column in the list goes there and
// keeps the list open; H or the chip's × turns it off. Without findings
// there is no entry, chip or key.
{
  const healthHost = `document.querySelector('.oe-health-chip').closest('foreignObject')`;
  const healthOn = `document.documentElement.classList.contains('health-mode')`;
  await key('Escape');
  if (await evaluate(`document.querySelector('g.view[data-view="all"]') !== null`)) await viewTab('all');
  if (await evaluate(`getComputedStyle(${menuButton('highlight')}.parentNode).display !== 'none'`)) await click(menuButton('highlight'));
  if (healthTotal === 0) {
    await shot('health-hidden', `${menuItem('highlight', 'Schema health')} === undefined && ${healthHost}.style.display === 'none'`);
    await closeMenu('highlight');
    await key('h', 'KeyH');
    await shot('health-key-does-nothing', `!${healthOn} && ${healthHost}.style.display === 'none'`);
  } else {
    await click(menuItem('highlight', 'Schema health'));
    await closeMenu('highlight');
    // Every table on screen with a finding shows its triangle, and only those.
    const marked = `(() => { const d = ${data}; const v = ${visible}; const tables = new Set(d.health.map((f) => f.table));
      const want = [...v.querySelectorAll('.table')].filter((g) => tables.has(g.getAttribute('data-id'))).length;
      const got = [...v.querySelectorAll('.health-mark')].filter((m) => getComputedStyle(m).display !== 'none').length;
      return (got === want && [...v.querySelectorAll('.table:not(.has-health) .health-mark')].length === 0) || { want, got }; })()`;
    const items = `[...document.querySelectorAll('.oe-panel .oe-health-item')]`;
    const shown = `${items}.filter((e) => e.style.display !== 'none')`;
    await shot('health-on-menu', `${healthOn} && ${healthHost}.style.display !== 'none' && document.querySelector('.oe-health-chip').textContent.startsWith('Health: ${healthTotal} finding') && ${marked} === true
      && document.querySelector('.oe-panel .oe-ph-name')?.textContent === 'Schema health' && ${items}.length === ${healthTotal}`);
    const severities = await evaluate(`[...document.querySelectorAll('.oe-panel .oe-health-filter')].map((b) => b.getAttribute('data-severity')).filter((s) => s !== 'all')`);
    for (const severity of severities) {
      await click(`document.querySelector('.oe-panel .oe-health-filter[data-severity="${severity}"]')`);
      const want = await evaluate(`${data}.health.filter((f) => f.severity === '${severity}').length`);
      await shot(`health-filter-${severity}`, `${shown}.length === ${want} && ${shown}.every((e) => e.getAttribute('data-severity') === '${severity}')`);
    }
    // One severity only: the list has no filter.
    if (severities.length > 0) await click(`document.querySelector('.oe-panel .oe-health-filter[data-severity="all"]')`);
    else await shot('health-no-filter', `document.querySelector('.oe-panel .oe-health-filters') === null`);
    const target = await evaluate(`(() => { const e = ${shown}.find((x) => x.querySelector('.oe-chip')); return e ? [e.querySelector('.oe-link').title.slice('Go to '.length), e.querySelector('.oe-chip').textContent] : null; })()`);
    if (target) {
      await click(`${shown}.find((x) => x.querySelector('.oe-chip')).querySelector('.oe-chip')`);
      await pause(200);
      await shot('health-list-jumps', `${inView(`.table.selected[data-id="${target[0]}"] .column.hl-column[data-column="${target[1]}"]`)} !== null && ${inView(`.table.selected[data-id="${target[0]}"] .health-mark`)} !== null
        && document.querySelector('.oe-panel .oe-ph-name')?.textContent === 'Schema health' && ${healthOn}`);
    }
    await key('Escape');
    await key('h', 'KeyH');
    await shot('health-off-key', `!${healthOn} && ${healthHost}.style.display === 'none' && [...document.querySelectorAll('.health-mark')].every((m) => getComputedStyle(m).display === 'none')`);
    await key('h', 'KeyH');
    await shot('health-on-key', `${healthOn} && ${items}.length === ${healthTotal} && document.querySelector('.oe-panel').closest('foreignObject').style.display !== 'none'`);
    await click(`document.querySelector('.oe-health-chip .oe-chip-close')`);
    await shot('health-off-chip', `!${healthOn} && ${healthHost}.style.display === 'none' && document.querySelector('.oe-panel').closest('foreignObject').style.display === 'none'`);
  }
  await evaluate('document.activeElement?.blur()');
}

// Central tables: Highlight › Central tables (and S) gives every starred
// table a gold border and fades the other tables, with a chip and the list
// of each domain's central tables; a click in the list selects the table
// and keeps the list; S or the chip's × turns it off.
{
  const centralTotal = await evaluate(`Object.values(${data}.nodes).filter((x) => x.central).length`);
  const centralHost = `document.querySelector('.oe-central-chip').closest('foreignObject')`;
  const centralOn = `document.documentElement.classList.contains('central-mode')`;
  await key('Escape');
  if (await evaluate(`document.querySelector('g.view[data-view="all"]') !== null`)) await viewTab('all');
  if (centralTotal === 0) {
    await key('s', 'KeyS');
    await shot('central-key-does-nothing', `!${centralOn} && ${centralHost}.style.display === 'none'`);
  } else {
    await click(menuButton('highlight'));
    await click(menuItem('highlight', 'Central tables'));
    await closeMenu('highlight');
    const marked = `(() => { const v = ${visible}; const op = (g) => Number(getComputedStyle(g).opacity);
      const central = [...v.querySelectorAll('.table.central')]; const other = [...v.querySelectorAll('.table:not(.central)')];
      return (central.every((g) => op(g) === 1 && getComputedStyle(g.querySelector(':scope > rect:last-of-type')).strokeWidth === '3px') && other.every((g) => op(g) < 0.5)) || { central: central.length, other: other.length }; })()`;
    const chips = `[...document.querySelectorAll('.oe-panel .oe-central-domain .oe-chip')]`;
    await shot('central-on-menu', `${centralOn} && ${centralHost}.style.display !== 'none' && ${marked} === true && document.querySelector('.oe-panel .oe-ph-name')?.textContent === 'Central tables' && ${chips}.length === ${centralTotal}`);
    const target = await evaluate(`${chips}[0].title.slice('Go to '.length)`);
    await click(`${chips}[0]`);
    await pause(200);
    await shot('central-list-jumps', `${inView(`.table.selected[data-id="${target}"]`)} !== null && document.querySelector('.oe-panel .oe-ph-name')?.textContent === 'Central tables' && ${centralOn}`);
    await key('Escape');
    await key('s', 'KeyS');
    await shot('central-off-key', `!${centralOn} && ${centralHost}.style.display === 'none'`);
    await key('s', 'KeyS');
    await shot('central-on-key', `${centralOn} && ${chips}.length === ${centralTotal}`);
    await click(`document.querySelector('.oe-central-chip .oe-chip-close')`);
    await shot('central-off-chip', `!${centralOn} && ${centralHost}.style.display === 'none' && document.querySelector('.oe-panel').closest('foreignObject').style.display === 'none'`);
  }
  await evaluate('document.activeElement?.blur()');
}

// Highlight from the keyboard: Enter on the button opens the menu with the
// focus on its first mode, Enter toggles it (the menu stays, checked, and
// the mode's chip shows), Esc closes it and gives the focus back.
if (await evaluate(`getComputedStyle(${menuButton('highlight')}.parentNode).display !== 'none'`)) {
  const enter = async () => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await pause(200);
  };
  const first = `document.querySelector('.oe-highlight-menu .oe-item')`;
  const chipShown = `[...document.querySelectorAll('.oe-review-chip')].some((c) => c.closest('foreignObject').style.display !== 'none')`;
  await key('Escape');
  await evaluate(`${menuButton('highlight')}.focus()`);
  await enter();
  await shot('highlight-keyboard-open', `${menuOpen('highlight')} && document.activeElement === ${first} && ${first}.getAttribute('aria-checked') === 'false'`);
  await enter();
  await shot('highlight-keyboard-toggle', `${menuOpen('highlight')} && ${first}.getAttribute('aria-checked') === 'true' && document.activeElement === ${first} && ${chipShown} && ${menuButton('highlight')}.classList.contains('active')`);
  await key('Escape');
  await shot('highlight-keyboard-close', `!${menuOpen('highlight')} && document.activeElement === ${menuButton('highlight')}`);
  await enter();
  await enter();
  await key('Escape');
  await shot('highlight-keyboard-off', `!${chipShown} && !${menuButton('highlight')}.classList.contains('active')`);
  await evaluate('document.activeElement?.blur()');
  await key('Escape');
}

// Tour: T walks the domains in the overview's order,
// each in its view with a caption (its note when it has one; name and table
// count always) at the bottom, clear of the toolbar and of its central
// table (unless that table is too tall to fit above it at a readable
// scale), legend and minimap set aside. It moves on by itself; ← → step and
// wrap round; Space pauses; a download holds none of it; Esc goes back to
// the view and camera it started from. One domain makes no tour.
{
  const order = await evaluate(`${data}.domainOrder`);
  if (order.length < 2) {
    await click(menuButton('more'));
    await shot('tour-hidden', `${menuItem('more', 'Tour')} === undefined`);
    await closeMenu('more');
  } else {
    const startedOn = await evaluate(`${visible}.getAttribute('data-view')`);
    const startCam = await camera();
    const caption = (i) => `(() => { const d = ${data}; const k = ${JSON.stringify(order)}[${i}]; const t = document.querySelector('.oe-tour');
      const want = d.domainNotes[k] ?? null; const note = t.querySelector('.oe-tour-note')?.textContent ?? null; const head = t.querySelector('.oe-tour-head b').textContent;
      const count = t.querySelector('.oe-tour-count').textContent;
      return ${visible}.getAttribute('data-view') === 'domain:' + k && note === want && head.startsWith(k.split('/').slice(1).join('/') + ' · ') && count === '${i + 1} / ${order.length}' || { view: ${visible}.getAttribute('data-view'), note, want, head, count }; })()`;
    const tourClear = `(() => { const d = ${data}; const card = document.querySelector('.oe-tour').getBoundingClientRect();
      const k = ${visible}.getAttribute('data-view').slice(7); const id = Object.keys(d.nodes).find((n) => d.nodes[n].cluster === k && d.nodes[n].central);
      const c = id && ${visible}.querySelector('.table[data-id="' + CSS.escape(id) + '"]').getBoundingClientRect();
      const hit = Boolean(c) && c.bottom > card.top && c.top < card.bottom && c.right > card.left && c.left < card.right;
      // Running under the caption is only allowed when the table is taller than the strip above it even at the
      // smallest readable scale (11/12): then it is at that scale with its top just under the toolbar.
      const s = Number(/scale\\(([-\\d.e]+)\\)/.exec(document.querySelector('.camera').getAttribute('transform'))[1]);
      const unavoidable = hit && Math.abs(s - 11 / 12) < 0.001 && c.height > card.top - 44 - 16 && c.top >= 44 && c.top <= 44 + 10;
      const off = card.top < 44 || card.bottom > innerHeight || card.left < 0 || card.right > innerWidth;
      const aside = ['.oe-legend-host', '.oe-minimap-host', '.oe-back-host'].every((s) => document.querySelector(s).closest('foreignObject').style.display === 'none');
      return ((!hit || unavoidable) && !off && aside) || { hit, s, top: c && c.top, height: c && c.height, room: card.top - 44, off, aside }; })()`;
    // ⋯ lists the tour with its key; T starts it.
    await click(menuButton('more'));
    await shot('tour-menu-item', `${menuItem('more', 'Tour')}.textContent === 'TourT' && ${menuItem('more', 'Tour')}.getAttribute('aria-checked') === 'false'`);
    await closeMenu('more');
    await key('t', 'KeyT');
    // Each step fades its view in and pulses its domain's frame, also when the domain is seen whole.
    await shot('tour-start', `${caption(0)} === true && ${tourClear} && ${visible}.classList.contains('oe-enter') && ${visible}.querySelector('.cluster[data-cluster="' + CSS.escape(${JSON.stringify(order)}[0]) + '"]').classList.contains('arrive')
      && getComputedStyle(${visible}.querySelector('.cluster.arrive > rect')).stroke === 'rgb(232, 89, 12)'`);
    await pause(6400);
    await shot('tour-auto-next', caption(1));
    await key('ArrowLeft');
    await shot('tour-prev', `${caption(0)} === true && ${tourClear}`);
    await key('ArrowLeft');
    await shot('tour-wraps-to-last', caption(order.length - 1));
    await key(' ', 'Space');
    await pause(6400);
    await shot('tour-paused', `${caption(order.length - 1)} === true && document.querySelector('.oe-tour-controls button[title^="Resume"]') !== null`);
    await click(`document.querySelector('.oe-tour-controls button[title^="Next"]')`);
    await shot('tour-next-wraps-to-first', caption(0));
    // A narrow window: the caption fits and the view is fitted above it.
    await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 640, deviceScaleFactor: 1, mobile: false });
    await evaluate(`window.dispatchEvent(new Event('resize'))`);
    await pause(200);
    await shot('tour-narrow', tourClear);
    await send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
    await evaluate(`window.dispatchEvent(new Event('resize'))`);
    await pause(200);
    const downloads = join(resolve(outDir), 'downloads', 'tour');
    await mkdir(downloads, { recursive: true });
    await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    // A fresh step: its central table is still pulsing when the file is drawn.
    await key('ArrowRight');
    await choose('more', 'As SVG');
    let file = null;
    for (let i = 0; i < 100 && !file; i++) {
      file = (await readdir(downloads)).find((f) => f.endsWith('.svg'));
      await pause(100);
    }
    await pause(200);
    const plain = file ? (await readFile(join(downloads, file))).toString() : '';
    if (!file || /foreignObject|class="[^"]*\b(oe-tour|arrive)\b/.test(plain)) failures.push(`download during the tour: ${file} ${(/foreignObject|class="[^"]*\b(oe-tour|arrive)\b/.exec(plain) ?? [])[0]}`);
    await closeMenu('more');
    await key('Escape');
    const endCam = await camera();
    await shot(
      'tour-esc-restores',
      `${viewIs(startedOn)} && ${JSON.stringify(endCam)}.s === ${startCam.s} && ${Math.abs(endCam.x - startCam.x) < 0.01 && Math.abs(endCam.y - startCam.y) < 0.01} && document.querySelector('.oe-tour').closest('foreignObject').style.display === 'none'`,
    );
  }
}

await key('Escape');
// The palette: Cmd+K (Ctrl+K) or a click on the search trigger. Empty, it
// groups the views and databases to go to and the commands of this file,
// each with its shortcut; ⌘F keeps to tables and columns. Typing filters
// the commands too; "a > b" offers the join path; Esc gives the focus back.
{
  const rows = `[...document.querySelectorAll('.oe-spotlight-list .oe-result')]`;
  const row = (label) => `${rows}.find((r) => r.querySelector('.name').textContent.startsWith(${JSON.stringify(label)}))`;
  const groups = `[...document.querySelectorAll('.oe-spotlight-list .oe-spotlight-group')].map((g) => g.textContent)`;
  const typeInto = async (text) => {
    await evaluate(`(() => { const i = document.querySelector('.oe-spotlight-input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input')); })()`);
    await pause(150);
  };
  const ctrlK = await evaluate(`(() => { const e = new KeyboardEvent('keydown', { key: 'k', ${FIND_MODIFIER === 4 ? 'metaKey' : 'ctrlKey'}: true, bubbles: true, cancelable: true }); document.dispatchEvent(e); const r = e.defaultPrevented; document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return r; })()`);
  if (ctrlK !== true) failures.push('the palette shortcut does not prevent the browser default');
  const domains = await evaluate(`${data}.domainOrder.length`);
  const dbs = await evaluate(`Object.keys(${data}.databases).length`);
  // It opens on the last text, selected; emptied, it lists the commands.
  await click(`document.querySelector('.oe-search-trigger')`);
  await typeInto('');
  await shot(
    'palette-empty',
    `(() => { const g = ${groups}; const kbd = (l) => (${rows}.find((r) => r.querySelector('.name').textContent === l)?.querySelector('kbd')?.textContent ?? '');
      const want = ['Join path…', 'Download as SVG', 'Download as PNG', 'Download as JPEG'];
      return ${spotlightShown} && document.activeElement === document.querySelector('.oe-spotlight-input') && document.querySelector('.oe-spotlight-input').placeholder === 'Search tables and columns, or run a command'
        && g[0] === 'Go to' && g[1] === 'Actions' && ${rows}[0].classList.contains('active') && want.every((l) => ${rows}.some((r) => r.querySelector('.name').textContent === l))
        && /J$/.test(kbd('Join path…')) && (${row('Tour')} !== undefined) === ${domains >= 2} && (${row('Personal data')} !== undefined) === ${piiTotal > 0} && (${row('Schema health')} !== undefined) === ${healthTotal > 0}
        && ${rows}.filter((r) => r.querySelector('.name').textContent.endsWith(' database')).length === ${dbs > 1 ? dbs : 0} || { g, rows: ${rows}.map((r) => r.textContent) }; })()`,
  );
  await key('ArrowDown');
  await shot('palette-arrow', `${rows}[1].classList.contains('active') && !${rows}[0].classList.contains('active')`);
  // Hover moves the highlight; a click runs the row.
  await evaluate(`${row('Map')}.scrollIntoView({ block: 'nearest' })`);
  await mouse('mouseMoved', await centre(row('Map')));
  await pause(100);
  await shot('palette-hover', `${row('Map')}.classList.contains('active')`);
  await click(row('Map'));
  await shot('palette-click-runs', `!${spotlightShown} && ${viewIs('overview')}`);
  // Typed: a command by a word of its label (and the table hits first when a name starts with it).
  await modKey('k');
  await typeInto('rankin');
  await shot('palette-typed', `${row('Ranking')} !== undefined && ${groups}.includes('Go to')`);
  await key('Enter');
  await shot('palette-enter-runs', `${viewIs('ranking')} && !${spotlightShown}`);
  // "a > b": the join path between the two tables, run with Enter.
  const pair = await evaluate(`(() => { const d = ${data}; const names = Object.keys(d.nodes).filter((id) => d.nodes[id].kind === 'table').map((id) => id.split('.')[2]);
    const unique = (id) => names.filter((n) => n === id.split('.')[2]).length === 1;
    const l = d.links.find((x) => x.kind !== 'view_source' && x.kind !== 'polymorphic' && !x.via && x.from !== x.to && d.nodes[x.from]?.kind === 'table' && d.nodes[x.to]?.kind === 'table' && unique(x.from) && unique(x.to));
    return l ? [l.from, l.to] : null; })()`);
  if (pair) {
    const [a, b] = pair.map((id) => id.split('.')[2]);
    await modKey('k');
    await typeInto(`${a} > ${b}`);
    await shot('palette-join', `${groups}[0] === 'Join path' && ${rows}[0].querySelector('.name').textContent === ${JSON.stringify(`Join path ${a} → ${b}`)} && ${row('Join path…')} !== undefined`);
    await key('Enter');
    await shot('palette-join-runs', `!${spotlightShown} && (() => { const t = document.querySelector('.oe-panel')?.textContent ?? ''; return t.startsWith('Join path') && t.includes(${JSON.stringify(a)}) && t.includes(${JSON.stringify(b)}); })()`);
    await key('Escape');
    // "Join path…" opens the join box with From taken.
    await modKey('k');
    await typeInto(`${a} → `);
    await click(row('Join path…'));
    await shot('palette-join-box', `document.querySelector('.oe-join-spot').closest('foreignObject').style.display !== 'none' && document.querySelector('.oe-join-from input').value === ${JSON.stringify(a)} && document.activeElement === document.querySelector('.oe-join-to input')`);
    await key('Escape');
  }
  // ⌘F: tables and columns only, no commands.
  await findKey();
  await typeInto('');
  await shot('palette-search-only', `${spotlightShown} && document.querySelector('.oe-spotlight-input').placeholder === 'Search tables and columns' && ${rows}.length === 0 && document.querySelector('.oe-spotlight-empty').textContent === 'Type a table or column name'`);
  await typeInto('download');
  await shot('palette-search-no-commands', `${row('Download as SVG')} === undefined`);
  await key('Escape');
  // Esc gives the focus back to the trigger it was opened from.
  await click(`document.querySelector('.oe-search-trigger')`);
  await key('Escape');
  await shot('palette-focus-back', `!${spotlightShown} && document.activeElement === document.querySelector('.oe-search-trigger')`);
  await evaluate('document.activeElement?.blur()');
}

// Deep links: erd.svg#table=<id> opens on that table, selected, with its
// panel; #column=<id>.<column> unfolds that column; selecting a table writes
// its link into the address without adding history entries.
{
  const linked = await evaluate(`(() => { const d = ${data}; const [id, n] = Object.entries(d.nodes).find(([, n]) => n.kind === 'table' && n.columns.length > 2); return [id, n.columns[2].name]; })()`);
  const base = pathToFileURL(resolve(input)).href;
  // The model the viewer embeds, to pick the tables the links name.
  const model = JSON.parse(/<script type="application\/json" id="open-erd-data">([^<]*)<\/script>/.exec(await readFile(input, 'utf8'))[1]);
  const open = async (hash) => {
    const blank = once('Page.loadEventFired');
    await send('Page.navigate', { url: 'about:blank' });
    await blank;
    const page = once('Page.loadEventFired');
    await send('Page.navigate', { url: `${base}${hash}` });
    await page;
    await pause(500);
  };
  await open(`#table=${encodeURIComponent(linked[0])}`);
  const home = await evaluate(`document.querySelector('g.view[data-view="all"]') ? 'all' : 'domain:' + ${data}.nodes[${JSON.stringify(linked[0])}].cluster`);
  await shot('deep-link-table', `${viewIs(home)} && ${inView(`.table.selected[data-id="${linked[0]}"]`)} !== null && document.querySelector('.oe-panel .oe-ph-name')?.textContent === ${JSON.stringify(linked[0].split('.')[2])}`);
  await open(`#column=${encodeURIComponent(`${linked[0]}.${linked[1]}`)}`);
  await shot('deep-link-column', `document.querySelector('.oe-panel .oe-col.open')?.getAttribute('data-column') === ${JSON.stringify(linked[1])} && decodeURIComponent(location.hash) === ${JSON.stringify(`#column=${linked[0]}.${linked[1]}`)}`);
  // #tables=: tables of different domains lit together, the rest dimmed,
  // fitted, no panel; an unknown id is left out; Esc clears it.
  const tables = Object.keys(model.nodes).filter((id) => model.nodes[id].kind === 'table');
  const spread = [...new Map(tables.map((id) => [model.nodes[id].cluster, id])).values()].slice(0, 3);
  await open(`#tables=${[...spread, 'no.such.table'].map(encodeURIComponent).join(',')}`);
  await shot(
    'deep-link-tables',
    `(() => { const lit = ${JSON.stringify(spread)}.map((id) => ${visible}.querySelector('.table[data-id="' + CSS.escape(id) + '"]'));
      const r = lit.map((g) => g?.getBoundingClientRect());
      const onScreen = r.every((b) => b && b.left >= 0 && b.right <= innerWidth && b.top >= 44 && b.bottom <= innerHeight);
      return lit.every((g) => g?.classList.contains('hl')) && ${visible}.classList.contains('dimmed') && ${visible}.querySelector('.table.selected') === null
        && document.querySelector('.oe-panel').closest('foreignObject').style.display === 'none' && onScreen || { lit: lit.map((g) => g?.getAttribute('class')), onScreen }; })()`,
  );
  await key('Escape');
  await shot('deep-link-tables-esc', `!${visible}.classList.contains('dimmed') && ${visible}.querySelector('.table.hl') === null`);
  // #path=: two tables give the join panel's paths; more give one path
  // through them in order.
  // A pair two hops or more apart, among the first tables (searching every
  // pair of a large schema takes long).
  const few = tables.slice(0, 30);
  const pair = few.flatMap((a) => few.map((b) => [a, b])).find(([a, b]) => findJoinPaths(model, a, b, 1)[0]?.hops.length >= 2);
  if (pair) {
    const [from, to] = pair;
    const [best] = findJoinPaths(model, from, to);
    await open(`#path=${encodeURIComponent(from)},${encodeURIComponent(to)}`);
    await shot('deep-link-path', `document.querySelectorAll('.oe-panel .oe-hops li').length === ${best.hops.length} && ${visible}.classList.contains('dimmed') && ${JSON.stringify(best.nodes)}.every((id) => ${visible}.querySelector('.table.hl[data-id="' + CSS.escape(id) + '"]') !== null)`);
    const through = [from, best.nodes[1], to];
    const { path } = pathThrough(model, through);
    await open(`#path=${through.map(encodeURIComponent).join(',')}`);
    await shot('deep-link-path-through', `document.querySelectorAll('.oe-panel .oe-paths .oe-btn').length === 1 && document.querySelectorAll('.oe-panel .oe-hops li').length === ${path.hops.length}`);
  }
  // Two tables no relations join are lit instead, with a note.
  const lone = tables.find((id) => id !== tables[0] && findJoinPaths(model, tables[0], id, 1).length === 0);
  if (lone) {
    await open(`#path=${encodeURIComponent(tables[0])},${encodeURIComponent(lone)}`);
    await shot(
      'deep-link-path-gap',
      `${JSON.stringify([tables[0], lone])}.every((id) => ${visible}.querySelector('.table.hl[data-id="' + CSS.escape(id) + '"]') !== null) && ${visible}.classList.contains('dimmed')
        && document.querySelector('.oe-panel').closest('foreignObject').style.display === 'none' && document.querySelector('.oe-toast')?.textContent.startsWith('No join path')`,
    );
  }
  // No known table: the usual start.
  await open('#tables=no.such.table');
  await shot('deep-link-tables-unknown', `${viewIs(startView)} && !${visible}.classList.contains('dimmed')`);
  const other = await evaluate(`[...${visible}.querySelectorAll('.table')].map((g) => g.getAttribute('data-id')).find((id) => id !== ${JSON.stringify(linked[0])})`);
  await bringIntoView(inView(`.table[data-id="${other}"]`));
  const before = await evaluate('history.length');
  await click(inView(`.table[data-id="${other}"]`), { where: 'top' });
  await shot('selection-updates-hash', `decodeURIComponent(location.hash) === ${JSON.stringify(`#table=${other}`)} && history.length === ${before}`);
}

// Without script the file must still show the static overview.
await send('Emulation.setScriptExecutionDisabled', { value: true });
const reloaded = once('Page.loadEventFired');
await send('Page.reload', { ignoreCache: true });
await reloaded;
await pause(300);
await send('Emulation.setScriptExecutionDisabled', { value: false });
await shot('no-script', `document.querySelector('.oe-toolbar') === null && ${viewIs(startView)} && document.querySelectorAll('g.view:not([style])').length === 1`);

await close();
if (errors.length > 0) console.error(`console errors:\n  ${errors.join('\n  ')}`);
if (failures.length > 0) console.error(`failed checks:\n  ${failures.join('\n  ')}`);
console.log(errors.length === 0 && failures.length === 0 ? 'viewer OK' : 'viewer FAILED');
process.exitCode = errors.length + failures.length > 0 ? 1 : 0;
