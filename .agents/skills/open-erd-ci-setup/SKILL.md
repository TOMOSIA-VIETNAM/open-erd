---
name: open-erd-ci-setup
description: Set up a GitHub Actions workflow in a source repository so every pull request that touches the schema files gets one comment showing how the ERD would change (summary, table of changes, what still needs $open-erd-sync, link to diff.svg), computed without AI from the open-erd extract script. Comment only; nothing is pushed to the ERD workspace. Use when the user wants the ERD checked, previewed or kept from going stale in CI or on pull requests.
---

1. Read `../../../adapters/root.md` (relative to this file) → `ROOT` + this platform's tool names.
2. Read `ROOT/skills/ci-setup/SKILL.md` → follow it verbatim, every step, in order. Text handed to this
   skill is the text that file expects after `/open-erd:ci-setup`.

FORBIDDEN: summarizing, reordering or skipping a step; acting on what this file says; treating a
tool you lack as a step you may drop.
