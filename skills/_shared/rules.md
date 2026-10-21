# open-erd: rules shared by every command

Read this before acting. Each `SKILL.md` adds its own steps on top.

## Talking to the user

- Speak the user's language (the one they write in). Everything written into
  the workspace (model notes, enum meanings, commit messages) is English.
- Ask one question at a time and wait. A question that needs a choice lists the
  options.

## Locating the plugin and the engine

The engine is one bundled file inside this plugin: `<plugin root>/dist/open-erd.mjs`.
Resolve `<plugin root>` once per session, in this order, and keep the absolute
path:

1. `${CLAUDE_PLUGIN_ROOT}` (set by Claude Code for plugin skills).
2. Two levels above the "Base directory for this skill" shown when this skill
   loaded (`<plugin root>/skills/<name>/`).
3. `ls -d ~/.claude/plugins/cache/*/open-erd/*/` — when several versions exist,
   prefer the one containing a `.in_use` file, else the most recently modified.

Check it with `node <plugin root>/dist/open-erd.mjs --help`. Shell variables do
not survive between tool calls: write the absolute path into every command.

Engine commands (`<ws>` = absolute workspace path):

```bash
node <plugin root>/dist/open-erd.mjs validate --workspace <ws>
node <plugin root>/dist/open-erd.mjs lock     --workspace <ws>
node <plugin root>/dist/open-erd.mjs layout   --workspace <ws>
node <plugin root>/dist/open-erd.mjs render   --workspace <ws> [--profile <name>]
node <plugin root>/dist/open-erd.mjs diff     --workspace <ws> --from <ref> --to <ref|HEAD|WORKTREE> [--profile <name>]
```

Exit code 0 = success. Non-zero: show the engine's message, fix the cause in
the workspace (never in the engine), run again. An option the engine
rejects: tell the user this engine build does not support it and stop that
step. `render` never writes `layout.json`; a render error about missing or
stale positions means run `layout` first. `render` writes `out/erd.svg` and
`out/erd.xlsx` (`out/erd.<profile>.*` with `--profile`). `diff` writes
`out/diff.svg` and `out/diff.xlsx` (`out/diff.<profile>.*` with `--profile`)
and never writes `layout.json` either.

`validate` also checks `tests/locked.yaml`: every reviewed fact listed there
must still be in the model unchanged, or marked `review: stale`. A locked-fact
error means restore the fact or set it `stale`; never edit the lock file to
make it pass (only `/open-erd:review` removes an entry, after the user
confirmed that change). `lock` rewrites the file from the reviewed facts and only
`/open-erd:review` runs it; it refuses while a locked fact is broken.

## Finding the workspace

The workspace is the folder holding `open-erd.yaml`. Use, in order: a path the
user gave, the current directory if it has `open-erd.yaml`, a path mentioned
earlier in this conversation. Otherwise ask for it. Never guess a default
location, and never create a workspace outside `/open-erd:init`.

## Safety (no exceptions)

- Never write, create, delete or `git` anything in a source repository. Allowed
  there: reading files and read-only git (`rev-parse`, `status --porcelain`,
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

## Last line of init, sync, review, render, diff

After the command finishes (success or not), end with exactly one line in the
user's language inviting feedback on open-erd, containing the literal command
`/open-erd:feedback <text>`. In Vietnamese:
`Góp ý / báo lỗi: /open-erd:feedback <nội dung>`.
