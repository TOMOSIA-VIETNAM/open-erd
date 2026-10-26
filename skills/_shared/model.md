# open-erd: workspace and model format

The engine validator rejects unknown keys. Write only the fields below.
Authoritative definition: `<plugin root>/engine/src/model/schema.js`; read it
when this page and the engine disagree.

## Workspace layout

```
<ws>/
  .gitignore            # contains: open-erd.local.yaml, .DS_Store
  open-erd.yaml         # shared config (committed)
  open-erd.local.yaml   # this machine's source paths (gitignored)
  model/<db>.yaml       # one file per logical database
  model/cross-db.yaml   # relations whose two ends are in different databases
  layout.json           # written by `layout` only; edit by hand only to move a node the user asked to move
  extract/<source>.mjs  # extract script per source repo
  extract/facts/<source>.json         # script output, committed so sync can diff it
  extract/db-<db>.metadata.json       # cached database metadata, if the user allowed a read
  tests/locked.yaml     # reviewed facts `validate` protects; written by `lock`, never by hand except to drop a confirmed change
  tests/verification.yaml   # verdicts of the last verification (rules.md, "Verification"); `verify` keeps it sorted
  out/                  # engine output (erd.svg, erd.xlsx, diff.svg)
```

## `open-erd.yaml`

```yaml
schema_version: 1
sources:                     # logical names, used in evidence; no paths here
  - name: billing-api
hub:                         # cross-cutting references, drawn as badges instead of lines
  columns: [created_by, updated_by, tenant_id]
  tables: [billing.public.users]
collapse_join_tables: false  # true draws a pure join table as one n-n line
outputs: { drawio: true }    # default true: render also writes out/erd.drawio (Overview and All tables pages)
# outputs.drawio_svg_url: https://example.com/erd/erd.svg   # optional: where erd.svg is published; erd.drawio table headers then link to it
hidden:                      # left out of every profile render
  tables: [billing.public.audit_logs]
  columns: [billing.public.users.password_digest]   # embedded: <table id>.<entity>.<column> or <table id>.<entity>
ignore_missing:              # possibly missing relations `validate` stops reporting
  columns:
    - billing.public.payments.stripe_charge_id   # not a FK: Stripe charge id
  tables:
    - billing.public.settings                    # standalone key/value store
health:                      # schema health findings to stop reporting
  ignore:
    - unindexed_fk:billing.public.audit_logs          # <rule>:<table id>, whole table
    - missing_fk:billing.public.payments.order_id     # <rule>:<table id>.<column>, that column only
default_view: all            # all (default) | overview | heatmap | domain:<db>/<domain>; the view the SVG opens on
verify: ai-only              # ai-only (default) | full | off; checking before each commit, see rules.md "Verification"
not_in_model:                # tables the extract facts list that the model leaves out on purpose; `verify` skips them
  - billing.public.schema_migrations   # framework table
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
moves. Run `layout` before a profile render as for a normal one.

`validate` warns (exit code stays 0) about possibly missing relations: a
column of a table named like a reference (`*_id`, `*Id`, `*_ids`) that no
relation, hub or polymorphic entry uses (with a `*_type` column beside it:
"looks like a polymorphic association"), and a table that no relation,
polymorphic entry or view source touches. The same warnings show in the
SVG (amber triangle on the column) and in the To review sheet. When a
warned column is not a reference (external provider id, a value from a
static file) or a table stands alone on purpose, add it to
`ignore_missing` with the reason as a YAML comment on the same line.
`ignore_missing.columns` silences column warnings only,
`ignore_missing.tables` only the "nothing connects this table" warning.

`validate` also counts schema health findings (rules `missing_fk`,
`unindexed_fk`, `polymorphic_unindexed`, `orphan_table`,
`redundant_index`; listed in erd.svg and the Health sheet). They never
fail validation and are not model errors: do not change the model to make
one go away. Add an entry to `health.ignore` only when the user says a
finding is intended, with their reason as a comment.

`not_in_model` takes table ids as the table would have in the model
(`<db>.<schema>.<table>`, `_` as schema where the engine has none); an id
that is also in the model is an error. Add one only after the user agreed
the table stays out, with the reason as a YAML comment.

Left out, `default_view` is `all`; a schema over 300 tables has no view of
all tables and opens on the overview. A configured `default_view` the render
has no such view for (the view of all tables above 300 tables; a domain a
profile hides) falls back to the overview, with a warning from `render`.

A hub is only for references that cut across every domain: audit columns
(`created_by`, `updated_by`), tenant or company scoping (`tenant_id`,
`company_id`), and the tables such columns point at (`users`, `tenants`).
Never make a core business table a hub (one a domain is built around, such
as `orders` or `campaigns`), however many tables reference it: its lines are
the structure of its domain, and as a hub it turns into badges everywhere.
Prefer `hub.columns` over `hub.tables`: a column hub hides only those
cross-cutting references, a table hub hides every reference to the table.
Propose a hub only when it removes real clutter: references from many tables
in several domains. A handful of references is clearer as lines. The engine
keeps as lines, whatever the hub says, a hub reference inside the hub table's
own domain and the references of a table that has no other relation.
Propose each hub with the reason it is cross-cutting; do not decide alone.
The ERD still lists every hub relation in the hub table's panel and draws
them while that table is selected.

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
domains:                     # optional; one entry per domain of this file's tables
  Billing:
    note: Invoices sent to customers each cycle, their payments and refunds.   # shown on the overview card
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
    # kind, sources, sti, partition, generated_by, embedded
    indexes:                           # as the schema source declares them
      - { name: index_invoices_on_user_id_and_status, columns: [user_id, status] }
      - { name: index_invoices_on_number, columns: [number], unique: true }
      - { columns: [due_on], where: "status = 'open'", using: btree }
    columns:                           # at least one
      - { name: id, type: bigint, pk: true, auto_increment: true, note: Surrogate key. }
      - { name: user_id, type: bigint, nullable: false, note: Customer billed by this invoice. }
      - { name: email, type: varchar, nullable: false, unique: true, pii: true, note: Address the invoice is sent to. }
      - { name: total, type: numeric, generated: "subtotal + tax", note: "Amount due, computed by the database." }
      - name: status
        type: varchar
        nullable: false
        default: draft
        note: Lifecycle state.
        enum:                          # stored value -> meaning
          draft: Created, not yet sent to the customer (Invoice::STATUSES)
          paid: Payment confirmed by the gateway (Invoice::STATUSES)
          void: ""                     # code shows no meaning beyond the value
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
    note: Staff discuss an invoice or a payment with the customer; one thread per record.
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
`renamed_from`, `default`, `auto_increment`, `generated` optional. A
polymorphic entry may also carry `note` and `internal_note`.

- `default`: the default value as the schema source writes it, as a string.
  A literal when the code gives one (`draft`, `"0"`, `"false"`), else the
  expression as written (`now()`, `gen_random_uuid()`, `nextval('users_id_seq')`,
  `Date.now`, `cuid()`; a lambda or function default whole, never cut).
  Always a YAML string: quote numbers, booleans and
  `null` (`default: "0"`). An ORM constant resolves to its stored value
  (`Status.DRAFT` -> `draft`). Only when a file shows it; never guess.
- `auto_increment: true`: the database numbers new rows itself: `SERIAL`,
  `IDENTITY`, `AUTO_INCREMENT`, Prisma `@default(autoincrement())`,
  Sequelize `autoIncrement: true`, TypeORM `@PrimaryGeneratedColumn()`
  (`'increment'`; the `'uuid'` strategy is a `default` instead), and the
  implicit integer id of Rails `create_table`, Laravel `$table->id()` /
  `increments()`, Django `AutoField`/`BigAutoField`. Do not also set
  `default` for a plain auto-increment (`nextval(...)` of a `serial` is
  implied).
- `generated`: the expression of a generated / computed column (`GENERATED
  ALWAYS AS (...)`, Rails `t.virtual ... as:`, Prisma `@default(dbgenerated(...))`
  on a computed column, Laravel `storedAs`/`virtualAs`).

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
    indexes: [{ columns: [plan_id, region_code], unique: true }]
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
- **indexes**: one entry per index statement the schema source declares
  (`add_index` / `t.index`, `$table->index()` / `$table->unique([...])`,
  Django `Meta.indexes` / `unique_together` / `UniqueConstraint` /
  `db_index=True`, Prisma `@@index` / `@@unique`, TypeORM `@Index`, Sequelize
  `indexes` / `addIndex`, Mongoose `index: true` / `schema.index()`, SQL
  `CREATE [UNIQUE] INDEX`), or that database metadata shows. Fields: `columns`
  (required, in index order; embedded fields as `<entity>.<column>`), `name`
  (as declared; leave it out when the source names none), `unique: true`,
  `where` (the predicate of a partial index, as written), `using` (the
  access method: `btree`, `gin`, `hash`, ...). A single-column unique
  constraint written on the column itself (`->unique()`, `@unique`,
  `unique: true`) stays `unique: true` on that column, not an index.
  Primary keys are not listed. A unique index over several columns is drawn
  as a "unique (...)" line on the table's box.
- `unique: [[a, b]]` on a table is the older form of a unique index; the
  engine still reads it (as `indexes: [{ columns: [a, b], unique: true }]`),
  but write `indexes`.

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
  enums, the mapped value when an ORM maps names). Write a meaning only when
  the code reveals what the value means for the business (a branch, a label,
  a comment: `paid: Payment confirmed by the gateway (Invoice::STATUSES)`);
  otherwise leave it empty (`smartsite_standard_one: ""`). Never restate the
  value in words or with the class or attribute it came from
  (`Smartsite standard one (Template.code)`): the ERD hides such meanings.
- **note** on a table: English, one or two sentences on what a row means for
  the business. Learn it from how the code uses the table: the services,
  controllers, jobs and operations that create, change or read its rows,
  not from its name. `A promotion a company runs for a period; entries and
  rewards hang off it.` says something; `Stores campaigns.` only restates the
  name and is not a note. Translate non-English comments and keep the
  original in `note_source`.
- **note** on a column: every column gets one, so the Excel column grid
  never has an empty Comment. English, at most about 15 words, saying what the
  value means or is used for (`Customer billed by this invoice.`, `Set when
  the gateway confirms payment.`, `Surrogate key.`), learned from the code
  that sets or reads it; never just the column name in words. Write only what code,
  schema comments or names show; when nothing does, write `Unclear from
  code.` rather than guess. Enum value meanings stay in `enum`, not in the
  note.
- **note** on a domain (`domains:` in its database's model file): one
  English sentence, about 90 characters at most (the overview card shows two
  lines), saying what the domain covers for the business, learned from how
  the code uses its tables (`Invoices sent to customers each cycle, their
  payments and refunds.`), not a list of table names. A key must be the
  `domain` of a table in that file. Write one for every domain.
- **note** on a polymorphic entry: what the association means for the
  business, from the code that creates its rows: which records get one and
  what for (`Staff discuss an invoice or a payment with the customer.`).
  Write one for every polymorphic entry; the ERD shows it when the
  polymorphic node is selected.
- **pii**: mark every column that holds or may hold personal data, not
  only the obvious ones: names, emails, phone numbers, postal addresses,
  birth dates, IP addresses, device ids, government ids (tax, passport,
  national id numbers), auth, session and password reset tokens, free text
  that may contain personal data (comments, messages, notes written by
  users), geo location. The ERD's PII map, the PII sheet of the workbook
  and the `public` profile (which drops these columns) rely on it.
- **Special patterns** (STI, view, partition, tenant schemas, embedded
  documents, indexes, framework tables, replica/shard): use the
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
timestamps, no absolute paths. The engine's `verify` command reads the
fields below and compares them with the model; every other key (`stack`,
`polymorphic`, `enums`, `hints`, `sti`, `macros`, `via_classes`,
`on_delete`, ...) is free-form, for whoever writes the model.

```json
{
  "source": "billing-api",
  "database": "billing",
  "tables": [
    { "name": "invoices", "schema": null, "database": "billing", "evidence": "db/schema.rb#invoices",
      "columns": [ { "name": "id", "type": "bigint", "pk": true, "nullable": false, "unique": false, "auto_increment": true },
                   { "name": "status", "type": "string", "nullable": false, "unique": false, "default": "draft" } ],
      "indexes": [ { "name": "index_invoices_on_status", "columns": ["status"], "unique": false } ] }
  ],
  "associations": [
    { "from": { "database": "billing", "table": "invoices", "columns": ["payer_id"] },
      "to": { "database": "billing", "table": "parties", "columns": ["id"] },
      "constraint": false, "evidence": ["app/models/invoice.rb#Invoice"] }
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

Read by the engine:

- `source`: the source name; prefixed to evidence (`<source>:<path>`).
- `database` (file level, optional): the database of every table that does
  not name its own.
- `tables[]`: `name` and `columns` required. `database`: the logical
  database of the model (`model/<db>.yaml`); needed on the table or the
  file unless the workspace has one database. `schema`: the schema segment
  of the table id, or `null` when the source does not say (the table then
  matches the model table of that name in its database; when no model
  table has the name, the schema every table of that database shares).
  `evidence`: a string or a list of strings. `indexes[]`: `columns`
  (required), `name`, `unique`, `where`, `using`, as in the model; the older
  `unique: [[a, b]]` on a table is read as unique indexes.
- `columns[]`: `name` and `type` required; `nullable`, `pk`, `unique`,
  `auto_increment` (booleans, absent = false), `default` (as the schema
  source writes it; absent or `null` when the source sets none: a Ruby
  `nil`, PHP `null`, Python `None`, JavaScript `null` or `undefined` is no
  default). A field no column of the file has
  is not compared, so a script that does not extract it reports no
  difference for it; one that does must write it wherever it applies.
- `associations[]`: `from` and `to` with `table` and `columns` (and
  `database` when it differs from the table's), `constraint: true` when DDL
  creates a foreign key (the model's `kind: db_fk`), and `evidence`. An
  association without a constraint only tells `verify` that the relation
  still exists in code.

Evidence in facts omits the `<source>:` prefix; add it when copying into the
model. The script records what files say; meaning, domain, notes, `pii`,
direction and `kind` are decided when writing the model.
