---
name: diff
argument-hint: '[from: tag | commit | HEAD] [to: HEAD | WORKTREE]  e.g. v1.0-handover HEAD'
description: Show what changed in the database design between two versions of an open-erd workspace (a tag such as v1.0-handover, any commit, HEAD, or the uncommitted working copy), writing out/diff.svg and a Changes sheet and summarising the changes in plain words. Use when the user asks what changed in the DB or ERD since a release, a handover or a given commit; /open-erd:sync already draws the diff of its own changes.
---

# diff

Read first (if `${CLAUDE_PLUGIN_ROOT}` is empty, the plugin root is two
levels above this skill's base directory): `${CLAUDE_PLUGIN_ROOT}/skills/_shared/rules.md`.

1. Find the workspace (rules.md). List the versions to compare (tags, then the
   latest commits, each a `sync`, `review` or `init`):

```bash
git -C <ws> tag --list --sort=-creatordate --format='%(refname:short)  %(creatordate:short)  %(subject)'
git -C <ws> log --format='%h  %ad  %s' --date=short -8
```

2. Pick `--from` and `--to` from what the user said: a tag, a commit, or a
   date ("since 1 October" → `git -C <ws> rev-list -1 --before=<date> HEAD`).
   `--to` defaults to `HEAD`; `WORKTREE` when the user asks about uncommitted
   edits. Nothing said → ask, with the newest tag (or the commit before the
   last sync) recommended and a few of the listed versions as the other
   options, each named by its date and subject.
3. Run:

```bash
node <plugin root>/dist/open-erd.mjs diff --workspace <ws> --from <ref> --to <ref|HEAD|WORKTREE> [--profile <name>]
```

   `--profile <name>` when the result will be shared outside the team (same
   profiles as render). `--from` is always a git ref. A warning about
   uncommitted changes with `--to HEAD` means the user's latest edits are
   not included: offer `--to WORKTREE`.
   The engine prints the summary line, then one sentence per change, and
   writes `out/diff.svg` (opens on all tables; click a coloured table for its
   changes) and `out/diff.xlsx` (the "to" side's sheets plus a Changes sheet,
   opened first).

4. Summarise in the user's language, for a reader who does not read code:
   one sentence with the totals (the engine's summary line), then grouped by domain: tables added,
   removed, renamed ("possibly renamed" when the engine only guesses),
   columns and relations changed, enum values changed. Keep names as they
   are. Give the output paths the engine printed.
5. End with the feedback line.
