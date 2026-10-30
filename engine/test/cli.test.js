import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

async function run(...args) {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, ...args]);
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

test('--help lists every command', async () => {
  const { code, stdout } = await run('--help');
  assert.equal(code, 0);
  for (const name of ['validate', 'lock', 'verify', 'facts-diff', 'layout', 'render', 'diff']) assert.match(stdout, new RegExp(`^  ${name} `, 'm'));
});

test('validate exits 0 on a valid workspace and 1 with file paths on errors', async () => {
  assert.equal((await run('validate', '--workspace', fixture('workspace-valid'))).code, 0);
  const bad = await run('validate', '--workspace', fixture('workspace-invalid'));
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /^model\/shop\.yaml: tables\[2\]\.columns\[1\]\.enum: /m);
});

test('missing --workspace and unknown commands fail', async () => {
  assert.equal((await run('validate')).code, 1);
  assert.equal((await run('frobnicate')).code, 1);
});

test('--version prints the engine version from package.json', async () => {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  for (const flag of ['--version', '-v']) {
    const { code, stdout } = await run(flag);
    assert.equal(code, 0);
    assert.equal(stdout, `${version}\n`);
  }
});

test('the bundle runs when reached through a symlinked directory', async (t) => {
  // A plugin directory linked into place: node resolves the bundle's own URL
  // to the real path but keeps the linked path in argv, and the entry check
  // must still treat it as the started script.
  const dir = await mkdtemp(join(tmpdir(), 'open-erd-link-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const link = join(dir, 'dist');
  try {
    await symlink(fileURLToPath(new URL('../../dist', import.meta.url)), link, 'dir');
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') return t.skip('symlinks not permitted here');
    throw e;
  }
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const { stdout } = await promisify(execFile)(process.execPath, [join(link, 'open-erd.mjs'), '--version']);
  assert.equal(stdout, `${version}\n`);
});

test('layout --relayout rejects an unknown view before writing anything', async () => {
  const { code, stderr } = await run('layout', '--workspace', fixture('workspace-valid'), '--relayout', 'domain:nope/Nope');
  assert.equal(code, 1);
  assert.match(stderr, /--relayout: unknown view "domain:nope\/Nope" \(views: overview, all, domain:/);
  const { stdout } = await run('layout', '--help');
  assert.match(stdout, /--relayout <view>/);
});

test('layout and render refuse a model with no tables instead of drawing an infinite canvas', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'open-erd-empty-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'model'));
  await writeFile(join(dir, 'open-erd.yaml'), 'schema_version: 1\n');
  await writeFile(join(dir, 'model', 'empty.yaml'), 'schema_version: 1\ndatabase: empty\nengine: mysql\ntables: []\n');
  for (const command of ['layout', 'render']) {
    const { code, stderr } = await run(command, '--workspace', dir);
    assert.equal(code, 1, command);
    assert.match(stderr, /error: the model has no tables/);
  }
});
