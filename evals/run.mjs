// Runs /open-erd:init headless on fixture sources, checks the workspace it
// produced end to end, and scores it against the fixture's expected model.
//
//   node evals/run.mjs [--cases rails,prisma] [--runs 3] [--parallel 3] [--out evals/out]
//                      [--model <id>] [--budget 20] [--timeout-min 45]
//
// Each run: copy fixtures/<case>/source into a fresh temp dir (one git repo
// per source, committed, so writes into it are detectable), run Claude Code
// with only this plugin loaded and the user's CLAUDE.md, memory, settings and
// MCP servers left out, then write evals/out/<case>/<n>/{transcript.jsonl,
// stderr.log, result.json, score.json, ws/}. Temp dirs are kept (they hold
// the sources the workspace's evidence points at); delete them by hand.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, aggregate, formatDetails, formatTable, scoreCase } from './score.mjs';

const ENGINE = path.join(ROOT, 'dist/open-erd.mjs');
const YAML = (await import('node:module')).createRequire(path.join(ROOT, 'engine/package.json'))('yaml');

function parseArgs(argv) {
  const opts = { runs: 1, parallel: 3, out: path.join(ROOT, 'evals/out'), budget: 20, timeoutMin: 45, model: null, cases: null };
  for (let i = 0; i < argv.length; i++) {
    const [k, v] = [argv[i], argv[i + 1]];
    if (k === '--cases') opts.cases = v.split(',');
    else if (k === '--runs') opts.runs = Number(v);
    else if (k === '--parallel') opts.parallel = Number(v);
    else if (k === '--out') opts.out = path.resolve(v);
    else if (k === '--model') opts.model = v;
    else if (k === '--budget') opts.budget = Number(v);
    else if (k === '--timeout-min') opts.timeoutMin = Number(v);
    else throw new Error(`unknown option ${k}`);
    i++;
  }
  return opts;
}

const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

/** sha256 over every file path + content under `dir`, skipping `.git`. */
function hashTree(dir) {
  const h = crypto.createHash('sha256');
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else h.update(`${path.relative(dir, p)}\0`).update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}

/** Copy the fixture's sources into `<tmp>/<source name>/`, each its own committed git repo. */
function prepareSources(caseName, tmp) {
  const caseDir = path.join(ROOT, 'fixtures', caseName);
  const names = (YAML.parse(fs.readFileSync(path.join(caseDir, 'expected/open-erd.yaml'), 'utf8')).sources ?? []).map((s) => s.name);
  return names.map((name) => {
    const dest = path.join(tmp, name);
    fs.cpSync(path.join(caseDir, 'source', names.length > 1 ? name : ''), dest, { recursive: true });
    git(dest, 'init', '-q');
    git(dest, 'add', '-A');
    git(dest, '-c', 'user.name=eval', '-c', 'user.email=eval@example.invalid', 'commit', '-qm', 'fixture source');
    return { name, path: dest, hash: hashTree(dest) };
  });
}

export function initPrompt(sources, ws) {
  return [
    '/open-erd:init',
    '',
    'This session is non-interactive: nobody can answer questions. Use the answers below wherever the skill would ask, and do not stop to ask anything.',
    `- Source repositories: ${sources.map((s) => `\`${s.name}\` at ${s.path}`).join(', ')}. Use exactly these logical names.`,
    `- Workspace location: ${ws} (create it there).`,
    '- Extract scripts: approved. Show each script, then run it; if you fix a script, rerun it without asking.',
    '- Live database metadata: no. Do not access any database.',
    '- Domains, hub tables/columns and collapse_join_tables: your own proposal is approved as you present it.',
    'Carry every step through to the commit and the final report.',
  ].join('\n');
}

/** Run headless Claude Code; resolves with the parsed final `result` event (or null). */
export function runClaude({ prompt, cwd, transcript, stderrFile, model, budget, timeoutMin, pluginDir = ROOT }) {
  const args = ['-p', prompt, '--plugin-dir', pluginDir, '--permission-mode', 'bypassPermissions', '--output-format', 'stream-json',
    '--verbose', '--setting-sources', 'project,local', '--strict-mcp-config', '--no-session-persistence', '--max-budget-usd', String(budget)];
  if (model) args.push('--model', model);
  const env = { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
  return new Promise((resolve) => {
    const out = fs.openSync(transcript, 'w');
    const err = fs.openSync(stderrFile, 'w');
    const child = spawn('claude', args, { cwd, env, stdio: ['ignore', out, err] });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMin * 60_000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      fs.closeSync(out);
      fs.closeSync(err);
      const lines = fs.readFileSync(transcript, 'utf8').trim().split('\n');
      let result = null;
      for (const l of lines) { try { const e = JSON.parse(l); if (e.type === 'result') result = e; } catch { /* partial line */ } }
      resolve({ code, signal, result });
    });
  });
}

/** End-to-end checks on a workspace produced by init. */
export function checkWorkspace(ws, sources, finalText) {
  const engine = (cmd) => spawnSync('node', [ENGINE, cmd, '--workspace', ws], { encoding: 'utf8' });
  const exists = (p) => fs.existsSync(path.join(ws, p));
  const validate = exists('open-erd.yaml') ? engine('validate') : { status: null, stderr: 'no open-erd.yaml' };
  const log = exists('.git') ? git(ws, 'log', '--oneline') : { stdout: '' };
  const checks = {
    validate: validate.status === 0,
    svg: exists('out/erd.svg'),
    xlsx: exists('out/erd.xlsx'),
    ownGitRepo: exists('.git') && git(ws, 'rev-parse', '--show-toplevel').stdout.trim() === fs.realpathSync(ws),
    commits: log.stdout.trim() ? log.stdout.trim().split('\n').length : 0,
    clean: exists('.git') && git(ws, 'status', '--porcelain').stdout.trim() === '',
    localNotCommitted: exists('.git') && git(ws, 'ls-files', 'open-erd.local.yaml').stdout.trim() === '',
    sourcesUntouched: sources.every((s) => hashTree(s.path) === s.hash && git(s.path, 'status', '--porcelain').stdout.trim() === ''),
    feedbackLine: /\/open-erd:feedback/.test(finalText ?? ''),
  };
  checks.pass = checks.validate && checks.svg && checks.xlsx && checks.ownGitRepo && checks.commits > 0 && checks.localNotCommitted
    && checks.sourcesUntouched && checks.feedbackLine;
  return { checks, validateOutput: `${validate.stdout ?? ''}${validate.stderr ?? ''}`.trim() };
}

async function oneRun(caseName, opts) {
  const caseOut = path.join(opts.out, caseName);
  fs.mkdirSync(caseOut, { recursive: true });
  let n = 1;
  while (fs.existsSync(path.join(caseOut, String(n)))) n++;
  const runDir = path.join(caseOut, String(n));
  fs.mkdirSync(runDir);

  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `open-erd-eval-${caseName}-`)));
  const sources = prepareSources(caseName, tmp);
  const ws = path.join(tmp, `${caseName}-erd`);
  const started = Date.now();
  console.log(`[${caseName}#${n}] start  tmp=${tmp}`);
  const { code, signal, result } = await runClaude({
    prompt: initPrompt(sources, ws), cwd: tmp, transcript: path.join(runDir, 'transcript.jsonl'),
    stderrFile: path.join(runDir, 'stderr.log'), model: opts.model, budget: opts.budget, timeoutMin: opts.timeoutMin,
    pluginDir: opts.pluginDir,
  });
  const e2e = checkWorkspace(ws, sources, result?.result);
  if (fs.existsSync(ws)) fs.cpSync(ws, path.join(runDir, 'ws'), { recursive: true });
  // An API failure (usage limit, overload) says nothing about the skills: keep
  // the run's files but write no score.json, so aggregation leaves it out.
  const apiError = result?.terminal_reason === 'api_error' || !result ? (result?.result ?? `no result event (exit ${code}, ${signal})`) : null;
  const summary = {
    case: caseName, run: n, tmp, workspace: ws, exit: code, signal, wallMs: Date.now() - started,
    costUsd: result?.total_cost_usd ?? null, durationMs: result?.duration_ms ?? null, turns: result?.num_turns ?? null,
    resultSubtype: result?.subtype ?? null, apiError, ...e2e,
  };
  fs.writeFileSync(path.join(runDir, 'result.json'), `${JSON.stringify(summary, null, 2)}\n`);
  if (apiError) {
    console.log(`[${caseName}#${n}] API ERROR, not scored: ${apiError}`);
    return null;
  }
  const score = scoreCase(caseName, ws);
  fs.writeFileSync(path.join(runDir, 'score.json'), `${JSON.stringify(score, null, 2)}\n`);
  console.log(`[${caseName}#${n}] done   e2e=${e2e.checks.pass ? 'pass' : 'FAIL'} cost=$${summary.costUsd?.toFixed(2)} ${Math.round(summary.wallMs / 60000)} min`
    + ` rel P/R=${score.relations.precision?.toFixed(2)}/${score.relations.recall?.toFixed(2)}`);
  const details = formatDetails(score);
  if (details) console.log(details);
  if (!e2e.checks.pass) console.log(`  e2e: ${JSON.stringify(e2e.checks)}`);
  return score;
}

// The plugin as Claude sees it: what the skills use, without fixtures, evals or
// dev notes, so a run cannot read the expected answers.
const PLUGIN_FILES = ['.claude-plugin', 'skills', 'dist', 'engine/package.json', 'engine/src'];

function pluginCopy() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'open-erd-eval-plugin-')));
  for (const f of PLUGIN_FILES) fs.cpSync(path.join(ROOT, f), path.join(dir, f), { recursive: true });
  return dir;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  opts.pluginDir = pluginCopy();
  console.log(`plugin copy: ${opts.pluginDir}`);
  const all = fs.readdirSync(path.join(ROOT, 'fixtures')).filter((c) => fs.existsSync(path.join(ROOT, 'fixtures', c, 'expected'))).sort();
  const cases = opts.cases ?? all;
  for (const c of cases) if (!all.includes(c)) throw new Error(`unknown case ${c}; known: ${all.join(', ')}`);
  const queue = cases.flatMap((c) => Array.from({ length: opts.runs }, () => c));
  const scores = [];
  const worker = async () => {
    while (queue.length) {
      const s = await oneRun(queue.shift(), opts);
      if (s) scores.push(s);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.parallel, queue.length) }, worker));
  if (scores.length) console.log(`\n${formatTable(aggregate(scores))}`);
  else console.log('\nno run produced a score');
  console.log(`\nAll runs under ${opts.out}: node evals/score.mjs --out ${path.relative(process.cwd(), opts.out) || '.'}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
