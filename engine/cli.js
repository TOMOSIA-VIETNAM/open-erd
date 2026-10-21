#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import pkg from './package.json' with { type: 'json' };
import { CONFIG_FILE } from './src/model/schema.js';
import { formatError, parseWorkspace } from './src/model/load.js';
import { applyProfile } from './src/model/profile.js';
import { checkLayout, computeLayout, formatReport } from './src/layout/index.js';
import { LAYOUT_FILE, parseLayout, serializeLayout } from './src/layout/layout-file.js';
import { renderSvg } from './src/render/svg/render.js';

const COMMANDS = {
  validate: {
    usage: 'validate --workspace <dir>',
    summary: 'check open-erd.yaml and model/*.yaml against the model schema',
    options: { workspace: { type: 'string' } },
    run: runValidate,
  },
  layout: {
    usage: 'layout --workspace <dir>',
    summary: 'write coordinates for new nodes into layout.json, report moved nodes',
    options: { workspace: { type: 'string' } },
    run: runLayout,
  },
  render: {
    usage: 'render --workspace <dir> [--profile <name>]',
    summary: 'write out/erd.svg (out/erd.<profile>.svg with a sharing profile) from the model and layout.json; never writes layout.json',
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

async function runValidate({ workspace }) {
  if (!(await loadModel(workspace))) return 1;
  console.log(`${workspace}: valid`);
  return 0;
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
  if (profile === undefined) {
    svg = renderSvg(model, layout);
  } else {
    // Positions come from the layout of the full model, so check that one;
    // the filtered model is drawn at those positions (see resolveView).
    checkLayout(model, layout);
    svg = renderSvg(applyProfile(model, profile), layout, { fitStored: true });
  }
  const file = join(workspace, 'out', profile === undefined ? 'erd.svg' : `erd.${profile}.svg`);
  await mkdir(join(workspace, 'out'), { recursive: true });
  await writeFile(file, svg);
  console.log(`wrote ${file}${profile === undefined ? '' : ` (profile ${profile})`}`);
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
