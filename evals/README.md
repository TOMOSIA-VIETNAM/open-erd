# Extraction eval

Measures how well `/open-erd:init` turns source code into a model, on the
fixtures in `../fixtures/` (each has `source/` and a hand-written `expected/`).
Run it after changing a skill prompt or the model Claude Code uses.

## Files

- `score.mjs` — deterministic scorer, no LLM. Compares a workspace's
  `model/*.yaml` with `fixtures/<case>/expected` and checks that every
  evidence string resolves to a file containing its symbol.
- `run.mjs` — runs `/open-erd:init` headless on fixture sources, checks the
  resulting workspace end to end, scores it. Costs money (see below).
- `score.test.mjs` — unit tests of the scorer on synthetic models.
- `verify-case.mjs` — the verification case: slips wrong facts into a
  fixture's expected model and scores a verification run.
- `verify.test.mjs` — deterministic half of that case, no LLM: on every
  fixture the structural wrong facts must be reported by the engine's facts
  comparison, the AI-written ones left to the verifier agent.
- `out/` — run output, gitignored.

## Commands

```bash
node --test evals/*.test.mjs                 # scorer unit tests
node evals/score.mjs --fixtures              # every expected scores 1.0 against itself and its evidence resolves
node evals/score.mjs <case> <workspace>      # score one workspace, list every missing/extra/wrong item
node evals/run.mjs                           # 1 run per fixture, 3 in parallel
node evals/run.mjs --runs 3                  # full eval: 3 runs per fixture, median per case
node evals/run.mjs --cases rails,prisma --runs 3 --out evals/out/try2
node evals/score.mjs --out evals/out         # re-aggregate all runs under a directory, writes summary.json
```

`run.mjs` options: `--cases a,b`, `--runs N` (default 1), `--parallel N`
(default 3), `--out <dir>` (default `evals/out`), `--model <id>`,
`--budget <usd per run>` (default 20, passed as `--max-budget-usd`),
`--timeout-min <n>` (default 45).

## What a run does

1. Copies `fixtures/<case>/source` (or each `source/<repo>/` for multi-repo
   cases) to a temp dir, one committed git repo per source, named as in
   `expected/open-erd.yaml` `sources` so evidence prefixes can match.
2. Runs `claude -p "/open-erd:init …"` with `--plugin-dir` set to a temp copy
   of the plugin holding only `.claude-plugin/`, `skills/`, `dist/` and
   `engine/src/` (so the run cannot read `fixtures/*/expected`),
   `--permission-mode bypassPermissions`, and the user's environment left out
   (`--setting-sources project,local`, `--strict-mcp-config`,
   `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`), so
   the result depends on the plugin, not on personal settings. The prompt
   answers every question init asks: source names and paths, workspace path,
   extract script approved, no database access, proposed domains approved.
3. Checks the workspace: `validate` passes, `out/erd.svg` and `out/erd.xlsx`
   exist, the workspace is its own git repo with a commit and a clean tree,
   `open-erd.local.yaml` is not committed, the source copies are unchanged
   (tree hash and `git status`), and the final message contains
   `/open-erd:feedback`.
4. Writes `out/<case>/<n>/`: `transcript.jsonl` (stream-json), `stderr.log`,
   `result.json` (checks, cost, duration), `score.json`, `ws/` (copy of the
   workspace). Temp dirs are kept because the workspace's evidence points at
   them; their paths are in `result.json` and can be deleted by hand.

## Scoring

- **tables**: precision/recall on table ids.
- **relations**: matched by `from.table + from.columns + to.table +
  to.columns`. On matched relations: accuracy of `cardinality`, `optional`,
  `kind`.
- **polymorphic**: matched by `table + name + target set`.
- **enums**: precision/recall on `table.column=value` (embedded columns as
  `table.entity.column`).
- **notes**: share of expected tables with a note whose produced table has a
  non-empty note (presence only, not wording).
- **evidence**: every `<repo>:<path>[:line]#<symbol>` names a source, an
  existing file and a symbol in it (problems are listed, not scored).

The logical database name and the schema segment are naming choices that the
source does not always fix (Laravel and Sequelize fixtures do not name their
engine), so each produced `<db>.<schema>` prefix is mapped one-to-one to the
expected prefix sharing most table names. A table placed under the wrong one
of several schemas (tenant vs public) still fails to match.

Median: per case and per metric, the median run (lower middle for an even
count), ranked by F1 for counts and accuracy for the rest. Totals sum the
counts of those runs over all cases.

## Verification case

`node evals/run.mjs --task verify [--cases laravel,django]` (costs money,
same options as above) checks the verification step of the skills instead
of init. Per run:

1. The fixture's expected model is committed as a workspace, with facts
   files matching it in `extract/facts/` and the fixture sources copied as
   for init.
2. Wrong facts are written on top, uncommitted (first fitting fact in id
   order): a column type (`column-type`), the target of a `db_fk` relation
   (`db_fk-target`), the target of a declared or inferred relation
   (`relation-target`) and a table note (`table-note`). The first two are
   for `open-erd verify`, the last two for the verifier agent.
3. Claude is asked to run the "Verification" step of `skills/_shared/rules.md`
   on that change, fix what it finds and commit.
4. `score.json`: per injected fact whether the model still holds the wrong
   value (`caught`) and whether it is back to the expected one
   (`restored`); `falseAlarms`, the record entries judged wrong or fixed
   that name no injected fact; the record's counts. `result.json` adds
   whether `verify` passes afterwards, the tree is clean, the sources are
   untouched and the commit message has the `verify:` line.

Run `node --test evals/*.test.mjs` for the deterministic half.

## Thresholds (on totals)

| Metric | Minimum |
|---|---|
| tables recall | 0.98 |
| relations precision | 0.90 |
| relations recall | 0.90 |
| polymorphic recall | 0.90 |

`score.mjs --out` exits non-zero when one fails.

## Cost

Each run is a full Claude Code session that reads the fixture, writes and runs
an extract script, writes the model and renders: expect a few dollars and
5–20 minutes per run. `result.json` records `costUsd` and `durationMs` from
Claude Code's final result event. The full eval (6 fixtures × 3 runs) is 18
sessions; on a subscription login it can hit the 5-hour usage limit. A run
that ends on an API error (usage limit, overload) gets `apiError` in
`result.json` and no `score.json`, so it is left out of the totals; rerun
those cases later into the same `--out` directory.
