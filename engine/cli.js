#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import pkg from './package.json' with { type: 'json' };
import { CONFIG_FILE, LOCKED_FILE, OUTPUT_DEFAULTS, VERIFICATION_FILE, VERIFY_DEFAULT } from './src/model/schema.js';
import { compareStrings, formatError, parseWorkspace } from './src/model/load.js';
import { checkLocked, lockFacts, parseLocked, serializeLocked } from './src/model/lock.js';
import { applyProfile, resolveProfile } from './src/model/profile.js';
import { compareFacts, describeDelta, readFacts } from './src/model/facts.js';
import { applyFacts, needsSyncMarkdown } from './src/model/apply-facts.js';
import { parseVerification, serializeVerification, verificationSummary } from './src/model/verification.js';
import { formatWarning, missingRelations, warningsFor } from './src/model/missing.js';
import { addChangesSheet, addVerificationSheet, buildWorkbook, serializeWorkbook } from './src/render/xlsx/workbook.js';
import { changesMarkdown, describeChange, diffModels, summarize, summaryLine } from './src/diff/changes.js';
import { diffMarks, mergeLayouts, unionModel } from './src/diff/union.js';
import { EVERY_VIEW, checkLayout, computeLayout, formatReport } from './src/layout/index.js';
import { LAYOUT_FILE, parseLayout, serializeLayout } from './src/layout/layout-file.js';
import { openingView, renderSvg } from './src/render/svg/render.js';
import { renderDrawio } from './src/render/drawio/render.js';

// `--to` value meaning the workspace files on disk, committed or not.
const WORKTREE = 'WORKTREE';
// Workspace files a snapshot is made of.
const SNAPSHOT_FILE = (path) => path === CONFIG_FILE || path === LAYOUT_FILE || /^model\/[^/]+\.yaml$/.test(path);
// What `--format` accepts: plain lines for a terminal, or Markdown (for a
// pull request comment) on stdout with progress lines on stderr.
const FORMATS = ['text', 'markdown'];

const git = (workspace, ...args) =>
  promisify(execFile)('git', ['-C', workspace, ...args], { maxBuffer: 256 * 1024 * 1024 }).then((r) => r.stdout);

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
  verify: {
    usage: 'verify --workspace <dir> [--facts <dir>]',
    summary:
      'compare tables, columns, indexes and constraint-backed relations of the model with the extract facts (<workspace>/extract/facts/*.json, or --facts), ' +
      `print each mismatch and exit 1 on any; skipped when open-erd.yaml says verify: off. Also checks ${VERIFICATION_FILE}, rewrites it sorted and prints its commit line`,
    options: { workspace: { type: 'string' }, facts: { type: 'string' } },
    run: runVerify,
  },
  'apply-facts': {
    usage: 'apply-facts --workspace <dir> [--facts <dir>] --out <dir> [--format text|markdown]',
    summary:
      'write a copy of the workspace into --out with the mechanical differences from the extract facts applied (tables, columns, indexes, ' +
      'constraint-backed relations; new tables in domain Unassigned) and list what is left for /open-erd:sync (renames, notes, relations without a constraint, ' +
      'anything a reviewed fact uses); never writes the workspace itself',
    options: { workspace: { type: 'string' }, facts: { type: 'string' }, out: { type: 'string' }, format: { type: 'string' } },
    run: runApplyFacts,
  },
  layout: {
    usage: `layout --workspace <dir> [--relayout <view>]... [--relayout '${EVERY_VIEW}']`,
    summary:
      'write coordinates for new nodes into layout.json, report moved nodes; --relayout (repeatable) places the named view ' +
      `(overview = the domain cards, all = the view of all tables, domain:<db>/<domain>; '${EVERY_VIEW}' = every view) from scratch, dropping their kept positions`,
    options: { workspace: { type: 'string' }, relayout: { type: 'string', multiple: true } },
    run: runLayout,
  },
  render: {
    usage: 'render --workspace <dir> [--profile <name>]',
    summary: 'write out/erd.svg, out/erd.xlsx and out/erd.drawio unless outputs.drawio is false (out/erd.<profile>.* with a sharing profile) from the model and layout.json; never writes layout.json',
    options: { workspace: { type: 'string' }, profile: { type: 'string' } },
    run: runRender,
  },
  diff: {
    usage: `diff --workspace <dir> --from <ref> (--to <ref|${WORKTREE}> | --to-workspace <dir>) [--profile <name>] [--format text|markdown]`,
    summary:
      `compare two snapshots of the workspace (git refs such as a tag or HEAD; ${WORKTREE} = the files on disk; --to-workspace = the files of another ` +
      'workspace directory, such as the copy apply-facts writes), print the changes (--format markdown: a summary and a table for a pull request comment), ' +
      'write out/diff.svg and out/diff.xlsx into --workspace (the "to" side plus a Changes sheet; out/diff.<profile>.* with a sharing profile, applied to both sides as the "to" side declares it)',
    options: {
      workspace: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      'to-workspace': { type: 'string' },
      profile: { type: 'string' },
      format: { type: 'string' },
    },
    run: runDiff,
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

// Returns the parsed verification record, `null` when it is invalid (errors
// printed), or undefined when the workspace has none.
async function readVerification(workspace) {
  let text;
  try {
    text = await readFile(join(workspace, VERIFICATION_FILE), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  }
  const { verification, errors } = parseVerification(text);
  for (const e of errors) console.error(formatError(e));
  return verification;
}

async function runValidate({ workspace }) {
  const model = await loadModel(workspace);
  const locked = await readLocked(workspace);
  if (!model || locked === null || (await readVerification(workspace)) === null) return 1;
  const broken = checkLocked(model, locked);
  for (const e of broken) console.error(formatError(e));
  if (broken.length > 0) {
    console.error(`${broken.length} locked fact(s) changed or missing`);
    return 1;
  }
  // Possibly missing relations are for a reviewer to look at, not errors.
  const warnings = missingRelations(model);
  for (const w of warnings) console.error(formatWarning(w));
  console.log(`${workspace}: valid${locked ? `, ${locked.relations?.length ?? 0} locked relation(s) and ${locked.polymorphic?.length ?? 0} polymorphic association(s) intact` : ''}${warnings.length > 0 ? `; ${warnings.length} possibly missing relation(s), see the warnings (silence a known one with ignore_missing in ${CONFIG_FILE})` : ''}`);
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

/**
 * Facts files of `dir` as `[{ file, data }]`, by file name; null after
 * printing why (no directory, no file, a file that is not JSON).
 */
async function readFactsFiles(dir) {
  let names;
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort(compareStrings);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    names = [];
  }
  if (names.length === 0) {
    console.error(`no facts files (*.json) in ${dir}: run the extract scripts first`);
    return null;
  }
  const files = [];
  for (const file of names) {
    try {
      files.push({ file, data: JSON.parse(await readFile(join(dir, file), 'utf8')) });
    } catch (e) {
      console.error(`${file}: not valid JSON: ${e.message}`);
      return null;
    }
  }
  return files;
}

// A check that passes on nothing would hide exactly what it exists to
// catch, so a workspace without facts files fails rather than passes.
async function runVerify({ workspace, facts: factsDir }) {
  const model = await loadModel(workspace);
  const verification = await readVerification(workspace);
  if (!model || verification === null) return 1;
  if (verification) {
    await writeFile(join(workspace, VERIFICATION_FILE), serializeVerification(verification));
    console.log(`${VERIFICATION_FILE}: ${verificationSummary(verification)}`);
  }
  const mode = model.config.verify ?? VERIFY_DEFAULT;
  if (mode === 'off') {
    console.log(`verify: off in ${CONFIG_FILE}; structure not compared with the extract facts`);
    return 0;
  }
  const files = await readFactsFiles(factsDir ?? join(workspace, 'extract', 'facts'));
  if (!files) return 1;
  const facts = readFacts(files);
  for (const e of facts.errors) console.error(formatError(e));
  if (facts.errors.length > 0) return 1;
  const deltas = compareFacts(model, facts);
  for (const d of deltas) console.error(`mismatch: ${describeDelta(d)}`);
  if (deltas.length > 0) {
    console.error(`${deltas.length} mismatch(es) between the model and the extract facts: fix the model (or the extract script), or list a table left out on purpose in not_in_model of ${CONFIG_FILE}`);
    return 1;
  }
  console.log(`${workspace}: model matches the extract facts (${files.length} file(s), ${facts.tables.length} table(s))`);
  return 0;
}

// Workspace files apply-facts copies as they are, besides open-erd.yaml and
// the model files: enough for validate, layout, render and diff on the copy.
const COPIED_FILES = [LAYOUT_FILE, LOCKED_FILE, VERIFICATION_FILE];

function checkFormat(format) {
  if (format === undefined || FORMATS.includes(format)) return true;
  console.error(`--format must be one of ${FORMATS.join(', ')}`);
  return false;
}

async function runApplyFacts({ workspace, facts: factsDir, out, format = 'text' }) {
  if (!out) {
    console.error(`Missing --out\nUsage: open-erd ${COMMANDS['apply-facts'].usage}`);
    return 1;
  }
  if (!checkFormat(format)) return 1;
  if (resolve(out) === resolve(workspace)) {
    console.error('--out must be another directory: apply-facts never writes the workspace itself');
    return 1;
  }
  const files = await readWorkspaceFiles(workspace);
  const { model, errors } = parseWorkspace(files);
  for (const e of errors) console.error(formatError(e));
  if (!model) return 1;
  const factsFiles = await readFactsFiles(factsDir ?? join(workspace, 'extract', 'facts'));
  if (!factsFiles) return 1;
  const facts = readFacts(factsFiles);
  for (const e of facts.errors) console.error(formatError(e));
  if (facts.errors.length > 0) return 1;
  const result = applyFacts(files, model, compareFacts(model, facts));

  // The copy must load: a broken copy would make every later step fail
  // with an error about a file nobody wrote by hand.
  const copy = { ...files, ...result.files };
  const check = parseWorkspace(copy);
  for (const e of check.errors) console.error(`${out}: ${formatError(e)}`);
  if (!check.model) return 1;
  await mkdir(join(out, 'model'), { recursive: true });
  for (const [path, text] of Object.entries(copy)) await writeFile(join(out, path), text);
  for (const path of COPIED_FILES) {
    let bytes;
    try {
      bytes = await readFile(join(workspace, path));
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    await mkdir(dirname(join(out, path)), { recursive: true });
    await writeFile(join(out, path), bytes);
  }

  const report = format === 'markdown' ? console.error : console.log;
  report(`wrote ${out}: ${result.applied.length} change(s) from the extract facts applied, ${result.needsSync.length} left for /open-erd:sync`);
  for (const d of result.applied) report(`  applied: ${describeDelta(d)}`);
  if (format === 'markdown') console.log(needsSyncMarkdown(result.needsSync));
  else for (const n of result.needsSync) console.log(`  needs sync: ${n.path}: ${n.reason}`);
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
async function workspaceDate(workspace, ref = 'HEAD') {
  const run = async (...args) => (await git(workspace, ...args)).trim();
  try {
    if ((await run('rev-parse', '--show-toplevel')) !== (await realpath(workspace))) return NO_HISTORY_DATE;
    return new Date(Number(await run('log', '-1', '--format=%ct', ref)) * 1000);
  } catch {
    return NO_HISTORY_DATE;
  }
}

async function runLayout({ workspace, relayout = [] }) {
  const model = await loadModel(workspace);
  if (!model) return 1;
  // Repeatable: a domain name may itself contain a comma.
  const relayoutViews = relayout.map((v) => v.trim()).filter(Boolean);
  const { layout, report, offCentre } = await computeLayout(model, await readLayout(workspace), { relayout: relayoutViews });
  await writeFile(join(workspace, LAYOUT_FILE), serializeLayout(layout));
  console.log(formatReport(report));
  // Kept positions win over centring (stability rules); say how to opt in.
  const views = Object.keys(offCentre).sort(compareStrings);
  if (views.length > 0) {
    console.log(
      `hint: central tables sit away from the middle of their domain in ${views.length} view(s): ${views.join(', ')}.\n` +
        `  Kept positions win; to re-center, run layout with --relayout '<view>' (or --relayout '${EVERY_VIEW}' for every view): that view is placed from scratch.`,
    );
  }
  return 0;
}

// Published URL of out/<name>.svg, from outputs.drawio_svg_url (the URL of
// erd.svg; other renders sit beside it), for the draw.io header links.
function svgUrlOf(config, name) {
  const url = config.outputs?.drawio_svg_url;
  return url === undefined ? undefined : new URL(`${name}.svg`, url).href;
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
  // Found on the full model, narrowed to what the profile still shows.
  let warnings = missingRelations(model);
  if (profile === undefined) {
    svg = renderSvg(model, layout, { warnings });
  } else {
    // Positions come from the layout of the full model, so check that one;
    // the filtered model is drawn at those positions (see resolveView).
    checkLayout(model, layout);
    shown = applyProfile(model, profile);
    warnings = warningsFor(warnings, shown);
    svg = renderSvg(shown, layout, { fitStored: true, warnings });
  }
  if (openingView(shown).fallback) console.error(`warning: default_view "${shown.config.default_view}" is not in this render; it opens on the overview`);
  const workbook = buildWorkbook(shown, { warnings });
  // The verifier's reasons are team-internal, like evidence and internal
  // notes: a profile that drops either does not get the sheet.
  const verification = await readVerification(workspace);
  if (verification === null) return 1;
  const sharing = profile === undefined ? null : resolveProfile(model.config, profile);
  if (verification && (!sharing || (!sharing.drop_evidence && !sharing.drop_notes.includes('internal_note')))) addVerificationSheet(workbook, verification);
  const xlsx = await serializeWorkbook(workbook, { date: await workspaceDate(workspace) });
  const name = profile === undefined ? 'erd' : `erd.${profile}`;
  const base = join(workspace, 'out', name);
  await mkdir(join(workspace, 'out'), { recursive: true });
  await writeFile(`${base}.svg`, svg);
  await writeFile(`${base}.xlsx`, xlsx);
  const written = [`${base}.svg`, `${base}.xlsx`];
  if ({ ...OUTPUT_DEFAULTS, ...shown.config.outputs }.drawio) {
    await writeFile(`${base}.drawio`, renderDrawio(shown, layout, { svgUrl: svgUrlOf(shown.config, name), ...(profile === undefined ? {} : { fitStored: true }) }));
    written.push(`${base}.drawio`);
  }
  console.log(`wrote ${written.join(', ')}${profile === undefined ? '' : ` (profile ${profile})`}`);
  return 0;
}

/**
 * Model and layout of one snapshot: `WORKTREE` reads the files on disk, any
 * other value is a git ref of the workspace repository, read with git show
 * so nothing is checked out. Returns null after printing the errors.
 */
async function readSnapshot(workspace, ref) {
  let files;
  let layoutText;
  if (ref === WORKTREE) {
    files = await readWorkspaceFiles(workspace);
    try {
      layoutText = await readFile(join(workspace, LAYOUT_FILE), 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  } else {
    let paths;
    try {
      // Paths come out relative to the workspace, which may sit below the
      // repository root.
      paths = (await git(workspace, 'ls-tree', '-r', '--name-only', ref, '--', '.')).split('\n').filter(SNAPSHOT_FILE);
    } catch (e) {
      throw new Error(`cannot read snapshot "${ref}" of ${workspace}: ${e.stderr?.trim() || e.message}`);
    }
    files = {};
    for (const path of paths.sort(compareStrings)) {
      const text = await git(workspace, 'show', `${ref}:./${path}`);
      if (path === LAYOUT_FILE) layoutText = text;
      else files[path] = text;
    }
  }
  const { model, errors } = parseWorkspace(files);
  for (const e of errors) console.error(`${ref}: ${formatError(e)}`);
  if (!model) return null;
  // A snapshot without layout.json is laid out from scratch.
  return { model, layout: layoutText === undefined ? undefined : parseLayout(layoutText) };
}

async function runDiff({ workspace, from, to, 'to-workspace': toWorkspace, profile, format = 'text' }) {
  if (!from || (!to && !toWorkspace)) {
    console.error(`Missing --from or --to\nUsage: open-erd ${COMMANDS.diff.usage}`);
    return 1;
  }
  if (to && toWorkspace) {
    console.error('Give one of --to or --to-workspace, not both');
    return 1;
  }
  if (!checkFormat(format)) return 1;
  if (from === WORKTREE) {
    console.error(`--from must be a git ref; ${WORKTREE} is only allowed as --to`);
    return 1;
  }
  if (to === 'HEAD') {
    const dirty = await git(workspace, 'status', '--porcelain', '--', CONFIG_FILE, 'model', LAYOUT_FILE).catch(() => '');
    if (dirty.trim()) console.error(`warning: uncommitted changes in ${workspace} are not part of HEAD; use --to ${WORKTREE} to include them`);
  }
  const before = await readSnapshot(workspace, from);
  // The other directory is read as its files on disk and labelled by its path.
  const after = toWorkspace ? await readSnapshot(toWorkspace, WORKTREE) : await readSnapshot(workspace, to);
  const toLabel = toWorkspace ? basename(resolve(toWorkspace)) : to;
  if (!before || !after) return 1;
  // Both sides are filtered by the profile as the newer snapshot declares
  // it: the result is shared today, so today's hidden list applies.
  const filter = (side) => (profile === undefined ? side.model : applyProfile({ ...side.model, config: after.model.config }, profile));
  const [fromModel, toModel] = [filter(before), filter(after)];

  const result = diffModels(fromModel, toModel);
  const summary = summaryLine(summarize(result.changes));
  const union = unionModel(fromModel, toModel, result);
  const { layout } = await computeLayout(union, mergeLayouts(before.layout, after.layout));
  // Change colours only on the drawing; the workbook is the "to" side's,
  // with its To review checklist.
  const svg = renderSvg(union, layout, { diff: { from, to: toLabel, summary, marks: diffMarks(union, result.changes) }, warnings: [] });
  const workbook = buildWorkbook(toModel, { warnings: warningsFor(missingRelations(after.model), toModel) });
  addChangesSheet(workbook, toModel, result.changes);
  const xlsx = await serializeWorkbook(workbook, { date: toWorkspace ? await workspaceDate(toWorkspace) : await workspaceDate(workspace, to === WORKTREE ? 'HEAD' : to) });

  const base = join(workspace, 'out', profile === undefined ? 'diff' : `diff.${profile}`);
  await mkdir(join(workspace, 'out'), { recursive: true });
  await writeFile(`${base}.svg`, svg);
  await writeFile(`${base}.xlsx`, xlsx);
  const wrote = `wrote ${base}.svg and ${base}.xlsx${profile === undefined ? '' : ` (profile ${profile})`}`;
  if (format === 'markdown') {
    console.log(changesMarkdown(result.changes));
    console.error(wrote);
    return 0;
  }
  console.log(`${from} → ${toLabel}: ${summary}`);
  for (const c of result.changes) console.log(`  ${c.table ?? c.database}: ${describeChange(c)}`);
  console.log(wrote);
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
