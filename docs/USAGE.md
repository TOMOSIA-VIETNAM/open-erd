# open-erd: usage reference

The short guide is the README. This page lists every output, command and behaviour.

## Outputs in detail

| File | What it is |
|---|---|
| `out/erd.svg` | One self-contained file. Opens on **All tables**, zoomed in to a readable size around the schema's most connected table, with a minimap (a schema over 300 tables opens on the overview; `default_view` in `open-erd.yaml` picks another start). **Overview**: one card per domain, grouped by database, the most connected domain first: its name, table count, a one-line business description (`domains:` in the model), its central table, and the domains it is most related to, each with a small strength bar; hovering or focusing a card draws curved connectors to every related domain (thicker = more relations, tooltip with the count), a click opens the domain, a click on a related domain opens that one. **Connections** (a toolbar tab next to the map): a domain × domain matrix shaded by how many relations each row's domain makes to each column's, with the count inside a domain on the diagonal; hover a cell for both directions, click it to list the relations; the header row and column stay on screen while you pan. Then domain views, neighborhood of a table. Click a table to highlight its links and open its panel: name, domain and note on top, one row of actions (related tables Direct / +1 level, join path, **Copy schema** as approximate SQL `CREATE TABLE`, a JSON schema-like document for MongoDB, or a Markdown table), then tabs Columns · Relations · Indexes; a column row shows its key icon, type, `NULL` when nullable, `= default`, its enum values on click and its note, click a line to animate it, hover a column for type/enum meanings/notes. **Search**: ⌘F / Ctrl+F (or `/`) opens a search box over tables and columns. **Join path** (⌘J / Ctrl+J, or the toolbar button): a box with From and To fields picks two tables and get up to three ways to join them, each hop's condition (`orders.user_id = users.id`) with warnings (unconfirmed, cross-DB, polymorphic type filter, row multiplication), lit hop by hop on the diagram, and **Copy SQL** (`SELECT *` with one `JOIN` per hop and a `--` comment above every hop to check; not offered for a path across databases). The toolbar switches between **All tables · Map · Connections** (⌘A / Ctrl+A jumps to All tables); **Databases** jumps to one database. With a table selected, ⌘C / Ctrl+C copies its `CREATE TABLE` with indexes; ⋯ › Keyboard shortcuts lists every key. **Download** the view on screen as a static SVG, PNG or JPEG. In table boxes: a key on primary key columns, a link on columns referencing another table, a bolt on indexed columns, a list icon on columns with enum values, an amber mark on columns that look like a missing relation; the most connected table of a domain (its *central table*) has a stronger header and a star. Lines are solid when confirmed (database foreign key, declared in code, or reviewed) and dashed when found in code but not confirmed; **Review mode** (in the ⋯ menu, offered while facts wait for review) colours them by review state. In a view you navigated to, a pill just above the drawing's top left corner names where Back goes (Backspace or Alt+← too). The legend lists only what the view on screen draws and folds to a small "Legend" pill; a minimap shows where you are once the view no longer fits the screen. Without JavaScript it still shows a static view (all tables, or `default_view` from `open-erd.yaml`: `overview` draws the cards, `connections` the matrix). |
| `out/erd.xlsx` | Overview sheet first (one row per table), then one sheet per table with its column grid (`# · Name · Type · Nullable · Default · Generated · Expression · Primary Key · Auto Inc · Index · Comment`), then Relations, Polymorphic, Indexes and a "To review" checklist (pending and stale facts, then possibly missing relations), cross-linked. A Verification sheet lists the verdicts of the last verification (see below); a sharing profile that drops evidence or internal notes (the default for every profile) leaves it out. |
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

## In the viewer

### Keyboard shortcuts

⌘ on a Mac, Ctrl elsewhere. The same list is under ⋯ › Keyboard shortcuts.

| Keys | Does |
|---|---|
| ⌘F or `/` | Search tables and columns |
| ⌘J | Join path: From and To fields (Tab or Enter moves on, Enter on To finds the path); starts from the selected table. Where a browser keeps ⌘J for itself, use the toolbar's Join path |
| ⌘A | All tables (in a text field it selects the text as usual) |
| ⌘C | With a table selected and no text selected: copies its `CREATE TABLE` with indexes |
| L | Shows or hides the legend |
| Backspace or Alt+← | Back to the previous table or view |
| Shift+Backspace or Alt+→ | Forward again |
| Esc | Closes search, a menu or the panel |

### Moving between tables

Jumping from one table to another (a relation chip, a row of a group box, a
search hit, a stub, a join path) is remembered: Back returns to the previous
table, in the same view, with its panel on the same tab, before it returns
to the previous view. The panel shows the last tables visited with ← and →,
and the table reached pulses briefly.

### Links to a table

`erd.svg#table=<db>.<schema>.<table>` opens on that table, selected, with its
panel; `#column=<table id>.<column>` also unfolds that column; `#view=<view>`
opens a view (`all`, `overview`, `connections`, `domain:<db>/<domain>`). The
address follows the selected table, so it can be copied and shared as is.

## Commands

| Command | Does |
|---|---|
| `/open-erd:init` | Asks where to put the ERD workspace (outside your code repo, its own git repo), writes a read-only extract script per source repo and runs it after you approve, proposes domains, draws the first ERD. |
| `/open-erd:sync` | Re-reads the code, updates the model, asks you to confirm renames, marks facts that no longer match as `stale` instead of deleting them, commits. |

After building the model, `init` and `sync` have a second agent, with a fresh context, re-read the code for relations the model missed, starting from the warnings of `validate` (a `*_id` column nothing uses, a table nothing connects to). What it finds is added as `pending` for you to review; columns that are not references go into `ignore_missing` in `open-erd.yaml`.
| `/open-erd:review` | Walks through inferred and stale relations one by one; you confirm or correct in plain words. Reviewed facts are locked. |
| `/open-erd:render` | Re-renders the outputs; `--profile public` drops evidence, PII columns, internal notes and hidden tables for sharing outside the team. |
| `/open-erd:snapshot` | Tags the workspace (e.g. `v1.0-handover`). |
| `/open-erd:diff` | Compares two snapshots (or a snapshot and the current state). |
| `/open-erd:ci-setup` | Writes a GitHub Actions workflow for a source repository (after you agree) that comments the ERD changes on each pull request; see [Pull request preview](#pull-request-preview). |
| `/open-erd:feedback <text>` | Opens a GitHub issue on this repository with your feedback, after showing you the draft. Never attaches your project's data. |

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
