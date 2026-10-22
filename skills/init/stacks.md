# Writing an extract script per stack

One script per source repo: `<ws>/extract/<source>.mjs`. It reads static files
under the source path given as its only argument and prints the facts JSON
(format in `../_shared/model.md`) to stdout.

## Finding every model root first

Models and schemas often live outside `app/models` or `db/`. Before writing a
script, list every folder that declares tables, documents or migrations, and
show the list to the user. Look for:

- Ruby: `Gemfile` / `Gemfile.lock` gems with `path:` or `git:` (an internal
  gem shipping models), `engines/*/`, `components/*/`, `packs/*/`, `gems/*/`,
  `shared/`, `lib/**/models`, `config.autoload_paths` / `eager_load_paths`
  additions, Mongoid documents (`include Mongoid::Document`) next to Active
  Record models, several `db/*schema.rb` / `db/*structure.sql` (multiple
  databases in `config/database.yml`).
- Git submodules (`.gitmodules`) and vendored copies of another repo.
- JavaScript / TypeScript: `pnpm-workspace.yaml`, `workspaces` in
  `package.json`, `nx.json` / `turbo.json` projects, `packages/*/`, `apps/*/`,
  `libs/*/`; every `*.prisma`, every TypeORM data source `entities` glob,
  every Sequelize `models/` and `migrations/` folder.
- Python: every installed-in-place package (`pyproject.toml` / `setup.py` in
  subfolders), every app in `INSTALLED_APPS`, `models/` packages split into
  several files.
- PHP: `composer.json` `autoload` paths and path repositories, Laravel
  modules (`Modules/*/`, `app/Domain/*/`), extra migration paths
  (`loadMigrationsFrom`).
- Any source file referencing a model class, table or collection that none
  of the roots found so far declares.

A root inside the source repo is read by that source's script. A root
outside it (a `path:` gem in a sibling folder, a submodule that is not
checked out, a package installed elsewhere) cannot be reached: the script
reads only under its source path. Ask the user to add it as its own source
(name + path), or to check it out.

If an expected root is missing (a `path:` gem folder that does not exist, an
empty submodule, models referenced but declared nowhere), stop and tell the
user what is missing and where it was referenced. Do not write the model
from the part you could read: a partial ERD looks complete and misleads.

Script rules:

- Node 20+, ESM, imports only `node:fs` and `node:path`. No npm packages (the
  workspace has no `node_modules`), no network, no child processes, no file
  writes, no `eval`/`import()` of source files.
- Parse with small hand-written readers (regex plus bracket matching). It does
  not need to be a full parser; it must handle every file that is in this repo.
- Deterministic: sort tables by name, columns in file order, everything else by
  a stable key; `JSON.stringify(facts, null, 2)`.
- Paths in evidence are relative to the source root with `/` separators.
- `verify` compares the model with the fields listed under "Read by the
  engine" in `../_shared/model.md` ("Extract facts file"): write those
  exactly in that shape (`database` on each table or on the file,
  `constraint: true` on an association the DDL backs with a foreign key, no
  `default` when the source sets none).
- Skip `node_modules`, `vendor`, `.git`, build output, test fixtures.
- Print to stderr a one-line count per kind of fact, and every file it could
  not parse, so gaps are visible.
- For every column record, when the source shows them, `default` (as written:
  a literal or an expression, as a string), `auto_increment: true`, and
  `generated` (the expression of a generated/computed column). They fill the
  Default, Auto Inc, Generated and Expression columns of the Excel table
  sheets. Per-stack idioms below; never guess one the file does not show.
- For every table record its declared indexes as `indexes: [{ name?, columns,
  unique, where?, using? }]` (shape and rules in `../_shared/model.md`,
  "indexes"): one entry per index statement, columns in index order, the
  name only when the source gives one (Rails `name:`, an explicit Laravel
  index name, Prisma `map:`, `CREATE INDEX <name>`). Per-stack idioms below.

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
(`posts_tags`) has no model and often no `id`. Defaults: `default:` on a
column (`default: -> { "now()" }` is the expression `now()`); the implicit
`id` of `create_table` is `auto_increment` (unless `id: false` or
`id: :uuid`, whose default is shown as `default: -> { "gen_random_uuid()" }`);
`t.virtual "x", as: "expr"` is `generated`. Mongoid documents: `field :x,
default:`. Indexes: `t.index [cols], name:, unique:, where:, using:` inside
`create_table` and `add_index :table, [cols], ...` (later `remove_index`
drops one); in `structure.sql`, `CREATE [UNIQUE] INDEX`. Mongoid: `index({ x:
1 }, { unique: true })`.

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
`enum(...)` columns. Defaults: `->default(...)`, `->useCurrent()` (`CURRENT_TIMESTAMP`);
`$table->id()`, `increments`/`bigIncrements` and `->autoIncrement()` are
`auto_increment`; `->storedAs('expr')` / `->virtualAs('expr')` are `generated`.
Indexes: `->index()` on a column, `$table->index([cols], 'name')`,
`$table->unique([cols], 'name')`, `$table->fullText(...)` (`using: fulltext`),
`$table->spatialIndex(...)` (`using: spatial`); `dropIndex`/`dropUnique` in a
later migration remove one. `->unique()` on one column is the column's
`unique: true`, not an index.

**Django** — `*/models.py`. Table = `<app_label>_<model lowercased>` unless
`Meta.db_table`. `ForeignKey` → column `<field>_id` unless `db_column`;
`OneToOneField` is `1-1`; `"self"` is a self-reference; `settings.AUTH_USER_MODEL`
resolves through `settings.py`. `db_constraint=False` is `declared`, otherwise
`db_fk`. `ManyToManyField` without `through` creates
`<app>_<model>_<field>` that exists in no file; with `through=` the join table
is that model. `GenericForeignKey` targets come from `GenericRelation` fields
on other models. `TextChoices`/`IntegerChoices`/`choices=` are enums keyed by
the stored value. `null=True` is nullable; `blank` is not. Defaults:
`default=` (resolve a choices constant to its stored value), `db_default=`;
the implicit `id` (`DEFAULT_AUTO_FIELD`, `AutoField`, `BigAutoField`) is
`auto_increment`; `GeneratedField(expression=...)` is `generated`.
`auto_now`/`auto_now_add` are set by Django, not by the database: say so in
the column note, not in `default`. Indexes: `Meta.indexes = [models.Index(
fields=[...], name=..., condition=Q(...))]` (`condition` is `where`, written
as the SQL it becomes), `Meta.unique_together`, `Meta.constraints =
[UniqueConstraint(fields=..., name=..., condition=...)]` (unique),
`db_index=True` on a field (one column, no name). `ForeignKey` gets an index
from Django without declaring one: do not list it.

**Prisma** — `schema.prisma`. `@@map` renames tables, `@map` renames columns
(a field without `@map` keeps its own name, camelCase included). `@relation
(fields: [...], references: [...])` gives columns and target, composite
included; two relations to the same model are told apart by the relation name.
`@id`/`@@id`, `@unique`/`@@unique`. Implicit many-to-many (list fields on both
sides, no `fields:`) creates `_<A>To<B>(A, B)` with models sorted
alphabetically, A = first. Enum values with `@map` are stored as the mapped
string. `relationMode = "prisma"` means `declared`, otherwise `db_fk`.
`?` is nullable. `@default(x)` is `default` (`now()`, `uuid()`, `cuid()`, a
literal, an enum value as stored); `@default(autoincrement())` is
`auto_increment`; `@default(dbgenerated("expr"))` is `default: expr`.
`@updatedAt` is set by Prisma: say so in the column note. Indexes:
`@@index([a, b], map: "name", type: Hash)` (`type` is `using`) and
`@@unique([a, b], map: "name")`; `@unique` on a field is the column's
`unique: true`.

**TypeORM** — `@Entity('name')`/`@Entity({ name, schema })`, `@Column`,
`@PrimaryGeneratedColumn`, `@PrimaryColumn`, `@ManyToOne` + `@JoinColumn
({ name })`, `@OneToOne` + `@JoinColumn`, `@ManyToMany` + `@JoinTable`.
Column names follow the naming strategy (check for `SnakeNamingStrategy` in the
data source). `type: 'enum', enum: X` reads values from TS enum `X`.
Entity with no schema may resolve through `search_path` (schema per tenant):
look for code setting it. `@Column({ default })` is `default`;
`@PrimaryGeneratedColumn()` / `('increment')` / `('identity')` and
`@Generated('increment')` are `auto_increment`, `('uuid')` is a uuid default
(take the expression from the migration when there is one);
`generatedType` + `asExpression` is `generated`. Indexes: `@Index('name',
['a', 'b'], { unique: true, where: '...' })` on the entity class and
`@Index()` on a property (one column), `@Unique('name', ['a', 'b'])`; in
migrations, `new TableIndex({ name, columnNames, isUnique, where })` and
`CREATE INDEX` in `queryRunner.query`.

**Sequelize** — migrations `queryInterface.createTable` with `references:
{ model, key }` (constraint) and `addConstraint`; models `sequelize.define` or
`Model.init` with `tableName`, `belongsTo`/`hasMany`/`belongsToMany({ through })`.
`belongsTo` without `references` is `declared`. `DataTypes.ENUM(...)` values.
`allowNull: false`. `defaultValue` (`Sequelize.NOW`/`fn('now')` is `now()`) is
`default`; `autoIncrement: true` is `auto_increment`. Indexes: model option
`indexes: [{ name, fields, unique, where, using }]`, migrations
`queryInterface.addIndex('table', [cols], { name, unique, where })`
(`removeIndex` drops one).

**Mongoose** — `new Schema({...})` / `mongoose.Schema`, `mongoose.model
('Name', schema, 'collection')`. Collection = third argument, else
`{ collection: }` option, else the model name lowercased and pluralised by
Mongoose's rules (`Child` → `children`, `LogEntry` → `logentries`). Every `ref:` is
`declared`. `[{ type: ObjectId, ref }]` is one `n-n` on the holding side.
`refPath` is polymorphic (targets from the enum of the path it names).
Nested objects and subschemas (single or in arrays) are `embedded` entities,
not columns; a `ref` inside one is a relation from the embedded path
(`../_shared/model.md`, "Special patterns"). `enum: [...]` on paths. Schema is `_`.
`unique: true` on a ref makes it `1-1`. `default:` on a path is `default`
(a function as written, e.g. `Date.now`). Indexes: `index: true` on a path
(one column; `unique: true` alone stays the column's flag),
`schema.index({ a: 1, b: -1 }, { unique: true, name, partialFilterExpression })`
(`partialFilterExpression` as `where`, written as the JSON it is).

**Raw SQL** — `CREATE TABLE`, `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY`,
inline `REFERENCES`, `CREATE TYPE ... AS ENUM`, `CHECK (col IN (...))`,
`COMMENT ON`, `PARTITION BY` / `PARTITION OF` (partitions are not tables),
`CREATE VIEW` / `MATERIALIZED VIEW` (one table with a note). Apply migrations
in version order; later `DROP`/`RENAME` win. `DEFAULT <expr>` is `default`;
`SERIAL`/`BIGSERIAL`, `GENERATED ... AS IDENTITY`, `AUTO_INCREMENT`,
`AUTOINCREMENT` and `IDENTITY(1,1)` are `auto_increment`; `GENERATED ALWAYS
AS (<expr>) [STORED]` and `AS (<expr>)` computed columns are `generated`.
`ALTER COLUMN ... SET DEFAULT` / `DROP DEFAULT` update it.
`CREATE [UNIQUE] INDEX <name> ON <table> [USING <method>] (cols) [WHERE ...]`
and `ALTER TABLE ... ADD CONSTRAINT <name> UNIQUE (cols)` are indexes;
`DROP INDEX` removes one.

## Traps to check in every repo

- A column `*_id` with no association: grep services/jobs/clients for where it
  is set or used. Found → a hint (`inferred`). Provider ids (`stripe_*_id`,
  `gateway_*_id`, `external_id`) are not relations.
- Ids passed to another service through an HTTP client or queue: `cross_db`,
  evidence = the client function.
- Schema per tenant, partitions, views: one table each, with the special-pattern
  fields of `../_shared/model.md`.
- Join tables that exist in no file (Rails HABTM, Django M2M, Prisma implicit).
- Foreign keys that point to a unique non-PK column (`currencies.iso_code`).
- Self-references and two relations between the same pair of tables.
- Integer enums: keep the stored number as the key.
