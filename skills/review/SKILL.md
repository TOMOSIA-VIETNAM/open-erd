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
how many there are of each, and that they can stop at any time ("stop"); what
is answered so far is kept.

The user may narrow it ("only Billing", "only inferred"): filter the queue.

## 2. One item at a time

Show, in the user's language:

- the fact in words: `orders.customer_id → accounts.id (many orders to one
  account, optional: no, kind: declared)`; for polymorphic, the type and id
  columns and the target list;
- why it is `stale` if so (compare with the current facts file or code);
- for each evidence entry, the source file and a short snippet (≤ 10 lines)
  around the symbol, read from the source path in `open-erd.local.yaml`.
  Evidence `db`: show the matching entry of `extract/db-<db>.metadata.json`.

Then wait for the answer in natural language and map it:

| Answer | Change |
|---|---|
| correct / yes | `review: reviewed` |
| a correction (other target, cardinality, optional, kind, columns, targets) | apply it, `review: reviewed`, keep evidence and add what the user cited |
| wrong / delete | confirm once ("delete this relation?"), then remove it |
| skip / not sure | leave it, next |

A `stale` item the user says is still right becomes `reviewed` again with the
current evidence. Deleting a `stale` item always needs that explicit
confirmation.

Save the YAML after each answer, so stopping keeps the progress. When a
confirmed correction or deletion touches a fact listed in
`tests/locked.yaml`, remove that entry too (`lock` below re-adds it with the
corrected values).

## 3. Finish

```bash
node <plugin root>/dist/open-erd.mjs validate --workspace <ws>
node <plugin root>/dist/open-erd.mjs lock     --workspace <ws>
node <plugin root>/dist/open-erd.mjs layout   --workspace <ws>
node <plugin root>/dist/open-erd.mjs render   --workspace <ws>
```

Commit (rules.md): `review: <n> reviewed, <n> corrected, <n> deleted`.

Report the counts, how many items are left, and the output paths. End with
the feedback line.
