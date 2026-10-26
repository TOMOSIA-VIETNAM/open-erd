// Column types that hold a point in time. Matched on type, not name, because
// stacks name them differently (created_at, inserted_at, createdAt).
export const TIMESTAMP_TYPE = /^(timestamp|timestamptz|datetime|date|time)\b/i;

const plainWords = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * The meaning of enum value `value` as outputs show it: empty when it only
 * spells the value out again, ignoring case, separators and a trailing code
 * symbol ("gold: Gold (Plan.tier)").
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
