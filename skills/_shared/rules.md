# open-erd: rules shared by every command

Read this before acting. Each `SKILL.md` adds its own steps on top.

## Talking to the user

- Speak the user's language (the one they write in). Everything written into
  the workspace (model notes, enum meanings, commit messages) is English.
- Every question to the user goes through the `AskUserQuestion` tool, so the
  user answers with one click (every "ask", "confirm", "approve" or "which
  one" in the skills means this):
  - One decision per call, then wait for the answer. Batch (up to 4) only
    questions that do not depend on each other's answers.
  - 2–4 concrete options. The one you recommend comes first, its label ends
    with "(Recommended)" and its description says why in one sentence; every
    other option's description says what it changes or costs. Recommend from
    what you found (the code, the model, the facts), not a guess.
  - A short `header` (≤ 12 characters) naming the decision. Use `preview`
    when the user must compare code, a script, YAML or a commit message.
  - No "Other" option: the tool always lets the user type their own answer
    (a path, a tag name, a domain name). Questions that only need free text,
    such as an absolute path with no candidate, still go through the tool
    with the candidates you found as options.
  - Approvals that gate an action (running an extract script, writing a
    workflow, creating an issue, deleting a fact) put the proceeding option
    first only when the check before it passed; show what will run or be
    written in the question or its `preview`.
  - Without the tool on this platform, ask in plain text in the same shape:
    numbered options, the recommended one first and marked, then wait.

## Locating the plugin and the engine

The engine is one bundled file inside this plugin: `<plugin root>/dist/open-erd.mjs`.
Resolve `<plugin root>` once per session, in this order, and keep the absolute
path:

1. `${CLAUDE_PLUGIN_ROOT}` (set by Claude Code for plugin skills).
2. Two levels above the "Base directory for this skill" shown when this skill
   loaded (`<plugin root>/skills/<name>/`).
3. `ls -d ~/.claude/plugins/cache/*/open-erd/*/` — when several versions exist,
   prefer the one containing a `.in_use` file, else the most recently modified.

On any other agent platform, `<plugin root>` is the `ROOT` resolved by
`adapters/root.md`, which also maps the tool names used below.

Check it with `node <plugin root>/dist/open-erd.mjs --help`. Shell variables do
not survive between tool calls: write the absolute path into every command.

Engine commands (`<ws>` = absolute workspace path):

```bash
node <plugin root>/dist/open-erd.mjs validate --workspace <ws>
node <plugin root>/dist/open-erd.mjs lock     --workspace <ws>
node <plugin root>/dist/open-erd.mjs verify   --workspace <ws>
node <plugin root>/dist/open-erd.mjs layout   --workspace <ws>
node <plugin root>/dist/open-erd.mjs render   --workspace <ws> [--profile <name>]
node <plugin root>/dist/open-erd.mjs diff     --workspace <ws> --from <ref> --to <ref|HEAD|WORKTREE> [--profile <name>]
node <plugin root>/dist/open-erd.mjs apply-facts --workspace <ws> --out <dir>   # CI preview copy; never writes <ws>
```

Exit code 0 = success. Non-zero: show the engine's message, fix the cause in
the workspace (never in the engine), run again. An option the engine
rejects: tell the user this engine build does not support it and stop that
step. `render` never writes `layout.json`; a render error about missing or
stale positions means run `layout` first. `render` writes `out/erd.svg`,
`out/erd.xlsx` and `out/erd.drawio` (unless `outputs.drawio: false`) (`out/erd.<profile>.*` with `--profile`). `diff` writes
`out/diff.svg` and `out/diff.xlsx` (`out/diff.<profile>.*` with `--profile`)
and never writes `layout.json` either.

`validate` also checks `tests/locked.yaml`: every reviewed fact listed there
must still be in the model unchanged, or marked `review: stale`. A locked-fact
error means restore the fact or set it `stale`; never edit the lock file to
make it pass (only `/open-erd:review` removes an entry, after the user
confirmed that change). `validate`, `verify` and `render` also reject an
invalid `tests/verification.yaml` (see "Verification"): fix the file as the
error says. `lock` rewrites the file from the reviewed facts and only
`/open-erd:review` runs it; it refuses while a locked fact is broken.

`verify` compares the model's tables, columns, indexes and constraint-backed
relations with `extract/facts/*.json` and prints one `mismatch:` line per
difference (exit 1); see "Verification".

## Finding the workspace

The workspace is the folder holding `open-erd.yaml`. Try, in order, and stop
at the first that gives one:

1. A path the user gave.
2. The current directory, if it has `open-erd.yaml`.
3. A path mentioned earlier in this conversation.
4. A workspace whose `open-erd.local.yaml` lists the current source
   repository. Workspaces usually sit next to the source, not inside it, so
   look up to three folders above the repository (never above `$HOME`), two
   levels deep:

   ```bash
   repo=$(git rev-parse --show-toplevel)
   dir=$(dirname "$repo")
   for i in 1 2 3; do
     [ "$dir" = "$HOME" ] || [ "$dir" = / ] && break
     find "$dir" -maxdepth 3 -name open-erd.local.yaml -not -path '*/node_modules/*' 2>/dev/null \
       | xargs grep -l "path: $repo\$" 2>/dev/null
     dir=$(dirname "$dir")
   done | sort -u
   ```

   Each hit's folder is a candidate (it must also hold `open-erd.yaml`). One
   candidate: use it and say which workspace in one line. Several: list them
   and ask which one.
5. Ask for it.

Never guess a default location, and never create a workspace outside
`/open-erd:init`.

## Safety (no exceptions)

- Never write, create, delete or `git` anything in a source repository (one
  exception: the workflow file `/open-erd:ci-setup` writes after the user
  agreed). Allowed there: reading files and read-only git (`rev-parse`, `status --porcelain`,
  `log`, `show`).
- Never boot a source app (`rails runner`, `artisan`, `manage.py`, `node app`,
  `npm install`, …). Extract scripts read static files only.
- Never write credentials, tokens, connection strings or hostnames of a
  database into the workspace.
- Database access only through the user's own CLI or MCP, only after asking
  for that specific read this time, read-only metadata only. Never read data
  rows.
- Never `git push` the workspace unless the user asks in this conversation.
- Never change or remove a fact with `review: reviewed` without the user
  confirming that exact change. When code no longer supports it, set
  `review: stale` and leave the rest as it was.
- Never write SVG or XLSX by hand: outputs come from the engine only.

## Extract scripts: approval

An extract script (`<ws>/extract/<source>.mjs`) may run without asking only
when it is tracked in the workspace git and unchanged since the last commit:

```bash
git -C <ws> ls-files --error-unmatch extract/<source>.mjs && git -C <ws> diff --quiet HEAD -- extract/<source>.mjs
```

Otherwise (new or edited) show the user the full script, say what it reads
and that it writes nothing, and ask permission before running it. Before
asking, check it imports nothing but `node:fs` and `node:path` and contains no
`child_process`, `http`, `https`, `net`, `fetch(`, `writeFile`, `appendFile`,
`mkdir`, `rm(`, `rmSync`, `unlink` or `rename(`.

Run: `node <ws>/extract/<source>.mjs <source path> > <ws>/extract/facts/<source>.json`.
Source paths come from `<ws>/open-erd.local.yaml`.

## Committing the workspace

The workspace has its own git repository. Commit there only (`git -C <ws> …`),
English message, after `validate` passes. Stage with
`git -C <ws> add -A`, then check `git -C <ws> status --short` does not list
`open-erd.local.yaml` (it must stay gitignored). Nothing staged: skip the
commit.

For each source, record its revision:

```bash
git -C <source path> rev-parse HEAD           # "not a git repo" if this fails
git -C <source path> status --porcelain | head -1   # non-empty -> append "+dirty"
```

## Missing-relation review

`init` and `sync` run this after the model passes `validate`, before
`layout`. Its goal: relations the model left out, found by a second reader
who did not write the model.

1. Collect the `warning: possibly missing relation: ...` lines `validate`
   printed (may be none).
2. Start one reviewer subagent with a fresh context (Claude Code `Agent`
   tool, general-purpose, or as `adapters/root.md` maps it; not a fork of this
   conversation). Give it only:
   the source names and paths from `open-erd.local.yaml`, the workspace path,
   the absolute `<plugin root>`, the warning lines verbatim, and this task:
   - Read `<ws>/model/*.yaml` and `<plugin root>/skills/_shared/model.md`
     ("Writing facts").
   - For each warning, read the code that writes or reads that column or
     table, and decide: a relation (or polymorphic association) the model
     misses, or not a reference.
   - Then scan the sources on its own for associations, joins, lookups by
     id and foreign keys the model does not have (ORM associations, raw SQL
     `JOIN`, `where(x_id: ...)`, `findBy...Id`, cross-service id fields).
   - Read only; write nothing; run no app.
   - Return two lists, every item with `evidence` as
     `<source>:<path>#<symbol>` and a one-line `why`:
     `proposals` (from table + columns, to table + columns, cardinality,
     optional, kind, or a polymorphic entry) and `not_references`
     (`<table id>.<column>` or `<table id>`).
3. Check each item against the code it cites (open the file, find the
   symbol). Drop what you cannot confirm.
4. Add each confirmed proposal to the model with its evidence and
   `review: pending`, never `reviewed`. Add each confirmed non-reference to
   `ignore_missing` in `open-erd.yaml` with the reason as a YAML comment.
5. Run `validate` again. Tell the user how many relations were added from
   the review and which warnings remain.

## Verification

Every change written into the model is checked by a second reader before it
is committed: in `init`, `sync`, `review`, and after any edit the user asks
for in conversation ("invoices.user_id points to customers"). Run it once
the model passes `validate` (after the missing-relation review when the
command has one), before `layout` and the commit.

`verify` in `open-erd.yaml` decides how much runs:

| `verify` | Structure check (step 1) | Verifier agent (step 2) |
|---|---|---|
| `off` | skipped | skipped; leave this section |
| `ai-only` (default) | runs | facts an AI wrote |
| `full` | runs | every changed fact, also those copied from the facts (about 30-50% more tokens per run) |

Scope: what changed since the last commit, `git -C <ws> diff HEAD -- model`
plus untracked files from `git -C <ws> status --porcelain -- model`. In
`init` (no commit yet) that is the whole model.

1. **Structure (no AI).** The facts must be current: `sync` has just re-run
   the extract scripts; elsewhere re-run them first (approval rule in
   "Extract scripts: approval"). Then:

   ```bash
   node <plugin root>/dist/open-erd.mjs verify --workspace <ws>
   ```

   Each `mismatch:` line names one difference between the model and the
   facts (a column type, nullable, default, index, a table or column missing
   on one side, a relation that should or should not be `db_fk`). Fix the
   model to match the facts, or fix the extract script when it is what is
   wrong (show the change and ask, as for any script edit). A table the
   model leaves out on purpose (a framework table): after the user agrees,
   add its id to `not_in_model` in `open-erd.yaml` with the reason as a YAML
   comment. A `review: reviewed` fact the facts contradict: set it `stale`,
   never change it; `verify` does not report what a stale fact uses. Run
   again until it exits 0. Exit 1 with "no facts files" means the extract
   scripts never ran: run them, do not skip the check.

2. **AI-written facts (verifier agent).** From the scope, list each changed
   fact an AI wrote, one line each, named by its model path:
   - notes: `<table id>.note`, `<table id>.<column>.note`, `<db>.domains.<domain>.note`,
     `polymorphic <table id> «<name>».note`;
   - enum meanings: `<table id>.<column>.enum.<value>`;
   - relations of kind `declared`, `inferred` or `cross_db` (target,
     `cardinality`, `optional`): `relation <from table>.<columns> -> <to table>.<columns>`;
   - polymorphic entries (targets, `optional`): `polymorphic <table id> «<name>»`.

   With `verify: full` also list the other changed facts (columns, indexes,
   `db_fk` relations). Give each line its evidence (the fact's `evidence`, or
   the code you read for a note). Nothing listed: skip to step 4 with an
   empty record.

   Start one verifier subagent with a fresh context (Claude Code `Agent`
   tool, general-purpose, or as `adapters/root.md` maps it; not a fork of this
   conversation) whose prompt is
   `<plugin root>/skills/_shared/verifier.md` followed by: the source names
   and paths from `open-erd.local.yaml`, the workspace path, the absolute
   `<plugin root>`, and the fact list (each line: model path, what the model
   now says, evidence). Give it nothing else: not your reasoning, not the
   diff.

3. **Apply the verdicts.** The verifier never edits the model; you do.
   - `confirmed`: keep.
   - `wrong`: open the code it cites; when it holds, apply the fix (a
     `reviewed` fact is set `stale` instead, and the user told). Then start a
     new verifier with only the fixed facts. At most two rounds per fact: a
     fact still `wrong` after the second stays as the code best supports,
     with `review: pending` on a relation or polymorphic entry, and is named
     to the user.
   - `unverifiable`: a relation or polymorphic entry gets `review: pending`,
     never `reviewed`; a note stays as written. Both are recorded.

4. **Record.** Write `<ws>/tests/verification.yaml` with this run's verdicts
   only (it replaces the previous run's):

   ```yaml
   schema_version: 1
   facts:
     - fact: billing.public.invoices.note
       result: fixed            # confirmed | fixed (wrong, corrected, then confirmed) | wrong | unverifiable
       reason: Said one invoice per order; InvoiceJob creates one per billing cycle.
   ```

   Then run `verify` again: it checks the file, rewrites it sorted and prints
   the commit line `verify: confirmed N, fixed M, unverifiable K`. Put that
   line in the commit message body. The record is team-internal: `render`
   adds it as the Verification sheet of `out/erd.xlsx`, never to a sharing
   profile that drops evidence or internal notes.

## Last line of init, sync, review, render, diff, ask, ci-setup

After the command finishes (success or not), end with exactly one line in the
user's language inviting feedback on open-erd, containing the literal command
`/open-erd:feedback <text>`. In Vietnamese:
`Góp ý / báo lỗi: /open-erd:feedback <nội dung>`.
