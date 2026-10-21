// Dev-only: drives the viewer embedded in a rendered erd.svg through headless
// Chrome (DevTools protocol over Node's built-in WebSocket) with real mouse
// and keyboard events, screenshots every step, checks what each step should
// have changed, and fails on any console error or failed check.
// Usage: node scripts/verify-viewer.js <erd.svg> <out dir>   (CHROME_PATH overrides the binary)
// The steps pick their targets from the drawing itself (the first domain
// with tables, a table with lines, a stub, a polymorphic node, ...), so any
// workspace with relations works.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEWPORT = { width: 1400, height: 900 };
const [input, outDir] = process.argv.slice(2);
if (!input || !outDir) {
  console.error('Usage: node scripts/verify-viewer.js <erd.svg> <out dir>');
  process.exit(1);
}

const profile = await mkdtemp(join(tmpdir(), 'open-erd-cdp-'));
const chrome = spawn(CHROME, ['--headless=new', '--hide-scrollbars', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank']);
// A failed step throws; Chrome must not outlive the script.
process.on('exit', () => chrome.kill());
const port = await new Promise((done, fail) => {
  let text = '';
  chrome.stderr.on('data', (chunk) => {
    text += chunk;
    const m = text.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
    if (m) done(m[1]);
  });
  chrome.on('exit', () => fail(new Error(`chrome exited before listening:\n${text}`)));
});
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const socket = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl);
await new Promise((done) => socket.addEventListener('open', done, { once: true }));

let nextId = 1;
const pending = new Map();
const listeners = [];
socket.addEventListener('message', ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.id && pending.has(msg.id)) {
    const { done, fail } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) fail(new Error(`${msg.error.message}`));
    else done(msg.result);
  } else if (msg.method) {
    for (const l of listeners) l(msg);
  }
});
const send = (method, params = {}) =>
  new Promise((done, fail) => {
    const id = nextId++;
    pending.set(id, { done, fail });
    socket.send(JSON.stringify({ id, method, params }));
  });
const once = (method) => new Promise((done) => listeners.push((m) => m.method === method && done(m.params)));

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

// Centre of the element `find` (JS expression returning an element) on screen.
async function centre(find, where = 'centre') {
  const p = await evaluate(`(() => { const e = ${find}; if (!e) return null; const r = e.getBoundingClientRect();
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
await shot('overview', `${viewIs('overview')} && document.querySelector('.oe-toolbar') !== null`);

// A domain whose view has a table with lines and a stub, preferring one
// with an enum column so the tooltip step shows enum values.
const domain = await evaluate(`(() => {
  const d = JSON.parse(document.getElementById('open-erd-data').textContent);
  const usable = [...document.querySelectorAll('g.view')].filter((v) => v.getAttribute('data-view').startsWith('domain:') && v.querySelector('.stub') && v.querySelector('.table') && v.querySelector('.relation-group'));
  const withEnum = usable.find((v) => [...v.querySelectorAll('.table')].some((g) => d.nodes[g.getAttribute('data-id')].columns.some((c) => c.enum)));
  return (withEnum ?? usable[0]).getAttribute('data-view').slice(7);
})()`);
await click(`document.querySelector('.domain[data-domain=${JSON.stringify(domain)}]')`);
await shot('domain-view', viewIs(`domain:${domain}`));

// The database crumb shows that database's whole frame on the overview.
await click(`document.querySelectorAll('.oe-crumbs .oe-link')[1]`);
await shot('database-crumb', `${viewIs('overview')} && document.querySelector('.database[data-database=${JSON.stringify(domain.split('/')[0])}] .db-frame').getBoundingClientRect().width > innerWidth / 3`);
await click(`document.querySelector('.domain[data-domain=${JSON.stringify(domain)}]')`);

const table = await evaluate(`(() => { const g = ${visible}.querySelector('.relation-group'); return ${visible}.querySelector('.table[data-id="' + g.getAttribute('data-from') + '"]') ? g.getAttribute('data-from') : g.getAttribute('data-to'); })()`);
await click(inView(`.table[data-id="${table}"]`), { where: 'top' });
await shot('table-highlight', `${visible}.classList.contains('dimmed') && ${inView('.table.selected')} !== null && ${inView('.relation-group.hl')} !== null`);

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
  await shot('polymorphic-targets', `[...${visible}.querySelectorAll('.poly-routes')].some((g) => g.style.display !== 'none') && document.querySelectorAll('.oe-panel li').length > 0`);
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

// The table highlighted earlier has lines; open its neighborhood from the full view.
await click(`[...document.querySelectorAll('.oe-btn')].find((b) => b.textContent === 'All tables')`);
await shot('all-tables', viewIs('all'));
await click(inView(`.table[data-id="${table}"]`), { where: 'top', count: 2 });
await shot('neighborhood-1-hop', `${viewIs('neighborhood')} && ${visible}.querySelectorAll('.table, .poly').length > 1`);
const oneHop = await evaluate(`${visible}.querySelectorAll('.table, .poly').length`);
await click(`[...document.querySelectorAll('.oe-btn')].find((b) => b.textContent === '2 hops')`);
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

// Wheel zoom and drag pan move the camera.
const before = await evaluate(`document.querySelector('.camera').getAttribute('transform')`);
await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 500, deltaX: 0, deltaY: -300 });
await pause(100);
await mouse('mousePressed', { x: 700, y: 500 });
await mouse('mouseMoved', { x: 780, y: 560 });
await mouse('mouseReleased', { x: 780, y: 560 });
await shot('zoom-pan', `document.querySelector('.camera').getAttribute('transform') !== ${JSON.stringify(before)}`);

// Without script the file must still show the static overview.
await send('Emulation.setScriptExecutionDisabled', { value: true });
const reloaded = once('Page.loadEventFired');
await send('Page.reload', { ignoreCache: true });
await reloaded;
await pause(300);
await send('Emulation.setScriptExecutionDisabled', { value: false });
await shot('no-script', `document.querySelector('.oe-toolbar') === null && ${viewIs('overview')} && document.querySelectorAll('g.view:not([style])').length === 1`);

socket.close();
chrome.kill();
await rm(profile, { recursive: true, force: true }).catch(() => {});
if (errors.length > 0) console.error(`console errors:\n  ${errors.join('\n  ')}`);
if (failures.length > 0) console.error(`failed checks:\n  ${failures.join('\n  ')}`);
console.log(errors.length === 0 && failures.length === 0 ? 'viewer OK' : 'viewer FAILED');
process.exitCode = errors.length + failures.length > 0 ? 1 : 0;
