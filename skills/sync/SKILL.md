---
name: sync
description: Bring an existing open-erd workspace up to date with the source code. Re-runs the extract scripts, applies what changed to model/*.yaml, asks before recording renames, marks reviewed facts that no longer match the code as stale instead of changing them, re-renders the ERD and commits with each source repo's revision. Use when the code changed since the last ERD, or the user asks to update or refresh the ERD.
---

# sync

Read first (if `${CLAUDE_PLUGIN_ROOT}` is empty, the plugin root is two
levels above this skill's base directory): `${CLAUDE_PLUGIN_ROOT}/skills/_shared/rules.md` and
`${CLAUDE_PLUGIN_ROOT}/skills/_shared/model.md`. When a script needs fixing:
`${CLAUDE_PLUGIN_ROOT}/skills/init/stacks.md`.

No `open-erd.yaml` in the workspace → offer `/open-erd:init`.

## 1. Preconditions

- `git -C <ws> status --porcelain`: uncommitted changes in `model/` or
  `layout.json` → show them and ask whether to keep them in this sync or stop.
- `open-erd.local.yaml` missing or a source path not found → ask for the path
  of that source and write it there.

## 2. Re-extract

For each source, run its script (approval rule in rules.md: an unchanged,
committed script runs without asking; a new or edited one is shown first).
Then:

```bash
git -C <ws> diff --stat -- extract/facts
git -C <ws> diff -- extract/facts/<source>.json
```

That diff is the list of code changes to apply. No diff and no new hints →
skip to step 6, do not commit, and tell the user nothing changed.

If the stack gained something the script misses (new folder, new idiom), fix
the script, show the change, ask, rerun.

Cached database metadata (`extract/db-*.metadata.json`) is reused as is.
Refresh it only if the user agrees this time (same rules as init).

## 3. Apply changes to the model

For each change in the facts diff, update `model/*.yaml`:

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

Every new table, column and polymorphic entry gets a `note` (rules in
`model.md`, "Writing facts": business meaning learned from how the code uses
it, not the name restated); also write one for any column or polymorphic
entry still without a note. A new enum value gets a meaning only when the
code reveals one, else `""`. Copy
`default`, `auto_increment` and `generated` from the facts, and update them
like any other attribute when the facts change. An extract script written
before these fields existed does not emit them: extend it (`stacks.md`),
show the change and ask as for any script edit.

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
"Missing-relation review") before `layout`. Tell the user
which nodes `layout` reports as moved.

## 7. Commit and report

Commit (rules.md) with a subject plus one line per source:

```
sync: <n> added, <n> changed, <n> removed, <n> stale

<source>: <sha>[+dirty]
```

Report what changed in plain words, the stale and pending counts, and suggest
`/open-erd:review` when there are any. End with the feedback line.
