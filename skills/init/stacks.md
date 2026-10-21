# Writing an extract script per stack

One script per source repo: `<ws>/extract/<source>.mjs`. It reads static files
under the source path given as its only argument and prints the facts JSON
(format in `../_shared/model.md`) to stdout.

Script rules:

- Node 20+, ESM, imports only `node:fs` and `node:path`. No npm packages (the
  workspace has no `node_modules`), no network, no child processes, no file
  writes, no `eval`/`import()` of source files.
- Parse with small hand-written readers (regex plus bracket matching). It does
  not need to be a full parser; it must handle every file that is in this repo.
- Deterministic: sort tables by name, columns in file order, everything else by
  a stable key; `JSON.stringify(facts, null, 2)`.
- Paths in evidence are relative to the source root with `/` separators.
- Skip `node_modules`, `vendor`, `.git`, build output, test fixtures.
- Print to stderr a one-line count per kind of fact, and every file it could
  not parse, so gaps are visible.

## Detecting the stack

| Marker file | Stack |
|---|---|
| `Gemfile` + `db/schema.rb` or `db/structure.sql` | Rails |
| `composer.json` with `laravel/framework`, `database/migrations/` | Laravel |
| `manage.py`, `*/models.py`, `settings.py` | Django |
| `prisma/schema.prisma` (or any `*.prisma`) | Prisma |
| `package.json` with `typeorm`, `@Entity(` in `*.ts` | TypeORM |
| `package.json` with `sequelize`, `migrations/*.js` | Sequelize |
| `package.json` with `mongoose`, `new Schema(` / `mongoose.Schema(` | Mongoose |
| `*.sql` with `CREATE TABLE` (schema dumps, Flyway, Liquibase SQL) | raw SQL |

A repo can hold several (an app with Prisma plus raw SQL migrations). Show the
user what you detected per repo and which files each script will read, before
writing it.

## Per-stack guidance

**Rails** — tables and columns from `db/schema.rb` (`create_table "x"`, `t.<type>
"col", null: false`); `id: false` means no `id` column; `primary_key:` names
a non-`id` PK. `add_foreign_key` lines are constraints; with none, every
association is `declared`. Associations from `app/models/**/*.rb`:
`belongs_to`, `has_many`, `has_one`, `has_and_belongs_to_many`, with
`class_name:`, `foreign_key:`, `table_name =`. Table name of a class = snake
plural of the class unless `self.table_name`. STI: a `type` column plus
classes inheriting another model, not `ApplicationRecord`; a subclass's
associations land on the base table. `polymorphic: true` + `as: :name` give
polymorphic targets. `enum status: { a: 0 }` / `enum :status, {...}` are
integer- or string-backed: keys are the stored values. HABTM join table
(`products_tags`) has no model and often no `id`.

**Laravel** — tables from `database/migrations/*.php` in filename order,
applying `Schema::table` alterations and drops. `foreignId('x')->constrained()`
and `->foreign()->references()->on()` are constraints; `constrained('table')`
names the target; bare `unsignedBigInteger` linked only by `belongsTo` is
`declared`. Eloquent `app/Models/*.php`: `belongsTo(Model::class, 'fk')`,
`hasOne`, `hasMany`, `belongsToMany(Model::class, 'pivot')`, `$table`.
`morphs('x')`/`nullableMorphs` + `morphTo`/`morphMany`/`morphToMany`/
`morphedByMany` are polymorphic; `*_type` stores aliases from
`Relation::morphMap`/`enforceMorphMap` (usually in `AppServiceProvider`).
Enums: PHP backed enums in `$casts` (read the enum file for values) and DB
`enum(...)` columns.

**Django** — `*/models.py`. Table = `<app_label>_<model lowercased>` unless
`Meta.db_table`. `ForeignKey` → column `<field>_id` unless `db_column`;
`OneToOneField` is `1-1`; `"self"` is a self-reference; `settings.AUTH_USER_MODEL`
resolves through `settings.py`. `db_constraint=False` is `declared`, otherwise
`db_fk`. `ManyToManyField` without `through` creates
`<app>_<model>_<field>` that exists in no file; with `through=` the join table
is that model. `GenericForeignKey` targets come from `GenericRelation` fields
on other models. `TextChoices`/`IntegerChoices`/`choices=` are enums keyed by
the stored value. `null=True` is nullable; `blank` is not.

**Prisma** — `schema.prisma`. `@@map` renames tables, `@map` renames columns
(a field without `@map` keeps its own name, camelCase included). `@relation
(fields: [...], references: [...])` gives columns and target, composite
included; two relations to the same model are told apart by the relation name.
`@id`/`@@id`, `@unique`/`@@unique`. Implicit many-to-many (list fields on both
sides, no `fields:`) creates `_<A>To<B>(A, B)` with models sorted
alphabetically, A = first. Enum values with `@map` are stored as the mapped
string. `relationMode = "prisma"` means `declared`, otherwise `db_fk`.
`?` is nullable.

**TypeORM** — `@Entity('name')`/`@Entity({ name, schema })`, `@Column`,
`@PrimaryGeneratedColumn`, `@PrimaryColumn`, `@ManyToOne` + `@JoinColumn
({ name })`, `@OneToOne` + `@JoinColumn`, `@ManyToMany` + `@JoinTable`.
Column names follow the naming strategy (check for `SnakeNamingStrategy` in the
data source). `type: 'enum', enum: X` reads values from TS enum `X`.
Entity with no schema may resolve through `search_path` (schema per tenant):
look for code setting it.

**Sequelize** — migrations `queryInterface.createTable` with `references:
{ model, key }` (constraint) and `addConstraint`; models `sequelize.define` or
`Model.init` with `tableName`, `belongsTo`/`hasMany`/`belongsToMany({ through })`.
`belongsTo` without `references` is `declared`. `DataTypes.ENUM(...)` values.
`allowNull: false`.

**Mongoose** — `new Schema({...})` / `mongoose.Schema`, `mongoose.model
('Name', schema, 'collection')`. Collection = third argument, else
`{ collection: }` option, else the model name lowercased and pluralised by
Mongoose's rules (`Person` → `people`, `CheckIn` → `checkins`). Every `ref:` is
`declared`. `[{ type: ObjectId, ref }]` is one `n-n` on the holding side.
`refPath` is polymorphic (targets from the enum of the path it names).
Embedded subschemas are columns of type `object`/`array` with a note; refs
inside them have no place in the model. `enum: [...]` on paths. Schema is `_`.
`unique: true` on a ref makes it `1-1`.

**Raw SQL** — `CREATE TABLE`, `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY`,
inline `REFERENCES`, `CREATE TYPE ... AS ENUM`, `CHECK (col IN (...))`,
`COMMENT ON`, `PARTITION BY` / `PARTITION OF` (partitions are not tables),
`CREATE VIEW` / `MATERIALIZED VIEW` (one table with a note). Apply migrations
in version order; later `DROP`/`RENAME` win.

## Traps to check in every repo

- A column `*_id` with no association: grep services/jobs/clients for where it
  is set or used. Found → a hint (`inferred`). Provider ids (`stripe_*_id`,
  `gateway_*_id`, `external_id`) are not relations.
- Ids passed to another service through an HTTP client or queue: `cross_db`,
  evidence = the client function.
- Schema per tenant, partitions, views: one table each, with a note.
- Join tables that exist in no file (Rails HABTM, Django M2M, Prisma implicit).
- Foreign keys that point to a unique non-PK column (`coupons.code`).
- Self-references and two relations between the same pair of tables.
- Integer enums: keep the stored number as the key.
