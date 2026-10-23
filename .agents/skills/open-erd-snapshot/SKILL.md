---
name: open-erd-snapshot
description: Mark the current state of an open-erd workspace as a named snapshot (a git tag in the workspace, e.g. v1.0-handover) so later diffs can compare against it. Use when the user hands over, releases, or wants to remember the ERD as it is now.
---

1. Read `../../../adapters/root.md` (relative to this file) → `ROOT` + this platform's tool names.
2. Read `ROOT/skills/snapshot/SKILL.md` → follow it verbatim, every step, in order. Text handed to this
   skill is the text that file expects after `/open-erd:snapshot`.

FORBIDDEN: summarizing, reordering or skipping a step; acting on what this file says; treating a
tool you lack as a step you may drop.
