import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { VIEW_SOURCE, buildDiagram } from '../src/layout/diagram.js';
import { computeLayout } from '../src/layout/index.js';
import { ALL_VIEW, ALL_VIEW_MAX_TABLES, OVERVIEW, viewNames, viewTree } from '../src/layout/views.js';
import { applyProfile } from '../src/model/profile.js';
import { HUB_LAYER, POLY_LAYER, pageName, renderDrawio } from '../src/render/drawio/render.js';
import { buildScene, buildScenes, renderSvg } from '../src/render/svg/render.js';
import { endMarkers } from '../src/render/svg/markers.js';
import { normalizeModel } from '../src/model/load.js';
import { columnEntries } from '../src/model/columns.js';
import { MULTI, fk, loadMulti, loadWorkspace, table } from './helpers/shop.js';
import { descendants, parseXml } from './helpers/xml.js';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
const PATTERNS = fileURLToPath(new URL('./fixtures/workspace-patterns', import.meta.url));
const ER = { one: 'ERmandOne', zeroOrOne: 'ERzeroToOne', many: 'ERoneToMany', zeroOrMany: 'ERzeroToMany' };

const escapeAttr = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');
const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const parseStyle = (text) => Object.fromEntries(text.split(';').filter(Boolean).map((kv) => kv.split('=')));

// Cells of one <diagram>, by id: a plain mxCell, or an mxCell wrapped in a
// <UserObject> that carries the id, label, link and custom properties
// (`data`: every other attribute of the UserObject).
function cellsOf(diagram) {
  const root = descendants(diagram).find((e) => e.name === 'root');
  return root.children.map((el) => {
    const wrapped = el.name === 'UserObject';
    const mx = wrapped ? el.children[0] : el;
    assert.equal(mx.name, 'mxCell');
    if (wrapped) assert.equal(mx.attrs.id, undefined, 'a wrapped mxCell must not carry its own id');
    const { id, label, link, ...data } = wrapped ? el.attrs : {};
    return { ...mx.attrs, id: id ?? mx.attrs.id, value: label ?? mx.attrs.value, link, data, style: parseStyle(mx.attrs.style ?? ''), geometry: mx.children[0] };
  });
}

// Data URIs of the icon images in an HTML label, in order.
const iconsIn = (label) => [...label.matchAll(/<img src="(data:image\/svg\+xml;base64,[^"]+)"/g)].map((m) => Buffer.from(m[1].split(',')[1], 'base64').toString());

async function multi() {
  const model = await loadMulti();
  const { layout } = await computeLayout(model);
  return { model, layout, xml: renderDrawio(model, layout) };
}

test('the test XML parser rejects malformed input', () => {
  assert.throws(() => parseXml('<a><b></a>'));
  assert.throws(() => parseXml('<a x="1 & 2"/>'));
  assert.throws(() => parseXml('<a x="1" x="2"/>'));
  assert.throws(() => parseXml('<a>'));
});

test('drawio: well-formed plain XML, two pages (Overview, All tables), no timestamps', async () => {
  const { xml } = await multi();
  const file = parseXml(xml);
  assert.equal(file.name, 'mxfile');
  assert.equal(file.attrs.compressed, 'false');
  assert.equal(file.attrs.modified, undefined);
  assert.deepEqual(file.children.map((d) => d.attrs.id), [OVERVIEW, ALL_VIEW]);
  assert.deepEqual(file.children.map((d) => d.attrs.name), ['Overview', 'All tables']);
});

test('drawio: a schema without the view of all tables gets one page per domain instead', async () => {
  const model = await loadMulti();
  // More tables than the view of all tables allows, spread over two domains.
  const extra = Array.from({ length: ALL_VIEW_MAX_TABLES }, (_, i) => table(`shop._.filler_${String(i).padStart(3, '0')}`, i % 2 ? 'Catalog' : 'Orders', []));
  const big = { ...model, tables: [...model.tables, ...extra] };
  const diagram = buildDiagram(big);
  assert.ok(!viewNames(diagram).includes(ALL_VIEW));
  const { layout } = await computeLayout(big);
  const pages = parseXml(renderDrawio(big, layout)).children;
  const expected = viewNames(diagram);
  assert.deepEqual(pages.map((d) => d.attrs.id), expected);
  assert.deepEqual(pages.map((d) => d.attrs.name), expected.map(pageName));
});

test('drawio: ids are unique per page and every parent, source and target exists', async () => {
  const { xml } = await multi();
  for (const page of parseXml(xml).children) {
    const cells = cellsOf(page);
    const ids = new Set(cells.map((c) => c.id));
    assert.equal(ids.size, cells.length, `duplicate ids on page ${page.attrs.name}`);
    for (const c of cells) {
      if (c.parent !== undefined) assert.ok(ids.has(c.parent), `${c.id}: unknown parent ${c.parent}`);
      for (const end of [c.source, c.target]) if (end !== undefined) assert.ok(ids.has(end), `${c.id}: unknown end ${end}`);
    }
  }
});

test('drawio: every relation is a connector on its column rows with crow\'s foot ends and the routed waypoints', async () => {
  const { model, xml } = await multi();
  const diagram = buildDiagram(model);
  for (const page of parseXml(xml).children.slice(1)) {
    const name = page.attrs.id;
    const cells = new Map(cellsOf(page).map((c) => [c.id, c]));
    const { links } = viewTree(model, diagram, name);
    assert.ok(links.length > 0);
    for (const link of links) {
      const edge = cells.get(`e|${link.id}`);
      assert.ok(edge, `${name}: no connector for ${link.id}`);
      assert.equal(edge.edge, '1');
      assert.ok(descendants(edge.geometry).some((e) => e.name === 'Array'), 'waypoints from the router');
      assert.equal(edge.style.edgeStyle, 'orthogonalEdgeStyle');
      for (const [side, end] of [['from', edge.source], ['to', edge.target]]) {
        const node = diagram.nodes.get(link[side].node);
        const onRow = node?.kind === 'table' && link[side].column !== null && cells.get(`n|${node.id}`)?.style.shape === 'table';
        if (onRow) {
          assert.equal(end, `n|${node.id}|${link[side].column}`);
          assert.equal(cells.get(end).style.shape, 'tableRow');
          assert.equal(cells.get(end).parent, `n|${node.id}`);
        } else {
          assert.equal(end, `n|${link[side].node}`);
        }
      }
      if (link.kind === VIEW_SOURCE) continue;
      const markers = endMarkers(link);
      assert.equal(edge.style.startArrow, ER[markers.from], link.id);
      assert.equal(edge.style.endArrow, ER[markers.to], link.id);
    }
  }
});

test('drawio: the Overview page is the domain cards, without lines', async () => {
  const { model, xml } = await multi();
  const diagram = buildDiagram(model);
  const cells = cellsOf(parseXml(xml).children[0]);
  assert.deepEqual(cells.filter((c) => c.edge === '1'), []);
  const cards = cells.filter((c) => c.id.startsWith('n|') && !c.id.endsWith('|accent'));
  assert.deepEqual(cards.map((c) => c.id.slice(2)).sort(), [...diagram.clusters.keys()]);
  const orders = cards.find((c) => c.id === 'n|shop/Orders');
  assert.equal(orders.style.fillColor, '#ffffff');
  for (const text of ['Orders', '4 tables', 'What a customer bought, how it was paid and what was refunded.', 'Central: orders', 'Related domains', 'Content', 'Events', 'activity']) {
    assert.ok(orders.value.includes(text), text);
  }
  assert.ok(cells.some((c) => c.id === 'n|shop/Orders|accent' && c.parent === 'n|shop/Orders'));
});

test('drawio: two line styles as in the SVG, one neutral colour', async () => {
  const { xml } = await multi();
  const all = new Map(cellsOf(parseXml(xml).children.at(-1)).map((c) => [c.id, c]));
  const edge = (id) => all.get(`e|${id}`).style;
  // Cross-DB has no dash pattern of its own; its label names both databases.
  const crossDb = edge('activity._.page_views(product_id)->shop._.products(id)');
  assert.equal(crossDb.dashed, '0');
  assert.equal(all.get('e|activity._.page_views(product_id)->shop._.products(id)').value, 'activity → shop');
  // An unreviewed inference and a stale fact are dashed; colours stay neutral.
  for (const id of ['auth.public.memberships(role_id)->auth.public.roles(id)', 'shop._.products(brand_id)->shop._.brands(id)']) {
    assert.equal(edge(id).dashPattern, '6 4', id);
    assert.equal(edge(id).strokeColor, '#6b778a', id);
  }
  const poly = [...all.values()].find((c) => c.id.startsWith('e|') && c.id.includes('->«'));
  assert.equal(poly.style.dashed, '0');
});

test('drawio: no tooltip anywhere; details are Edit Data properties of table headers and column names', async () => {
  const { xml } = await multi();
  // draw.io draws an icon beside a cell with a tooltip or a note: no
  // tooltips, and a note on table headers only.
  assert.doesNotMatch(xml, /\btooltip=/);
  for (const page of parseXml(xml).children) {
    for (const c of cellsOf(page)) if (c.data.note !== undefined) assert.ok(c.style.shape === 'table' && c.data.table, `${c.id} has a note`);
  }
  const all = new Map(cellsOf(parseXml(xml).children.at(-1)).map((c) => [c.id, c]));
  const { note, ...orders } = all.get('n|shop._.orders').data;
  assert.ok(note);
  assert.deepEqual(orders, {
    table: 'shop._.orders',
    domain: 'Orders',
    description: 'One order per checkout; the basket becomes order items.',
    central: 'yes',
    indexes: "index_orders_on_placed_at: placed_at where status = 'paid'\nindex_orders_on_user_id_and_status: user_id, status",
  });
  assert.equal(all.get('n|auth.public.users').data.indexes, 'index_users_on_email: email unique\nindex_users_on_status: status');
  assert.deepEqual(all.get('n|shop._.orders|status|name').data, {
    column: 'status',
    type: 'varchar(16)',
    default: 'pending',
    primary_key: 'no',
    enum: 'pending — Created, waiting for payment\npaid — Payment confirmed by the gateway\ncancelled — Cancelled by the customer or by timeout',
    description: 'Lifecycle of the order; only paid orders are shipped.',
    pii: 'no',
  });
  const userId = all.get('n|shop._.orders|user_id|name').data;
  assert.equal(userId.references, 'auth.public.users.id');
  assert.equal(userId.nullable, 'no');
  assert.equal(all.get('n|shop._.orders|id|name').data.primary_key, 'yes');
  assert.equal(all.get('n|auth.public.users|email|name').data.pii, 'yes');
  // The label stays literal text: no placeholders.
  assert.doesNotMatch(xml, /placeholders=/);
});

test('drawio: table headers link to the SVG only when it is published; Overview cards link to the All tables page', async () => {
  const { model, layout, xml } = await multi();
  const pages = parseXml(xml).children;
  const headers = (cells) => cells.filter((c) => c.style.shape === 'table' && c.data.table);
  assert.ok(headers(cellsOf(pages.at(-1))).length > 0);
  for (const h of headers(cellsOf(pages.at(-1)))) assert.equal(h.link, undefined, `${h.id}: a relative link opens nothing in draw.io`);
  const url = 'https://example.com/erd/erd.svg';
  for (const h of headers(cellsOf(parseXml(renderDrawio(model, layout, { svgUrl: url })).children.at(-1)))) {
    assert.equal(h.link, `${url}#table=${encodeURIComponent(h.data.table)}`);
  }
  const cards = cellsOf(pages[0]).filter((c) => c.id.startsWith('n|') && !c.id.endsWith('|accent'));
  assert.ok(cards.length > 0);
  for (const c of cards) assert.equal(c.link, `data:page/id,${pages[1].attrs.id}`);
  assert.equal(pages[1].attrs.id, ALL_VIEW);
});

test('drawio: icons as in the SVG, as data URI images in the labels', async () => {
  const { xml } = await multi();
  const all = new Map(cellsOf(parseXml(xml).children.at(-1)).map((c) => [c.id, c]));
  const name = (row) => all.get(`${row}|name`);
  const icons = (row) => iconsIn(name(row).value);
  assert.equal(name('n|shop._.orders|id').style.html, '1');
  // Primary key: gold key; reference: blue link; enum and index marks after the name.
  assert.match(icons('n|shop._.orders|id')[0], /stroke="#c98a04"/);
  assert.match(icons('n|shop._.orders|user_id')[0], /stroke="#2f6fd6"/);
  const status = icons('n|shop._.orders|status');
  assert.equal(status.length, 2, 'enum and index marks');
  assert.match(status[0], /stroke="#7c5cc4"/);
  assert.match(status[1], /fill="#1f9d8f"/);
  // No key: an empty gutter keeps the name in line; the type on the right of the same label.
  assert.match(name('n|shop._.orders|status').value, /<span style="display:inline-block;width:15px"><\/span>status<img/);
  assert.match(name('n|shop._.orders|status').value, />varchar\(16\)<\/span><\/div>$/);
  // Header: star for a central table, table icon otherwise.
  assert.match(iconsIn(all.get('n|shop._.orders').value)[0], /fill="#f2b705"/);
  assert.equal(all.get('n|shop._.orders').style.html, '1');
  const plain = [...all.values()].find((c) => c.style.shape === 'table' && c.data.central === 'no');
  assert.match(iconsIn(plain.value)[0], /stroke="#5f6b7e"/);
  for (const svg of [...all.values()].flatMap((c) => iconsIn(c.value ?? ''))) parseXml(svg);
});

test('drawio: texts in the measured font, loaded by draw.io, and cut only when the layout cut them', async () => {
  const { model, layout, xml } = await multi();
  const page = cellsOf(parseXml(xml).children.at(-1));
  const texts = page.filter((c) => c.value && (c.vertex === '1' || c.edge === '1'));
  assert.ok(texts.length > 0);
  for (const c of texts) {
    assert.equal(c.style.fontFamily, 'Inter', c.id);
    assert.match(decodeURIComponent(c.style.fontSource), /^https:\/\/fonts\.googleapis\.com\/css2\?family=Inter/, c.id);
  }
  // The fixture's boxes hold every name and type: nothing is cut.
  assert.ok(!xml.includes('…'));
  // A box narrower than its text (the layout caps widths) is cut as in the SVG.
  const long = 'a_column_name_far_too_long_for_the_widest_box_the_layout_draws_at_all';
  const wide = normalizeModel({ ...model, tables: [...model.tables, table('shop._.wide', 'Catalog', [[long, 'bigint']])] });
  const { layout: wideLayout } = await computeLayout(wide);
  const row = cellsOf(parseXml(renderDrawio(wide, wideLayout)).children.at(-1)).find((c) => c.id === `n|shop._.wide|${long}|name`);
  assert.match(row.value, /…/);
});

test('drawio: a table header carries the table\'s note as HTML (description, columns, indexes, relations)', async () => {
  const { model, xml } = await multi();
  const all = new Map(cellsOf(parseXml(xml).children.at(-1)).map((c) => [c.id, c]));
  const note = all.get('n|shop._.orders').data.note;
  const orders = model.tables.find((t) => t.id === 'shop._.orders');
  assert.match(note, /^<p[^>]*><b>shop\._\.orders<\/b><\/p><p[^>]*>One order per checkout; the basket becomes order items\.<\/p>/);
  // One header row, then one row per column.
  const table = note.match(/<table[^>]*>([\s\S]*?)<\/table>/)[1];
  const rows = table.match(/<tr[^>]*>[\s\S]*?<\/tr>/g);
  assert.equal(rows.length, orders.columns.length + 1);
  assert.deepEqual([...rows[0].matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]), ['Column', 'Type', 'Null', 'Default', 'Comment']);
  const cellsOfRow = (name) => [...rows.find((r) => new RegExp(`(<td[^>]*>|> |<b>)${name}(</b>)?</td>`).test(r)).matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
  const [statusName, statusType, , statusDefault, statusComment] = cellsOfRow('status');
  assert.match(statusName, />IX<\/span> .*>ENUM<\/span> status$/);
  assert.equal(statusType, 'varchar(16)');
  assert.equal(statusDefault, 'pending');
  assert.equal(statusComment, 'Lifecycle of the order; only paid orders are shipped.<br>pending — Created, waiting for payment<br>paid — Payment confirmed by the gateway<br>cancelled — Cancelled by the customer or by timeout');
  assert.match(cellsOfRow('id')[0], />PK<\/span> <b>id<\/b>$/);
  assert.match(cellsOfRow('user_id')[0], />FK<\/span> /);
  assert.equal(cellsOfRow('user_id')[2], 'no');
  assert.match(note, /<b>Indexes<\/b><\/p>index_orders_on_placed_at: placed_at where status = 'paid'<br>index_orders_on_user_id_and_status: user_id, status<br>/);
  assert.match(note, /<b>References<\/b><\/p>[^]*user_id → auth\.public\.users\.id<br>/);
  assert.match(note, /<b>Referenced by<\/b><\/p>[^]*shop\._\.order_items\.order_id → id<br>/);
});

// Cell a column's link jumps to, from its draw.io action JSON.
function jumpTarget(link) {
  assert.ok(link.startsWith('data:action/json,'), link);
  const { actions } = JSON.parse(link.slice('data:action/json,'.length));
  const [cell] = actions[0].select.cells;
  assert.deepEqual(actions, [{ select: { cells: [cell] } }, { scroll: { cells: [cell] } }, { highlight: { cells: [cell], color: '#2563eb' } }]);
  return cell;
}

test('drawio: a referencing column links to what it references on the same page', async () => {
  const base = await loadMulti();
  // A composite reference: both of its columns go to the one table.
  const pair = table('shop._.order_notes', 'Orders', [['order_id', 'bigint'], ['order_item_id', 'bigint']]);
  const composite = { ...fk(pair.id, 'order_id', 'shop._.order_items'), from: { table: pair.id, columns: ['order_id', 'order_item_id'] }, to: { table: 'shop._.order_items', columns: ['order_id', 'id'] } };
  const model = normalizeModel({ ...base, tables: [...base.tables, pair], relations: [...base.relations, composite] });
  const { layout } = await computeLayout(model);
  const xml = renderDrawio(model, layout);
  const all = new Map(cellsOf(parseXml(xml).children.at(-1)).map((c) => [c.id, c]));
  const link = (row) => all.get(`${row}|name`).link;
  assert.equal(jumpTarget(link('n|shop._.orders|user_id')), 'n|auth.public.users');
  assert.equal(jumpTarget(link(`n|${pair.id}|order_id`)), 'n|shop._.order_items');
  assert.equal(jumpTarget(link(`n|${pair.id}|order_item_id`)), 'n|shop._.order_items');
  // A polymorphic id column goes to the polymorphic node.
  const poly = model.polymorphic[0];
  const polyTarget = jumpTarget(link(`n|${poly.table}|${poly.id_column}`));
  assert.ok(all.get(polyTarget) && polyTarget.includes(poly.name), polyTarget);
  // Columns referencing nothing have no link; every target is a cell of the page.
  assert.equal(link('n|shop._.orders|status'), undefined);
  for (const c of all.values()) if (c.id.endsWith('|name') && c.link) assert.ok(all.has(jumpTarget(c.link)), c.id);
  // A table header keeps its own (optional) link to the SVG.
  const linked = cellsOf(parseXml(renderDrawio(model, layout, { svgUrl: 'https://example.com/erd.svg' })).children.at(-1));
  assert.equal(linked.find((c) => c.id === 'n|shop._.orders').link, 'https://example.com/erd.svg#table=shop._.orders');
  assert.equal(renderDrawio(model, layout), xml);
});

test('drawio: on a domain page, a column referencing a table outside goes to its stub or group', async () => {
  const base = await loadMulti();
  const sales = Array.from({ length: ALL_VIEW_MAX_TABLES }, (_, i) => table(`shop._.s${String(i).padStart(3, '0')}`, 'Sales', [['core_id', 'bigint']]));
  const model = normalizeModel({ ...base, tables: [...base.tables, table('shop._.core', 'Core', []), ...sales], relations: [...base.relations, ...sales.slice(0, 3).map((t) => fk(t.id, 'core_id', 'shop._.core'))] });
  const { layout } = await computeLayout(model);
  const pages = parseXml(renderDrawio(model, layout)).children;
  const salesPage = new Map(cellsOf(pages.find((d) => d.attrs.id === 'domain:shop/Sales')).map((c) => [c.id, c]));
  assert.equal(jumpTarget(salesPage.get('n|shop._.s000|core_id|name').link), 'n|shop._.core');
  assert.equal(salesPage.get('n|shop._.core').style.shape === 'table', false, 'core is a stub on the Sales page');
  const orders = new Map(cellsOf(pages.find((d) => d.attrs.id === 'domain:shop/Orders')).map((c) => [c.id, c]));
  // Another domain's table is a stub here; a hub table (users) is not drawn, so no link.
  assert.equal(jumpTarget(orders.get('n|shop._.orders|organization_id|name').link), 'n|auth.public.organizations');
  assert.equal(orders.get('n|shop._.orders|user_id|name').link, undefined);
});

test('drawio: hub and polymorphic target lines sit on their own hidden layers, attached to existing rows', async () => {
  const { model, layout, xml } = await multi();
  const diagram = buildDiagram(model);
  const seen = { hub: 0, poly: 0 };
  for (const page of parseXml(xml).children) {
    const scene = buildScene(model, layout, page.attrs.id, diagram);
    const cells = new Map(cellsOf(page).map((c) => [c.id, c]));
    const expected = [
      [HUB_LAYER, scene.hubRoutes.map((r) => `hub|${r.link.id}`), 'hub'],
      [POLY_LAYER, scene.polyRoutes.map((r) => `poly|${r.poly}->${r.target}`), 'poly'],
    ];
    for (const [layer, ids, kind] of expected) {
      const cell = cells.get(layer.id);
      if (ids.length === 0) {
        assert.equal(cell, undefined, `${page.attrs.id}: empty layer ${layer.name}`);
        continue;
      }
      assert.equal(cell.parent, '0');
      assert.equal(cell.visible, '0', `${layer.name} must start hidden`);
      assert.equal(cell.value, layer.name);
      for (const id of ids) {
        const edge = cells.get(id);
        assert.ok(edge, `${page.attrs.id}: missing ${id}`);
        assert.equal(edge.parent, layer.id);
        for (const end of [edge.source, edge.target]) {
          const target = cells.get(end);
          assert.ok(target && target.vertex === '1', `${id}: end ${end} is not a drawn cell`);
          if (end.split('|').length > 2) assert.equal(target.style.shape, 'tableRow');
        }
        seen[kind] += 1;
      }
    }
  }
  assert.ok(seen.hub > 0 && seen.poly > 0, 'the fixture must exercise both layers');
});

test('drawio: two renders are byte-identical', async () => {
  const { model, layout, xml } = await multi();
  assert.equal(renderDrawio(model, layout), xml);
});

test('drawio: a public profile render holds no hidden table, hidden or PII column, evidence or internal note', async () => {
  const model = await loadWorkspace(PATTERNS);
  const { layout } = await computeLayout(model);
  const full = renderDrawio(model, layout);
  const shared = renderDrawio(applyProfile(model, 'public'), layout, { fitStored: true });
  parseXml(shared);
  const secrets = ['audit_secrets', 'tax_number', 'email_address', 'ship_line1'];
  for (const text of secrets) {
    assert.ok(full.includes(text), `full render lacks ${text}, so the check below proves nothing`);
    assert.ok(!shared.includes(text), `public render leaks ${text}`);
  }
  for (const e of new Set([...model.relations, ...model.polymorphic].flatMap((f) => f.evidence))) assert.ok(!shared.includes(e), `public render leaks evidence ${e}`);
  const internal = model.tables.flatMap((t) => [t.internal_note, ...columnEntries(t).map(({ column: c }) => c.internal_note)]).filter(Boolean);
  assert.ok(internal.length > 0, 'the fixture must have internal notes');
  for (const note of internal) assert.ok(full.includes(escapeAttr(escapeHtml(note))), `full render lacks the internal note ${note}, so the check below proves nothing`);
  const notes = model.tables.flatMap((t) => [t.internal_note, t.note_source, ...columnEntries(t).flatMap(({ column: c }) => [c.internal_note, c.note_source])]).filter(Boolean);
  for (const note of notes) {
    assert.ok(!shared.includes(escapeAttr(escapeHtml(note))) && !shared.includes(escapeAttr(note)), `public render leaks note ${note}`);
  }
});

test('CLI: render writes out/erd.drawio (headers linking to erd.svg; erd.<profile>.svg for a profile) and none with outputs.drawio false', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'open-erd-'));
  const run = (...args) => promisify(execFile)(process.execPath, [CLI, ...args]);
  try {
    await cp(MULTI, dir, { recursive: true });
    await run('layout', '--workspace', dir);
    await run('render', '--workspace', dir);
    assert.doesNotMatch(await readFile(join(dir, 'out', 'erd.drawio'), 'utf8'), /#table=/);
    const config = join(dir, 'open-erd.yaml');
    const original = await readFile(config, 'utf8');
    await writeFile(config, `${original}outputs: { drawio_svg_url: "https://example.com/erd/erd.svg" }\n`);
    await run('render', '--workspace', dir);
    assert.match(await readFile(join(dir, 'out', 'erd.drawio'), 'utf8'), /link="https:\/\/example\.com\/erd\/erd\.svg#table=shop\._\.orders"/);
    await run('render', '--workspace', dir, '--profile', 'public');
    const shared = await readFile(join(dir, 'out', 'erd.public.drawio'), 'utf8');
    parseXml(shared);
    assert.match(shared, /link="https:\/\/example\.com\/erd\/erd\.public\.svg#table=/);
    assert.doesNotMatch(shared, /erd\.svg#/);
    await writeFile(config, `${original}outputs: { drawio_svg_url: "erd.svg" }\n`);
    await assert.rejects(run('validate', '--workspace', dir), /drawio_svg_url/);
    await writeFile(config, original);
    await rm(join(dir, 'out'), { recursive: true });
    await writeFile(config, `${await readFile(config, 'utf8')}outputs: { drawio: false }\n`);
    const { stdout } = await run('render', '--workspace', dir);
    assert.doesNotMatch(stdout, /drawio/);
    assert.deepEqual((await readdir(join(dir, 'out'))).sort(), ['erd.svg', 'erd.xlsx']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('drawio: a per-domain page draws group stubs as one box, their bundled lines as connectors', async () => {
  const base = await loadMulti();
  // Too many tables for the view of all tables: one page per domain. Sales
  // tables all reference one Core table, so Core's page groups them.
  const sales = Array.from({ length: ALL_VIEW_MAX_TABLES }, (_, i) => table(`shop._.s${String(i).padStart(3, '0')}`, 'Sales', [['core_id', 'bigint']]));
  const model = normalizeModel({ ...base, tables: [...base.tables, table('shop._.core', 'Core', []), ...sales], relations: [...base.relations, ...sales.slice(0, 3).map((t) => fk(t.id, 'core_id', 'shop._.core'))] });
  const { layout } = await computeLayout(model);
  const page = parseXml(renderDrawio(model, layout)).children.find((d) => d.attrs.id === 'domain:shop/Core');
  const cells = cellsOf(page);
  const group = cells.find((c) => c.id === 'n|group:shop/Sales');
  assert.ok(group && group.value.includes('Sales') && group.value.includes('s000'));
  assert.ok(cells.some((c) => c.edge === '1' && (c.source === 'n|group:shop/Sales' || c.target === 'n|group:shop/Sales')));
});

test('a polymorphic target left with no columns still renders in SVG and draw.io', async () => {
  const model = await loadMulti();
  const targets = new Set(model.polymorphic.flatMap((a) => a.targets));
  const columns = model.tables.filter((t) => targets.has(t.id)).flatMap((t) => t.columns.map((c) => `${t.id}.${c.name}`));
  // The profile drops every column of the targets, and the relations that use them.
  const shown = applyProfile({ ...model, config: { ...model.config, hidden: { columns } } }, 'public');
  assert.ok(shown.polymorphic.length > 0 && shown.tables.some((t) => targets.has(t.id) && t.columns.length === 0));
  const { layout } = await computeLayout(shown);
  assert.doesNotThrow(() => renderSvg(shown, layout, { fitStored: true }));
  assert.doesNotThrow(() => renderDrawio(shown, layout, { fitStored: true }));
});

test('prebuilt scenes give the same SVG and draw.io bytes as building them per file', async () => {
  const model = await loadMulti();
  const { layout } = await computeLayout(model);
  const scenes = buildScenes(model, layout);
  assert.equal(renderSvg(model, layout, { scenes }), renderSvg(model, layout));
  assert.equal(renderDrawio(model, layout, { scenes }), renderDrawio(model, layout));
});
