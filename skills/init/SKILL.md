---
name: init
description: Create an open-erd workspace for a project and draw its first ERD from the source code. Asks where the workspace goes, writes a read-only extract script per source repo (run only with permission), builds model/<db>.yaml with evidence, proposes domains, then lays out and renders an interactive SVG. Use when the user wants an ERD, a database diagram or table documentation for a codebase that has no open-erd workspace yet.
---

# init

Read first (if `${CLAUDE_PLUGIN_ROOT}` is empty, the plugin root is two
levels above this skill's base directory): `${CLAUDE_PLUGIN_ROOT}/skills/_shared/rules.md` (plugin root, engine
commands, safety, commit, last line) and
`${CLAUDE_PLUGIN_ROOT}/skills/_shared/model.md` (file formats). Per-stack
extraction guidance: `${CLAUDE_PLUGIN_ROOT}/skills/init/stacks.md`.

If the chosen workspace already has `open-erd.yaml`, stop and offer
`/open-erd:sync` instead.

## 1. Sources and workspace

1. Ask which source repositories go into this ERD (absolute paths; one or
   more). Give each a short logical name (repo folder name, kebab-case) and
   confirm the names: they appear in every evidence string.
2. Ask where to create the workspace. There is no default. It must be outside
   every source repo (check that no source path is a prefix of it and vice
   versa). Suggest a sibling folder such as `<parent>/<project>-erd` only as an
   example.
3. Create it:

```bash
mkdir -p <ws>/model <ws>/extract/facts
git -C <ws> init
printf 'open-erd.local.yaml\n.DS_Store\n' > <ws>/.gitignore
```

4. Write `open-erd.yaml` (`schema_version: 1`, `sources` names only) and
   `open-erd.local.yaml` (names + absolute paths). Formats in `model.md`.

## 2. Extract scripts

First find every model root of every source (`stacks.md`, "Finding every
model root first"): path gems, submodules, engines, packages, shared
folders. Show the user the list per source. A root outside the source path
becomes its own source after the user confirms its path. If an expected root
is missing (referenced but not on disk), stop here and tell the user what is
missing and where it is referenced; do not build a partial model.

Then for each source:

1. Detect the stack(s) from marker files (`stacks.md`). Tell the user what
   you found and which files the script will read.
2. Write `<ws>/extract/<source>.mjs` following `stacks.md`. Read enough of
   the real files first that the script handles this repo's actual idioms.
3. Show the full script, then ask permission to run it (rules.md, "Extract
   scripts: approval"). Do not run before a yes.
4. Run it to `extract/facts/<source>.json`. Read the stderr summary. If it
   missed files or idioms, fix the script, show the change, ask again, rerun.

Still useful after extraction: read models, services and clients yourself
for `inferred` and `cross_db` hints the script cannot see; record what you
used as evidence.

## 3. Optional: database metadata

Ask once whether the user wants to add metadata from a live database (gives
real foreign keys, indexes, constraints). Only on yes, and for each database
separately:

- Use the user's own CLI or MCP tool and connection; never ask for or store
  credentials.
- Read only catalog metadata (`information_schema`, `pg_catalog`, `SHOW
  CREATE TABLE`, `db.getCollectionInfos()`): FKs, indexes, unique and check
  constraints, column comments. Row counts and `DISTINCT` enum values are a
  separate question each. Never `SELECT` data rows.
- Show the exact queries before running them.
- Save the result, without hostnames or credentials, to
  `<ws>/extract/db-<db>.metadata.json` (sorted, no timestamps).

Facts confirmed by metadata get `kind: db_fk` (when a constraint exists) and
`db` added to `evidence`.

## 4. Write the model

From the facts files (and metadata cache), write one `model/<db>.yaml` per
logical database and `model/cross-db.yaml` when needed, following every rule in
`model.md` "Writing facts": table ids, direction, `kind`, evidence with the
source name prefix, `review: pending`, English notes, enum meanings (only
what code reveals; empty rather than the value restated), `pii`,
and each column's `default`, `auto_increment` and `generated` from the facts.

Write a `note` on every table, every column and every polymorphic entry,
not only the important ones: the Excel table sheets show it as the Comment of
each column. Read how services, controllers, jobs and operations use a table
before writing its note, and describe that business meaning rather than
restating the name. Keep each column note short (about 15 words at most), say
only what code, schema comments or names show, and write `Unclear from code.`
when nothing does.

## 5. Domains

Group tables into domains (5–15 tables each when possible; by bounded context,
module folder, table prefix, then relation density). Present the proposal as a
list `Domain: table, table, …` per database and ask the user to approve or
change it. Write `domain` only after approval. In the same message propose
`collapse_join_tables` and hubs: `hub.columns` for audit and scoping columns
first, `hub.tables` only for cross-cutting tables such as `users` or
`tenants`, never a business table a domain is built around (`model.md`,
`open-erd.yaml`), each with its reason.

## 6. Validate, layout, render

```bash
node <plugin root>/dist/open-erd.mjs validate --workspace <ws>
node <plugin root>/dist/open-erd.mjs layout   --workspace <ws>
node <plugin root>/dist/open-erd.mjs render   --workspace <ws>
```

Fix validation errors in the model and rerun until it passes. Then, before
`layout`, run the missing-relation review (rules.md, "Missing-relation
review").

## 7. Commit and report

Commit in the workspace (rules.md, "Committing the workspace"):
`init: ERD from <source>@<sha>[, <source>@<sha>…]`.

Report to the user: workspace path, output files the engine printed, counts
(databases, tables, relations, polymorphic), and how many facts are pending
review, with the next step `/open-erd:review`. Mention that the workspace is
not pushed anywhere. End with the feedback line.
