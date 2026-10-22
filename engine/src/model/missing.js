import { columnEntries } from './columns.js';
import { compareStrings } from './load.js';

// Relations the model may be missing, found mechanically: a column named like
// a reference that nothing covers, and a table nothing connects to. They are
// warnings, never errors: an external provider id (`stripe_customer_id`) or a
// standalone settings table is fine, and `ignore_missing` in open-erd.yaml
// silences such known cases.

// `user_id`, `userId`, and the array forms `tag_ids` / `tagIds`. A bare `id`
// or `_id` is a key of its own table, never a reference.
const REFERENCE_NAME = /(?:._ids?|[a-z0-9]Ids?)$/;
// The type column paired with a reference column of the same base name, as
// polymorphic associations store them: `commentable_type` + `commentable_id`.
const typeColumnOf = (name) => name.replace(/_ids?$/, '_type').replace(/([a-z0-9])Ids?$/, '$1Type');

export const MISSING_KINDS = {
  column: 'column',
  polymorphic: 'polymorphic',
  table: 'table',
};

/**
 * Warnings sorted by table id, then in column order; each is
 * `{ kind, table, column?, typeColumn?, message }`:
 *   - kind `column`: a column of a table (not a view) named like a
 *     reference (see REFERENCE_NAME)
 *     that is no end of any relation (hub relations included) and no column
 *     of any polymorphic association;
 *   - kind `polymorphic`: the same, with a `<base>_type` column beside it
 *     that nothing covers either, so it looks like an undeclared polymorphic
 *     association; reported once, on the id column;
 *   - kind `table`: a table that no relation, polymorphic association
 *     (owner or target) or view source touches.
 * `config.ignore_missing.columns` (`<table id>.<column path>`) silences the
 * first two for that column, `config.ignore_missing.tables` the last one for
 * that table. A relation naming a column the table lacks is not a warning:
 * loading the workspace already rejects it.
 */
export function missingRelations(model) {
  const ignore = model.config?.ignore_missing ?? {};
  const ignoredColumns = new Set(ignore.columns ?? []);
  const ignoredTables = new Set(ignore.tables ?? []);
  const covered = new Map(model.tables.map((t) => [t.id, new Set()]));
  const linked = new Set();
  const cover = (table, columns) => {
    linked.add(table);
    for (const c of columns) covered.get(table)?.add(c);
  };
  for (const r of model.relations) {
    cover(r.from.table, r.from.columns);
    cover(r.to.table, r.to.columns);
  }
  for (const a of model.polymorphic) {
    cover(a.table, [a.type_column, a.id_column]);
    for (const t of a.targets) linked.add(t);
  }
  for (const t of model.tables) {
    for (const s of t.sources ?? []) {
      linked.add(t.id);
      linked.add(s);
    }
  }

  const warnings = [];
  for (const t of [...model.tables].sort((a, b) => compareStrings(a.id, b.id))) {
    if (!linked.has(t.id) && !ignoredTables.has(t.id)) {
      warnings.push({ kind: MISSING_KINDS.table, table: t.id, message: 'no relation, hub reference or polymorphic association connects this table' });
    }
    // A view's columns are what it selects; how it connects is its `sources`.
    if ((t.kind ?? 'table') !== 'table') continue;
    const paths = new Set(columnEntries(t).map((e) => e.path));
    // A primary key named like a reference (`user_id` as the key of a 1-1
    // extension table) still points somewhere, so keys are checked too.
    for (const path of paths) {
      const name = path.split('.').pop();
      if (!REFERENCE_NAME.test(name) || covered.get(t.id).has(path) || ignoredColumns.has(`${t.id}.${path}`)) continue;
      const typePath = path.slice(0, path.length - name.length) + typeColumnOf(name);
      if (typePath !== path && paths.has(typePath) && !covered.get(t.id).has(typePath)) {
        warnings.push({
          kind: MISSING_KINDS.polymorphic,
          table: t.id,
          column: path,
          typeColumn: typePath,
          message: `with ${typePath} it looks like a polymorphic association, but none is declared`,
        });
      } else {
        warnings.push({ kind: MISSING_KINDS.column, table: t.id, column: path, message: 'looks like a reference, but no relation, hub or polymorphic association uses it' });
      }
    }
  }
  return warnings;
}

/**
 * The warnings about what `shown` still holds. Warnings are found on the full
 * model and then narrowed to a profile's model: found on the filtered model,
 * a hidden `users` table would make every `user_id` look unlinked, and a
 * hidden table or column must not be named in shared output.
 */
export function warningsFor(warnings, shown) {
  const columns = new Map(shown.tables.map((t) => [t.id, new Set(columnEntries(t).map((e) => e.path))]));
  return warnings.filter((w) => columns.has(w.table) && [w.column, w.typeColumn].every((c) => c === undefined || columns.get(w.table).has(c)));
}

/** One line per warning, as `validate` prints them. */
export function formatWarning(w) {
  return `warning: possibly missing relation: ${w.column ? `${w.table}.${w.column}` : w.table}: ${w.message}`;
}
