---
name: snapshot
description: Mark the current state of an open-erd workspace as a named snapshot (a git tag in the workspace, e.g. v1.0-handover) so later diffs can compare against it. Use when the user hands over, releases, or wants to remember the ERD as it is now.
---

# snapshot

Read first (if `${CLAUDE_PLUGIN_ROOT}` is empty, the plugin root is two
levels above this skill's base directory): `${CLAUDE_PLUGIN_ROOT}/skills/_shared/rules.md`.

1. Find the workspace (rules.md). Uncommitted changes
   (`git -C <ws> status --porcelain`) → ask whether to commit them first
   (validate, then commit as in rules.md) or tag the last commit as is.
2. Name: the user's, else suggest one from existing tags
   (`git -C <ws> tag --list`) and the occasion, e.g. `v1.0-handover`,
   `2026-10-release`. Tag names have no spaces. Existing name → ask for another;
   never move or delete a tag.
3. Create an annotated tag:

```bash
git -C <ws> tag -a <name> -m "<one line: occasion, in English>"
```

4. Report the tag and commit (`git -C <ws> rev-parse --short <name>`). Say it
   is local; push only if the user asks (`git -C <ws> push <remote> <name>`).
   Suggest `/open-erd:diff` against it later.
