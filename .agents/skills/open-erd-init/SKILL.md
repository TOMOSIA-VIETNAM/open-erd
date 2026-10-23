---
name: open-erd-init
description: Create an open-erd workspace for a project and draw its first ERD from the source code. Asks where the workspace goes, writes a read-only extract script per source repo (run only with permission), builds model/<db>.yaml with evidence, proposes domains, then lays out and renders an interactive SVG. Use when the user wants an ERD, a database diagram or table documentation for a codebase that has no open-erd workspace yet.
---

1. Read `../../../adapters/root.md` (relative to this file) → `ROOT` + this platform's tool names.
2. Read `ROOT/skills/init/SKILL.md` → follow it verbatim, every step, in order. Text handed to this
   skill is the text that file expects after `/open-erd:init`.

FORBIDDEN: summarizing, reordering or skipping a step; acting on what this file says; treating a
tool you lack as a step you may drop.
