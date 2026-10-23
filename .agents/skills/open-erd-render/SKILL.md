---
name: open-erd-render
description: Regenerate the ERD outputs (out/erd.svg, out/erd.xlsx, out/erd.drawio) of an open-erd workspace from its model, without re-reading source code. Optional sharing profile such as public, which drops evidence, PII columns and hidden tables. Use when the user wants to re-export, rebuild or share the ERD files, or after editing the model or layout by hand.
---

1. Read `../../../adapters/root.md` (relative to this file) → `ROOT` + this platform's tool names.
2. Read `ROOT/skills/render/SKILL.md` → follow it verbatim, every step, in order. Text handed to this
   skill is the text that file expects after `/open-erd:render`.

FORBIDDEN: summarizing, reordering or skipping a step; acting on what this file says; treating a
tool you lack as a step you may drop.
