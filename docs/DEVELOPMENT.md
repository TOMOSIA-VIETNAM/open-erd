# open-erd: development

## Upgrading

After updating the plugin, run `layout` once before `render` (the skills do
this for you):

```
node <plugin root>/dist/open-erd.mjs layout --workspace <ws>
```

A new engine version may draw boxes a little larger (new icons in table
boxes, overview domains drawn as cards);
`render` then stops with "layout.json is out of date ... (run layout)".
`layout` keeps every position it can (the usual stability rules) and only
makes room for the bigger boxes. A fresh layout puts each domain's central
table in the middle of its domain; existing positions are kept, so `layout`
prints a hint for views where the central table sits off-centre. Overview cards kept from
a layout made before cards existed stay in their old order with uneven gaps;
`--relayout overview` puts them in a tidy grid. To place a
view from scratch, opt in per view:

```
node <plugin root>/dist/open-erd.mjs layout --workspace <ws> --relayout 'domain:<db>/<domain>'
node <plugin root>/dist/open-erd.mjs layout --workspace <ws> --relayout all    # the view of all tables
node <plugin root>/dist/open-erd.mjs layout --workspace <ws> --relayout overview   # cards in order, most connected first
node <plugin root>/dist/open-erd.mjs layout --workspace <ws> --relayout '*'    # every view
```

Models written before table indexes existed may carry `unique: [[a, b]]` on a
table; it is still read, as a unique index over those columns.

## Build and test

```
cd engine
npm ci
npm test              # unit, geometry, stability and determinism tests
npm run test:large    # 1000-table and 500-tenant scale tests
npm run build         # bundles the engine to dist/open-erd.mjs (committed)
npm run eval          # runs Claude headless on every fixture and scores it (costs API usage; see evals/README.md)
```

`fixtures/` holds small sample apps per stack with hand-written expected
models; `evals/` scores Claude's extraction against them.

## Verification internals

- `engine/src/model/facts.js`: `readFacts` reads the fields of the facts
  files listed in `skills/_shared/model.md` ("Extract facts file") and
  ignores the rest; `compareFacts(model, facts)` is pure and returns sorted
  deltas `{ change: added | removed | changed | error, scope: table |
  column | index | relation, table, path, field?, before?, after?,
  evidence? }`, named by model ids and carrying the model-form entry, so a
  command can apply them to the model later. A field no column of a facts
  file carries is not compared (older scripts), and deltas about a `stale`
  fact or what it uses are dropped.
- `verify: full | ai-only | off` and `not_in_model` live in
  `engine/src/model/schema.js`; the record `tests/verification.yaml` has its
  schema there too and its parse/serialize in
  `engine/src/model/verification.js`. `validate`, `verify` and `render` read
  the record; `verify` rewrites it sorted.
- `render` appends the Verification sheet only without a profile, or with a
  profile that keeps both evidence and `internal_note`.
- `engine/src/model/apply-facts.js`: `applyFacts(files, model, deltas)`
  is pure (workspace texts in, edited texts out) and applies the mechanical
  deltas of `compareFacts` through the `yaml` Document API, so comments and
  each node's flow or block style survive; untouched files are copied byte
  for byte. The yaml library may still drop alignment spaces after a key
  (`to:   {` becomes `to: {`) in an edited file. Removed tables and columns
  something else uses, possible renames (`possibleRenames` of the diff),
  reviewed facts and relation kind changes go to `needsSync` instead. The
  CLI loads the result before writing `--out` and fails if it does not.
- `diff --to-workspace <dir>` reads the "to" side from another directory's
  files; `--format markdown` prints `changesMarkdown` (summary and a table
  capped at `MARKDOWN_ROWS`) on stdout. `skills/ci-setup/workflow.yml` is the
  workflow template; `engine/test/ci-workflow.test.js` checks its
  placeholders and runs its shell step and comment script locally.
- `evals/verify.test.mjs` slips wrong facts into every fixture's expected
  model and checks which ones the comparison reports; `node evals/run.mjs
  --task verify` runs the agent side (costs API usage).

