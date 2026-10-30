import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ExcelJS from 'exceljs';
import { parseVerification, serializeVerification, verificationSummary } from '../src/model/verification.js';
import { factsFromModel } from './helpers/facts.js';
import { MULTI, loadMulti } from './helpers/shop.js';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

async function run(...args) {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, ...args]);
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

const RECORD = `schema_version: 1
facts:
  - fact: relation shop.public.orders.user_id -> auth.public.users.id
    result: confirmed
  - fact: shop.public.orders.status.enum.paid
    result: wrong
    reason: The code sets paid when the order ships, not on payment.
  - fact: auth.public.users.note
    result: unverifiable
    reason: No code reads the table.
  - fact: shop.public.orders.note
    result: fixed
    reason: Said one row per cart; the code creates one per checkout.
`;

test('the verification record round-trips sorted, worst verdict first', () => {
  const { verification, errors } = parseVerification(RECORD);
  assert.deepEqual(errors, []);
  const text = serializeVerification(verification);
  assert.deepEqual(
    parseVerification(text).verification.facts.map((f) => f.result),
    ['wrong', 'unverifiable', 'fixed', 'confirmed'],
  );
  // Same verdicts in another order give the same bytes.
  const reversed = { ...verification, facts: [...verification.facts].reverse() };
  assert.equal(serializeVerification(reversed), text);
  assert.equal(verificationSummary(verification), 'verify: confirmed 1, fixed 1, unverifiable 1, wrong 1');
});

test('the verification record rejects an unknown result, a missing fact and duplicates', () => {
  const bad = parseVerification('schema_version: 1\nfacts:\n  - { fact: a, result: maybe }\n  - { result: confirmed }\n');
  assert.equal(bad.verification, null);
  assert.deepEqual(bad.errors.map((e) => e.path), ['facts[0].result', 'facts[1].fact']);
  const twice = parseVerification('schema_version: 1\nfacts:\n  - { fact: a, result: confirmed }\n  - { fact: a, result: wrong }\n');
  assert.deepEqual(twice.errors.map((e) => `${e.path}: ${e.message}`), ['facts[1].fact: duplicate fact "a"']);
});

// A copy of workspace-multi with facts matching its model.
async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'open-erd-verify-'));
  await cp(MULTI, dir, { recursive: true });
  await mkdir(join(dir, 'extract', 'facts'), { recursive: true });
  for (const { file, data } of factsFromModel(await loadMulti())) await writeFile(join(dir, 'extract', 'facts', file), JSON.stringify(data));
  return dir;
}

test('verify passes on facts matching the model and fails with one line per mismatch', async () => {
  const dir = await workspace();
  try {
    const ok = await run('verify', '--workspace', dir);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /model matches the extract facts \(\d+ file\(s\), \d+ table\(s\)\)/);

    const file = join(dir, 'extract', 'facts', 'app-shop.json');
    const data = JSON.parse(await readFile(file, 'utf8'));
    data.tables[0].columns[0].type = 'uuid';
    await writeFile(file, JSON.stringify(data));
    const bad = await run('verify', '--workspace', dir);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, new RegExp(`^mismatch: column shop\\._\\.${data.tables[0].name}\\.${data.tables[0].columns[0].name}: type ".*" in the model, "uuid" in the facts$`, 'm'));
    assert.match(bad.stderr, /1 mismatch\(es\)/);

    // --facts reads another directory; a directory without facts fails.
    assert.equal((await run('verify', '--workspace', dir, '--facts', join(dir, 'model'))).code, 1);
    const none = await run('verify', '--workspace', dir, '--facts', join(dir, 'nowhere'));
    assert.match(none.stderr, /no facts files \(\*\.json\) in .*nowhere: run the extract scripts first/);

    // verify: off skips the comparison.
    await writeFile(join(dir, 'open-erd.yaml'), `${await readFile(join(dir, 'open-erd.yaml'), 'utf8')}verify: off\n`);
    const off = await run('verify', '--workspace', dir);
    assert.equal(off.code, 0);
    assert.match(off.stdout, /verify: off in open-erd\.yaml/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('verify and validate check the record; verify rewrites it sorted and prints the commit line', async () => {
  const dir = await workspace();
  try {
    await mkdir(join(dir, 'tests'), { recursive: true });
    await writeFile(join(dir, 'tests', 'verification.yaml'), RECORD);
    const ok = await run('verify', '--workspace', dir);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /^tests\/verification\.yaml: verify: confirmed 1, fixed 1, unverifiable 1, wrong 1$/m);
    const text = await readFile(join(dir, 'tests', 'verification.yaml'), 'utf8');
    assert.equal(text, serializeVerification(parseVerification(RECORD).verification));

    await writeFile(join(dir, 'tests', 'verification.yaml'), 'schema_version: 1\nfacts:\n  - { fact: a, result: maybe }\n');
    for (const command of ['verify', 'validate']) {
      const bad = await run(command, '--workspace', dir);
      assert.equal(bad.code, 1);
      assert.match(bad.stderr, /^tests\/verification\.yaml: facts\[0\]\.result: must be one of/m);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('render adds the Verification sheet, never under a profile that drops evidence or internal notes', async () => {
  const dir = await workspace();
  const sheets = async (name) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await readFile(join(dir, 'out', `${name}.xlsx`)));
    return workbook;
  };
  try {
    assert.equal((await run('layout', '--workspace', dir)).code, 0);
    assert.equal((await run('render', '--workspace', dir)).code, 0);
    assert.equal((await sheets('erd')).getWorksheet('Verification'), undefined);

    await mkdir(join(dir, 'tests'), { recursive: true });
    await writeFile(join(dir, 'tests', 'verification.yaml'), RECORD);
    await writeFile(join(dir, 'open-erd.yaml'), `${await readFile(join(dir, 'open-erd.yaml'), 'utf8')}profiles:\n  team: { drop_evidence: false, drop_notes: [] }\n`);
    for (const args of [[], ['--profile', 'public'], ['--profile', 'team']]) assert.equal((await run('render', '--workspace', dir, ...args)).code, 0);
    const sheet = (await sheets('erd')).getWorksheet('Verification');
    assert.deepEqual(sheet.getRow(1).values.slice(1), ['Fact', 'Result', 'Reason']);
    assert.deepEqual(sheet.getRow(2).values.slice(1), ['shop.public.orders.status.enum.paid', 'wrong', 'The code sets paid when the order ships, not on payment.']);
    assert.equal(sheet.rowCount, 5);
    assert.equal((await sheets('erd.public')).getWorksheet('Verification'), undefined);
    assert.ok((await sheets('erd.team')).getWorksheet('Verification'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a sharing profile keeps the Verification sheet without the facts that name what it hides', async () => {
  const dir = await workspace();
  try {
    await mkdir(join(dir, 'tests'), { recursive: true });
    await writeFile(
      join(dir, 'tests', 'verification.yaml'),
      `schema_version: 1
facts:
  - { fact: auth.public.users.email.note, result: confirmed }
  - { fact: shop._.brands.note, result: confirmed }
  - { fact: shop._.brands_archive.note, result: confirmed }
  - { fact: relation shop._.products.brand_id -> shop._.brands.id, result: confirmed }
  - { fact: shop._.tags.note, result: confirmed }
`,
    );
    await writeFile(
      join(dir, 'open-erd.yaml'),
      `${await readFile(join(dir, 'open-erd.yaml'), 'utf8')}profiles:\n  team: { drop_evidence: false, drop_notes: [], drop_pii: true, hide: { tables: [shop._.brands] } }\n`,
    );
    assert.equal((await run('layout', '--workspace', dir)).code, 0);
    const rendered = await run('render', '--workspace', dir, '--profile', 'team');
    assert.equal(rendered.code, 0, rendered.stderr);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await readFile(join(dir, 'out', 'erd.team.xlsx')));
    const facts = workbook.getWorksheet('Verification').getSheetValues().slice(2).map((row) => row[1]);
    assert.deepEqual(facts, ['shop._.brands_archive.note', 'shop._.tags.note']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
