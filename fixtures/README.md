# Extraction fixtures

Small fake applications used to measure how well the AI turns source code into
an open-erd model. Each case has:

- `source/` — the application files an extractor reads (schema/migrations,
  models, a few services). Not runnable, no secrets.
- `expected/` — the hand-written model in workspace form. It must pass
  `node dist/open-erd.mjs validate --workspace fixtures/<case>/expected`.
- `README.md` — the traps the case contains.

| Case | Stack | Traps (short) |
|---|---|---|
| `rails` | Rails, `schema.rb` | no FKs in schema, polymorphic, STI, enum in model, custom `foreign_key`/`class_name`, HABTM |
| `laravel` | Laravel migrations + Eloquent | `morphTo`/`morphMany`, PHP enum casts, partial `constrained()` |
| `django` | Django `models.py` | FK/OneToOne/ManyToMany `through`, `GenericForeignKey`, `TextChoices`, `db_constraint=False` |
| `prisma` | `schema.prisma` | `@@map`/`@map`, named `@relation` pairs, composite key referenced by a 2-column FK, implicit `_CourseToTag`, enum, self-relation |
| `mongoose` | Node + Mongoose | `ObjectId` refs, array of refs, `refPath`, embedded subdocuments, pluralized collection names |
| `multi-db` | TypeORM (postgres) + Sequelize (mysql) | cross-service id via HTTP client, schema-per-tenant, partitioned table |

## Conventions used by every `expected/`

- `kind`
  - `db_fk`: the source DDL creates a foreign key constraint (migration
    `foreign()`/`constrained()`, Django `ForeignKey` with the default
    `db_constraint=True`, Prisma `@relation` without `relationMode = "prisma"`,
    TypeORM `@ManyToOne` / Sequelize `references`).
  - `declared`: an ORM association names the relation but no constraint exists
    (Rails `belongs_to` on an FK-less `schema.rb`, Django `db_constraint=False`,
    Prisma under `relationMode = "prisma"`).
  - `inferred`: only naming or usage in code shows the link (an `*_id` column
    with no association anywhere).
  - `cross_db`: the two ends live in different databases; such relations go in
    `model/cross-db.yaml`.
- `evidence` is never `db` (fixtures have no database). It is
  `<repo>:<path>#<symbol>` where `<repo>` is a `sources[].name` from the case's
  `open-erd.yaml`. Single-repo cases: `<path>` is relative to `source/`.
  `multi-db`: each repo is a folder `source/<repo>/` and `<path>` is relative
  to it. `<symbol>` is a class, function, method or table name that appears in
  that file.
- `review` is `pending` everywhere: an expected model describes what extraction
  should produce before any human review.
- Relations point from the referencing table (`n-1`, or `1-1` when the
  referencing column is unique). A join table is two `n-1` relations, never one
  `n-n` line; `collapse_join_tables: true` draws it as one line. An array of
  ids stored on one side (MongoDB) has no join table and is one `n-n` relation.
- `optional` mirrors the referencing column's `nullable`.
- Enum keys are the values stored in the column (`0`, `1` for integer-backed
  enums), and the meaning names the code symbol.
- Patterns the model schema has no field for (STI, partition,
  schema-per-tenant, view, embedded document) are written as a table `note`
  plus, for STI, an `enum` on the type column. No unknown keys: the validator
  rejects them.
