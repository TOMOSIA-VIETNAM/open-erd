# open-erd: usage reference

The short guide is the README. This page lists every output, command and behaviour.

## Outputs in detail

| File | What it is |
|---|---|
| `out/erd.svg` | One self-contained file. Opens on **All tables**, zoomed in to a readable size around the schema's most connected table, with a minimap (a schema over 300 tables opens on the overview; `default_view` in `open-erd.yaml` picks another start). **Overview**: one card per domain, grouped by database, the most connected domain first: its name, table count, a one-line business description (`domains:` in the model), its central table, and the domains it is most related to, each with a small strength bar; hovering or focusing a card draws curved connectors to every related domain (thicker = more relations, tooltip with the count), a click opens the domain, a click on a related domain opens that one. **Ranking** (a toolbar tab next to the map): the tables ranked by the relations pointing at them, one section per database, each a row with its full name and a bar whose length and colour grow with that count (hub references and polymorphic targets included, a self-reference not), so the tables the rest of the schema leans on stand out; no central-table star, since that one is picked within a domain; under each database, the tables no other table refers to follow as a grid of names (they may still refer to others); hovering a row names the table with its domain and the counts both ways, a click opens the table. Then domain views, neighborhood of a table. Click a table to highlight its links and open its panel: name, domain and note on top, one row of actions (related tables Direct / +1 level, join path, **Copy schema** as approximate SQL `CREATE TABLE`, a JSON schema-like document for MongoDB, or a Markdown table), then tabs Columns · Relations · Indexes; a column row shows its key icon, type, `NULL` when nullable, `= default`, its enum values on click and its note, click a line to animate it and open its panel (its review state and kind, the relation in one sentence, then a card per end with its table, columns and database: hovering a card pulses that table, a click goes to it), hover a column for type/enum meanings/notes. **Toolbar**: Back and the breadcrumb on the left (with several databases, its database crumb, or "All databases" on the views showing them all, opens a list of the databases and shows the one picked); on the right the view tabs, the search box, **Highlight ▾** and **⋯**. **Search** (the toolbar's box, ⌘K / Ctrl+K) opens a palette: type a table or column name to jump there, or run a command (views and databases to go to, join path, tour, downloads, highlights, copy schema, each with its shortcut; listed when the box is empty); ⌘F / Ctrl+F (or `/`) opens it for tables and columns only. **Join path** (⌘J / Ctrl+J, Join path… in the palette, or `a > b` typed there): a box with From and To fields picks two tables and get up to three ways to join them, each hop's condition (`orders.user_id = users.id`) with warnings (unconfirmed, cross-DB, polymorphic type filter, row multiplication), lit hop by hop on the diagram, and **Copy SQL** (`SELECT *` with one `JOIN` per hop and a `--` comment above every hop to check; not offered for a path across databases). The toolbar switches between **All tables · Map · Ranking** (⌘A / Ctrl+A jumps to All tables); the database crumb jumps to one database. With a table selected, ⌘C / Ctrl+C (or Copy schema in its panel or the palette) copies its `CREATE TABLE` with indexes; the faint ? beside the legend, or the ? key, lists every key. **Tour** (⋯ › Tour, the palette, or T; offered when there are at least two domains) presents the domains one after another, in the overview's card order, each zoomed on its central table with a caption; every step fades in while the domain's frame and its central table pulse orange, so a move to a domain seen whole is as plain as a move to a table (the domain's note, or its name and table count), with Pause, Previous, Next and Esc to return to the view you were on. **Download** the view on screen as a static SVG, PNG or JPEG (⋯ or the palette), as it looks: selection and highlights included. **Tips**: a small pill beside the ? shows one tip about a feature shortly after the file opens and when you move to another view, at most one a minute, gone after 10 seconds (tips not seen yet first); × or ⋯ › Tips turns them off, remembered in this browser. In table boxes: a key on primary key columns, a link on columns referencing another table, a bolt on indexed columns, a list icon on columns with enum values, an amber mark on columns that look like a missing relation; the most connected table of a domain (its *central table*) has a stronger header and a star. Lines are solid when confirmed (database foreign key, declared in code, or reviewed) and dashed when found in code but not confirmed; **Highlight ▾** holds the modes that mark the drawing in every view, each with its count; the button reads as on while one is, and is not shown when none has anything to show. **Review mode** (offered while facts wait for review) colours them by review state. **Personal data** (Highlight, or P; offered when some column is marked `pii`) tints those columns in every view and fades everything else, with a tree of domains, tables and their columns, one per line (counts, a click goes to the table or column); the `public` profile drops these columns, so its file has no such entry. **Central tables** (Highlight, or S; offered when some table is starred) gives the starred table of every domain a gold border and fades the others, with a list per domain (a click goes to the table). **Schema health** (Highlight, or H; offered when there are findings, see [Schema health](#schema-health)) puts a small amber triangle on every table with a finding and lists the findings, filterable by severity, each with its suggestion and reference SQL; a click goes to the table or column. In a view you navigated to (a domain opened from the overview too), a pill just above the drawing's top left corner names where Back goes (← too; → goes forward again). The legend lists only what the view on screen draws and folds to a small "Legend" pill (folded at first on the overview and in the views of related tables, where it would cover the drawing); a minimap shows where you are once the view no longer fits the screen. Without JavaScript it still shows a static view (all tables, or `default_view` from `open-erd.yaml`: `overview` draws the cards, `ranking` the ranked bars). |
| `out/erd.xlsx` | Overview sheet first (one row per table), then one sheet per table with its column grid (`# · Name · Type · Nullable · Default · Generated · Expression · Primary Key · Auto Inc · Index · Comment`), then Relations, Polymorphic, Indexes, PII (every column marked `pii`, when there is one), Health (the schema health findings, when there are any: Severity · Rule · Database · Table · Column(s) · Finding · Suggestion · SQL) and a "To review" checklist (pending and stale facts, then possibly missing relations), cross-linked. A Verification sheet lists the verdicts of the last verification (see below); a sharing profile that drops evidence or internal notes (the default for every profile) leaves it out. |
| `out/erd.drawio` | Two pages, Overview (the domain cards, without lines) and All tables (one page per domain instead when the schema is too large for the view of all tables): tables as draw.io table shapes (one row per column, enum meanings in the tooltip of their column), relations as crow's foot connectors attached to the column rows, so tables can be dragged and edited in draw.io. Turn off with `outputs: { drawio: false }` in `open-erd.yaml`. |
| `out/diff.svg`, `out/diff.xlsx` | What changed between two versions of the workspace, colored on the diagram and written as plain sentences, plus a Changes sheet. `diff.svg` opens with **Changes** on (Highlight, or C): tables, cards and lines the diff did not change are faded in every view, tables at the end of a changed line only half; a chip under the toolbar gives the counts, its List shows each changed table with what changed (a click goes there) and × shows everything at full strength. Clicking a table still selects it; Esc brings the fade back. |

![Diff panel for a changed table](docs/images/diff.png)

Readability with 100+ tables: three zoom levels (overview / domain / neighborhood; in a domain view the tables of another domain that has several of them are one box with one bundled line per column),
shared columns such as `created_by` shown as badges instead of lines (a reference inside the hub table's own domain, and the references of a table with no other relation, stay lines),
polymorphic associations drawn as one node, relations nobody confirmed yet
dashed (their evidence, `repo:path#symbol`, is in the To review sheet).
Adding tables keeps the existing layout's relative order, so people who know
the diagram still recognise it.

![Overview](docs/images/overview.png)

## In the viewer

### Keyboard shortcuts

⌘ on a Mac, Ctrl elsewhere. The same list, in the same three groups, opens from the faint ? beside the legend, or the ? key.

| Keys | Does |
|---|---|
| **Find and move** | |
| ⌘K | Palette: search tables and columns, or run a command (go to a view or database, join path, tour, downloads, highlights, copy schema), each listed with its shortcut; `a > b` (or `a → b`) offers the join path between tables `a` and `b` |
| ⌘F or `/` | The palette for tables and columns only |
| ⌘J | Join path: From and To fields (Tab or Enter moves on, Enter on To finds the path); starts from the selected table. Where a browser keeps ⌘J for itself, use Join path… in the palette |
| ⌘A | All tables (in a text field it selects the text as usual) |
| Shift-click (or ⌘/Ctrl-click) a table | Adds it to the selection, or takes it out: the tables are lit together, the panel lists them (Copy link; Join path for two) and the address names them (`tables=`), so a copied link shows the same tables |
| ← → | Back to the previous table or view, forward again |
| **Highlight** | |
| P | Personal data map: columns marked `pii` tinted, the rest faded, with their list (only when the model has such columns) |
| H | Schema health: tables with findings marked, with the list of findings (only when there are findings) |
| S | Central tables: the starred table of each domain marked, the rest faded, with their list (only when a table is starred) |
| C | Changes: fade what a diff did not change, with the list of changes (only in `diff.svg`) |
| L | Shows or hides the legend |
| **Other** | |
| T | Tour: shows each domain in turn, most connected first, zoomed on its central table with its name, table count and note; moves on every 6 s. ← → step, Space pauses, Esc ends it and returns to where you were |
| ⌘C | With a table selected and no text selected: copies its `CREATE TABLE` with indexes |
| ? | This list of keys |
| Esc | Closes the palette, a menu or the panel; with a highlight mode's own list open, turns that mode off; with nothing open, turns every highlight mode off |

### Moving between tables

Jumping from one table to another (a relation chip, a row of a group box, a
search hit, a stub, a join path) is remembered: Back returns to the previous
table, in the same view, with its panel on the same tab, before it returns
to the previous view. The panel shows the last tables visited with ← and →,
and the table reached pulses briefly.

### Links

A link to `erd.svg` with one of these after `#` opens the viewer there.
Table ids are `<db>.<schema>.<table>`; a list is separated by commas. Ids
that name no table are left out (a link with none opens as usual).

| After `#` | Opens |
|---|---|
| `table=<table id>` | That table, selected, with its panel. |
| `column=<table id>.<column>` | The same, with that column unfolded in the panel. |
| `view=<view>` | A view: `all`, `overview`, `ranking`, `domain:<db>/<domain>`. |
| `tables=<id>,<id>,...` | All tables (in a schema too large for it, the smallest domain view holding them all, else the first table's domain with a note on how many are elsewhere), those tables lit and the rest faded, zoomed to fit them, with a panel listing them. With `view=<view>&` before it, that view when it draws them all. Shift-click writes this link. Esc or a click on empty space clears it. |
| `path=<id>,<id>,...` | A join path, as the Join path panel shows it. Two tables: the cheapest paths between them. More: the cheapest path between each table and the next, end to end (a direct relation, when there is one, is always the cheapest). When no relations join two neighbours, the tables are lit as with `tables=`. |

Put `view=<view>&` before `table=` or `column=` to open the table in that
view, for example `#view=domain:shop/Orders&table=shop.public.orders`
(when the view does not draw the table, its usual view). The address follows
the selected table and the view it is seen in, so it can be copied and
shared as is. `/open-erd:ask` answers with a `tables=` or `path=` link.

## Schema health

A list of things worth a look in the schema, found mechanically from the
model. There is no score, and the SQL is a reference to review, not a
migration for your framework. A rule only reports what the model records
for certain: a database whose model lists no index at all gets no index
findings.

| Rule | Severity | Reports |
|---|---|---|
| `missing_fk` | medium | A relation declared in code with no foreign key in the database (SQL engines only; not for polymorphic columns, views, partitioned tables, or a target that is neither a key nor unique). SQL: `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY …` (none for SQLite, which cannot add one to an existing table). |
| `unindexed_fk` | medium | The referencing columns of a relation that no index starts with (a composite index starting with them, the primary key or a unique column counts). Not for inferred relations, nor for a database foreign key on MySQL / MariaDB, which index those themselves. SQL: `CREATE INDEX …`; MongoDB gets a `createIndex` line. |
| `polymorphic_unindexed` | medium | A polymorphic association with no index starting with its type and id columns (in either order). |
| `orphan_table` | low | A table nothing connects to (not a hub table, not in `ignore_missing.tables`). |
| `redundant_index` | low | An index whose columns begin another index of the same table (same method and `where`), or a duplicate. A unique index is never redundant to a longer one. SQL: `DROP INDEX …` when the index has a name. |

`validate` never fails because of these; it adds the count to its last line.
The same findings show in the SVG (Highlight › Schema health) and in the Health
sheet. A sharing profile shows only findings about what it still shows.
To stop reporting one, add it to `open-erd.yaml` with the reason as a
comment: `<rule>:<table id>` silences the rule on the whole table,
`<rule>:<table id>.<column>` only the findings that involve that column.

```yaml
health:
  ignore:
    - unindexed_fk:billing.public.audit_logs              # write-only log, read by date only
    - missing_fk:billing.public.payments.order_id         # rows outlive their order on purpose
```

## Commands

| Command | Does |
|---|---|
| `/open-erd:init` | Asks where to put the ERD workspace (outside your code repo, its own git repo), writes a read-only extract script per source repo and runs it after you approve, proposes domains, draws the first ERD. |
| `/open-erd:sync` | Re-reads the code, updates the model, asks you to confirm renames, marks facts that no longer match as `stale` instead of deleting them, commits, and when something changed writes `out/diff.svg` / `out/diff.xlsx` showing what this sync changed. |

After building the model, `init` and `sync` have a second agent, with a fresh context, re-read the code for relations the model missed, starting from the warnings of `validate` (a `*_id` column nothing uses, a table nothing connects to). What it finds is added as `pending` for you to review; columns that are not references go into `ignore_missing` in `open-erd.yaml`.
| `/open-erd:review` | Walks through inferred and stale relations one by one; you confirm or correct in plain words. Reviewed facts are locked. |
| `/open-erd:diff` | Compares two versions of the workspace: a tag, any commit, `HEAD`, or the uncommitted working copy. |
| `/open-erd:ask "<question>"` | Answers a question about the data from the ERD model only (not the code), naming the tables, columns and relations it relies on, with a link that opens them in `erd.svg` (see [Links](#links)). Writes nothing. |
| `/open-erd:ci-setup` | Writes a GitHub Actions workflow for a source repository (after you agree) that comments the ERD changes on each pull request; see [Pull request preview](#pull-request-preview). |
| `/open-erd:feedback <text>` | Opens a GitHub issue on this repository with your feedback, after showing you the draft. Never attaches your project's data. |

The other commands find the workspace by themselves: a path you give, the current folder when it is the workspace, or, run from inside a source repository, a workspace up to three folders above it whose `open-erd.local.yaml` lists that repository (they ask when there are several, or none).

To change the diagram, just say it: "orders.status: refunded means money
returned", "move Billing next to Orders", "invoices.user_id points to
customers, not users".

## Verification

Before `init`, `sync`, `review` or an edit you asked for in conversation
commits the model, the change is checked twice:

1. **Structure, no AI.** `open-erd verify --workspace <ws>` compares the
   model's tables, columns (type, nullable, primary key, unique, default,
   auto increment), indexes and foreign-key relations with what the extract
   scripts read from the code (`extract/facts/*.json`), prints one line per
   difference and fails on any. A table the model leaves out on purpose (a
   framework table) goes into `not_in_model` in `open-erd.yaml`.
2. **What the AI wrote, by a second agent.** A verifier with a fresh
   context, that did not write the model, re-reads the code for each changed
   note, enum meaning, relation found in code (target, cardinality,
   optional) and polymorphic association, and answers confirmed, wrong (with
   the fix) or unverifiable. Wrong facts are fixed and checked again (two
   rounds at most); unverifiable relations stay `pending` for you. The
   verifier never edits the model itself.

The verdicts go into `tests/verification.yaml` and the Verification sheet
of `out/erd.xlsx`, and the commit message gets a line such as
`verify: confirmed 12, fixed 2, unverifiable 1`.

Choose how much runs with `verify` in `open-erd.yaml`:

| `verify` | Structure check | Second agent | Cost |
|---|---|---|---|
| `ai-only` (default) | yes | facts an AI wrote | one extra agent per change |
| `full` | yes | every changed fact, also those copied from the code's schema | about 30–50% more tokens per sync |
| `off` | no | no | none |

## Pull request preview

`/open-erd:ci-setup` sets up a workflow in a source repository so a pull
request that changes the schema files gets one comment with how the ERD
would change. No AI runs in CI:

1. The workflow checks out the pull request, the ERD workspace repository
   and the open-erd engine (pinned to the commit of the plugin you run).
2. It runs the workspace's extract script on the pull request's code, then
   `apply-facts` copies the workspace and applies the mechanical changes:
   tables, columns, indexes and foreign-key (`db_fk`) relations added or
   removed, column type, nullable, default and similar attributes. New
   tables go into a domain named `Unassigned`.
3. `diff` compares the workspace with that copy. The comment shows the
   summary line, a table of changes, what is left for `/open-erd:sync`
   (possible renames, the domain and notes of new tables, relation kinds,
   anything a reviewed fact uses) and a link to `diff.svg` and `diff.xlsx`
   in the run's artifacts. Every new push updates the same comment.

The workflow only comments: the workspace is not changed. Run
`/open-erd:sync` after merging as usual.

Paths that trigger it are the files and folders the extract script reads;
the skill shows them before writing. It writes
`.github/workflows/open-erd.yml` only after you agree, and never commits it.

Token setup, once per source repository:

- The workspace is its own repository, so the workflow needs to read it:
  create a fine-grained personal access token (or a GitHub App installed on
  the workspace repository) limited to that repository, with
  **Contents: Read-only**. Add it to the source repository as the Actions
  secret `OPEN_ERD_WORKSPACE_TOKEN` (Settings → Secrets and variables →
  Actions).
- Commenting uses the workflow's own `GITHUB_TOKEN`; the workflow asks
  `pull-requests: write` for it. Pull requests from forks are skipped.

Run the same steps by hand:

```
node <plugin root>/dist/open-erd.mjs apply-facts --workspace <ws> --facts <facts dir> --out <copy>
node <plugin root>/dist/open-erd.mjs diff --workspace <ws> --from HEAD --to-workspace <copy> --format markdown
```

## Safety

- Nothing is written to your source repositories (except the workflow file `/open-erd:ci-setup` writes after you agree); extract scripts only read files and never boot your app.
- Database access happens only when you approve it each time, read-only, metadata only; credentials are never stored.
- The workspace is never pushed unless you ask.

## Supported sources

Rails, Laravel, Django, Prisma, TypeORM, Sequelize, Mongoose and raw SQL are
covered by the extraction guide; other stacks work through the same
read-only-script approach. Several repositories and several databases (SQL and
MongoDB) can share one ERD.

## draw.io tips

- Select a table header or a column name and press ⌘M (Edit Data) to read its type, default, enum values and description.
- Clicking a table header in the draw.io viewer opens that table in `erd.svg` (keep both files in the same folder).
- Overview cards link to the All tables page.
