#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import pkg from './package.json' with { type: 'json' };
import { CONFIG_FILE, LOCKED_FILE } from './src/model/schema.js';
import { formatError, parseWorkspace } from './src/model/load.js';
import { checkLocked, lockFacts, parseLocked, serializeLocked } from './src/model/lock.js';
import { applyProfile } from './src/model/profile.js';
import { buildWorkbook, serializeWorkbook } from './src/render/xlsx/workbook.js';
import { checkLayout, computeLayout, formatReport } from './src/layout/index.js';
import { LAYOUT_FILE, parseLayout, serializeLayout } from './src/layout/layout-file.js';
import { renderSvg } from './src/render/svg/render.js';

const COMMANDS = {
  validate: {
    usage: 'validate --workspace <dir>',
    summary: `check open-erd.yaml and model/*.yaml against the model schema, and that every fact in ${LOCKED_FILE} is still there unchanged or marked stale`,
    options: { workspace: { type: 'string' } },
    run: runValidate,
  },
  lock: {
    usage: 'lock --workspace <dir>',
    summary: `rewrite ${LOCKED_FILE} from the reviewed facts (keeps entries of stale facts); refuses while the model breaks the current file`,
    options: { workspace: { type: 'string' } },
    run: runLock,
  },
  layout: {
    usage: 'layout --workspace <dir>',
    summary: 'write coordinates for new nodes into layout.json, report moved nodes',
    options: { workspace: { type: 'string' } },
    run: runLayout,
  },
  render: {
    usage: 'render --workspace <dir> [--profile <name>]',
    summary: 'write out/erd.svg and out/erd.xlsx (out/erd.<profile>.svg and .xlsx with a sharing profile) from the model and layout.json; never writes layout.json',
    options: { workspace: { type: 'string' }, profile: { type: 'string' } },
    run: runRender,
  },
  diff: {
    usage: 'diff --workspace <dir> --from <ref> --to <ref|WORKTREE>',
    summary: 'compare two snapshots, write out/diff.svg and the Changes sheet',
    options: { workspace: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } },
  },
};

function helpText() {
  const width = Math.max(...Object.values(COMMANDS).map((c) => c.usage.length));
  const lines = Object.values(COMMANDS).map((c) => `  ${c.usage.padEnd(width)}  ${c.summary}`);
  return ['Usage: open-erd <command> [options]', '', 'Commands:', ...lines, '', 'Options:', '  -h, --help     show this help', '  -v, --version  print the engine version'].join('\n');
}

// Reads the workspace files the model loader needs into `{ relativePath: text }`.
export async function readWorkspaceFiles(dir) {
  const files = {};
  try {
    files[CONFIG_FILE] = await readFile(join(dir, CONFIG_FILE), 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  let entries = [];
  try {
    entries = await readdir(join(dir, 'model'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  for (const name of entries.filter((n) => n.endsWith('.yaml'))) {
    files[`model/${name}`] = await readFile(join(dir, 'model', name), 'utf8');
  }
  return files;
}

async function loadModel(workspace) {
  const { model, errors } = parseWorkspace(await readWorkspaceFiles(workspace));
  for (const e of errors) console.error(formatError(e));
  return model;
}

// Returns the parsed layout, or undefined when the workspace has none yet.
async function readLayout(workspace) {
  let text;
  try {
    text = await readFile(join(workspace, LAYOUT_FILE), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  }
  return parseLayout(text);
}

// Returns the parsed lock file, `null` when it is invalid (errors printed),
// or undefined when the workspace has none yet.
async function readLocked(workspace) {
  let text;
  try {
    text = await readFile(join(workspace, LOCKED_FILE), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  }
  const { locked, errors } = parseLocked(text);
  for (const e of errors) console.error(formatError(e));
  return locked;
}

async function runValidate({ workspace }) {
  const model = await loadModel(workspace);
  const locked = await readLocked(workspace);
  if (!model || locked === null) return 1;
  const broken = checkLocked(model, locked);
  for (const e of broken) console.error(formatError(e));
  if (broken.length > 0) {
    console.error(`${broken.length} locked fact(s) changed or missing`);
    return 1;
  }
  console.log(`${workspace}: valid${locked ? `, ${locked.relations?.length ?? 0} locked relation(s) and ${locked.polymorphic?.length ?? 0} polymorphic association(s) intact` : ''}`);
  return 0;
}

async function runLock({ workspace }) {
  const model = await loadModel(workspace);
  const previous = await readLocked(workspace);
  if (!model || previous === null) return 1;
  const locked = lockFacts(model, previous);
  const file = join(workspace, LOCKED_FILE);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, serializeLocked(locked));
  console.log(`wrote ${file}: ${locked.relations.length} relation(s), ${locked.polymorphic.length} polymorphic association(s)`);
  return 0;
}

// Fixed date for a workspace without its own git history (zip's own epoch).
const NO_HISTORY_DATE = new Date('1980-01-01T00:00:00Z');

/**
 * Created/modified time written into the xlsx: the commit time of the
 * workspace's HEAD, so the file says which state of the model it shows while
 * rendering the same commit twice gives the same bytes. A folder that is not
 * the root of its own repository (a fixture inside another repo, no git
 * installed, no commit yet) gets NO_HISTORY_DATE: the time of an unrelated
 * repository would change the bytes without the model changing.
 */
async function workspaceDate(workspace) {
  const git = (...args) => promisify(execFile)('git', ['-C', workspace, ...args]).then((r) => r.stdout.trim());
  try {
    if ((await git('rev-parse', '--show-toplevel')) !== (await realpath(workspace))) return NO_HISTORY_DATE;
    return new Date(Number(await git('log', '-1', '--format=%ct')) * 1000);
  } catch {
    return NO_HISTORY_DATE;
  }
}

async function runLayout({ workspace }) {
  const model = await loadModel(workspace);
  if (!model) return 1;
  const { layout, report } = await computeLayout(model, await readLayout(workspace));
  await writeFile(join(workspace, LAYOUT_FILE), serializeLayout(layout));
  console.log(formatReport(report));
  return 0;
}

// A profile render gets its own file name, so a shared file is never
// mistaken for the full one (or the reverse) and both can sit side by side.
async function runRender({ workspace, profile }) {
  const model = await loadModel(workspace);
  if (!model) return 1;
  const layout = await readLayout(workspace);
  if (!layout) {
    console.error(`${LAYOUT_FILE} not found in ${workspace} (run layout first)`);
    return 1;
  }
  let svg;
  let shown = model;
  if (profile === undefined) {
    svg = renderSvg(model, layout);
  } else {
    // Positions come from the layout of the full model, so check that one;
    // the filtered model is drawn at those positions (see resolveView).
    checkLayout(model, layout);
    shown = applyProfile(model, profile);
    svg = renderSvg(shown, layout, { fitStored: true });
  }
  const xlsx = await serializeWorkbook(buildWorkbook(shown), { date: await workspaceDate(workspace) });
  const base = join(workspace, 'out', profile === undefined ? 'erd' : `erd.${profile}`);
  await mkdir(join(workspace, 'out'), { recursive: true });
  await writeFile(`${base}.svg`, svg);
  await writeFile(`${base}.xlsx`, xlsx);
  console.log(`wrote ${base}.svg and ${base}.xlsx${profile === undefined ? '' : ` (profile ${profile})`}`);
  return 0;
}

export async function main(argv) {
  const [name, ...rest] = argv;
  if (name === '-v' || name === '--version') {
    console.log(pkg.version);
    return 0;
  }
  if (!name || name === '-h' || name === '--help') {
    console.log(helpText());
    return name ? 0 : 1;
  }
  const command = COMMANDS[name];
  if (!command) {
    console.error(`Unknown command: ${name}\n\n${helpText()}`);
    return 1;
  }
  let values;
  try {
    ({ values } = parseArgs({ args: rest, options: { ...command.options, help: { type: 'boolean', short: 'h' } } }));
  } catch (e) {
    console.error(`${e.message}\nUsage: open-erd ${command.usage}`);
    return 1;
  }
  if (values.help) {
    console.log(`Usage: open-erd ${command.usage}\n\n${command.summary}`);
    return 0;
  }
  if (!values.workspace) {
    console.error(`Missing --workspace\nUsage: open-erd ${command.usage}`);
    return 1;
  }
  if (!command.run) {
    console.error(`open-erd ${name}: not implemented yet`);
    return 2;
  }
  try {
    return await command.run(values);
  } catch (e) {
    // Layout and render report user-fixable problems (stale or invalid
    // layout.json) as errors; print the message, not a stack trace.
    console.error(e.message);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
