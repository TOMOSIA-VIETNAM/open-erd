import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { computeLayout } from '../src/layout/index.js';
import { parseWorkspace } from '../src/model/load.js';
import { applyProfile, resolveProfile } from '../src/model/profile.js';
import { PROFILE_DEFAULTS } from '../src/model/schema.js';
import { renderSvg } from '../src/render/svg/render.js';
import { buildWorkbook, serializeWorkbook } from '../src/render/xlsx/workbook.js';
import { loadWorkspace } from './helpers/shop.js';
import { xlsxParts } from './helpers/xlsx.js';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
const PATTERNS = fileURLToPath(new URL('./fixtures/workspace-patterns', import.meta.url));

// Strings that only the full render may contain. Names carry an underscore or
// punctuation so they cannot occur by chance in the embedded base64 font.
const SECRETS = {
  hiddenTable: 'audit_secrets',
  hiddenColumn: 'tax_number',
  piiColumn: 'email_address',
  embeddedPii: 'ship_line1',
  internalNote: 'Ask the billing team before changing this.',
  noteSource: '納税者番号',
};

async function renders() {
  const model = await loadWorkspace(PATTERNS);
  const { layout } = await computeLayout(model);
  return { model, layout, full: renderSvg(model, layout), shared: renderSvg(applyProfile(model, 'public'), layout, { fitStored: true }) };
}

// Every XML part of the workbook, concatenated: shared strings, sheets,
// hyperlink targets and document properties.
async function xlsxText(model) {
  const parts = xlsxParts(await serializeWorkbook(buildWorkbook(model), { date: new Date(0) }));
  // XML escapes the quotes and ampersands a secret might contain.
  return Object.values(parts).join('\n').replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('&apos;', "'");
}

for (const output of ['svg', 'xlsx']) {
  test(`public ${output} holds no hidden table, hidden or PII column, evidence or internal note`, async () => {
    const { model, full: fullSvg, shared: sharedSvg } = await renders();
    const [full, shared] = output === 'svg' ? [fullSvg, sharedSvg] : [await xlsxText(model), await xlsxText(applyProfile(model, 'public'))];
    const evidence = [...new Set([...model.relations, ...model.polymorphic].flatMap((f) => f.evidence))];
    assert.ok(evidence.length > 0);
    for (const [what, text] of Object.entries(SECRETS)) {
      assert.ok(full.includes(text), `full render lacks ${what}, so the check below proves nothing`);
      assert.ok(!shared.includes(text), `public render leaks ${what}: ${text}`);
    }
    for (const e of evidence) {
      assert.ok(full.includes(e), `full render lacks evidence ${e}`);
      assert.ok(!shared.includes(e), `public render leaks evidence ${e}`);
    }
    // Business notes and enum meanings are what the shared file is for.
    assert.ok(shared.includes('Customers and vendors of one tenant, in one table.'));
    assert.ok(shared.includes('Buys products (Customer)'));
  });
}

test('a profile keeps the full layout: shown boxes stay where they were', async () => {
  const { full, shared } = await renders();
  // Table id and box corner, per view, in document order.
  const corners = (svg) =>
    [...svg.matchAll(/<g class="table[^"]*" data-id="([^"]+)">(?:<title>[^<]*<\/title>)?(?:<rect class="tenant-copy"[^>]*>)*<rect class="table-box" x="([^"]+)" y="([^"]+)"/g)].map(
      (m) => `${m[1]} ${m[2]},${m[3]}`,
    );
  const before = new Set(corners(full));
  const after = corners(shared);
  assert.ok(after.length > 0 && after.length < before.size);
  for (const line of after) assert.ok(before.has(line), `${line} moved`);
});

test('hiding cascades to relations, polymorphic targets, view sources and keys', async () => {
  const model = await loadWorkspace(PATTERNS);
  const partner = applyProfile(model, 'partner');
  const ids = new Set(partner.tables.map((t) => t.id));
  assert.ok(!ids.has('store.public.plans') && !ids.has('store.tenant.audit_secrets'));
  assert.ok(partner.relations.every((r) => ids.has(r.from.table) && ids.has(r.to.table)));
  // partner keeps evidence, public drops it.
  assert.ok(partner.relations.every((r) => r.evidence.length > 0));
  assert.ok(applyProfile(model, 'public').relations.every((r) => r.evidence === undefined));

  const hideKey = {
    ...model,
    config: { ...model.config, profiles: { p: { hide: { tables: ['store.tenant.orders'], columns: ['store.tenant.order_lines.position', 'docs._.reviews.replies'] } } } },
  };
  const p = applyProfile(hideKey, 'p');
  const lines = p.tables.find((t) => t.id === 'store.tenant.order_lines');
  assert.equal(lines.unique, undefined, 'a unique key over a hidden column goes');
  assert.ok(!lines.columns.some((c) => c.name === 'position'));
  assert.deepEqual(p.tables.find((t) => t.id === 'store.public.sales_by_month').sources, ['store.tenant.order_lines']);
  const reviews = p.tables.find((t) => t.id === 'docs._.reviews');
  assert.deepEqual(reviews.embedded.map((e) => e.name), ['shipping']);
  assert.ok(!p.relations.some((r) => r.from.columns.includes('replies.author')));
  // Embedded PII goes; the entity stays while it has columns.
  assert.deepEqual(reviews.embedded[0].columns.map((c) => c.name), ['city']);
  assert.equal(p.config.hidden, undefined);
  assert.equal(p.config.profiles, undefined);
});

test('profiles resolve over the defaults; unknown names are errors', async () => {
  const model = await loadWorkspace(PATTERNS);
  assert.deepEqual(resolveProfile(model.config, 'public'), PROFILE_DEFAULTS);
  assert.deepEqual(resolveProfile(model.config, 'partner'), { ...PROFILE_DEFAULTS, drop_evidence: false, hide: { tables: ['store.public.plans'], columns: [] } });
  assert.throws(() => applyProfile(model, 'publik'), /unknown profile "publik" \(known: partner, public\)/);
});

test('profile config is validated: names, note fields, hidden columns', () => {
  const files = (config) => ({
    'open-erd.yaml': `schema_version: 1\n${config}`,
    'model/a.yaml': 'schema_version: 1\ndatabase: a\nengine: mysql\ntables:\n  - { id: a._.t, domain: D, columns: [{ name: id, type: int }] }\n',
  });
  const errors = (config) => parseWorkspace(files(config)).errors.map((e) => `${e.path}: ${e.message}`);
  assert.deepEqual(errors('profiles:\n  "../x": {}\n'), ['profiles["../x"]: invalid key "../x", expected letters, digits, - and _']);
  assert.match(errors('profiles:\n  p: { drop_notes: [secret] }\n')[0], /^profiles\.p\.drop_notes\[0\]: must be one of note \| note_source \| internal_note/);
  assert.deepEqual(errors('hidden: { columns: [a._.t.nope] }\n'), ['hidden.columns[0]: unknown column "a._.t.nope"']);
  assert.deepEqual(errors('profiles:\n  p: { hide: { tables: [a._.x] } }\n'), ['profiles.p.hide.tables[0]: unknown table "a._.x"']);
});

test('CLI: render --profile writes out/erd.<profile>.svg and .xlsx next to erd.svg and erd.xlsx', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'open-erd-'));
  const run = (...args) => promisify(execFile)(process.execPath, [CLI, ...args]);
  try {
    await cp(PATTERNS, dir, { recursive: true });
    await run('layout', '--workspace', dir);
    await run('render', '--workspace', dir);
    const { stdout } = await run('render', '--workspace', dir, '--profile', 'public');
    assert.match(stdout, /erd\.public\.xlsx \(profile public\)/);
    assert.deepEqual((await readdir(join(dir, 'out'))).sort(), ['erd.public.svg', 'erd.public.xlsx', 'erd.svg', 'erd.xlsx']);
    assert.ok(!(await readFile(join(dir, 'out', 'erd.public.svg'), 'utf8')).includes('audit_secrets'));
    await assert.rejects(run('render', '--workspace', dir, '--profile', 'nope'), (e) => e.code === 1 && /unknown profile "nope"/.test(e.stderr));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
