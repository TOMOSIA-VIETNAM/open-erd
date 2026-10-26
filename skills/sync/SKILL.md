---
name: sync
argument-hint: '[what to focus on, e.g. "new billing tables"]'
description: Bring an existing open-erd workspace up to date with the source code. Re-runs the extract scripts, applies what changed to model/*.yaml, asks before recording renames, marks reviewed facts that no longer match the code as stale instead of changing them, re-renders the ERD and commits with each source repo's revision. Use when the code changed since the last ERD, or the user asks to update or refresh the ERD.
---

# sync

Read first (if `${CLAUDE_PLUGIN_ROOT}` is empty, the plugin root is two
levels above this skill's base directory): `${CLAUDE_PLUGIN_ROOT}/skills/_shared/rules.md` and
`${CLAUDE_PLUGIN_ROOT}/skills/_shared/model.md`. When a script needs fixing:
`${CLAUDE_PLUGIN_ROOT}/skills/init/stacks.md`.

Text typed after the command (`/open-erd:sync <text>`) is the user's focus for
this run, e.g. "new billing tables" or "only the orders domain": still sync
everything that changed, but look hardest at that area (scan its code for
tables, columns, relations and notes the scripts may miss) and report on it
first. With no text, sync everything. If nothing changed since the last sync,
say the model is up to date; still run layout and render so the outputs use the installed plugin version, and commit only if they changed.

No `open-erd.yaml` in the workspace → offer `/open-erd:init`.

## 1. Preconditions

- Note where the workspace starts: `git -C <ws> rev-parse HEAD` → `<before>`
  (step 7 compares the ERD with it).
- `git -C <ws> status --porcelain`: uncommitted changes in `model/` or
  `layout.json` → show them and ask whether to keep them in this sync or stop.
- `open-erd.local.yaml` missing or a source path not found → ask for the path
  of that source and write it there.

## 2. Re-extract

For each source, run its script (approval rule in rules.md: an unchanged,
committed script runs without asking; a new or edited one is shown first).
Then list what the scripts now read differently from the last commit:

```bash
node <plugin root>/dist/open-erd.mjs facts-diff --workspace <ws>
```

It prints one line per change (`added table ...`, `changed column
<table>.<column>: type "a" → "b"`, `removed association ...`, enum values,
polymorphic targets, hints), sorted. That list is the code changes to apply.
A new table's columns and indexes are not listed one by one: read them from
`extract/facts/<source>.json`. An `added`, `removed` or `changed <file>:
<key>` line (a part of the facts the engine does not itemise, such as `sti`)
means: compare that key in
the file with `git -C <ws> show HEAD:extract/facts/<file>`. `no changes` →
skip to step 6, do not commit, and tell the user nothing changed.

If the stack gained something the script misses (new folder, new idiom), fix
the script, show the change, ask, rerun.

Cached database metadata (`extract/db-*.metadata.json`) is reused as is.
Refresh it only if the user agrees this time (same rules as init).

## 3. Apply changes to the model

For each line `facts-diff` printed, update `model/*.yaml`:

| Change | Fact not reviewed (`pending`/`stale`) | Fact `review: reviewed` |
|---|---|---|
| new table / column / relation / enum value | add, `review: pending` on relations and polymorphic | — |
| attribute changed (type, nullable, target, enum) | update | leave the fact as it is, set `review: stale` |
| removed from code | delete | leave it, set `review: stale` |

A table or column has no review field: treat it as reviewed when any reviewed
relation or polymorphic entry uses it. Removing such a table or column → keep
it and mark those facts `stale`.

New tables need a domain: propose one (existing domains first) and ask, in one
message for all new tables.
A new domain gets a one-sentence business description under `domains:` in
its database's model file (`model.md`, "note on a domain"); so does any
domain still without one. Drop the entry of a domain that no table uses any
more (`validate` rejects it).

Every new table, column and polymorphic entry gets a `note` (rules in
`model.md`, "Writing facts": business meaning learned from how the code uses
it, else what it does technically, not the name restated); also write one for
any column or polymorphic entry still without a note when the code now tells,
and delete placeholder notes that describe nothing (`Unclear from code.`,
`Unknown.`). A new column that holds personal data gets
`pii: true` (the list in `model.md`, "Writing facts"). A new enum value
gets a meaning only when the code reveals one, else `""`. Copy
`default`, `auto_increment`, `generated` and each table's `indexes` from the
facts, and update them like any other attribute when the facts change (an
index added, dropped or changed in a migration). An extract script written
before these fields existed does not emit them: extend it (`stacks.md`),
show the change and ask as for any script edit. A table still carrying the
older `unique: [[a, b]]` gets it rewritten as `indexes: [{ columns: [a, b],
unique: true }]` (same meaning, `model.md`).

## 4. Renames

A removal plus an addition that look like the same thing (table with mostly
the same columns; column with the same type in the same table; a migration
with `rename_table`/`rename_column`/`RENAME`) is a rename candidate. List
candidates and ask the user to confirm each. On yes:

- keep the fact and its review state, change the id or name, set
  `renamed_from: <old id or old column name>` on the new table or column;
- update every relation, polymorphic entry, `hub` and `hidden` entry that
  used the old name.

On no: handle as one removal and one addition.

## 5. Check reviewed facts survived

```bash
git -C <ws> diff -- model
```

Every hunk that touches a fact with `review: reviewed` may only change
`review` to `stale` or be a confirmed rename. Anything else: restore it.

## 6. Validate, layout, render

```bash
node <plugin root>/dist/open-erd.mjs validate --workspace <ws>
node <plugin root>/dist/open-erd.mjs layout   --workspace <ws>
node <plugin root>/dist/open-erd.mjs render   --workspace <ws>
```

`validate` reporting a locked fact as missing or changed means step 5 missed
it: restore it or mark it `stale`. Never run `lock` in sync. Once `validate`
passes and the facts changed, run the missing-relation review (rules.md,
"Missing-relation review") before `layout`, then the verification of what
changed (rules.md, "Verification"). Tell the user
which nodes `layout` reports as moved.

## 7. Commit and report

Commit (rules.md) with a subject plus one line per source:

```
sync: <n> added, <n> changed, <n> removed, <n> stale

<source>: <sha>[+dirty]
verify: confirmed <n>, fixed <n>, unverifiable <n>
```

(the `verify:` line as `verify` printed it; none when `verify: off`).

When this sync committed a change to the model, draw what changed, so the
user does not have to ask for it:

```bash
node <plugin root>/dist/open-erd.mjs diff --workspace <ws> --from <before> --to HEAD
```

It writes `out/diff.svg` and `out/diff.xlsx` (not committed: they describe
this one sync) and prints a summary line. Nothing committed (the model was
already up to date) → no diff.

Report what changed in plain words, then where to see it: "Open
`<ws>/out/diff.svg` in a browser: changed tables are coloured, the rest is
faded" with the summary line, and `<ws>/out/erd.svg` for the full ERD. Give
the stale and pending counts and suggest `/open-erd:review` when there are
any. Mention once that `/open-erd:diff` compares any two versions (a tag, an
older commit) when the user wants a wider comparison than this sync. End with
the feedback line.
