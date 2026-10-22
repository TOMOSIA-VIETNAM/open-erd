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

