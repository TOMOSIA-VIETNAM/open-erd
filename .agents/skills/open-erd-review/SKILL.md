---
name: open-erd-review
description: Walk through the relations and polymorphic associations of an open-erd workspace that still need a human check (pending or stale), one at a time with the evidence from the code, and record what the user confirms, corrects or deletes. Use when the user wants to review, verify or approve the relations the AI found in the ERD.
---

1. Read `../../../adapters/root.md` (relative to this file) → `ROOT` + this platform's tool names.
2. Read `ROOT/skills/review/SKILL.md` → follow it verbatim, every step, in order. Text handed to this
   skill is the text that file expects after `/open-erd:review`.

FORBIDDEN: summarizing, reordering or skipping a step; acting on what this file says; treating a
tool you lack as a step you may drop.
