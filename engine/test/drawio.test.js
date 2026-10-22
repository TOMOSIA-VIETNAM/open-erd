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
import { buildScene } from '../src/render/svg/render.js';
import { endMarkers } from '../src/render/svg/markers.js';
import { normalizeModel } from '../src/model/load.js';
import { MULTI, fk, loadMulti, loadWorkspace, table } from './helpers/shop.js';
import { descendants, parseXml } from './helpers/xml.js';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
const PATTERNS = fileURLToPath(new URL('./fixtures/workspace-patterns', import.meta.url));
const ER = { one: 'ERmandOne', zeroOrOne: 'ERzeroToOne', many: 'ERoneToMany', zeroOrMany: 'ERzeroToMany' };

const parseStyle = (text) => Object.fromEntries(text.split(';').filter(Boolean).map((kv) => kv.split('=')));

// Cells of one <diagram>, by id: a plain mxCell, or an mxCell wrapped in an
// <object> that carries the id, label and tooltip.
function cellsOf(diagram) {
  const root = descendants(diagram).find((e) => e.name === 'root');
  return root.children.map((el) => {
    const mx = el.name === 'object' ? el.children[0] : el;
    assert.equal(mx.name, 'mxCell');
    if (el.name === 'object') assert.equal(mx.attrs.id, undefined, 'a wrapped mxCell must not carry its own id');
    return { ...mx.attrs, id: el.attrs.id ?? mx.attrs.id, value: el.attrs.label ?? mx.attrs.value, tooltip: el.attrs.tooltip, style: parseStyle(mx.attrs.style ?? ''), geometry: mx.children[0] };
  });
}

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

test('drawio: two line styles as in the SVG, one neutral colour; tooltips only on enum columns', async () => {
  const { model, xml } = await multi();
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
  // Only rows of columns with enum values carry a tooltip: their values and meanings.
  const withEnum = new Set(model.tables.flatMap((t) => t.columns.filter((c) => c.enum && Object.keys(c.enum).length > 0).map((c) => `n|${t.id}|${c.name}`)));
  assert.ok(withEnum.size > 0);
  for (const page of parseXml(xml).children) {
    for (const c of cellsOf(page)) {
      if (withEnum.has(c.id)) assert.ok(c.tooltip, `${c.id} lacks its enum tooltip`);
      else assert.equal(c.tooltip, undefined, `${page.attrs.name}: ${c.id} has a tooltip`);
    }
  }
  assert.equal(all.get('n|shop._.orders|status').tooltip, 'pending: Created, waiting for payment\npaid: Payment confirmed by the gateway\ncancelled: Cancelled by the customer or by timeout');
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
});

test('CLI: render writes out/erd.drawio by default and none with outputs.drawio false', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'open-erd-'));
  const run = (...args) => promisify(execFile)(process.execPath, [CLI, ...args]);
  try {
    await cp(MULTI, dir, { recursive: true });
    await run('layout', '--workspace', dir);
    await run('render', '--workspace', dir);
    parseXml(await readFile(join(dir, 'out', 'erd.drawio'), 'utf8'));
    await rm(join(dir, 'out'), { recursive: true });
    const config = join(dir, 'open-erd.yaml');
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
