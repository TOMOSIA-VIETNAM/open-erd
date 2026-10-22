// Single description of the workspace files. The validator walks these specs,
// so a field documented here is exactly a field the engine accepts.
//
// Spec node shapes:
//   { type: 'string', pattern?, oneOf?, hint? }
//   { type: 'boolean' } | { type: 'integer', oneOf?, min? }
//   { type: 'array', items, minItems? }
//   { type: 'object', fields: { key: spec } }   unknown keys are errors
//   { type: 'map', values: spec, keys? }        free keys (matching keys.pattern), typed values
// Any node may carry `required: true` (meaningful inside `fields`).

export const SCHEMA_VERSION = 1;

// Table ids are `<db>.<schema>.<table>`; engines without schemas (MySQL, SQLite,
// Mongo) put `_` in the schema slot. Segments never contain dots, so splitting
// on '.' is always unambiguous.
export const TABLE_ID_PATTERN = /^[^.\s]+\.[^.\s]+\.[^.\s]+$/;

// `db` for facts read from database metadata, otherwise `<repo>:<path>` with an
// optional `#<symbol>` (a line number may be appended to the path but is ignored
// when comparing).
export const EVIDENCE_PATTERN = /^(db|[^:\s]+:\S+)$/;

export const CARDINALITIES = ['1-1', '1-n', 'n-1', 'n-n'];
// Polymorphic associations are not relations with one target; they are
// declared in their own `polymorphic` list (see modelFileSchema).
export const RELATION_KINDS = ['db_fk', 'declared', 'inferred', 'cross_db'];
export const REVIEW_STATES = ['pending', 'reviewed', 'stale'];
// A view or materialized view is drawn like a table, tagged with its kind and
// linked by muted lines to the tables it reads (`sources`).
export const TABLE_KINDS = ['table', 'view', 'materialized_view'];
export const PARTITION_METHODS = ['range', 'list', 'hash'];
// Free-text fields a sharing profile can drop. `note` is the business
// meaning readers outside the team want; `internal_note` is for the team
// only (code pointers, doubts, history); `note_source` is the original,
// untranslated text (often an internal DB comment).
export const NOTE_FIELDS = ['note', 'note_source', 'internal_note'];
export const PROFILE_NAME = /^[A-Za-z0-9_-]+$/;

// Older files must go through a migration before the engine reads them.
const schemaVersion = { type: 'integer', oneOf: [SCHEMA_VERSION], required: true };
const text = { type: 'string' };
const identifier = { type: 'string', pattern: /^\S+$/, hint: 'non-empty, no whitespace' };
// Names that become one segment of a dotted path (embedded entities and
// their columns are addressed as `<entity>.<column>`).
const segment = { type: 'string', pattern: /^[^.\s]+$/, hint: 'no dots or whitespace' };
const count = { type: 'integer', min: 1 };
const columnList = (minItems) => ({ type: 'array', items: identifier, minItems });
const tableId = {
  type: 'string',
  pattern: TABLE_ID_PATTERN,
  hint: '<db>.<schema>.<table>, use _ as schema for schemaless engines, no dots inside a segment',
};

const column = {
  type: 'object',
  fields: {
    name: { ...identifier, required: true },
    type: { ...text, required: true },
    nullable: { type: 'boolean' },
    pk: { type: 'boolean' },
    unique: { type: 'boolean' },
    // value -> business meaning of that value
    enum: { type: 'map', values: text },
    note: text,
    // Original-language note when `note` was translated to English.
    note_source: text,
    internal_note: text,
    pii: { type: 'boolean' },
    renamed_from: identifier,
    // Default value exactly as the schema source writes it: a literal
    // ("0", "draft") or an expression ("now()", "nextval('users_id_seq')").
    default: text,
    // The database assigns the next number on insert (SERIAL, IDENTITY,
    // AUTO_INCREMENT, an ORM's implicit integer id).
    auto_increment: { type: 'boolean' },
    // Expression of a generated / computed column (GENERATED ALWAYS AS ...).
    generated: text,
  },
};

// A document nested inside its parent (MongoDB subdocument, JSON column with
// a known shape). Drawn as an inset box inside the parent's box; relations
// address its columns as `<name>.<column>`, e.g. orders.items.event.
const embedded = {
  type: 'object',
  fields: {
    name: { ...segment, required: true },
    // true for a list of subdocuments (`items: [ItemSchema]`).
    array: { type: 'boolean' },
    note: text,
    internal_note: text,
    columns: {
      type: 'array',
      items: { ...column, fields: { ...column.fields, name: { ...segment, required: true } } },
      minItems: 1,
      required: true,
    },
  },
};

const table = {
  type: 'object',
  fields: {
    id: { ...tableId, required: true },
    domain: { ...text, required: true },
    // `table` when omitted.
    kind: { type: 'string', oneOf: TABLE_KINDS },
    // Tables a view reads from; only for kind view / materialized_view.
    sources: { type: 'array', items: tableId, minItems: 1 },
    note: text,
    note_source: text,
    internal_note: text,
    renamed_from: tableId,
    columns: { type: 'array', items: column, minItems: 1, required: true },
    embedded: { type: 'array', items: embedded, minItems: 1 },
    // Single-table inheritance: one table, the class stored in `column`.
    sti: {
      type: 'object',
      fields: {
        column: { ...identifier, required: true },
        subclasses: { type: 'array', items: identifier, minItems: 1, required: true },
      },
    },
    // Partitions are merged into this one table; `interval` says how a range
    // is cut (month, day, ...).
    partition: {
      type: 'object',
      fields: {
        method: { type: 'string', oneOf: PARTITION_METHODS, required: true },
        columns: { ...columnList(1), required: true },
        interval: text,
      },
    },
    // Unique keys spanning several columns; a single unique column is
    // `unique: true` on the column itself.
    unique: { type: 'array', items: columnList(2), minItems: 1 },
    // Set when a framework creates the table without any file declaring it
    // (Django ManyToManyField, Prisma implicit many-to-many): names the
    // mechanism, e.g. "Prisma implicit many-to-many".
    generated_by: text,
  },
};

const endpoint = {
  type: 'object',
  fields: {
    table: { ...tableId, required: true },
    columns: { type: 'array', items: identifier, minItems: 1, required: true },
  },
};

const evidence = {
  type: 'array',
  items: { type: 'string', pattern: EVIDENCE_PATTERN, hint: 'db or <repo>:<path>[#<symbol>]' },
  minItems: 1,
  required: true,
};
const review = { type: 'string', oneOf: REVIEW_STATES, required: true };

const relation = {
  type: 'object',
  fields: {
    from: { ...endpoint, required: true },
    to: { ...endpoint, required: true },
    cardinality: { type: 'string', oneOf: CARDINALITIES, required: true },
    // true when the referencing columns are nullable
    optional: { type: 'boolean', required: true },
    kind: { type: 'string', oneOf: RELATION_KINDS, required: true },
    evidence,
    review,
  },
};

// One association whose target table is chosen per row by a type column, e.g.
// comments.commentable_type + comments.commentable_id -> posts | photos. The
// diagram draws one virtual «name» node listing the targets instead of one
// line per target.
const polymorphic = {
  type: 'object',
  fields: {
    name: { ...identifier, required: true },
    table: { ...tableId, required: true },
    type_column: { ...identifier, required: true },
    id_column: { ...identifier, required: true },
    // true when the id column is nullable
    optional: { type: 'boolean', required: true },
    // Referenced by their primary key.
    targets: { type: 'array', items: tableId, minItems: 1, required: true },
    // What the association means for the business (which records get one,
    // what it is used for), shown when the virtual node is selected.
    note: text,
    internal_note: text,
    evidence,
    review,
  },
};

// model/<db>.yaml
export const modelFileSchema = {
  type: 'object',
  fields: {
    schema_version: schemaVersion,
    database: { ...identifier, pattern: /^[^.\s]+$/, hint: 'no dots or whitespace', required: true },
    engine: { ...identifier, required: true },
    tables: { type: 'array', items: table, required: true },
    relations: { type: 'array', items: relation },
    polymorphic: { type: 'array', items: polymorphic },
    // Schema-per-tenant: each tenant has its own copy of `schema`, modelled
    // once. `count` is the number of tenants when known (it needs a database
    // read; source code rarely tells).
    tenant_schemas: {
      type: 'array',
      minItems: 1,
      items: { type: 'object', fields: { schema: { ...segment, required: true }, count, note: text } },
    },
    // Replicas and shards of this one logical database; drawn as a note on
    // its frame, never as separate databases.
    topology: { type: 'object', fields: { replicas: count, shards: count, note: text } },
  },
};

// model/cross-db.yaml: relations whose ends live in different database files.
export const CROSS_DB_FILE = 'model/cross-db.yaml';
export const crossDbFileSchema = {
  type: 'object',
  fields: {
    schema_version: schemaVersion,
    relations: { type: 'array', items: relation, required: true },
  },
};

// Tables and columns to leave out. Columns are `<table id>.<column>`, or
// `<table id>.<entity>.<column>` / `<table id>.<entity>` for embedded ones.
const hideSpec = {
  type: 'object',
  fields: {
    tables: { type: 'array', items: tableId },
    columns: {
      type: 'array',
      items: { type: 'string', pattern: /^[^.\s]+\.[^.\s]+\.[^.\s]+\.\S+$/, hint: '<table id>.<column>' },
    },
  },
};

const profileFields = {
  // Relation and polymorphic evidence (repo paths, symbols).
  drop_evidence: { type: 'boolean' },
  // Columns marked `pii`, and every relation that uses one.
  drop_pii: { type: 'boolean' },
  drop_notes: { type: 'array', items: { type: 'string', oneOf: NOTE_FIELDS } },
  // Hidden in this profile in addition to the top-level `hidden`.
  hide: hideSpec,
};

// open-erd.yaml
export const CONFIG_FILE = 'open-erd.yaml';
export const configSchema = {
  type: 'object',
  fields: {
    schema_version: schemaVersion,
    // Source repositories by logical name; machine paths live in the gitignored
    // open-erd.local.yaml so the workspace stays portable.
    sources: {
      type: 'array',
      items: { type: 'object', fields: { name: { ...identifier, required: true } } },
    },
    // Hub tables/columns are drawn as badges instead of lines.
    hub: {
      type: 'object',
      fields: {
        tables: { type: 'array', items: tableId },
        columns: { type: 'array', items: identifier },
      },
    },
    // Draw a pure join table (exactly two foreign keys plus optional
    // timestamp columns) as one n-n line between the tables it joins.
    // Off by default: the join table often matters to readers.
    collapse_join_tables: { type: 'boolean' },
    // Left out of every profile render.
    hidden: hideSpec,
    // Sharing profiles by name, used by `render --profile <name>`. Fields left
    // out take their value from PROFILE_DEFAULTS; `public` exists even when
    // not declared here.
    // A profile name is part of its output file name (out/erd.<name>.svg).
    profiles: {
      type: 'map',
      keys: { pattern: PROFILE_NAME, hint: 'letters, digits, - and _' },
      values: { type: 'object', fields: profileFields },
    },
  },
};

/**
 * What a profile drops when a field is not set. Every profile is for
 * sharing outside the team, so the defaults are the safe ones; a profile
 * that wants evidence or PII kept says so explicitly.
 */
export const PROFILE_DEFAULTS = {
  drop_evidence: true,
  drop_pii: true,
  drop_notes: ['internal_note', 'note_source'],
  hide: { tables: [], columns: [] },
};
export const BUILT_IN_PROFILES = { public: {} };

// tests/locked.yaml: the reviewed facts `validate` protects, written by the
// `lock` command from the model. Data only; each entry carries the
// identity of a fact and the attributes a reviewer confirmed. Evidence is
// left out: code moves while the fact stays true.
export const LOCKED_FILE = 'tests/locked.yaml';
const lockedFields = (spec) => Object.fromEntries(Object.entries(spec.fields).filter(([key]) => key !== 'evidence' && key !== 'review'));
export const lockedFileSchema = {
  type: 'object',
  fields: {
    schema_version: schemaVersion,
    relations: { type: 'array', items: { type: 'object', fields: lockedFields(relation) } },
    polymorphic: { type: 'array', items: { type: 'object', fields: lockedFields(polymorphic) } },
  },
};
