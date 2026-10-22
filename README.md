# open-erd

Interactive ERDs generated from your project's source code — for projects whose
schema has no foreign keys, uses polymorphic associations, or spans several
databases.

A Claude Code plugin. Claude reads the code (and, only if you allow it, database
metadata) and writes a reviewable YAML **model**. Plain deterministic code turns
that model into the diagram: the same model always produces byte-identical
files.

![Table highlight in the interactive SVG](docs/images/table-highlight.png)

## What you get

| File | What it is |
|---|---|
| `out/erd.svg` | One self-contained file. Opens on **All tables**, zoomed in to a readable size around the schema's most connected table, with a minimap (a schema over 300 tables opens on the overview; `default_view` in `open-erd.yaml` picks another start). **Overview**: one card per domain, grouped by database, the most connected domain first: its name, table count, a one-line business description (`domains:` in the model), its central table, and the domains it is most related to, each with a small strength bar; hovering or focusing a card draws curved connectors to every related domain (thicker = more relations, tooltip with the count), a click opens the domain, a click on a related domain opens that one. **Connections** (a tab next to the map, also in **Views**): a domain × domain matrix shaded by how many relations each row's domain makes to each column's, with the count inside a domain on the diagonal; hover a cell for both directions, click it to list the relations; the header row and column stay on screen while you pan. Then domain views, neighborhood of a table. Click a table to highlight its links and open its panel: name, domain and note on top, one row of actions (related tables Direct / +1 level, join path, **Copy schema** as approximate SQL `CREATE TABLE`, a JSON schema-like document for MongoDB, or a Markdown table), then tabs Columns · Relations · Indexes; a column row shows its key icon, type, `NULL` when nullable, `= default`, its enum values on click and its note, click a line to animate it, hover a column for type/enum meanings/notes. **Search**: ⌘F / Ctrl+F (or `/`) opens a search box over tables and columns. **Join path**: pick two tables and get up to three ways to join them, each hop's condition (`orders.user_id = users.id`) with warnings (unconfirmed, cross-DB, polymorphic type filter, row multiplication), lit hop by hop on the diagram, and **Copy SQL** (`SELECT *` with one `JOIN` per hop and a `--` comment above every hop to check; not offered for a path across databases). **Views** switches between the overview, connections, all tables and each database. **Download** the view on screen as a static SVG, PNG or JPEG. In table boxes: a key on primary key columns, a link on columns referencing another table, a bolt on indexed columns, a list icon on columns with enum values, an amber mark on columns that look like a missing relation; the most connected table of a domain (its *central table*) has a stronger header and a star. Lines are solid when confirmed (database foreign key, declared in code, or reviewed) and dashed when found in code but not confirmed; **Review mode** (in the ⋯ menu, offered while facts wait for review) colours them by review state. In a view you navigated to, a pill at the top left names where Back goes (Backspace or Alt+← too). The legend lists only what the view on screen draws and folds to a small "Legend" pill; a minimap shows where you are once the view no longer fits the screen. Without JavaScript it still shows a static view (all tables, or `default_view` from `open-erd.yaml`: `overview` draws the cards, `connections` the matrix). |
| `out/erd.xlsx` | Overview sheet first (one row per table), then one sheet per table with its column grid (`# · Name · Type · Nullable · Default · Generated · Expression · Primary Key · Auto Inc · Index · Comment`), then Relations, Polymorphic, Indexes and a "To review" checklist (pending and stale facts, then possibly missing relations), cross-linked. |
| `out/erd.drawio` | Two pages, Overview (the domain cards, without lines) and All tables (one page per domain instead when the schema is too large for the view of all tables): tables as draw.io table shapes (one row per column, enum meanings in the tooltip of their column), relations as crow's foot connectors attached to the column rows, so tables can be dragged and edited in draw.io. Turn off with `outputs: { drawio: false }` in `open-erd.yaml`. |
| `out/diff.svg`, `out/diff.xlsx` | What changed between two snapshots, colored on the diagram and written as plain sentences, plus a Changes sheet. |

![Diff panel for a changed table](docs/images/diff.png)

Readability with 100+ tables: three zoom levels (overview / domain / neighborhood; in a domain view the tables of another domain that has several of them are one box with one bundled line per column),
shared columns such as `created_by` shown as badges instead of lines,
polymorphic associations drawn as one node, relations nobody confirmed yet
dashed (their evidence, `repo:path#symbol`, is in the To review sheet).
Adding tables keeps the existing layout's relative order, so people who know
the diagram still recognise it.

![Overview](docs/images/overview.png)

## Install

Requires Claude Code and Node.js 20 or later.

```
/plugin marketplace add TOMOSIA-VIETNAM/open-erd
/plugin install open-erd@open-erd
```

## Use

| Command | Does |
|---|---|
| `/open-erd:init` | Asks where to put the ERD workspace (outside your code repo, its own git repo), writes a read-only extract script per source repo and runs it after you approve, proposes domains, draws the first ERD. |
| `/open-erd:sync` | Re-reads the code, updates the model, asks you to confirm renames, marks facts that no longer match as `stale` instead of deleting them, commits. |

After building the model, `init` and `sync` have a second agent, with a fresh context, re-read the code for relations the model missed, starting from the warnings of `validate` (a `*_id` column nothing uses, a table nothing connects to). What it finds is added as `pending` for you to review; columns that are not references go into `ignore_missing` in `open-erd.yaml`.
| `/open-erd:review` | Walks through inferred and stale relations one by one; you confirm or correct in plain words. Reviewed facts are locked. |
| `/open-erd:render` | Re-renders the outputs; `--profile public` drops evidence, PII columns, internal notes and hidden tables for sharing outside the team. |
| `/open-erd:snapshot` | Tags the workspace (e.g. `v1.0-handover`). |
| `/open-erd:diff` | Compares two snapshots (or a snapshot and the current state). |
| `/open-erd:feedback <text>` | Opens a GitHub issue on this repository with your feedback, after showing you the draft. Never attaches your project's data. |

To change the diagram, just say it: "orders.status: refunded means money
returned", "move Billing next to Orders", "invoices.user_id points to
customers, not users".

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

## Safety

- Nothing is written to your source repositories; extract scripts only read files and never boot your app.
- Database access happens only when you approve it each time, read-only, metadata only; credentials are never stored.
- The workspace is never pushed unless you ask.

## Supported sources

Rails, Laravel, Django, Prisma, TypeORM, Sequelize, Mongoose and raw SQL are
covered by the extraction guide; other stacks work through the same
read-only-script approach. Several repositories and several databases (SQL and
MongoDB) can share one ERD.

## Development

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

## License

MIT
