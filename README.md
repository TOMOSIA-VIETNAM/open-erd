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
| `out/erd.svg` | One self-contained file. Overview (database → domain; one line per pair of domains, as thick as the relations it stands for, with their count in a badge; lines of a single relation start hidden, `overview.min_relations` in `open-erd.yaml` sets the threshold, hovering a domain shows all its lines), domain views, neighborhood of a table. Click a table to highlight its links, click a line to animate it, search tables/columns, hover a column for type/enum meanings/notes, Business/Technical mode. **Join path**: pick two tables and get up to three ways to join them, each hop's condition (`orders.user_id = users.id`) with warnings (unconfirmed, cross-DB, polymorphic type filter, row multiplication), lit hop by hop on the diagram, copyable as text or as a SQL skeleton (`SELECT *` with one `JOIN` per hop and a `--` comment above every hop to check; not offered for a path across databases). **Download** the view on screen as a static SVG, PNG or JPEG. Columns with enum values carry a small list icon; columns that look like a missing relation carry an amber mark. Lines are solid when confirmed (database foreign key, declared in code, or reviewed) and dashed when found in code but not confirmed; **Review mode** colours them by review state. The legend lists only what the view on screen draws; a minimap shows where you are once the view no longer fits the screen. Without JavaScript it still shows a static view (the overview, or `default_view` from `open-erd.yaml`). |
| `out/erd.xlsx` | Overview sheet first (one row per table), then one sheet per table with its column grid (`# · Name · Type · Nullable · Default · Generated · Expression · Primary Key · Auto Inc · Comment`), then Relations, Polymorphic and a "To review" checklist (pending and stale facts, then possibly missing relations), cross-linked. |
| `out/erd.drawio` | Two pages, Overview and All tables (one page per domain instead when the schema is too large for the view of all tables): tables as draw.io table shapes (one row per column, enum meanings in the tooltip of their column), relations as crow's foot connectors attached to the column rows, so tables can be dragged and edited in draw.io. Turn off with `outputs: { drawio: false }` in `open-erd.yaml`. |
| `out/diff.svg`, `out/diff.xlsx` | What changed between two snapshots, colored on the diagram and written as plain sentences, plus a Changes sheet. |

![Diff panel for a changed table](docs/images/diff.png)

Readability with 100+ tables: three zoom levels (overview / domain / neighborhood),
shared columns such as `created_by` shown as badges instead of lines,
polymorphic associations drawn as one node, relations nobody confirmed yet
dashed, with their evidence (`repo:path#symbol`). Adding tables keeps
the existing layout's relative order, so people who know the diagram still
recognise it.

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
