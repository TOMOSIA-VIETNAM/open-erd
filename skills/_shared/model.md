# open-erd: workspace and model format

The engine validator rejects unknown keys. Write only the fields below.
Authoritative definition: `<plugin root>/engine/src/model/schema.js`; read it
when this page and the engine disagree.

## Workspace layout

```
<ws>/
  .gitignore            # contains: open-erd.local.yaml
  open-erd.yaml         # shared config (committed)
  open-erd.local.yaml   # this machine's source paths (gitignored)
  model/<db>.yaml       # one file per logical database
  model/cross-db.yaml   # relations whose two ends are in different databases
  layout.json           # written by `layout` only; edit by hand only to move a node the user asked to move
  extract/<source>.mjs  # extract script per source repo
  extract/facts/<source>.json         # script output, committed so sync can diff it
  extract/db-<db>.metadata.json       # cached database metadata, if the user allowed a read
  tests/locked.yaml     # reviewed facts `validate` protects; written by `lock`, never by hand except to drop a confirmed change
  out/                  # engine output (erd.svg, erd.xlsx, diff.svg)
```

## `open-erd.yaml`

```yaml
schema_version: 1
sources:                     # logical names, used in evidence; no paths here
  - name: billing-api
hub:                         # drawn as badges instead of lines
  tables: [billing.public.users]
  columns: [created_by, tenant_id]
collapse_join_tables: false  # true draws a pure join table as one n-n line
hidden:                      # left out of every profile render
  tables: [billing.public.audit_logs]
  columns: [billing.public.users.password_digest]   # embedded: <table id>.<entity>.<column> or <table id>.<entity>
profiles:                    # render --profile <name> writes out/erd.<name>.svg
  partner:                   # name: letters, digits, - and _
    drop_evidence: false     # default true
    drop_pii: true           # default true: drops pii columns and relations using them
    drop_notes: [internal_note, note_source]   # default; may also list note
    hide: { tables: [billing.public.refunds], columns: [] }   # added to `hidden`
```

Only `schema_version` is required. Profile `public` exists without being
declared (all defaults). A profile render filters the model first, then draws
it at the positions of the full layout: hidden tables leave gaps, nothing
moves. Run `layout` before a profile render as for a normal one. Hub candidates: tables referenced by most
relations (users, accounts, tenants) and audit columns. Propose them, do not
decide alone.

## `open-erd.local.yaml` (never committed, never credentials)

```yaml
sources:
  - name: billing-api
    path: /absolute/path/to/billing-api
```

## `model/<db>.yaml`

```yaml
schema_version: 1
database: billing            # no dots, no spaces
engine: postgresql           # postgresql | mysql | sqlite | mongodb | sqlserver | oracle | ...
topology: { replicas: 2, shards: 4, note: ... }   # optional; one logical database
tenant_schemas:              # optional; schema-per-tenant, modelled once
  - { schema: tenant, count: 120, note: One schema tenant_<slug> per tenants row. }   # count only when known
tables:
  - id: billing.public.invoices        # <db>.<schema>.<table>; `_` as schema for MySQL, SQLite, MongoDB
    domain: Billing                    # required
    note: One invoice per customer per billing cycle.
    note_source: 請求サイクルごとの請求書      # only when `note` was translated
    internal_note: Totals recomputed by InvoiceJob.   # team-only; profiles drop it
    renamed_from: billing.public.bills  # only after the user confirmed a rename
    # optional pattern fields, see "Special patterns"
    # kind, sources, sti, partition, unique, generated_by, embedded
    columns:                           # at least one
      - { name: id, type: bigint, pk: true }
      - { name: user_id, type: bigint, nullable: false }
      - { name: email, type: varchar, nullable: false, unique: true, pii: true }
      - name: status
        type: varchar
        nullable: false
        note: Lifecycle state.
        enum:                          # stored value -> meaning
          draft: Created, not yet sent to the customer (Invoice::STATUSES)
          paid: Payment confirmed by the gateway (Invoice::STATUSES)
relations:
  - from: { table: billing.public.invoices, columns: [user_id] }
    to:   { table: billing.public.users, columns: [id] }
    cardinality: n-1          # 1-1 | 1-n | n-1 | n-n
    optional: false           # = nullable of the from columns
    kind: declared            # db_fk | declared | inferred | cross_db
    evidence: ["billing-api:app/models/invoice.rb#Invoice"]
    review: pending           # pending | reviewed | stale
polymorphic:
  - name: commentable
    table: billing.public.comments
    type_column: commentable_type
    id_column: commentable_id
    optional: false
    targets: [billing.public.invoices, billing.public.payments]
    evidence: ["billing-api:app/models/comment.rb#Comment"]
    review: pending
```

`model/cross-db.yaml` has only `schema_version` and `relations` (each with
`kind: cross_db`).

Every table and column named by a relation, polymorphic entry, `hub` or
`hidden` must exist in the model; `validate` rejects dangling names.
Identifier segments never contain `.`; keep names exactly as in the database
(including case). Column fields: `name`, `type` required; `nullable`, `pk`,
`unique`, `enum`, `note`, `note_source`, `internal_note`, `pii`,
`renamed_from` optional.

## Special patterns

```yaml
  - id: billing.public.parties              # STI: one table, subclasses listed
    sti: { column: type, subclasses: [Person, Company] }    # keep the enum on `type` for meanings
  - id: billing.public.monthly_revenue       # view / materialized view
    kind: materialized_view                  # table (default) | view | materialized_view
    sources: [billing.public.invoices]       # tables it reads; drawn as muted dashed lines
  - id: billing.tenant.usage_events          # partitions merged into one table
    partition: { method: range, columns: [occurred_at], interval: month }   # range | list | hash
  - id: billing.public.price_rules          # unique key over several columns
    unique: [[plan_id, region_code]]
  - id: billing.public._InvoiceToLabel       # created by a framework, declared in no file
    generated_by: Prisma implicit many-to-many
  - id: media._.playlists                    # NoSQL embedded documents
    embedded:
      - name: tracks                         # no dots; must not equal a column name
        array: true                          # list of subdocuments
        columns: [{ name: song, type: ObjectId }]
```

- A ref inside an embedded document is a relation from the embedded path:
  `from: { table: media._.playlists, columns: [tracks.song] }`. Do not keep a
  parent column (`tracks: array<object>`) next to the entity.
- Schema-per-tenant: put tenant tables under one schema (`tenant`) and declare
  it in `tenant_schemas`; each of its tables shows "× N tenants" (or "one
  copy per tenant" without `count`).
- Replica/shard: one model file per logical database, `topology` on it.

## Writing facts

- **Direction**: a relation goes from the referencing table (the one holding
  the column) to the referenced one: `n-1`, or `1-1` when the referencing
  column is unique. A join table is two `n-1` relations, never one `n-n`. One
  `n-n` only for an array of ids stored on one side (MongoDB).
- **Composite keys**: list every column, in order, on both ends.
- **kind**
  - `db_fk`: DDL creates a constraint (migration `foreign()`/`constrained()`,
    `add_foreign_key`, Django `ForeignKey` with default `db_constraint=True`,
    Prisma `@relation` without `relationMode = "prisma"`, TypeORM relation
    decorators, Sequelize `references`, SQL `REFERENCES`), or database
    metadata shows one.
  - `declared`: an ORM association names it but no constraint exists (Rails
    `belongs_to` with no `add_foreign_key`, Django `db_constraint=False`,
    Prisma `relationMode = "prisma"`, every Mongoose `ref`, Sequelize
    `belongsTo` without `references`).
  - `inferred`: only naming or usage in code shows the link. Say in a column
    note what the code does with it.
  - `cross_db`: ends in different databases. Goes in `model/cross-db.yaml`.
- **evidence**: `<source name>:<path relative to that source>#<symbol>`, where
  the symbol is one identifier (class, method, function, field or table
  name) found verbatim in that file: `#Invoice` or `#payer`, never a
  qualified `#Invoice.payer` / `#Invoice::payer`. A
  line number may follow the path (`path:42`), but is ignored when comparing.
  `db` when the fact came from database metadata. Every relation and
  polymorphic entry has at least one.
- **review**: every fact you add is `pending`. Only the user makes a fact
  `reviewed`. `stale` marks a reviewed fact the code no longer supports.
- **polymorphic type column**: give it an `enum` only when code declares
  its value set (a morph map, an `enum` on the path); keys are the stored
  values (often aliases) of this entry's targets only, meanings name the
  target. Values that only follow
  from the targets (plain class names) get no `enum`.
- **enum**: keys are the stored values (`"0"`, `"1"` for integer-backed
  enums, the mapped value when an ORM maps names). The meaning is a short
  English phrase plus the code symbol it came from.
- **note**: English, one or two sentences on what a row means for the
  business, for tables a newcomer would not guess. Translate non-English
  comments and keep the original in `note_source`.
- **pii**: names, emails, phones, addresses, birth dates, government ids,
  free-text written by end users, IPs.
- **Special patterns** (STI, view, partition, tenant schemas, embedded
  documents, multi-column unique, framework tables, replica/shard): use the
  fields in "Special patterns" above, not prose in `note`.
- **internal_note** vs **note**: `note` is what a customer may read;
  anything only the team should see (code pointers, doubts) goes in
  `internal_note`.
- **Precision**: a column ending in `_id` that holds an external provider id
  (`stripe_customer_id`, `paypal_payer_id`) is not a relation. Framework
  tables (`schema_migrations`, `django_content_type`, `ar_internal_metadata`,
  `_prisma_migrations`) are left out unless the user wants them.

## Extract facts file (`extract/facts/<source>.json`)

Deterministic output of one extract script: sorted arrays, sorted keys, no
timestamps, no absolute paths. Shape:

```json
{
  "source": "billing-api",
  "stack": ["rails"],
  "tables": [
    { "name": "invoices", "schema": null, "database": "billing", "evidence": "db/schema.rb#invoices",
      "columns": [ { "name": "id", "type": "bigint", "pk": true, "nullable": false, "unique": false } ] }
  ],
  "associations": [
    { "from": { "table": "invoices", "columns": ["payer_id"] }, "to": { "table": "parties", "columns": ["id"] },
      "macro": "belongs_to", "constraint": false, "evidence": "app/models/invoice.rb#Invoice" }
  ],
  "polymorphic": [
    { "table": "attachments", "name": "attachable", "type_column": "attachable_type", "id_column": "attachable_id",
      "targets": ["invoices", "payments"], "evidence": ["app/models/attachment.rb#Attachment"] }
  ],
  "enums": [
    { "table": "invoices", "column": "status", "values": { "0": "draft" }, "evidence": "app/models/invoice.rb#Invoice" }
  ],
  "hints": [
    { "table": "payments", "column": "batch_id", "text": "set in SettlementJob#perform", "evidence": "app/jobs/settlement_job.rb#perform" }
  ]
}
```

Evidence in facts omits the `<source>:` prefix; add it when copying into the
model. The script records what files say; meaning, domain, notes, `pii`,
direction and `kind` are decided when writing the model.
