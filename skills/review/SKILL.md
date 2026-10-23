---
name: review
description: Walk through the relations and polymorphic associations of an open-erd workspace that still need a human check (pending or stale), one at a time with the evidence from the code, and record what the user confirms, corrects or deletes. Use when the user wants to review, verify or approve the relations the AI found in the ERD.
---

# review

Read first (if `${CLAUDE_PLUGIN_ROOT}` is empty, the plugin root is two
levels above this skill's base directory): `${CLAUDE_PLUGIN_ROOT}/skills/_shared/rules.md` and
`${CLAUDE_PLUGIN_ROOT}/skills/_shared/model.md`.

## 1. Build the queue

From `model/*.yaml` collect every relation and polymorphic entry with
`review: pending` or `review: stale`. Order: `stale` first, then by `kind`
(`inferred`, `cross_db`, `declared`, `db_fk`), then by table id. Tell the user
how many there are of each, and, once, that they can stop at any time by
typing "stop" as their own answer to any question; what is answered so far is
kept.

The user may narrow it ("only Billing", "only inferred"): filter the queue.

## 2. One item at a time

Ask about each item with one `AskUserQuestion` call (rules.md, "Talking to
the user"), in the user's language. Before asking, gather:

- the evidence: for each evidence entry, the source file and the lines
  around the symbol (≤ 10 per file), read from the source path in
  `open-erd.local.yaml`; evidence `db`: the matching entry of
  `extract/db-<db>.metadata.json`;
- for a `stale` item, why: compare the fact with the current facts file or
  code (the column is gone, the target changed, ...);
- the verifier's verdict on this fact from `tests/verification.yaml`, if an
  earlier run left one (its `result` and `reason`).

The question (`header`: `Relation` or `Polymorphic`):

- `question`: the fact in plain words, by table and column names as the ERD
  shows them: from table → to table, how many on each side ("many orders
  belong to one account"), whether the link is optional, and how it was
  found ("declared in the code", "a foreign key in the database", "guessed
  from the column name and its use", "an id sent to another service"). A
  polymorphic entry: the type and id columns and the tables it can point
  to. A `stale` item adds, in one sentence, why it no longer matches the
  code.
- Options, the recommended one first with "(Recommended)" in its label and a
  one-line reason from the evidence (and the verifier's verdict when there
  is one) as its description:
  - **Correct**: "marked as checked; the diagram keeps it as it is".
  - **Correct with a change**: "type the change as your answer (another
    target table, how many, optional or not, columns, targets); it is
    applied and marked as checked".
  - **Delete**: "removed from the model and the diagram, after one more
    confirmation".
  - **Skip**: "left as it is, still to check; asked again next review".
  Recommend Correct when the evidence shows the link as stated, Correct with
  a change when it shows something different (say what in the reason),
  Delete when the code no longer has it, Skip when the evidence is not
  enough to tell.
- `preview` on the recommended option: the evidence snippets, each under a
  `<file>:<first line>` header, ≤ 10 lines per file.

Map the answer:

| Answer | Change |
|---|---|
| Correct | `review: reviewed` |
| A typed correction | apply it, `review: reviewed`, keep the evidence and add what the user cited |
| Correct with a change picked, nothing typed | ask what to change, with the corrections the evidence suggests as options; then as a typed correction |
| Delete | a second `AskUserQuestion`: "Delete this relation?" with Delete first (the user already chose it) and Keep; on Delete remove it |
| Skip | leave it, next item |
| "stop" typed | save, go to step 3 |

A typed answer that is not clear: ask again with the same options. A `stale`
item the user says is still right becomes `reviewed` again with the current
evidence.

Save the YAML after each answer, so stopping keeps the progress. When a
confirmed correction or deletion touches a fact listed in
`tests/locked.yaml`, remove that entry too (`lock` below re-adds it with the
corrected values).

## 3. Finish

Run `validate`, then the verification of what this review changed
(rules.md, "Verification"). A user-confirmed fact the verifier calls
`wrong`: show the user its reason and the code it cites, and change the
fact only if the user agrees. Then:

```bash
node <plugin root>/dist/open-erd.mjs validate --workspace <ws>
node <plugin root>/dist/open-erd.mjs lock     --workspace <ws>
node <plugin root>/dist/open-erd.mjs layout   --workspace <ws>
node <plugin root>/dist/open-erd.mjs render   --workspace <ws>
```

Commit (rules.md): `review: <n> reviewed, <n> corrected, <n> deleted`, with
the `verify: ...` line `verify` printed in the body.

Report the counts, how many items are left, and the output paths. End with
the feedback line.
