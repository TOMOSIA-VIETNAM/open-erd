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

// Overview lines say which way their relations point and list them: an
// arrow at the referenced domain, an "N relations" label, a tooltip, and a
// panel whose every entry leads to the referencing table's domain view.
const data = `JSON.parse(document.getElementById('open-erd-data').textContent)`;
await key('Escape');
await click(`document.querySelector('.oe-crumbs .oe-link') ?? document.querySelector('.oe-crumbs .here')`);
const overviewLine = await evaluate(`(() => { const d = ${data}; const lines = [...document.querySelectorAll('g.view[data-view="overview"] .relation-group')];
  lines.sort((a, b) => d.domainLinks[b.getAttribute('data-id')].length - d.domainLinks[a.getAttribute('data-id')].length);
  return lines[0]?.getAttribute('data-id') ?? null; })()`);
if (overviewLine) {
  const lineSel = inView(`.relation-group[data-id="${overviewLine}"] path.relation-hit`);
  await mouse('mouseMoved', await centre(lineSel));
  await pause(150);
  await shot(
    'overview-line-tooltip',
    `${viewIs('overview')} && [...document.querySelectorAll('.oe-tip')].some((t) => /relations? ?:/.test(t.textContent)) && ${inView('.relation-group .marker .head')} !== null && [...${visible}.querySelectorAll('.edge-label text')].every((t) => /^\\d+ relations?( · cross-DB → \\S+)?$/.test(t.textContent))`,
  );
  await click(lineSel);
  await shot(
    'overview-line-panel',
    `(() => { const n = ${data}.domainLinks[${JSON.stringify(overviewLine)}].length; return document.querySelector('.oe-panel h3')?.textContent.includes('→') && document.querySelectorAll('.oe-panel li').length === n || { n, li: document.querySelectorAll('.oe-panel li').length }; })()`,
  );
  const target = await evaluate(`${data}.domainLinks[${JSON.stringify(overviewLine)}][0].from`);
  await click(`document.querySelector('.oe-panel li .oe-link')`);
  await shot('overview-line-entry-jump', `${visible}.getAttribute('data-view').startsWith('domain:') && ${inView(`.table.selected[data-id="${target}"]`)} !== null`);
  await key('Escape');
  await click(`document.querySelector('.oe-crumbs .oe-link')`);
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
await click(`document.querySelector('.domain[data-domain=${JSON.stringify(domain)}]')`);

const table = await evaluate(`(() => { const g = ${visible}.querySelector('.relation-group'); return ${visible}.querySelector('.table[data-id="' + g.getAttribute('data-from') + '"]') ? g.getAttribute('data-from') : g.getAttribute('data-to'); })()`);
await click(inView(`.table[data-id="${table}"]`), { where: 'top' });
// The panel carries the table's column grid, one row per column.
await shot(
  'table-highlight',
  `${visible}.classList.contains('dimmed') && ${inView('.table.selected')} !== null && ${inView('.relation-group.hl')} !== null && document.querySelectorAll('.oe-panel .oe-grid tr[data-column]').length === ${data}.nodes[${JSON.stringify(table)}].columns.length`,
);

// Hover a column with an enum when there is one, else the first column.
const column = await evaluate(`(() => { const d = JSON.parse(document.getElementById('open-erd-data').textContent);
  for (const g of ${visible}.querySelectorAll('.table')) { const n = d.nodes[g.getAttribute('data-id')]; const c = n.columns.find((x) => x.enum); if (c) return [g.getAttribute('data-id'), c.name]; }
  const g = ${visible}.querySelector('.table'); return [g.getAttribute('data-id'), d.nodes[g.getAttribute('data-id')].columns[0].name]; })()`);
await mouse('mouseMoved', await centre(inView(`.table[data-id="${column[0]}"] .column[data-column="${column[1]}"]`)));
await pause(150);
await shot('column-tooltip', `[...document.querySelectorAll('foreignObject')].some((f) => f.style.display !== 'none' && f.querySelector('.oe-tip'))`);

await click(`${visible}.querySelector('.relation-group:not(.kind-polymorphic) path.relation-hit')`);
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
    await click(`[...document.querySelectorAll('.oe-menu .oe-result')].find((b) => b.textContent === ${JSON.stringify(label)})`);
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
  await click(`[...document.querySelectorAll('.oe-btn')].find((b) => b.textContent.startsWith('Download'))`);
  await shot('download-menu', `document.querySelectorAll('.oe-menu .oe-result').length === 3 && ${inView('.flow')} !== null`);
  await pick('This view as SVG');
  const plain = (await saved(`${base}.svg`)).toString();
  const views = (plain.match(/<g class="view"/g) ?? []).length;
  if (views !== 1 || plain.includes('<script') || plain.includes('foreignObject') || /class="[^"]*\b(dimmed|flowing)\b/.test(plain) || !plain.includes('@font-face')) {
    failures.push(`download svg: ${JSON.stringify({ views, script: plain.includes('<script'), highlight: /\b(dimmed|flowing)\b/.test(plain) })}`);
  }
  await click(`document.querySelector('.oe-menu .oe-check input')`);
  await pick('This view as SVG');
  const kept = (await saved(`${base}.svg`)).toString();
  if (!/class="[^"]*\bflowing\b/.test(kept) || !/class="view[^"]*\bdimmed\b/.test(kept)) failures.push('download svg with highlight lost the highlight');
  await click(`document.querySelector('.oe-menu .oe-check input')`);
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
}

await click(`${visible}.querySelector(':scope > rect')`, { where: 'top' });
await shot('cleared', `!${visible}.classList.contains('dimmed') && ${inView('.flow')} === null`);

const stub = await evaluate(`${inView('.stub')}.getAttribute('data-id')`);
await click(inView(`.stub[data-id="${stub}"]`));
await shot('stub-jump', `${visible}.getAttribute('data-view') !== ${JSON.stringify(`domain:${domain}`)} && ${inView(`.table.selected[data-id="${stub}"]`)} !== null`);

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
    `[...${visible}.querySelectorAll('.poly-routes')].some((g) => g.style.display !== 'none') && document.querySelectorAll('.oe-panel li').length > 0 && !document.querySelector('.oe-panel').textContent.includes('each row points at') && document.querySelectorAll('.oe-panel details[open]').length === 0 && [...document.querySelectorAll('.oe-panel details summary')].every((x) => /^Evidence \\(\\d+\\)$/.test(x.textContent))`,
  );
  await click(`document.querySelector('.oe-panel li .oe-link')`);
  await shot('polymorphic-target-jump', `${inView('.table.selected')} !== null`);
}

const query = column[1].slice(0, 4);
await click(`document.querySelector('.oe-search input')`);
await send('Input.insertText', { text: query });
await pause(200);
await shot('search-results', `document.querySelectorAll('.oe-result').length > 0`);
await key('Enter');
await shot('search-jump', `${inView('.table.selected')} !== null`);

await click(`[...document.querySelectorAll('.oe-btn')].find((b) => b.textContent === 'Business')`);
await shot('business-mode', `document.documentElement.classList.contains('business') && getComputedStyle(${inView('.column-type')}).display === 'none'`);
await click(`[...document.querySelectorAll('.oe-btn')].find((b) => b.textContent === 'Technical')`);

// The table highlighted earlier has lines; open its neighborhood from the
// full view, or from its domain view in a schema too large for a full view.
if (await evaluate(`document.querySelector('g.view[data-view="all"]') !== null`)) {
  await click(`[...document.querySelectorAll('.oe-btn')].find((b) => b.textContent === 'All tables')`);
  await shot('all-tables', `${viewIs('all')} && document.querySelector('.oe-crumbs .here').textContent === 'All tables · ' + Object.values(${data}.nodes).filter((x) => x.kind === 'table').length + ' tables'`);
  // The legend is open here, drawn with the diagram's own line and marker classes.
  await shot(
    'legend',
    `(() => { const f = [...document.querySelectorAll('foreignObject')].find((x) => x.querySelector('.oe-legend')); const r = f.querySelector('.oe-legend').getBoundingClientRect();
      return f.style.display !== 'none' && f.querySelectorAll('.oe-legend .item').length >= 16 && f.querySelector('.oe-legend .col-warn') !== null && f.querySelectorAll('.oe-legend .marker path').length >= 4 && f.querySelector('.oe-legend .review-pending .relation') !== null && r.bottom <= innerHeight && r.left >= 0; })()`,
  );
  // A cross-DB line names the database it reaches; its panel names both with their engines.
  const cross = await evaluate(`${inView('.relation-group.kind-cross_db')}?.getAttribute('data-id') ?? null`);
  if (cross) {
    await click(inView(`.relation-group[data-id="${cross}"] path.relation-hit`));
    await shot(
      'cross-db-line',
      `/^cross-DB → \\S+$/.test(${inView(`.relation-group[data-id="${cross}"] .edge-label text`)}.textContent) && /Cross-DB: \\S+ \\(.+\\) → \\S+ \\(.+\\)/.test(document.querySelector('.oe-panel').textContent)`,
    );
    await key('Escape');
  }
  await click(`[...document.querySelectorAll('.oe-btn')].find((b) => b.textContent === 'Legend')`);
} else {
  await click(`document.querySelector('.oe-crumbs .oe-link')`);
  await click(`document.querySelector('.domain[data-domain=${JSON.stringify(domain)}]')`);
  await shot('no-all-tables', `${viewIs(`domain:${domain}`)} && [...document.querySelectorAll('.oe-btn')].find((b) => b.textContent === 'All tables').style.display === 'none'`);
}
await click(inView(`.table[data-id="${table}"]`), { where: 'top', count: 2 });
// Its lines carry crow's feet like the drawn views.
await shot(
  'neighborhood-1-hop',
  `${viewIs('neighborhood')} && ${visible}.querySelectorAll('.table, .poly').length > 1 && [...${visible}.querySelectorAll('.relation-group')].filter((g) => g.getAttribute('class').includes('kind-view_source') === false).every((g) => g.querySelector('.marker path, .marker circle'))`,
);
const oneHop = await evaluate(`${visible}.querySelectorAll('.table, .poly').length`);
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
await click(`[...document.querySelectorAll('.oe-btn')].find((b) => b.textContent === '‹ Back')`);
await shot('back', `!(${viewIs('neighborhood')})`);

// A hub table: selecting it draws the hub lines pointing at it in this view,
// its panel lists every table referencing it, and its neighborhood holds
// them. Picks the hub with the most lines in the first view that has any.
const hub = await evaluate(`(() => { for (const v of document.querySelectorAll('g.view')) {
  const groups = [...v.querySelectorAll('.hub-routes')].sort((a, b) => b.children.length - a.children.length);
  if (groups.length > 0) return [v.getAttribute('data-view'), groups[0].getAttribute('data-hub')]; } return null; })()`);
if (hub) {
  const [hubView, hubTable] = hub;
  if (hubView === 'all') await click(`[...document.querySelectorAll('.oe-btn')].find((b) => b.textContent === 'All tables')`);
  else {
    await click(`document.querySelector('.oe-crumbs .oe-link')`);
    await click(`document.querySelector('.domain[data-domain=${JSON.stringify(hubView.slice(7))}]')`);
  }
  await click(inView(`.table[data-id="${hubTable}"]`), { where: 'top' });
  const referrers = await evaluate(`new Set(${data}.hubLinks.filter((l) => l.to === ${JSON.stringify(hubTable)} && l.from !== l.to).map((l) => l.from)).size`);
  await shot(
    'hub-table-selected',
    `[...${visible}.querySelectorAll('.hub-routes')].some((g) => g.getAttribute('data-hub') === ${JSON.stringify(hubTable)} && g.style.display !== 'none') && document.querySelector('.oe-panel').textContent.includes('Referenced by ${referrers} table')`,
  );
  // The panel's own neighborhood button: on a wide schema the open panel may
  // cover the table, so a double-click there would land on the panel.
  await click(`[...document.querySelectorAll('.oe-panel .oe-btn')].find((b) => b.textContent === 'Direct')`);
  await shot('hub-neighborhood', `${viewIs('neighborhood')} && ${visible}.querySelectorAll('.table').length >= ${referrers} + 1`);
  await key('Escape');
  await click(`[...document.querySelectorAll('.oe-btn')].find((b) => b.textContent === '‹ Back')`);
}

// Folding domains: a click on a domain's header folds it (tables and their
// lines hidden, the header counts them), nothing else moves; Expand all
// restores it.
{
  if (await evaluate(`document.querySelector('g.view[data-view="all"]') !== null`)) await click(`[...document.querySelectorAll('.oe-btn')].find((b) => b.textContent === 'All tables')`);
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
      return c.querySelector('.cluster-label').textContent.endsWith('(collapsed)') && tables.every((g) => getComputedStyle(g).display === 'none') && /\\d+ links? hidden/.test(c.querySelector('.fold-badge')?.textContent ?? '') && ${others} === ${JSON.stringify(before)}; })()`,
  );
  await click(`[...document.querySelectorAll('.oe-btn')].find((b) => b.textContent === 'Expand all')`);
  await shot('domains-expanded', `${visible}.querySelectorAll('.oe-hidden').length === 0 && ${visible}.querySelector('.fold-badge') === null`);
  await click(`[...document.querySelectorAll('.oe-btn')].find((b) => b.textContent === 'Collapse all')`);
  await shot('domains-all-collapsed', `${visible}.querySelectorAll('.nodes .table:not(.oe-hidden)').length === ${visible}.querySelectorAll('.nodes .table').length - ${visible}.querySelectorAll('.nodes .table.oe-hidden').length && ${visible}.querySelectorAll('.cluster.folded').length === ${visible}.querySelectorAll('.cluster').length`);
  await click(`[...document.querySelectorAll('.oe-btn')].find((b) => b.textContent === 'Expand all')`);
}

// A table whose only links are hub badges still counts them in its panel.
const badgeOnly = await evaluate(`(() => { const d = ${data}; const drawn = new Set(d.links.flatMap((l) => [l.from, l.to]));
  return d.hubLinks.map((l) => l.from).find((id) => !drawn.has(id)) ?? null; })()`);
if (badgeOnly) {
  await click(`document.querySelector('.oe-crumbs .oe-link')`);
  await click(`document.querySelector('.domain[data-domain=${JSON.stringify(badgeOnly.split('.')[0])}]') ?? document.querySelector('.domain')`);
  const clearSearch = `(() => { const i = document.querySelector('.oe-search input'); i.value = ''; i.dispatchEvent(new Event('input')); })()`;
  await evaluate(clearSearch);
  await click(`document.querySelector('.oe-search input')`);
  await send('Input.insertText', { text: badgeOnly.split('.')[2] });
  await pause(200);
  await key('Enter');
  await shot('badge-only-table', `/0 relations · \\d+ shared links? \\(badges\\)/.test(document.querySelector('.oe-panel').textContent)`);
  await key('Escape');
  await evaluate(clearSearch);
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
  await click(`[...document.querySelectorAll('.oe-btn')].find((b) => b.textContent === '‹ Back')`);
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
      return hops.length >= 2 && [...hops].every((li) => / = /.test(li.querySelector('code').textContent)) && lit >= 1 && ${early} < ${late} && ${visible}.querySelectorAll(':is(.table, .stub).selected').length === 2
        || { hops: hops.length, lit, early: ${early}, late: ${late} }; })()`,
  );
  await click(`[...document.querySelectorAll('.oe-panel .oe-btn')].find((b) => b.textContent === 'Copy conditions')`);
  await shot('join-path-copied', `/^Copied \\d+ conditions?$/.test(document.querySelector('.oe-panel .row .muted').textContent)`);
  await key('Escape');
  await click(`document.querySelector('.oe-crumbs .oe-link')`);
  await evaluate(`(() => { const i = document.querySelector('.oe-search input'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);
  await click(`document.querySelector('.oe-search input')`);
  await send('Input.insertText', { text: joinPair[0].split('.')[2] });
  await pause(200);
  await key('Enter');
  await click(`[...document.querySelectorAll('.oe-panel .oe-btn')].find((b) => b.textContent === 'Find join path from here')`);
  await shot('join-path-from-table', `document.querySelector('.oe-panel .oe-join-end b')?.getAttribute('title') === ${JSON.stringify(joinPair[0])} && document.querySelector('.oe-join-field input') !== null`);
  const other = await evaluate(`[...${visible}.querySelectorAll('.table')].map((g) => g.getAttribute('data-id')).find((id) => id !== ${JSON.stringify(joinPair[0])}) ?? null`);
  if (other) {
    await click(inView(`.table[data-id="${other}"]`), { where: 'top' });
    await shot('join-path-pick-on-diagram', `[...document.querySelectorAll('.oe-panel .oe-join-end b')].map((b) => b.getAttribute('title')).join() === ${JSON.stringify(`${joinPair[0]},${other}`)}`);
  }
  await key('Escape');
  await evaluate(`(() => { const i = document.querySelector('.oe-search input'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);
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
