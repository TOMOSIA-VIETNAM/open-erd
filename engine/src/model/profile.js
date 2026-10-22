import { BUILT_IN_PROFILES, NOTE_FIELDS, PROFILE_DEFAULTS } from './schema.js';
import { splitColumnRef } from './load.js';

/** Names `render --profile` accepts: the built-in ones plus the configured ones. */
export function profileNames(config) {
  return [...new Set([...Object.keys(BUILT_IN_PROFILES), ...Object.keys(config.profiles ?? {})])].sort();
}

/**
 * Settings of profile `name`: PROFILE_DEFAULTS, overridden by the built-in
 * profile, overridden by what open-erd.yaml declares. Throws on an unknown
 * name so a typo never renders the unfiltered model under a sharing name.
 */
export function resolveProfile(config, name) {
  const declared = config.profiles?.[name];
  if (!declared && !BUILT_IN_PROFILES[name]) {
    throw new Error(`unknown profile "${name}" (known: ${profileNames(config).join(', ')})`);
  }
  const merged = { ...PROFILE_DEFAULTS, ...BUILT_IN_PROFILES[name], ...declared };
  return { ...merged, hide: { tables: merged.hide.tables ?? [], columns: merged.hide.columns ?? [] } };
}

function withoutFields(object, fields) {
  const copy = { ...object };
  for (const f of fields) delete copy[f];
  return copy;
}

/**
 * The model as profile `name` shares it. Runs after loading and before
 * layout positions are resolved, so nothing it drops can reach any output:
 *   - tables in `hidden.tables` or the profile's `hide.tables`, with every
 *     relation touching them; they leave polymorphic targets (an association
 *     left without targets goes) and view sources;
 *   - columns in `hidden.columns` / `hide.columns`, and `pii` columns when
 *     `drop_pii`, with every relation, polymorphic association, STI,
 *     partition and index that uses them; an embedded entity listed by
 *     name, or left without columns, goes whole;
 *   - the note fields in `drop_notes`, everywhere they occur (domain notes
 *     included); the entry of a domain left without tables;
 *   - evidence when `drop_evidence`.
 * The config keeps no hidden names either: `hidden` and `profiles` are left out.
 */
export function applyProfile(model, name) {
  const p = resolveProfile(model.config, name);
  const hiddenTables = new Set([...(model.config.hidden?.tables ?? []), ...p.hide.tables]);
  const hiddenColumns = new Set([...(model.config.hidden?.columns ?? []), ...p.hide.columns]);
  const dropNotes = p.drop_notes.filter((f) => NOTE_FIELDS.includes(f));
  const keepColumn = (tableId, path, column) => !hiddenColumns.has(`${tableId}.${path}`) && !(p.drop_pii && column.pii);
  const strip = (object) => withoutFields(object, dropNotes);

  const kept = new Map();
  for (const t of model.tables) {
    if (hiddenTables.has(t.id)) continue;
    const columns = t.columns.filter((c) => keepColumn(t.id, c.name, c)).map(strip);
    const embedded = (t.embedded ?? [])
      .filter((e) => !hiddenColumns.has(`${t.id}.${e.name}`))
      .map((e) => ({ ...strip(e), columns: e.columns.filter((c) => keepColumn(t.id, `${e.name}.${c.name}`, c)).map(strip) }))
      .filter((e) => e.columns.length > 0);
    const paths = new Set([...columns.map((c) => c.name), ...embedded.flatMap((e) => e.columns.map((c) => `${e.name}.${c.name}`))]);
    const has = (names) => names.every((n) => paths.has(n));
    const table = withoutFields(strip(t), ['columns', 'embedded', 'sources', 'sti', 'partition', 'indexes']);
    table.columns = columns;
    if (embedded.length > 0) table.embedded = embedded;
    const sources = (t.sources ?? []).filter((id) => !hiddenTables.has(id));
    if (sources.length > 0) table.sources = sources;
    if (t.sti && paths.has(t.sti.column)) table.sti = t.sti;
    if (t.partition && has(t.partition.columns)) table.partition = t.partition;
    const indexes = (t.indexes ?? []).filter((i) => has(i.columns));
    if (indexes.length > 0) table.indexes = indexes;
    kept.set(t.id, { table, paths });
  }
  const endOk = (end) => kept.has(end.table) && end.columns.every((c) => kept.get(end.table).paths.has(c));
  const evidence = (fact) => (p.drop_evidence ? withoutFields(fact, ['evidence']) : fact);

  const polymorphic = [];
  for (const a of model.polymorphic) {
    const owner = kept.get(a.table);
    const targets = a.targets.filter((id) => kept.has(id));
    if (!owner || !owner.paths.has(a.type_column) || !owner.paths.has(a.id_column) || targets.length === 0) continue;
    polymorphic.push(evidence(strip({ ...a, targets })));
  }
  const hub = model.config.hub
    ? { ...model.config.hub, ...(model.config.hub.tables ? { tables: model.config.hub.tables.filter((id) => kept.has(id)) } : {}) }
    : undefined;
  const config = withoutFields(model.config, ['hidden', 'profiles', 'hub']);
  if (hub) config.hub = hub;
  // A domain whose tables are all hidden is gone, and so is its entry.
  const domainsOf = (db) =>
    Object.fromEntries(
      Object.entries(db.domains)
        .filter(([name]) => [...kept.values()].some(({ table }) => table.domain === name && table.id.split('.')[0] === db.database))
        .map(([name, d]) => [name, strip(d)]),
    );
  return {
    config,
    databases: model.databases.map((db) => ({
      ...db,
      ...(db.tenant_schemas ? { tenant_schemas: db.tenant_schemas.map(strip) } : {}),
      ...(db.topology ? { topology: strip(db.topology) } : {}),
      ...(db.domains ? { domains: domainsOf(db) } : {}),
    })),
    tables: [...kept.values()].map((k) => k.table),
    relations: model.relations.filter((r) => endOk(r.from) && endOk(r.to)).map(evidence),
    polymorphic,
  };
}
