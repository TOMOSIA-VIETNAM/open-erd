---
name: open-erd-sync
description: Bring an existing open-erd workspace up to date with the source code. Re-runs the extract scripts, applies what changed to model/*.yaml, asks before recording renames, marks reviewed facts that no longer match the code as stale instead of changing them, re-renders the ERD and commits with each source repo's revision. Use when the code changed since the last ERD, or the user asks to update or refresh the ERD.
---

1. Read `../../../adapters/root.md` (relative to this file) → `ROOT` + this platform's tool names.
2. Read `ROOT/skills/sync/SKILL.md` → follow it verbatim, every step, in order. Text handed to this
   skill is the text that file expects after `/open-erd:sync`.

FORBIDDEN: summarizing, reordering or skipping a step; acting on what this file says; treating a
tool you lack as a step you may drop.
