// Guards for the layer that lets agents other than Claude Code run the skills: one short entry per
// command under .agents/skills/, one adapter (adapters/root.md), the installers. They fail when that
// layer starts carrying behaviour of its own or drifts from skills/, which stays the only procedure.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(join(REPO, path), 'utf8');
const SHIMS = '.agents/skills';
const SHIM_MAX_LINES = 14;
// Each belongs to a file under skills/. Found in the adapter layer, it would have two owners.
const BEHAVIOUR_MARKERS = ['--workspace', 'validate', 'facts-diff', 'review: pending', 'open-erd.yaml', 'gh issue'];

const commands = () => readdirSync(join(REPO, 'skills'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('_')).map((d) => d.name).sort();
const shims = () => readdirSync(join(REPO, SHIMS)).filter((n) => n.startsWith('open-erd-')).sort();
const frontmatter = (text) => parse(text.match(/^---\n([\s\S]*?)\n---\n/)[1]);
const body = (text) => text.replace(/^---\n[\s\S]*?\n---\n/, '');

test('every command has exactly one shim, and Claude Code sees only the commands', () => {
  assert.deepEqual(shims().map((n) => n.replace('open-erd-', '')), commands());
  // Claude Code registers every skills/<dir>; a shim there would show up as a second command.
  assert.deepEqual(commands().filter((c) => c.startsWith('open-erd-')), []);
});

test('each shim names itself, mirrors its command description and hands over to it', () => {
  const hop = read('scripts/install-local.sh').match(/^HOP='(.*)'$/m)[1];
  for (const cmd of commands()) {
    const path = `${SHIMS}/open-erd-${cmd}/SKILL.md`;
    const text = read(path);
    const meta = frontmatter(text);
    assert.equal(meta.name, `open-erd-${cmd}`, path);
    const source = frontmatter(read(`skills/${cmd}/SKILL.md`)).description;
    assert.equal(meta.description, source.replace(/\/open-erd:([a-z-]+)/g, '$$open-erd-$1'), `${path}: description drifted from skills/${cmd}`);
    assert.ok(text.includes(`ROOT/skills/${cmd}/SKILL.md`), path);
    // --copy rewrites this exact text; if it changes here, copies keep a relative path that resolves nowhere.
    assert.ok(text.includes(hop), `${path} lacks the adapter hop install-local.sh rewrites`);
    const relative = hop.match(/`([^`]+)`/)[1];
    assert.ok(existsSync(resolve(dirname(join(REPO, path)), relative)), `${path}: ${relative} does not resolve`);
  }
});

test('the adapter layer carries no behaviour and shims stay short', () => {
  const files = [...shims().map((n) => `${SHIMS}/${n}/SKILL.md`), 'adapters/root.md'];
  const offenders = Object.fromEntries(files
    .map((f) => [f, BEHAVIOUR_MARKERS.filter((m) => body(read(f)).includes(m))])
    .filter(([, hits]) => hits.length));
  assert.deepEqual(offenders, {}, 'behaviour leaked into the adapter layer');
  for (const n of shims()) {
    const lines = read(`${SHIMS}/${n}/SKILL.md`).trim().split('\n').length;
    assert.ok(lines <= SHIM_MAX_LINES, `${n}: ${lines} lines`);
  }
});

test('the ROOT fallback looks where the installers put things', () => {
  // Stated twice: the installers write there, the fallback looks there. Drift is silent until
  // someone else's machine finds nothing.
  const targets = [...read('scripts/install-local.sh').matchAll(/"\$HOME\/([^"]+)"/g)].map((m) => m[1]);
  const clone = read('install.sh').match(/\$\{OPEN_ERD_HOME:-\$HOME\/([^}]+)\}/)[1];
  assert.ok(targets.length, 'install-local.sh no longer states its target directory');
  const row = read('adapters/root.md').split('\n').filter((l) => l.startsWith('| 3 |'));
  assert.equal(row.length, 1);
  for (const t of [...targets, clone]) assert.ok(row[0].includes(`~/${t}`), `the ROOT fallback misses ~/${t}`);
});

test('install.sh ships every file a run reads', () => {
  const ship = read('install.sh').match(/^SHIP='([\s\S]*?)'/m)[1].split(/\s+/).filter(Boolean).map((e) => e.replace(/^\/|\/$/g, ''));
  const runtime = new Set(['adapters', SHIMS, 'scripts/install-local.sh', '.codex-plugin/plugin.json']);
  for (const cmd of commands()) {
    for (const m of read(`skills/${cmd}/SKILL.md`).matchAll(/(?:<plugin root>|\$\{CLAUDE_PLUGIN_ROOT\})\/([A-Za-z0-9_./-]+)/g)) runtime.add(m[1].replace(/\/$/, ''));
  }
  for (const f of readdirSync(join(REPO, 'skills/_shared'))) {
    for (const m of read(`skills/_shared/${f}`).matchAll(/<plugin root>\/([A-Za-z0-9_./-]+)/g)) runtime.add(m[1].replace(/\/$/, ''));
  }
  const missing = [...runtime].filter((n) => !ship.some((e) => n === e || n.startsWith(`${e}/`)));
  assert.deepEqual(missing, [], 'a run reads these and install.sh does not ship them');
});

test('the Codex manifests point at what exists', () => {
  const plugin = JSON.parse(read('.codex-plugin/plugin.json'));
  assert.equal(plugin.skills.replace(/^\.\/|\/$/g, ''), SHIMS);
  const market = JSON.parse(read('.agents/plugins/marketplace.json'));
  assert.ok(existsSync(join(REPO, market.plugins[0].source, '.codex-plugin/plugin.json')));
  assert.equal(market.plugins[0].name, plugin.name);
});
