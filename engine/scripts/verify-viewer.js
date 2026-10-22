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
// start of its label (`views`, `more`, `download`).
const menuButton = (menu) => `document.querySelector('.oe-drop:has(.oe-${menu}-menu) > button')`;
const menuItem = (menu, label) => `[...document.querySelectorAll('.oe-${menu}-menu .oe-item')].find((b) => b.textContent.startsWith(${JSON.stringify(label)}))`;
const menuOpen = (menu) => `getComputedStyle(document.querySelector('.oe-${menu}-menu')).display !== 'none'`;
async function choose(menu, label) {
  if (!(await evaluate(menuOpen(menu)))) await click(menuButton(menu));
  await click(menuItem(menu, label));
}
const closeMenu = (menu) => evaluate(`${menuOpen(menu)} && ${menuButton(menu)}.click()`);
const backButton = `document.querySelector('.oe-left > button')`;
// Cmd+F on macOS (CDP modifier 4 = Meta), Ctrl+F elsewhere (2).
const FIND_MODIFIER = process.platform === 'darwin' ? 4 : 2;
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

// Overview lines, one per pair of domains: no arrowheads and no text label,
// a count badge instead, a tooltip, and a panel listing the relations by
// direction, every entry leading to the referencing table's domain view.
const data = `JSON.parse(document.getElementById('open-erd-data').textContent)`;
await key('Escape');
await click(`document.querySelector('.oe-crumbs .oe-link') ?? document.querySelector('.oe-crumbs .here')`);
const overviewLine = await evaluate(`(() => { const d = ${data}; const lines = [...document.querySelectorAll('g.view[data-view="overview"] .relation-group')];
  lines.sort((a, b) => d.domainLinks[b.getAttribute('data-id')].length - d.domainLinks[a.getAttribute('data-id')].length);
  // The busiest line whose middle is its own (another line may cross there).
  const own = lines.find((g) => { const e = g.querySelector('path.relation-hit') ?? g.querySelector('path.relation'); const m = e.getPointAtLength(e.getTotalLength() / 2).matrixTransform(e.getScreenCTM()); return g.contains(document.elementFromPoint(m.x, m.y)); });
  return own?.getAttribute('data-id') ?? null; })()`);
if (overviewLine) {
  const lineSel = inView(`.relation-group[data-id="${overviewLine}"] path.relation-hit`);
  await mouse('mouseMoved', await centre(lineSel));
  await pause(150);
  await shot(
    'overview-line-tooltip',
    `${viewIs('overview')} && [...document.querySelectorAll('.oe-tip')].some((t) => /⇄/.test(t.textContent) && /\\d+ relations?/.test(t.textContent)) && ${inView('.relation-group .marker')} === null && ${inView('.edge-label')} === null && ${visible}.querySelectorAll('.count-badge').length === ${visible}.querySelectorAll('.relation-group').length`,
  );
  await click(lineSel);
  await shot(
    'overview-line-panel',
    `(() => { const n = ${data}.domainLinks[${JSON.stringify(overviewLine)}].length; const groups = [...document.querySelectorAll('.oe-panel .sub')].filter((x) => /→ .+ \\(\\d+\\)$/.test(x.textContent)).length;
      return document.querySelector('.oe-panel h3')?.textContent.includes('⇄') && document.querySelectorAll('.oe-panel li').length === n && groups >= 1 || { n, li: document.querySelectorAll('.oe-panel li').length, groups }; })()`,
  );
  const target = await evaluate(`${data}.domainLinks[${JSON.stringify(overviewLine)}][0].from`);
  await click(`document.querySelector('.oe-panel li .oe-link')`);
  await shot('overview-line-entry-jump', `${visible}.getAttribute('data-view').startsWith('domain:') && ${inView(`.table.selected[data-id="${target}"]`)} !== null`);
  await key('Escape');
  await click(`document.querySelector('.oe-crumbs .oe-link')`);
}

// Weak overview links (fewer relations than overview.min_relations) start
// hidden; the toolbar button shows them all, hovering a domain shows its own
// and fades every other line and domain.
const weakSel = `g.view[data-view="overview"] .overview-link.weak`;
const weakDomain = await evaluate(`document.querySelector('${weakSel}')?.getAttribute('data-from') ?? null`);
if (weakDomain) {
  const weakShown = `[...document.querySelectorAll('${weakSel}')].filter((g) => getComputedStyle(g).display !== 'none').length`;
  await click(menuButton('more'));
  await shot('overview-weak-hidden', `${weakShown} === 0 && /^Show weak links \\(\\d+ hidden\\)$/.test(${menuItem('more', 'Show weak links')}.textContent) && !${menuItem('more', 'Show weak links')}.classList.contains('checked')`);
  await click(menuItem('more', 'Show weak links'));
  await shot('overview-weak-shown', `${weakShown} === document.querySelectorAll('${weakSel}').length && ${menuItem('more', 'Show weak links')}.classList.contains('checked')`);
  await click(menuItem('more', 'Show weak links'));
  await closeMenu('more');
  await mouse('mouseMoved', await centre(`document.querySelector('g.view[data-view="overview"] .domain[data-domain=${JSON.stringify(weakDomain)}]')`));
  await pause(150);
  await shot(
    'overview-domain-hover',
    `(() => { const v = document.querySelector('g.view[data-view="overview"]'); const mine = [...v.querySelectorAll('.overview-link')].filter((g) => [g.getAttribute('data-from'), g.getAttribute('data-to')].includes(${JSON.stringify(weakDomain)}));
      const others = [...v.querySelectorAll('.domain:not(.focus-node)')];
      return v.classList.contains('domain-focus') && mine.every((g) => getComputedStyle(g).display !== 'none' && getComputedStyle(g).opacity === '1') && others.length > 0 && others.every((d) => getComputedStyle(d).opacity === '0.25') || { mine: mine.length, others: others.length }; })()`,
  );
  await mouse('mouseMoved', { x: 5, y: 890 });
  await pause(100);
}

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
  await shot('long-enum-panel', `document.querySelectorAll('.oe-panel .oe-grid details[open] .oe-enum tr').length === ${enumCount} && document.querySelector('.oe-panel .oe-grid tr.open').getAttribute('data-column') === ${JSON.stringify(enumColumn)} && ${row}.classList.contains('hl-column')`);
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
  await shot('missing-relation-panel', `document.querySelector('.oe-panel .oe-grid .oe-warn') !== null`);
  await key('Escape');
  await click(`document.querySelector('.oe-crumbs .oe-link')`);
}

// A domain whose view has a table with lines and a stub, preferring one
// with an enum column so the tooltip step shows enum values.
const domain = await evaluate(`(() => {
  const d = JSON.parse(document.getElementById('open-erd-data').textContent);
  const usable = [...document.querySelectorAll('g.view')].filter((v) => v.getAttribute('data-view').startsWith('domain:') && v.querySelector('.stub') && v.querySelector('.table') && v.querySelector('.relation-group'));
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
await click(`document.querySelectorAll('.oe-crumbs .oe-link')[1]`);
await shot('database-crumb', `${viewIs('overview')} && (() => {
  const r = document.querySelector('.database[data-database=${JSON.stringify(domain.split('/')[0])}] .db-frame').getBoundingClientRect();
  const top = document.querySelector('.oe-toolbar')?.getBoundingClientRect().bottom ?? 0;
  const visible = r.left >= 0 && r.right <= innerWidth && r.top >= top && r.bottom <= innerHeight;
  const centred = Math.abs((r.left + r.right) / 2 - innerWidth / 2) < innerWidth * 0.2;
  return visible && centred;
})()`);
// The views menu jumps to a database's frame too, named as on the frame
// (first letter upper case; ids keep their case).
const dbName = domain.split('/')[0];
const dbLabel = dbName[0].toUpperCase() + dbName.slice(1);
await click(menuButton('views'));
await shot('views-menu', `${menuItem('views', 'Overview')} !== undefined && ${menuItem('views', dbLabel)} !== undefined`);
await click(menuItem('views', dbLabel));
await shot('views-menu-database', `${viewIs('overview')} && !${menuOpen('views')} && (() => {
  const r = document.querySelector('.database[data-database=${JSON.stringify(dbName)}] .db-frame').getBoundingClientRect();
  return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })()`);
await click(`document.querySelector('.domain[data-domain=${JSON.stringify(domain)}]')`);
await shot('database-crumb-name', `document.querySelectorAll('.oe-crumbs .oe-link')[1].textContent === ${JSON.stringify(dbLabel)}`);

const table = await evaluate(`(() => { const g = ${visible}.querySelector('.relation-group'); return ${visible}.querySelector('.table[data-id="' + g.getAttribute('data-from') + '"]') ? g.getAttribute('data-from') : g.getAttribute('data-to'); })()`);
await click(inView(`.table[data-id="${table}"]`), { where: 'top' });
// The panel carries the table's column grid, one row per column.
await shot(
  'table-highlight',
  `${visible}.classList.contains('dimmed') && ${inView('.table.selected')} !== null && ${inView('.relation-group.hl')} !== null && document.querySelectorAll('.oe-panel .oe-grid tr[data-column]').length === ${data}.nodes[${JSON.stringify(table)}].columns.length`,
);
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
await click(`[...document.querySelectorAll('.oe-panel .oe-btn')].find((b) => b.textContent.startsWith('Copy schema'))`);
await shot('copy-schema-menu', `[...document.querySelectorAll('.oe-copy-menu .oe-item')].map((b) => b.textContent).join('|') === (${data}.databases[${JSON.stringify(table.split('.')[0])}].engine === 'mongodb' ? 'JSON schema (approximate)|Markdown table' : 'SQL (CREATE TABLE, approximate)|Markdown table')`);
await click(`document.querySelector('.oe-copy-menu .oe-item')`);
await shot('copy-schema-sql', `/^Copied (SQL|JSON schema)$/.test(document.querySelector('.oe-panel .row .muted').textContent) && (window.__copied.startsWith('-- Generated from the ERD; types as recorded, review before use') || JSON.parse(window.__copied).$comment !== undefined)`);
await click(`[...document.querySelectorAll('.oe-panel .oe-btn')].find((b) => b.textContent.startsWith('Copy schema'))`);
await click(`[...document.querySelectorAll('.oe-copy-menu .oe-item')].find((b) => b.textContent === 'Markdown table')`);
await shot('copy-schema-markdown', `window.__copied.startsWith('### ${table.split('.')[2]}') && window.__copied.includes('| # | Column | Type |')`);

// Hover a column with an enum when there is one, else the first column.
const column = await evaluate(`(() => { const d = JSON.parse(document.getElementById('open-erd-data').textContent);
  for (const g of ${visible}.querySelectorAll('.table')) { const n = d.nodes[g.getAttribute('data-id')]; const c = n.columns.find((x) => x.enum); if (c) return [g.getAttribute('data-id'), c.name]; }
  const g = ${visible}.querySelector('.table'); return [g.getAttribute('data-id'), d.nodes[g.getAttribute('data-id')].columns[0].name]; })()`);
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
// without script; "keep highlight" keeps the flow; PNG is twice the view's
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
    await choose('download', label);
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
  await click(menuButton('download'));
  await shot('download-menu', `document.querySelectorAll('.oe-download-menu .oe-item').length === 3 && ${inView('.flow')} !== null && ${menuButton('download')}.title.startsWith('Download')`);
  await pick('This view as SVG');
  const plain = (await saved(`${base}.svg`)).toString();
  const views = (plain.match(/<g class="view"/g) ?? []).length;
  if (views !== 1 || plain.includes('<script') || plain.includes('foreignObject') || plain.includes('class="fold-toggle') || /class="[^"]*\b(dimmed|flowing)\b/.test(plain) || !plain.includes('@font-face')) {
    failures.push(`download svg: ${JSON.stringify({ views, script: plain.includes('<script'), highlight: /\b(dimmed|flowing)\b/.test(plain) })}`);
  }
  await click(`document.querySelector('.oe-download-menu .oe-check input')`);
  await pick('This view as SVG');
  const kept = (await saved(`${base}.svg`)).toString();
  if (!/class="[^"]*\bflowing\b/.test(kept) || !/class="view[^"]*\bdimmed\b/.test(kept)) failures.push('download svg with highlight lost the highlight');
  await click(`document.querySelector('.oe-download-menu .oe-check input')`);
  await pick('This view as PNG');
  const png = await saved(`${base}.png`);
  const [pw, ph] = [png.readUInt32BE(16), png.readUInt32BE(20)];
  const status = await evaluate(`document.querySelector('.oe-status').textContent`);
  const full = pw === Math.floor(bounds[2] * 2) && ph === Math.floor(bounds[3] * 2);
  if (!(full ? !status.includes('downscaled') : status.includes('downscaled'))) failures.push(`download png ${pw}x${ph} for ${bounds}: ${status}`);
  await pick('This view as JPEG');
  const jpg = await saved(`${base}.jpg`);
  await shot('download-saved', `${jpg[0] === 0xff && jpg[1] === 0xd8} && document.querySelector('.oe-status').textContent.startsWith('Saved ${base}.jpg')`);
  await key('Escape');
  await shot('download-menu-closed', `!${menuOpen('download')}`);
}

await click(`${visible}.querySelector(':scope > rect')`, { where: 'top' });
await shot('cleared', `!${visible}.classList.contains('dimmed') && ${inView('.flow')} === null`);

const stub = await evaluate(`${inView('.stub')}.getAttribute('data-id')`);
await click(inView(`.stub[data-id="${stub}"]`));
await shot('stub-jump', `${visible}.getAttribute('data-view') !== ${JSON.stringify(`domain:${domain}`)} && ${inView(`.table.selected[data-id="${stub}"]`)} !== null`);

// A table with indexes: the panel lists them, indexed columns carry the bolt.
const indexed = await evaluate(`(() => { const d = ${data}; for (const [id, n] of Object.entries(d.nodes)) if (n.indexes) return [id, n.cluster]; return null; })()`);
if (indexed) {
  const [indexTable, indexDomain] = indexed;
  await click(`document.querySelector('.oe-crumbs .oe-link')`);
  await click(`document.querySelector('.domain[data-domain=${JSON.stringify(indexDomain)}]')`);
  await click(inView(`.table[data-id="${indexTable}"]`), { where: 'top' });
  await shot(
    'indexes-panel',
    `(() => { const n = ${data}.nodes[${JSON.stringify(indexTable)}]; const rows = document.querySelectorAll('.oe-panel .oe-indexes tr').length - 1;
      const marked = [...${inView(`.table[data-id="${indexTable}"]`)}.querySelectorAll('.column')].filter((r) => r.querySelector('.icon-index')).map((r) => r.getAttribute('data-column')).sort();
      const expected = [...new Set(n.indexes.flatMap((i) => i.columns))].filter((c) => n.columns.some((x) => x.name === c)).sort();
      return rows === n.indexes.length && JSON.stringify(marked) === JSON.stringify(expected) || { rows, marked, expected }; })()`,
  );
  await key('Escape');
}

// A clicked line's panel shows its review state as an icon with the words as tooltip.
{
  const anyLine = await evaluate(`[...${visible}.querySelectorAll('.relation-group:not(.kind-view_source):not(.kind-polymorphic) path.relation-hit')].find((e) => { const m = e.getPointAtLength(e.getTotalLength() / 2).matrixTransform(e.getScreenCTM()); return m.x < innerWidth - 470 && e.closest('.relation-group').contains(document.elementFromPoint(m.x, m.y)); }) ? true : false`);
  if (anyLine) {
    await click(`[...${visible}.querySelectorAll('.relation-group:not(.kind-view_source):not(.kind-polymorphic) path.relation-hit')].find((e) => { const m = e.getPointAtLength(e.getTotalLength() / 2).matrixTransform(e.getScreenCTM()); return m.x < innerWidth - 470 && e.closest('.relation-group').contains(document.elementFromPoint(m.x, m.y)); })`);
    await shot(
      'line-review-icon',
      `(() => { const f = document.querySelector('.oe-panel .oe-line-facts'); const icon = f?.querySelector('.oe-review');
        return icon && ['Confirmed', 'Not confirmed yet', 'Code changed since confirmed'].includes(icon.title) && !/\\b(pending|reviewed|stale)\\b/.test(f.textContent); })()`,
    );
    await key('Escape');
  }
}

const polyView = await evaluate(`(() => { for (const v of document.querySelectorAll('g.view')) { const n = v.getAttribute('data-view'); if (n.startsWith('domain:') && v.querySelector('.poly-routes')) return n.slice(7); } })()`);
if (polyView) {
  await click(`document.querySelector('.oe-crumbs .oe-link')`);
  await click(`document.querySelector('.domain[data-domain=${JSON.stringify(polyView)}]')`);
  const poly = await evaluate(`${inView('.poly-routes')}.getAttribute('data-poly')`);
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
// The toolbar's search is a compact trigger naming the shortcut.
await shot('search-trigger', `/^Search(⌘F|Ctrl\\+F)$/.test(document.querySelector('.oe-search-trigger').textContent) && document.querySelector('.oe-toolbar input[type="search"]') === null || document.querySelector('.oe-search-trigger').textContent`);

// Business/Technical mode is gone.
await shot('no-business-mode', `![...document.querySelectorAll('button')].some((b) => /^(Business|Technical)$/.test(b.textContent)) && !document.documentElement.classList.contains('business')`);

// The table highlighted earlier has lines; open its neighborhood from the
// full view, or from its domain view in a schema too large for a full view.
if (await evaluate(`document.querySelector('g.view[data-view="all"]') !== null`)) {
  await choose('views', 'All tables');
  await shot('all-tables', `${viewIs('all')} && document.querySelector('.oe-crumbs .here').textContent === 'All tables · ' + Object.values(${data}.nodes).filter((x) => x.kind === 'table').length + ' tables'`);
  // The legend is open here, drawn with the diagram's own line and marker
  // classes, listing only what this view draws: no review colours outside
  // review mode, an end-marker entry per kind drawn.
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
  // Review mode, in the ⋯ menu with the counts, only when something waits
  // for review: pending lines turn amber, the legend shows the review icons
  // and a chip says the mode is on; its × turns it off.
  const counts = await evaluate(`${data}.review`);
  await click(menuButton('more'));
  if (counts.pending + counts.stale === 0) {
    await shot('review-mode-hidden', `${menuItem('more', 'Review mode')} === undefined && !/null|undefined/.test(document.querySelector('.oe-more-menu').textContent) && document.querySelector('.oe-review-chip').closest('foreignObject').style.display === 'none'`);
    await closeMenu('more');
  } else {
    const pending = await evaluate(`${inView('.relation-group.review-pending:not(.kind-view_source) path.relation')} !== null`);
    await shot('review-mode-item', `${menuItem('more', 'Review mode')}.textContent.startsWith('Review mode · ${counts.pending} to confirm · ${counts.stale} changed in code') && ${menuItem('more', 'Review mode')}.textContent.includes('amber = not confirmed yet') && !/null|undefined/.test(document.querySelector('.oe-more-menu').textContent)`);
    await click(menuItem('more', 'Review mode'));
    await closeMenu('more');
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
      `/^\\S+ → \\S+$/.test(${inView(`.relation-group[data-id="${cross}"] .edge-label text`)}.textContent) && /Cross-DB: \\S+ \\(.+\\) → \\S+ \\(.+\\)/.test(document.querySelector('.oe-panel').textContent)`,
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
  await choose('more', 'Legend');
  await closeMenu('more');
} else {
  await click(`document.querySelector('.oe-crumbs .oe-link')`);
  await click(`document.querySelector('.domain[data-domain=${JSON.stringify(domain)}]')`);
  await click(menuButton('views'));
  await shot('no-all-tables', `${viewIs(`domain:${domain}`)} && ${menuItem('views', 'All tables')} === undefined`);
  await closeMenu('views');
}
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
await send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
await evaluate(`window.dispatchEvent(new Event('resize'))`);
await pause(200);
await click(`[...document.querySelectorAll('.oe-toolbar .oe-btn')].find((b) => b.textContent === 'Direct + next level')`);
await shot('neighborhood-2-hops', `${viewIs('neighborhood')} && ${visible}.querySelectorAll('.table, .poly').length >= ${oneHop}`);
// The second ring stays fully readable while the centre is selected, and the
// fitted drawing ends left of the open panel.
await shot(
  'neighborhood-2-hops-readable',
  `(() => { const outer = [...${visible}.querySelectorAll('.table.hop-2, .poly.hop-2')];
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
  if (hubView === 'all') await choose('views', 'All tables');
  else {
    await click(`document.querySelector('.oe-crumbs .oe-link')`);
    await click(`document.querySelector('.domain[data-domain=${JSON.stringify(hubView.slice(7))}]')`);
  }
  // The legend sits bottom left and may cover the hub table.
  await evaluate(`[...document.querySelectorAll('.oe-legend .oe-link')].find((b) => b.textContent === 'Hide')?.click()`);
  await click(inView(`.table[data-id="${hubTable}"]`), { where: 'top' });
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

// Folding domains: a click on a domain's header folds it (tables and their
// lines hidden, the header counts them), nothing else moves; Expand all
// restores it.
{
  if (await evaluate(`document.querySelector('g.view[data-view="all"]') !== null`)) await choose('views', 'All tables');
  else {
    await click(`document.querySelector('.oe-crumbs .oe-link')`);
    await click(`document.querySelector('.domain[data-domain=${JSON.stringify(domain)}]')`);
  }
  const fold = await evaluate(`(() => { const d = ${data}; const v = ${visible};
    const withLines = [...v.querySelectorAll('.cluster')].map((c) => c.getAttribute('data-cluster')).find((k) => [...v.querySelectorAll('.relation-group')].some((g) => d.nodes[g.getAttribute('data-from')]?.cluster === k || d.nodes[g.getAttribute('data-to')]?.cluster === k));
    return withLines ?? null; })()`);
  const others = `[...${visible}.querySelectorAll('.nodes .table')].filter((g) => ${data}.nodes[g.getAttribute('data-id')].cluster !== ${JSON.stringify(fold)}).map((g) => g.getBoundingClientRect().x).join()`;
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
  const pickJoin = async (id) => {
    await click(`document.querySelector('.oe-join-field input')`);
    await send('Input.insertText', { text: id.split('.')[2] });
    await pause(150);
    await click(`[...document.querySelectorAll('.oe-join-picks .oe-result')].find((b) => b.querySelector('.where').textContent === ${JSON.stringify(id)})`);
  };
  await click(`[...document.querySelectorAll('.oe-btn')].find((b) => b.textContent === 'Join path')`);
  await pickJoin(joinPair[0]);
  await pickJoin(joinPair[1]);
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
    await shot('join-path-sql-copied', `document.querySelector('.oe-panel .row .muted').textContent === 'Copied SQL' && window.__copied.startsWith('-- Generated from the ERD: review before running')`);
  } else {
    await shot('join-path-sql-disabled', `/^No SQL: The path spans \\d+ databases/.test([...document.querySelectorAll('.oe-panel p.muted')].map((p) => p.textContent).join())`);
  }
  await key('Escape');
  await click(`document.querySelector('.oe-crumbs .oe-link')`);
  await searchFor(joinPair[0].split('.')[2]);
  await click(`[...document.querySelectorAll('.oe-panel .oe-btn')].find((b) => b.textContent === 'Find join path from here')`);
  await shot('join-path-from-table', `document.querySelector('.oe-panel .oe-join-end b')?.getAttribute('title') === ${JSON.stringify(joinPair[0])} && document.querySelector('.oe-join-field input') !== null`);
  const other = await evaluate(`[...${visible}.querySelectorAll('.table')].map((g) => g.getAttribute('data-id')).find((id) => id !== ${JSON.stringify(joinPair[0])}) ?? null`);
  if (other) {
    await click(inView(`.table[data-id="${other}"]`), { where: 'top' });
    await shot('join-path-pick-on-diagram', `[...document.querySelectorAll('.oe-panel .oe-join-end b')].map((b) => b.getAttribute('title')).join() === ${JSON.stringify(`${joinPair[0]},${other}`)}`);
  }
  await key('Escape');
}

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
const label = await centre(`[...${visible}.querySelectorAll('text')].find((t) => !t.closest('.table, .poly, .stub, .domain, .relation-group'))`);
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
