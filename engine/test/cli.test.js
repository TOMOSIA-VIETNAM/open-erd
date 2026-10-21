import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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
  for (const name of ['validate', 'layout', 'render', 'diff']) assert.match(stdout, new RegExp(`^  ${name} `, 'm'));
});

test('validate exits 0 on a valid workspace and 1 with file paths on errors', async () => {
  assert.equal((await run('validate', '--workspace', fixture('workspace-valid'))).code, 0);
  const bad = await run('validate', '--workspace', fixture('workspace-invalid'));
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /^model\/shop\.yaml: tables\[2\]\.columns\[1\]\.enum: /m);
});

test('unimplemented commands fail loudly', async () => {
  const { code, stderr } = await run('diff', '--workspace', fixture('workspace-valid'));
  assert.equal(code, 2);
  assert.match(stderr, /not implemented yet/);
});

test('missing --workspace and unknown commands fail', async () => {
  assert.equal((await run('validate')).code, 1);
  assert.equal((await run('frobnicate')).code, 1);
});
