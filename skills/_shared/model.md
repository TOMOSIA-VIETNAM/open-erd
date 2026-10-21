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
hidden:                      # left out of shared profiles
  tables: [billing.public.audit_logs]
  columns: [billing.public.users.password_digest]
```

Only `schema_version` is required. Hub candidates: tables referenced by most
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
tables:
  - id: billing.public.invoices        # <db>.<schema>.<table>; `_` as schema for MySQL, SQLite, MongoDB
    domain: Billing                    # required
    note: One invoice per customer per billing cycle.
    note_source: 請求サイクルごとの請求書      # only when `note` was translated
    renamed_from: billing.public.bills  # only after the user confirmed a rename
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
`unique`, `enum`, `note`, `note_source`, `pii`, `renamed_from` optional.

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
  the symbol (class, method, function, table name) appears in that file. A
  line number may follow the path (`path:42`), but is ignored when comparing.
  `db` when the fact came from database metadata. Every relation and
  polymorphic entry has at least one.
- **review**: every fact you add is `pending`. Only the user makes a fact
  `reviewed`. `stale` marks a reviewed fact the code no longer supports.
- **enum**: keys are the stored values (`"0"`, `"1"` for integer-backed
  enums, the mapped value when an ORM maps names). The meaning is a short
  English phrase plus the code symbol it came from.
- **note**: English, one or two sentences on what a row means for the
  business, for tables a newcomer would not guess. Translate non-English
  comments and keep the original in `note_source`.
- **pii**: names, emails, phones, addresses, birth dates, government ids,
  free-text written by end users, IPs.
- **No field for it** (STI, partition, schema-per-tenant, view, materialized
  view, embedded document, replica/shard): write it in the table `note`. STI:
  one table plus `enum` on the type column listing subclasses. Partitions: one
  table, note the partition key. Tenant schemas: one schema `tenant`, note
  `× N tenants` and how the schema is chosen. Embedded documents: one parent
  column of type `object`/`array` with a note. Replica/shard: one database.
- **Precision**: a column ending in `_id` that holds an external provider id
  (`stripe_customer_id`, `gateway_customer_id`) is not a relation. Framework
  tables (`schema_migrations`, `django_content_type`, `ar_internal_metadata`,
  `_prisma_migrations`) are left out unless the user wants them.

## Extract facts file (`extract/facts/<source>.json`)

Deterministic output of one extract script: sorted arrays, sorted keys, no
timestamps, no absolute paths. Shape:

```json
{
  "source": "shop-api",
  "stack": ["rails"],
  "tables": [
    { "name": "orders", "schema": null, "database": "shop", "evidence": "db/schema.rb#orders",
      "columns": [ { "name": "id", "type": "bigint", "pk": true, "nullable": false, "unique": false } ] }
  ],
  "associations": [
    { "from": { "table": "orders", "columns": ["customer_id"] }, "to": { "table": "accounts", "columns": ["id"] },
      "macro": "belongs_to", "constraint": false, "evidence": "app/models/order.rb#Order" }
  ],
  "polymorphic": [
    { "table": "comments", "name": "commentable", "type_column": "commentable_type", "id_column": "commentable_id",
      "targets": ["products", "orders"], "evidence": ["app/models/comment.rb#Comment"] }
  ],
  "enums": [
    { "table": "orders", "column": "status", "values": { "0": "pending" }, "evidence": "app/models/order.rb#Order" }
  ],
  "hints": [
    { "table": "shipments", "column": "warehouse_id", "text": "assigned in FulfillmentService#pick_warehouse", "evidence": "app/services/fulfillment_service.rb#pick_warehouse" }
  ]
}
```

Evidence in facts omits the `<source>:` prefix; add it when copying into the
model. The script records what files say; meaning, domain, notes, `pii`,
direction and `kind` are decided when writing the model.
