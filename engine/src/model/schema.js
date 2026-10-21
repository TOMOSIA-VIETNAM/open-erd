// Single description of the workspace files. The validator walks these specs,
// so a field documented here is exactly a field the engine accepts.
//
// Spec node shapes:
//   { type: 'string', pattern?, oneOf?, hint? }
//   { type: 'boolean' } | { type: 'integer', oneOf? }
//   { type: 'array', items, minItems? }
//   { type: 'object', fields: { key: spec } }   unknown keys are errors
//   { type: 'map', values: spec }               free keys, typed values
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

// Older files must go through a migration before the engine reads them.
const schemaVersion = { type: 'integer', oneOf: [SCHEMA_VERSION], required: true };
const text = { type: 'string' };
const identifier = { type: 'string', pattern: /^\S+$/, hint: 'non-empty, no whitespace' };
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
    pii: { type: 'boolean' },
    renamed_from: identifier,
  },
};

const table = {
  type: 'object',
  fields: {
    id: { ...tableId, required: true },
    domain: { ...text, required: true },
    note: text,
    note_source: text,
    renamed_from: tableId,
    columns: { type: 'array', items: column, minItems: 1, required: true },
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
    // Excluded from shared profiles. Columns are `<table id>.<column>`.
    hidden: {
      type: 'object',
      fields: {
        tables: { type: 'array', items: tableId },
        columns: {
          type: 'array',
          items: { type: 'string', pattern: /^[^.\s]+\.[^.\s]+\.[^.\s]+\.\S+$/, hint: '<table id>.<column>' },
        },
      },
    },
  },
};
