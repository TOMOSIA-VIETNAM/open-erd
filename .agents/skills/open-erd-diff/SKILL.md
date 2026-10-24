---
name: open-erd-diff
description: Show what changed in the database design between two snapshots of an open-erd workspace (a tag such as v1.0-handover, any commit, HEAD, or the uncommitted working copy), writing out/diff.svg and a Changes sheet and summarising the changes in plain words. Use when the user asks what changed in the DB or ERD since a release, a handover or a given commit; $open-erd-sync already draws the diff of its own changes.
---

1. Read `../../../adapters/root.md` (relative to this file) → `ROOT` + this platform's tool names.
2. Read `ROOT/skills/diff/SKILL.md` → follow it verbatim, every step, in order. Text handed to this
   skill is the text that file expects after `/open-erd:diff`.

FORBIDDEN: summarizing, reordering or skipping a step; acting on what this file says; treating a
tool you lack as a step you may drop.
