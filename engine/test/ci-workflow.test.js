import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import { readWorkspaceFiles } from '../cli.js';
import { parseWorkspace } from '../src/model/load.js';
import { factsFromModel } from './helpers/facts.js';
import { git, snapshotRepo } from './helpers/git-workspace.js';
import { MULTI } from './helpers/shop.js';

// The workflow /open-erd:ci-setup fills in and writes into a source repository.
const TEMPLATE = fileURLToPath(new URL('../../skills/ci-setup/workflow.yml', import.meta.url));
const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

const VALUES = {
  __PATHS__: "'db/schema.rb', 'app/models/**', '.github/workflows/open-erd.yml'",
  __WORKSPACE_REPO__: 'acme/shop-erd',
  __WORKSPACE_REF__: 'main',
  __WORKSPACE_DIR__: '.',
  __OPEN_ERD_REF__: '0123456789abcdef0123456789abcdef01234567',
  __SOURCE__: 'shop-api',
};

const filled = () => Object.entries(VALUES).reduce((text, [name, value]) => text.replaceAll(name, value), readFileSync(TEMPLATE, 'utf8'));

test('the workflow template has exactly the placeholders the skill fills and parses once filled', () => {
  const names = new Set(readFileSync(TEMPLATE, 'utf8').match(/__[A-Z_]+__/g));
  assert.deepEqual([...names].sort(), Object.keys(VALUES).sort());
  const workflow = parse(filled());
  assert.deepEqual(workflow.on.pull_request.paths, ['db/schema.rb', 'app/models/**', '.github/workflows/open-erd.yml']);
  assert.deepEqual(workflow.permissions, { contents: 'read', 'pull-requests': 'write' });
  const steps = workflow.jobs['erd-preview'].steps;
  // Well-known actions only, each pinned to a major version.
  assert.deepEqual([...new Set(steps.map((s) => s.uses).filter(Boolean))].sort(), [
    'actions/checkout@v4',
    'actions/github-script@v7',
    'actions/setup-node@v4',
    'actions/upload-artifact@v4',
  ]);
  assert.equal(steps.find((s) => s.with?.repository === 'TOMOSIA-VIETNAM/open-erd').with.ref, VALUES.__OPEN_ERD_REF__);
  // The workspace is only read: no step pushes or commits.
  assert.doesNotMatch(filled(), /git (push|commit)/);
});

// Runs the workflow's shell step and comment script as GitHub would, against local stand-ins.
test('the workflow steps comment once with the changes and update that comment on the next push', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'open-erd-ci-'));
  const ws = await snapshotRepo(MULTI, [{ tag: 'base' }], 'open-erd-ci-ws-');
  try {
    // A workspace whose extract script reads facts.json from the source root.
    const { model } = parseWorkspace(await readWorkspaceFiles(ws));
    const facts = factsFromModel(model, { source: 'shop-api' });
    await mkdir(join(ws, 'extract', 'facts'), { recursive: true });
    const shopFacts = facts.find((f) => f.data.tables.some((t) => t.database === 'shop'));
    for (const { file, data } of facts.filter((f) => f !== shopFacts)) await writeFile(join(ws, 'extract', 'facts', file), JSON.stringify(data));
    await writeFile(join(ws, 'extract', 'facts', 'shop-api.json'), JSON.stringify(shopFacts.data));
    await writeFile(join(ws, 'extract', 'shop-api.mjs'), "import fs from 'node:fs';\nimport path from 'node:path';\nprocess.stdout.write(fs.readFileSync(path.join(process.argv[2], 'facts.json'), 'utf8'));\n");
    await git(ws, 'add', '-A');
    await git(ws, 'commit', '-q', '-m', 'extract');
    await symlink(ws, join(dir, 'erd'));

    // The pull request drops a column of posts.
    const changed = structuredClone(shopFacts.data);
    const posts = changed.tables.find((t) => t.name === 'posts');
    posts.columns = posts.columns.filter((c) => c.name !== 'title');
    await mkdir(join(dir, 'source'));
    await writeFile(join(dir, 'source', 'facts.json'), JSON.stringify(changed));

    const steps = parse(filled()).jobs['erd-preview'].steps;
    const run = steps.find((s) => s.run);
    await promisify(execFile)('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', run.run], { cwd: dir, env: { ...process.env, ...run.env, ENGINE: CLI } });
    assert.match(await readFile(join(dir, 'changes.md'), 'utf8'), /\| `shop\._\.posts` \| Column title removed \|/);
    assert.equal(await readFile(join(dir, 'needs-sync.md'), 'utf8'), 'Nothing left for `/open-erd:sync`.\n\n');
    assert.ok((await readFile(join(dir, 'erd-diff', 'diff.svg'), 'utf8')).startsWith('<svg'));
    await readFile(join(dir, 'erd-diff', 'diff.xlsx'));

    // The comment script, with a stand-in for the GitHub API.
    const comments = [{ id: 1, user: { type: 'User' }, body: 'Looks good' }];
    const github = {
      paginate: async (method, params) => method(params),
      rest: {
        issues: {
          listComments: async () => structuredClone(comments),
          createComment: async ({ body }) => comments.push({ id: comments.length + 1, user: { type: 'Bot' }, body }),
          updateComment: async ({ comment_id, body }) => Object.assign(comments.find((c) => c.id === comment_id), { body }),
        },
      },
    };
    const script = steps.find((s) => s.uses === 'actions/github-script@v7');
    const AsyncFunction = (async () => {}).constructor;
    const comment = new AsyncFunction('require', 'github', 'context', 'process', script.with.script);
    const files = { readFileSync: (path, encoding) => readFileSync(join(dir, path), encoding) };
    const context = { repo: { owner: 'acme', repo: 'shop-api' }, issue: { number: 7 } };
    for (const url of ['https://example.com/artifacts/1', 'https://example.com/artifacts/2']) {
      await comment(() => files, github, context, { env: { ARTIFACT_URL: url } });
    }
    assert.equal(comments.length, 2);
    assert.match(comments[1].body, /^<!-- open-erd:erd-preview -->\n### ERD changes in this pull request\n/);
    assert.match(comments[1].body, /Column title removed/);
    assert.match(comments[1].body, /\(https:\/\/example\.com\/artifacts\/2\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(ws, { recursive: true, force: true });
  }
});
