// Column types that hold a point in time. Matched on type, not name, because
// stacks name them differently (created_at, inserted_at, createdAt).
export const TIMESTAMP_TYPE = /^(timestamp|timestamptz|datetime|date|time)\b/i;

const plainWords = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * The meaning of enum value `value` as outputs show it: empty when it only
 * spells the value out again, ignoring case, separators and a trailing code
 * symbol ("smartsite_standard_one: Smartsite standard one (Template.code)").
 * Such a meaning tells a reader nothing the value does not.
 */
export function enumMeaning(value, meaning) {
  const bare = meaning.replace(/\s*\([\w:.#]+\)\s*\.?\s*$/u, '');
  return plainWords(bare) === plainWords(value) ? '' : meaning;
}

/**
 * Every column of a table with the path relations, `hidden` and the viewer
 * address it by: its name, or `<entity>.<name>` inside an embedded entity.
 * Top-level columns first, then each entity's, in authored order.
 */
export function columnEntries(table) {
  return [
    ...table.columns.map((column) => ({ path: column.name, column, entity: null })),
    ...(table.embedded ?? []).flatMap((entity) =>
      entity.columns.map((column) => ({ path: `${entity.name}.${column.name}`, column, entity })),
    ),
  ];
}

/**
 * Columns a business reader does not need, per table id: Business mode in the
 * viewer fades them out. A column is technical when it is
 *   - a primary key column,
 *   - an end of a relation (referencing or referenced, hub relations included),
 *   - the type or id column of a polymorphic association, or
 *   - timestamp-typed (created_at, updated_at, ...).
 * Keys are how tables connect, and the diagram already shows that as lines;
 * bookkeeping timestamps say nothing about the business. A column with an
 * enum is never technical: its values carry business meaning. A note does
 * not count, since every column gets one.
 */
export function technicalColumns(model) {
  const keys = new Map(model.tables.map((t) => [t.id, new Set()]));
  const add = (table, columns) => {
    for (const c of columns) keys.get(table)?.add(c);
  };
  for (const r of model.relations) {
    add(r.from.table, r.from.columns);
    add(r.to.table, r.to.columns);
  }
  for (const a of model.polymorphic) add(a.table, [a.type_column, a.id_column]);
  return new Map(
    model.tables.map((t) => [
      t.id,
      new Set(
        columnEntries(t)
          .filter(({ path, column: c }) => !c.enum && (c.pk || keys.get(t.id).has(path) || TIMESTAMP_TYPE.test(c.type)))
          .map(({ path }) => path),
      ),
    ]),
  );
}
