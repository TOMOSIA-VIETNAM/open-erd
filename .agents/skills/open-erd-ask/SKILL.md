---
name: open-erd-ask
description: Answer a business or structural question about a project's data (which tables hold what, how two things are linked, what a status means) from its open-erd model alone, naming the tables, columns and relations the answer relies on and giving a link that opens them highlighted in out/erd.svg. Reads no source code and writes no files. Use when the user types $open-erd-ask "<question>" or asks how data in an open-erd workspace fits together.
---

1. Read `../../../adapters/root.md` (relative to this file) → `ROOT` + this platform's tool names.
2. Read `ROOT/skills/ask/SKILL.md` → follow it verbatim, every step, in order. Text handed to this
   skill is the text that file expects after `/open-erd:ask`.

FORBIDDEN: summarizing, reordering or skipping a step; acting on what this file says; treating a
tool you lack as a step you may drop.
