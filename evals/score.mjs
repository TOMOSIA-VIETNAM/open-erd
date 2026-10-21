// Deterministic extraction-quality scorer: compares a workspace model produced
// by the AI against a fixture's hand-written expected model.
//
//   node evals/score.mjs <case> <workspace>      score one workspace against fixtures/<case>/expected
//   node evals/score.mjs --fixtures              self-check: every expected scores 1.0 and its evidence resolves
//   node evals/score.mjs --out <dir>             aggregate every <dir>/<case>/<run>/score.json (median per case)
//
// Parses YAML itself (not through the engine) so it keeps working while the
// engine changes; the engine's `validate` is what checks schema conformance.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const YAML = createRequire(path.join(ROOT, 'engine/package.json'))('yaml');

// Success criteria of the extraction eval, applied to totals over all cases.
export const THRESHOLDS = [
  { metric: 'tables', field: 'recall', min: 0.98 },
  { metric: 'relations', field: 'precision', min: 0.9 },
  { metric: 'relations', field: 'recall', min: 0.9 },
  { metric: 'polymorphic', field: 'recall', min: 0.9 },
];

const readYaml = (file) => YAML.parse(fs.readFileSync(file, 'utf8')) ?? {};

/** Flattened model of a workspace directory (`open-erd.yaml` + `model/*.yaml`). */
export function loadWorkspace(dir) {
  const modelDir = path.join(dir, 'model');
  const files = fs.existsSync(modelDir) ? fs.readdirSync(modelDir).filter((f) => f.endsWith('.yaml')).sort() : [];
  const model = { databases: {}, tables: [], relations: [], polymorphic: [] };
  for (const f of files) {
    const data = readYaml(path.join(modelDir, f));
    if (data.database) model.databases[data.database] = data.engine;
    model.tables.push(...(data.tables ?? []));
    model.relations.push(...(data.relations ?? []));
    model.polymorphic.push(...(data.polymorphic ?? []));
  }
  return model;
}

const splitId = (id) => {
  const parts = String(id).split('.');
  return { prefix: parts.slice(0, 2).join('.'), rest: parts.slice(2).join('.') };
};

/**
 * Map each produced `<db>.<schema>` prefix to an expected one by the number of
 * table names they share (one-to-one, greedy by overlap). The logical database
 * name, and `_` vs `public` when the source does not name its engine, are
 * naming choices rather than extraction errors; a table under the wrong prefix
 * of a database that has several (tenant vs public) still fails to match.
 */
export function mapPrefixes(expectedIds, producedIds) {
  const names = (ids) => {
    const m = new Map();
    for (const id of ids) {
      const { prefix, rest } = splitId(id);
      if (!m.has(prefix)) m.set(prefix, new Set());
      m.get(prefix).add(rest);
    }
    return m;
  };
  const exp = names(expectedIds);
  const prod = names(producedIds);
  const pairs = [];
  for (const [p, ps] of prod) for (const [e, es] of exp) {
    const overlap = [...ps].filter((n) => es.has(n)).length;
    if (overlap > 0) pairs.push({ p, e, overlap });
  }
  pairs.sort((a, b) => b.overlap - a.overlap || (a.p === a.e ? -1 : 0) - (b.p === b.e ? -1 : 0) || cmp(a.p + a.e, b.p + b.e));
  const map = new Map();
  const used = new Set();
  for (const { p, e } of pairs) if (!map.has(p) && !used.has(e)) { map.set(p, e); used.add(e); }
  return map;
}

function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function setScore(expectedKeys, producedKeys) {
  const exp = new Map();
  for (const k of expectedKeys) exp.set(k, (exp.get(k) ?? 0) + 1);
  const missing = [];
  const extra = [];
  let tp = 0;
  const left = new Map(exp);
  for (const k of producedKeys) {
    if ((left.get(k) ?? 0) > 0) { tp++; left.set(k, left.get(k) - 1); } else extra.push(k);
  }
  for (const [k, n] of left) for (let i = 0; i < n; i++) missing.push(k);
  return withRatios({ tp, fp: extra.length, fn: missing.length, missing: missing.sort(), extra: extra.sort() });
}

export function withRatios(s) {
  const ratio = (n, d) => (d === 0 ? null : n / d);
  const precision = ratio(s.tp, s.tp + s.fp);
  const recall = ratio(s.tp, s.tp + s.fn);
  const f1 = precision === null || recall === null || precision + recall === 0 ? (s.tp + s.fp + s.fn === 0 ? null : 0)
    : (2 * precision * recall) / (precision + recall);
  return { ...s, precision, recall, f1 };
}

const relKey = (r) => `${r.from.table}(${(r.from.columns ?? []).join(',')}) -> ${r.to.table}(${(r.to.columns ?? []).join(',')})`;
const polyKey = (p) => `${p.table}#${p.name} -> [${[...(p.targets ?? [])].sort().join(', ')}]`;

function columnsOf(table) {
  const cols = [...(table.columns ?? [])];
  for (const e of table.embedded ?? []) for (const c of e.columns ?? []) cols.push({ ...c, name: `${e.name}.${c.name}` });
  return cols;
}

/** Score a produced model against an expected one. Both from `loadWorkspace`. */
export function scoreModels(expected, produced) {
  const prefixes = mapPrefixes(expected.tables.map((t) => t.id), produced.tables.map((t) => t.id));
  const rename = (id) => {
    const { prefix, rest } = splitId(id);
    return prefixes.has(prefix) ? `${prefixes.get(prefix)}.${rest}` : id;
  };
  const prodTables = produced.tables.map((t) => ({ ...t, id: rename(t.id) }));
  const prodRels = produced.relations.map((r) => ({
    ...r, from: { ...r.from, table: rename(r.from.table) }, to: { ...r.to, table: rename(r.to.table) },
  }));
  const prodPoly = produced.polymorphic.map((p) => ({ ...p, table: rename(p.table), targets: (p.targets ?? []).map(rename) }));

  const tables = setScore(expected.tables.map((t) => t.id), prodTables.map((t) => t.id));
  const relations = setScore(expected.relations.map(relKey), prodRels.map(relKey));
  const polymorphic = setScore(expected.polymorphic.map(polyKey), prodPoly.map(polyKey));

  // Attribute accuracy on matched relations.
  const byKey = new Map(prodRels.map((r) => [relKey(r), r]));
  const attr = (field) => {
    const wrong = [];
    let total = 0;
    for (const r of expected.relations) {
      const p = byKey.get(relKey(r));
      if (!p) continue;
      total++;
      if (p[field] !== r[field]) wrong.push(`${relKey(r)}: ${p[field]} (expected ${r[field]})`);
    }
    return { correct: total - wrong.length, total, accuracy: total ? (total - wrong.length) / total : null, wrong };
  };

  const enumKeys = (ts) => ts.flatMap((t) => columnsOf(t).flatMap((c) => Object.keys(c.enum ?? {}).map((v) => `${t.id}.${c.name}=${v}`)));
  const enums = setScore(enumKeys(expected.tables), enumKeys(prodTables));

  const prodById = new Map(prodTables.map((t) => [t.id, t]));
  const noteMissing = [];
  let noteTotal = 0;
  for (const t of expected.tables) {
    if (!t.note || !prodById.has(t.id)) continue;
    noteTotal++;
    if (!String(prodById.get(t.id).note ?? '').trim()) noteMissing.push(t.id);
  }
  const notes = { correct: noteTotal - noteMissing.length, total: noteTotal, accuracy: noteTotal ? (noteTotal - noteMissing.length) / noteTotal : null, wrong: noteMissing };

  return {
    prefixes: Object.fromEntries([...prefixes].filter(([p, e]) => p !== e)),
    tables, relations, cardinality: attr('cardinality'), optional: attr('optional'), kind: attr('kind'), polymorphic, enums, notes,
  };
}

/**
 * Every evidence `<repo>:<path>[:line]#<symbol>` names a known repo, an
 * existing file under that repo's root, and a symbol that file contains.
 * `roots` maps repo name -> absolute directory. Returns a list of problems.
 */
export function checkEvidence(model, roots) {
  const problems = [];
  let count = 0;
  for (const fact of [...model.relations, ...model.polymorphic]) {
    for (const ev of fact.evidence ?? []) {
      if (ev === 'db') continue;
      count++;
      const m = String(ev).match(/^([^:]+):([^#]+?)(?::\d+)?(?:#(.+))?$/);
      const [, repo, rel, symbol] = m ?? [];
      const file = repo && roots[repo] ? path.join(roots[repo], rel) : null;
      const err = !m ? 'malformed' : !roots[repo] ? 'unknown repo'
        : !fs.existsSync(file) || !fs.statSync(file).isFile() ? 'missing file'
          : symbol && !fs.readFileSync(file, 'utf8').includes(symbol) ? 'symbol not found' : null;
      if (err) problems.push(`${ev}: ${err}`);
    }
  }
  return { count, problems };
}

/** Evidence roots of a fixture's expected model: `source/` or `source/<repo>/` when there are several repos. */
export function fixtureRoots(caseDir) {
  const names = (readYaml(path.join(caseDir, 'expected/open-erd.yaml')).sources ?? []).map((s) => s.name);
  const multi = names.length > 1;
  return Object.fromEntries(names.map((n) => [n, path.join(caseDir, 'source', multi ? n : '')]));
}

/** Evidence roots of a real workspace: the paths in `open-erd.local.yaml`. */
export function workspaceRoots(ws) {
  const file = path.join(ws, 'open-erd.local.yaml');
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries((readYaml(file).sources ?? []).map((s) => [s.name, s.path]));
}

export function scoreCase(caseName, ws) {
  const expected = loadWorkspace(path.join(ROOT, 'fixtures', caseName, 'expected'));
  const produced = loadWorkspace(ws);
  return { case: caseName, ...scoreModels(expected, produced), evidence: checkEvidence(produced, workspaceRoots(ws)) };
}

const COUNT_METRICS = ['tables', 'relations', 'polymorphic', 'enums'];
const ACC_METRICS = ['cardinality', 'optional', 'kind', 'notes'];

/**
 * Per case, per metric: the median run (lower middle for an even count),
 * ranked by F1 for count metrics and accuracy for the others. Totals sum the
 * counts of those median runs over all cases; thresholds apply to totals.
 */
export function aggregate(scores) {
  const byCase = new Map();
  for (const s of scores) {
    if (!byCase.has(s.case)) byCase.set(s.case, []);
    byCase.get(s.case).push(s);
  }
  const pickMedian = (runs, metric, key) => {
    const sorted = [...runs].sort((a, b) => (a[metric][key] ?? 1) - (b[metric][key] ?? 1));
    return sorted[Math.floor((sorted.length - 1) / 2)][metric];
  };
  const cases = [];
  const total = Object.fromEntries([...COUNT_METRICS.map((m) => [m, { tp: 0, fp: 0, fn: 0 }]), ...ACC_METRICS.map((m) => [m, { correct: 0, total: 0 }])]);
  for (const [name, runs] of [...byCase].sort((a, b) => cmp(a[0], b[0]))) {
    const row = { case: name, runs: runs.length };
    for (const m of COUNT_METRICS) {
      row[m] = pickMedian(runs, m, 'f1');
      for (const k of ['tp', 'fp', 'fn']) total[m][k] += row[m][k];
    }
    for (const m of ACC_METRICS) {
      row[m] = pickMedian(runs, m, 'accuracy');
      total[m].correct += row[m].correct;
      total[m].total += row[m].total;
    }
    cases.push(row);
  }
  for (const m of COUNT_METRICS) total[m] = withRatios(total[m]);
  for (const m of ACC_METRICS) total[m].accuracy = total[m].total ? total[m].correct / total[m].total : null;
  // Nothing to measure (no expected item and none produced) is not a failure.
  const checks = THRESHOLDS.map((t) => {
    const value = total[t.metric][t.field];
    return { ...t, value, pass: value === null || value >= t.min };
  });
  return { cases, total, checks, pass: checks.every((c) => c.pass) };
}

const pct = (v) => (v === null || v === undefined ? '  —  ' : v.toFixed(2).padStart(5));

export function formatTable(agg) {
  const head = ['case', 'runs', 'tbl P', 'tbl R', 'rel P', 'rel R', 'card', 'kind', 'opt', 'poly P', 'poly R', 'enum P', 'enum R', 'notes'];
  const line = (name, runs, r) => [name.padEnd(9), String(runs).padStart(4), pct(r.tables.precision), pct(r.tables.recall),
    pct(r.relations.precision), pct(r.relations.recall), pct(r.cardinality.accuracy), pct(r.kind.accuracy), pct(r.optional.accuracy),
    pct(r.polymorphic.precision).padStart(6), pct(r.polymorphic.recall).padStart(6), pct(r.enums.precision).padStart(6),
    pct(r.enums.recall).padStart(6), pct(r.notes.accuracy)].join(' | ');
  const out = [head.map((h, i) => (i === 0 ? h.padEnd(9) : h.padStart(i >= 9 && i <= 12 ? 6 : i === 1 ? 4 : 5))).join(' | ')];
  out.push('-'.repeat(out[0].length));
  for (const c of agg.cases) out.push(line(c.case, c.runs, c));
  out.push('-'.repeat(out[0].length));
  out.push(line('TOTAL', agg.cases.reduce((n, c) => n + c.runs, 0), agg.total));
  out.push('');
  for (const c of agg.checks) out.push(`${c.value === null ? 'N/A ' : c.pass ? 'PASS' : 'FAIL'}  ${c.metric} ${c.field} ${pct(c.value).trim()} (>= ${c.min})`);
  return out.join('\n');
}

export function formatDetails(s) {
  const out = [];
  if (Object.keys(s.prefixes).length) out.push(`  prefix mapping: ${JSON.stringify(s.prefixes)}`);
  for (const m of COUNT_METRICS) {
    for (const k of s[m].missing) out.push(`  missing ${m}: ${k}`);
    for (const k of s[m].extra) out.push(`  extra   ${m}: ${k}`);
  }
  for (const m of ACC_METRICS) for (const w of s[m].wrong) out.push(`  wrong   ${m}: ${w}`);
  for (const p of s.evidence?.problems ?? []) out.push(`  evidence: ${p}`);
  return out.join('\n');
}

function main(argv) {
  if (argv[0] === '--fixtures') {
    let ok = true;
    const cases = fs.readdirSync(path.join(ROOT, 'fixtures')).filter((c) => fs.existsSync(path.join(ROOT, 'fixtures', c, 'expected'))).sort();
    for (const c of cases) {
      const dir = path.join(ROOT, 'fixtures', c);
      const model = loadWorkspace(path.join(dir, 'expected'));
      const s = scoreModels(model, model);
      const perfect = COUNT_METRICS.every((m) => s[m].fp + s[m].fn === 0);
      const ev = checkEvidence(model, fixtureRoots(dir));
      ok &&= perfect && ev.problems.length === 0;
      console.log(`${c}: self-score ${perfect ? 'ok' : 'NOT 1.0'}, ${ev.count} evidence, ${ev.problems.length} bad`);
      for (const p of ev.problems) console.log(`  ${p}`);
    }
    return ok ? 0 : 1;
  }
  if (argv[0] === '--out') {
    const dir = path.resolve(argv[1]);
    const scores = [];
    for (const c of fs.readdirSync(dir).sort()) {
      const caseDir = path.join(dir, c);
      if (!fs.statSync(caseDir).isDirectory()) continue;
      for (const r of fs.readdirSync(caseDir).sort()) {
        const f = path.join(caseDir, r, 'score.json');
        if (fs.existsSync(f)) scores.push(JSON.parse(fs.readFileSync(f, 'utf8')));
      }
    }
    if (!scores.length) { console.error(`no score.json under ${dir}`); return 1; }
    const agg = aggregate(scores);
    console.log(formatTable(agg));
    fs.writeFileSync(path.join(dir, 'summary.json'), `${JSON.stringify(agg, null, 2)}\n`);
    console.log(`\nwrote ${path.join(dir, 'summary.json')}`);
    return agg.pass ? 0 : 1;
  }
  if (argv.length === 2) {
    const s = scoreCase(argv[0], path.resolve(argv[1]));
    console.log(formatTable(aggregate([s])));
    const details = formatDetails(s);
    if (details) console.log(`\n${details}`);
    console.log(`\n${JSON.stringify(s)}`);
    return 0;
  }
  console.error('usage: node evals/score.mjs <case> <workspace> | --fixtures | --out <dir>');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
