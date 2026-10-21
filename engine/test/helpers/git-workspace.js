import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const CLI = fileURLToPath(new URL('../../cli.js', import.meta.url));
const exec = promisify(execFile);

export const runCli = (...args) => exec(process.execPath, [CLI, ...args]);
export const git = (dir, ...args) =>
  exec('git', ['-C', dir, '-c', 'user.name=open-erd test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args]);

/** Replaces each [search, replacement] in workspace file `path`; throws when a search text is missing. */
export async function editFile(dir, path, replacements) {
  let text = await readFile(join(dir, path), 'utf8');
  for (const [search, replacement] of replacements) {
    if (!text.includes(search)) throw new Error(`${path}: text not found: ${search}`);
    text = text.replace(search, replacement);
  }
  await writeFile(join(dir, path), text);
}

/**
 * A copy of workspace `base` in a new temporary git repository, with one
 * commit and tag per step: each step's `edit(dir)` runs, then `layout`, then
 * everything is committed and tagged `step.tag`. The caller removes the
 * returned directory.
 */
export async function snapshotRepo(base, steps, prefix = 'open-erd-diff-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await cp(base, dir, { recursive: true });
  await git(dir, 'init', '-q');
  for (const step of steps) {
    await step.edit?.(dir);
    await runCli('layout', '--workspace', dir);
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-q', '-m', step.tag);
    await git(dir, 'tag', step.tag);
  }
  return dir;
}
