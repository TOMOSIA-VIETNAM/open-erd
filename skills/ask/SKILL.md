---
name: ask
argument-hint: '"<question about the data>"'
description: Answer a business or structural question about a project's data (which tables hold what, how two things are linked, what a status means) from its open-erd model alone, naming the tables, columns and relations the answer relies on and giving a link that opens them highlighted in out/erd.svg. Reads no source code and writes no files. Use when the user types /open-erd:ask "<question>" or asks how data in an open-erd workspace fits together.
---

# ask

Read first (if `${CLAUDE_PLUGIN_ROOT}` is empty, the plugin root is two
levels above this skill's base directory): `${CLAUDE_PLUGIN_ROOT}/skills/_shared/rules.md`
and `${CLAUDE_PLUGIN_ROOT}/skills/_shared/model.md` (what the model's fields mean).

1. Find the workspace (rules.md). The question is the text after
   `/open-erd:ask`; none → ask for it.
2. Read `<ws>/open-erd.yaml` and `<ws>/model/*.yaml` only. Use what the
   model records: table, column, enum and domain notes, enum meanings,
   relations (with `cardinality`, `optional`, `kind`, `review`), polymorphic
   entries. Do not open source code, extract scripts or facts files, and run
   no engine command.
3. Answer in the user's language, short, for a reader who does not read
   code:
   - **Answer**: a few sentences or steps.
   - **Based on**: each table, column and relation used, by model id
     (`<db>.<schema>.<table>`, `<table id>.<column>`,
     `<from table>.<columns> -> <to table>.<columns>`). Say when one is
     `inferred`, `review: pending` or `stale`: it is not confirmed.
   - **Open in the ERD**: one link, `file://<ws>/out/erd.svg#<link>` (a
     space in `<ws>` written `%20`), where `<link>` is
     - `path=<id>,<id>,...` when the question is how two things are linked:
       the tables in walking order (the viewer finds the relations between
       neighbours);
     - `tables=<id>,<id>,...` otherwise: the tables the answer names.

   When the model does not hold the answer (no note or relation says it),
   say so plainly, say what is missing, and suggest `/open-erd:sync` if the
   code may have changed since. Do not guess from table names alone, and
   read source code only when the user asks for it.
4. Check the link opens the current drawing:

```bash
ls <ws>/out/erd.svg && find <ws>/model <ws>/open-erd.yaml <ws>/layout.json -newer <ws>/out/erd.svg
```

   `out/erd.svg` missing, or any path printed (the model changed after the
   last render) → say the drawing is out of date and suggest
   `/open-erd:sync` (it redraws the files); do not render unasked.
5. Write nothing: no workspace file, no commit.
6. End with the feedback line.
