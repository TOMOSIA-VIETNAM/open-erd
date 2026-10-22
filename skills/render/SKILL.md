---
name: render
description: Regenerate the ERD outputs (out/erd.svg, out/erd.xlsx, out/erd.drawio) of an open-erd workspace from its model, without re-reading source code. Optional sharing profile such as public, which drops evidence, PII columns and hidden tables. Use when the user wants to re-export, rebuild or share the ERD files, or after editing the model or layout by hand.
---

# render

Read first (if `${CLAUDE_PLUGIN_ROOT}` is empty, the plugin root is two
levels above this skill's base directory): `${CLAUDE_PLUGIN_ROOT}/skills/_shared/rules.md`.

1. Find the workspace (rules.md).
2. Profile: none by default. When the user wants to share outside the team,
   suggest `--profile public`.
3. Run:

```bash
node <plugin root>/dist/open-erd.mjs validate --workspace <ws>
node <plugin root>/dist/open-erd.mjs render   --workspace <ws> [--profile <name>]
```

If render reports nodes without positions or stale sizes, run `layout` and
render again; tell the user which nodes `layout` moved.

4. Report the absolute paths of every file the engine says it wrote, and the
   profile used. Do not commit: rendering changes nothing in the model; the
   next `sync` or `review` commits the outputs.
5. End with the feedback line.
