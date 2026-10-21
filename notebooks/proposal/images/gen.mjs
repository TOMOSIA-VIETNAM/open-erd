// Generates proposal illustration SVGs. Usage: node gen.mjs <outDir>
import { writeFileSync } from 'node:fs';
const out = process.argv[2];
const C = { ink: '#1f2937', sub: '#6b7280', line: '#94a3b8', blue: '#2563eb', blueBg: '#eff6ff', green: '#16a34a', greenBg: '#f0fdf4', red: '#dc2626', redBg: '#fef2f2', amber: '#d97706', amberBg: '#fffbeb', gray: '#e5e7eb', panel: '#f8fafc', purple: '#7c3aed', purpleBg: '#f5f3ff' };
const FONT = `font-family="-apple-system, 'Helvetica Neue', Arial, sans-serif"`;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" ${FONT}>
<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${C.sub}"/></marker>
<marker id="arrB" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${C.blue}"/></marker></defs>
<rect width="${w}" height="${h}" fill="#fff"/>${body}</svg>`;
const t = (x, y, s, o = {}) => `<text x="${x}" y="${y}" font-size="${o.size || 16}" fill="${o.fill || C.ink}" font-weight="${o.weight || 400}" text-anchor="${o.anchor || 'start'}"${o.deco ? ` text-decoration="${o.deco}"` : ''}${o.italic ? ' font-style="italic"' : ''}>${esc(s)}</text>`;
const r = (x, y, w, h, o = {}) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${o.rx ?? 8}" fill="${o.fill || '#fff'}" stroke="${o.stroke || C.line}" stroke-width="${o.sw || 1.5}"${o.dash ? ` stroke-dasharray="${o.dash}"` : ''}${o.op ? ` opacity="${o.op}"` : ''}/>`;
const path = (d, o = {}) => `<path d="${d}" fill="none" stroke="${o.stroke || C.sub}" stroke-width="${o.sw || 1.8}"${o.dash ? ` stroke-dasharray="${o.dash}"` : ''}${o.marker ? ` marker-end="url(#${o.marker})"` : ''}${o.op ? ` opacity="${o.op}"` : ''}/>`;
const badge = (x, y, n, fill = C.blue) => `<circle cx="${x}" cy="${y}" r="13" fill="${fill}"/>${t(x, y + 5, n, { size: 14, fill: '#fff', weight: 700, anchor: 'middle' })}`;

// Table box: title bar + rows. Returns svg string; geometry known to caller.
function table(x, y, w, name, rows, o = {}) {
  const h = 34 + rows.length * 24 + 8;
  const stroke = o.stroke || C.ink, head = o.head || '#f1f5f9';
  let s = `<g${o.op ? ` opacity="${o.op}"` : ''}>${r(x, y, w, h, { stroke, sw: o.sw || 1.5, dash: o.dash, fill: o.fill || '#fff' })}`;
  s += `<path d="M${x} ${y + 34} H${x + w}" stroke="${stroke}" stroke-width="1"/>`;
  s += `<rect x="${x + 1}" y="${y + 1}" width="${w - 2}" height="32" rx="7" fill="${head}"/>`;
  s += t(x + 12, y + 23, name, { weight: 700, size: 16, deco: o.strike ? 'line-through' : undefined });
  rows.forEach((row, i) => {
    const [label, extra, color] = Array.isArray(row) ? row : [row];
    s += t(x + 12, y + 56 + i * 24, label, { size: 14, fill: color || C.ink });
    if (extra) s += t(x + w - 10, y + 56 + i * 24, extra, { size: 12, fill: color || C.sub, anchor: 'end' });
  });
  return s + '</g>';
}
// Crow's foot ends on a horizontal segment. dir=+1 means line leaves toward +x.
const one = (x, y, dir, col) => `<path d="M${x + dir * 8} ${y - 8} V${y + 8} M${x + dir * 14} ${y - 8} V${y + 8}" stroke="${col}" stroke-width="1.8"/>`;
const many = (x, y, dir, col) => `<path d="M${x} ${y - 9} L${x + dir * 14} ${y} L${x} ${y + 9} M${x} ${y} H${x + dir * 14}" fill="none" stroke="${col}" stroke-width="1.8"/>`;
const vOne = (x, y, dir, col) => `<path d="M${x - 8} ${y + dir * 8} H${x + 8} M${x - 8} ${y + dir * 14} H${x + 8}" stroke="${col}" stroke-width="1.8"/>`;
const vMany = (x, y, dir, col) => `<path d="M${x - 9} ${y} L${x} ${y + dir * 14} L${x + 9} ${y} M${x} ${y} V${y + dir * 14}" fill="none" stroke="${col}" stroke-width="1.8"/>`;

// ---------- 01 problem vs solution ----------
{
  let b = t(800, 56, 'ERD today vs. ERD with open-erd', { size: 30, weight: 700, anchor: 'middle' });
  b += r(40, 90, 740, 770, { fill: C.redBg, stroke: '#fecaca', rx: 14 }) + r(820, 90, 740, 770, { fill: C.greenBg, stroke: '#bbf7d0', rx: 14 });
  b += t(70, 132, 'Today', { size: 24, weight: 700, fill: C.red }) + t(850, 132, 'With open-erd', { size: 24, weight: 700, fill: C.green });
  // tangled: 5x5 grid boxes, deterministic pseudo-random edges
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pts = []; for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) pts.push([100 + j * 132, 170 + i * 92]);
  let lines = ''; for (let k = 0; k < 70; k++) { const a = pts[Math.floor(rnd() * 25)], c = pts[Math.floor(rnd() * 25)]; if (a !== c) lines += path(`M${a[0] + 40} ${a[1] + 18} L${c[0] + 40} ${c[1] + 18}`, { stroke: '#f87171', sw: 1.2, op: 0.7 }); }
  b += lines + pts.map(([x, y], i) => r(x, y, 80, 36, { fill: '#fff', stroke: '#fca5a5', rx: 4 }) + t(x + 40, y + 23, `table_${i + 1}`, { size: 12, fill: C.sub, anchor: 'middle' })).join('');
  ['No ERD — or one that is already outdated', 'No foreign keys → DB tools draw no relations', 'Polymorphic & cross-DB links are invisible', '100+ tables drawn flat = unreadable spaghetti']
    .forEach((s, i) => b += t(70, 690 + i * 40, '✕  ' + s, { size: 19, fill: C.ink }));
  // clean overview: DB frames with domains
  const db = (x, y, w, h, name, eng) => r(x, y, w, h, { fill: '#fff', stroke: C.line, rx: 12, dash: '6 4' }) + t(x + 14, y + 26, name, { size: 15, weight: 700, fill: C.sub }) + t(x + w - 14, y + 26, eng, { size: 13, fill: C.sub, anchor: 'end' });
  const dom = (x, y, name, n) => r(x, y, 170, 70, { fill: C.blueBg, stroke: C.blue, rx: 10 }) + t(x + 85, y + 32, name, { size: 18, weight: 700, anchor: 'middle' }) + t(x + 85, y + 54, `${n} tables`, { size: 13, fill: C.sub, anchor: 'middle' });
  b += db(860, 170, 300, 150, 'auth', 'MySQL') + dom(925, 220, 'Identity', 12);
  b += db(1220, 170, 300, 150, 'catalog', 'MongoDB') + dom(1285, 220, 'Catalog', 18);
  b += db(860, 380, 660, 230, 'billing', 'PostgreSQL') + dom(925, 450, 'Orders', 24) + dom(1285, 450, 'Billing', 31);
  b += path('M1095 485 H1285', { stroke: C.ink }) + t(1190, 475, '14 links', { size: 13, fill: C.sub, anchor: 'middle' });
  b += path('M1010 290 V450', { stroke: C.blue, dash: '7 5' }) + t(1020, 375, 'cross-DB', { size: 13, fill: C.blue });
  b += path('M1370 290 V450', { stroke: C.blue, dash: '7 5' }) + t(1380, 375, 'cross-DB', { size: 13, fill: C.blue });
  b += t(1190, 640, 'click a domain → its tables → one table + neighbours', { size: 14, fill: C.sub, anchor: 'middle', italic: true });
  ['Generated from source code, re-synced in minutes', 'Same input → same diagram, every time', 'One SVG file: click, search, animate — no install', 'Excel data dictionary + readable change report']
    .forEach((s, i) => b += t(850, 690 + i * 40, '✓  ' + s, { size: 19, fill: C.ink }));
  writeFileSync(`${out}/01-problem-vs-solution.svg`, svg(1600, 900, b));
}

// ---------- 02 pipeline ----------
{
  let b = t(800, 56, 'How open-erd works — AI writes the model, code draws the diagram', { size: 28, weight: 700, anchor: 'middle' });
  b += r(40, 100, 700, 560, { fill: C.purpleBg, stroke: '#ddd6fe', rx: 14 }) + t(60, 132, 'AI zone (Claude)', { size: 18, weight: 700, fill: C.purple });
  b += r(780, 100, 780, 560, { fill: C.panel, stroke: C.gray, rx: 14 }) + t(800, 132, 'Deterministic zone (plain code, no LLM)', { size: 18, weight: 700, fill: C.sub });
  const card = (x, y, w, h, title, lines, o = {}) => r(x, y, w, h, { fill: '#fff', stroke: o.stroke || C.ink, rx: 10, sw: o.sw }) + t(x + 18, y + 32, title, { size: 19, weight: 700, fill: o.tc || C.ink }) + lines.map((l, i) => t(x + 18, y + 62 + i * 26, l, { size: 15, fill: C.sub })).join('');
  b += card(70, 170, 260, 150, 'Source code', ['Rails · Laravel · Django', 'Node · Prisma · Mongoose …', 'one or many repos']);
  b += card(70, 360, 260, 150, 'Databases', ['MySQL · Postgres · Mongo …', 'metadata only', 'read only with permission']);
  b += card(400, 210, 300, 260, 'Claude', ['writes extract script', '   per project (re-runnable)', 'groups tables into domains', 'notes + enum meanings', 'infers hidden relations', '   with evidence (file:line)'], { stroke: C.purple, tc: C.purple });
  b += path('M330 245 H400', { marker: 'arr' }) + path('M330 435 H400', { marker: 'arr' });
  b += card(810, 210, 300, 260, 'Model', ['model/<db>.yaml', 'layout.json (pinned positions)', '', 'single source of truth', 'git-versioned, human-reviewed', 'tags = snapshots for diff'], { stroke: C.blue, tc: C.blue, sw: 2.5 });
  b += path('M700 340 H810', { marker: 'arrB', stroke: C.blue, sw: 2.5 });
  b += card(1170, 150, 360, 120, 'Engine', ['layout (ELK) · render · semantic diff', 'same input → byte-identical output']);
  b += path('M1110 300 C1140 300 1140 210 1170 210', { marker: 'arr' });
  const outs = [['erd.svg', 'interactive, single file'], ['erd.xlsx', 'overview + dictionary'], ['diff.svg', 'what changed since v1.0']];
  outs.forEach(([n, d], i) => { const y = 310 + i * 82; b += r(1230, y, 300, 66, { fill: C.greenBg, stroke: C.green, rx: 10 }) + t(1248, y + 28, n, { size: 18, weight: 700, fill: C.green }) + t(1248, y + 52, d, { size: 14, fill: C.sub }); });
  b += path('M1200 270 V507', { stroke: C.sub }) + outs.map((_, i) => path(`M1200 ${343 + i * 82} H1230`, { marker: 'arr' })).join('');
  // feedback loop
  b += r(400, 720, 760, 120, { fill: C.amberBg, stroke: C.amber, rx: 12 }) + t(420, 752, 'Edit by talking in the terminal', { size: 19, weight: 700, fill: C.amber });
  b += t(420, 782, '“orders.status: add meaning for refunded”   “move Billing to the right”', { size: 15, fill: C.ink, italic: true });
  b += t(420, 810, '“the link invoices → users is wrong, it goes to customers”', { size: 15, fill: C.ink, italic: true });
  b += path('M550 720 V470', { marker: 'arr', stroke: C.amber, dash: '6 4' }) + path('M960 720 V470', { marker: 'arrB', stroke: C.amber, dash: '6 4' });
  b += t(560, 600, 'AI edits model', { size: 14, fill: C.amber }) + t(970, 600, 'then re-render', { size: 14, fill: C.amber });
  writeFileSync(`${out}/02-pipeline.svg`, svg(1600, 880, b));
}

// ---------- 03 interactive output ----------
{
  let b = t(800, 50, 'Output: one interactive SVG file', { size: 28, weight: 700, anchor: 'middle' });
  // canvas frame + toolbar
  b += r(40, 80, 1080, 790, { fill: '#fff', stroke: C.gray, rx: 12 });
  b += `<rect x="41" y="81" width="1078" height="50" rx="11" fill="${C.panel}"/>` + t(64, 112, 'Overview  ›  billing (PostgreSQL)  ›  Orders', { size: 16, weight: 600 });
  b += r(700, 92, 220, 30, { rx: 15 }) + t(716, 112, '⌕  search table / column', { size: 14, fill: C.sub });
  b += r(935, 92, 170, 30, { rx: 15, fill: C.ink, stroke: C.ink }) + t(1020, 112, 'Business | Technical', { size: 13, fill: '#fff', anchor: 'middle' });
  // tables
  b += table(90, 190, 250, 'users', [['id', 'bigint'], ['email', 'PII', C.red]], { stroke: C.blue, dash: '6 4', op: 0.85 });
  b += t(90, 180, 'auth DB (other database)', { size: 13, fill: C.blue });
  b += table(470, 170, 270, 'orders', [['id', 'bigint'], ['customer_id', 'bigint'], ['status', 'enum'], ['total', 'decimal'], ['→ users ×2', 'created_by, updated_by', C.sub]], { stroke: C.amber, sw: 3, head: C.amberBg });
  b += t(470, 160, 'One order per checkout.', { size: 13, fill: C.sub, italic: true });
  b += table(470, 500, 270, 'order_items', [['id', 'bigint'], ['order_id', 'bigint'], ['product_ref', 'string'], ['quantity', 'int']], {});
  b += table(830, 190, 250, 'payments', [['id', 'bigint'], ['order_id', 'bigint'], ['method', 'enum']], {});
  b += table(830, 500, 250, 'audit_logs', [['id', 'bigint'], ['action', 'string']], { op: 0.3 });
  // relations: users 1 — n orders (cross-DB dashed)
  b += path('M340 260 H470', { stroke: C.blue, dash: '7 5', sw: 2.2 }) + one(340, 260, 1, C.blue) + many(470, 260, -1, C.blue);
  b += t(405, 248, 'cross-DB', { size: 12, fill: C.blue, anchor: 'middle' }) + t(405, 280, 'inferred', { size: 12, fill: C.blue, anchor: 'middle' });
  // orders 1 — n order_items (animated highlight)
  b += `<path d="M605 340 V500" stroke="${C.amber}" stroke-width="3" stroke-dasharray="10 6" fill="none"/>` + vOne(605, 340, 1, C.amber) + vMany(605, 500, -1, C.amber);
  // orders 1 — n payments
  b += path('M740 260 H830', { stroke: C.amber, sw: 3 }) + one(740, 260, 1, C.amber) + many(830, 260, -1, C.amber);
  // polymorphic node
  b += r(110, 520, 220, 110, { fill: C.purpleBg, stroke: C.purple, rx: 10, dash: '5 4' }) + t(220, 552, '«commentable»', { size: 17, weight: 700, fill: C.purple, anchor: 'middle' });
  b += t(220, 578, 'polymorphic: comments', { size: 13, fill: C.sub, anchor: 'middle' }) + t(220, 602, 'orders, products +38 more', { size: 13, fill: C.sub, anchor: 'middle' });
  b += path('M220 520 V310 H470', { stroke: C.purple, dash: '5 4', sw: 2 }) + vMany(220, 520, -1, C.purple);
  b += t(130, 700, 'audit_logs dimmed: not linked to the selected table', { size: 13, fill: C.sub, italic: true });
  // callouts
  b += badge(745, 160, 1) + badge(405, 212, 2) + badge(630, 420, 3) + badge(110, 520, 4) + badge(762, 317, 5) + badge(1100, 108, 6);
  const notes = [
    ['Click a table', ['it and every line into it light up,', 'the rest fades']],
    ['Cross-DB / inferred link', ['dashed + evidence (file:line),', 'stays dashed until reviewed']],
    ['Click a line', ['animated flow shows', 'where the relation goes']],
    ['Polymorphic as one node', ['40 targets in 1 box,', 'lines appear only on click']],
    ['Hub columns as badges', ['created_by → users shown in the box,', 'not 100 lines into one table']],
    ['Search + two modes', ['Business hides types,', 'Technical shows everything']],
  ];
  b += r(1150, 80, 410, 790, { fill: C.panel, stroke: C.gray, rx: 12 });
  notes.forEach(([h, d], i) => { const y = 130 + i * 120; b += badge(1184, y, i + 1) + t(1210, y + 6, h, { size: 18, weight: 700 }) + d.map((l, k) => t(1210, y + 34 + k * 22, l, { size: 14, fill: C.sub })).join(''); });
  b += path('M200 840 H240', { stroke: C.ink }) + one(200, 840, 1, C.ink) + t(250, 845, 'one', { size: 14, fill: C.sub });
  b += path('M320 840 H360', { stroke: C.ink }) + many(360, 840, -1, C.ink) + t(370, 845, 'many', { size: 14, fill: C.sub });
  b += path('M450 840 H500', { stroke: C.ink }) + t(510, 845, 'verified', { size: 14, fill: C.sub });
  b += path('M600 840 H650', { stroke: C.blue, dash: '7 5' }) + t(660, 845, 'inferred (cross-DB)', { size: 14, fill: C.sub });
  b += path('M820 840 H870', { stroke: C.purple, dash: '5 4' }) + t(880, 845, 'polymorphic', { size: 14, fill: C.sub });
  writeFileSync(`${out}/03-interactive-output.svg`, svg(1600, 900, b));
}

// ---------- 04 diff ----------
{
  let b = t(800, 50, 'Diff for humans: what changed between two versions', { size: 28, weight: 700, anchor: 'middle' });
  b += r(40, 80, 1520, 60, { fill: C.ink, stroke: C.ink, rx: 10 }) + t(64, 118, 'v1.0-handover  →  v1.2', { size: 20, weight: 700, fill: '#fff' });
  b += t(1536, 118, '+1 table  ·  −1 table  ·  1 renamed  ·  3 columns changed  ·  2 relations changed', { size: 18, fill: '#fff', anchor: 'end' });
  b += table(80, 210, 260, 'customers', [['id', 'bigint'], ['name', 'string']], { stroke: C.blue, sw: 2.5, head: C.blueBg });
  b += t(80, 200, 'renamed from clients', { size: 13, fill: C.blue, weight: 600 });
  b += table(460, 190, 290, 'orders', [['id', 'bigint'], ['customer_id', 'renamed', C.amber], ['status', '+ refunded', C.amber], ['coupon_id', 'removed', C.red]], { stroke: C.amber, sw: 3, head: C.amberBg });
  b += table(460, 500, 290, 'refunds', [['id', 'bigint', C.green], ['order_id', 'bigint', C.green], ['reason', 'enum', C.green]], { stroke: C.green, sw: 3, head: C.greenBg });
  b += t(460, 490, 'new table', { size: 13, fill: C.green, weight: 600 });
  b += table(80, 500, 260, 'coupons', [['id', 'bigint'], ['code', 'string']], { stroke: C.red, dash: '6 4', strike: true, op: 0.6, head: C.redBg });
  b += t(80, 490, 'removed table', { size: 13, fill: C.red, weight: 600 });
  b += path('M340 270 H460', { stroke: C.ink, sw: 2 }) + one(340, 270, 1, C.ink) + many(460, 270, -1, C.ink);
  b += path('M605 360 V500', { stroke: C.green, sw: 3 }) + vOne(605, 360, 1, C.green) + vMany(605, 500, -1, C.green);
  b += path('M340 560 H400 V313 H460', { stroke: C.red, sw: 2, dash: '6 4', op: 0.6 });
  // side panel
  b += r(840, 170, 720, 420, { fill: C.panel, stroke: C.gray, rx: 12 }) + t(866, 210, 'orders — 5 changes', { size: 20, weight: 700 });
  [['~', C.amber, 'Column client_id renamed to customer_id'], ['+', C.amber, 'Enum status: added value “refunded” (order money returned)'], ['−', C.red, 'Column coupon_id removed (coupons table dropped)'], ['+', C.green, 'New relation: one order has many refunds'], ['−', C.red, 'Relation to coupons removed']]
    .forEach(([m, c, s], i) => { const y = 260 + i * 60; b += `<circle cx="880" cy="${y - 6}" r="14" fill="${c}"/>` + t(880, y - 1, m, { size: 16, fill: '#fff', weight: 700, anchor: 'middle' }) + t(906, y, s, { size: 17 }); });
  b += t(866, 560, 'Click any coloured table to see its changes in plain English.', { size: 14, fill: C.sub, italic: true });
  // excel strip
  b += t(80, 690, 'Same changes in erd.xlsx → sheet “Changes”', { size: 18, weight: 700 });
  const cols = [['Database', 150], ['Table', 170], ['Change', 160], ['Detail', 520], ['Before', 220], ['After', 220]];
  let x = 80; cols.forEach(([h, w]) => { b += `<rect x="${x}" y="710" width="${w}" height="34" fill="#e2e8f0" stroke="#cbd5e1"/>` + t(x + 10, 733, h, { size: 15, weight: 700 }); x += w; });
  const rows = [['billing', 'clients', 'Renamed', 'Table renamed', 'clients', 'customers'], ['billing', 'refunds', 'Added', 'New table: money returned per order', '', 'refunds'], ['billing', 'orders', 'Changed', 'Enum status: added value', 'pending, paid', '+ refunded']];
  rows.forEach((row, i) => { let x2 = 80; row.forEach((v, j) => { const w = cols[j][1]; b += `<rect x="${x2}" y="${744 + i * 34}" width="${w}" height="34" fill="#fff" stroke="#cbd5e1"/>` + t(x2 + 10, 767 + i * 34, v, { size: 14 }); x2 += w; }); });
  writeFileSync(`${out}/04-diff.svg`, svg(1600, 880, b));
}
