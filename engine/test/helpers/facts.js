// The extract facts a script would write for `model`, in the documented
// facts-file shape: the model's structure as one facts file per database,
// with schema `null` for engines without schemas (`_`) and
// `constraint: true` on db_fk relations. A model in sync with these facts
// compares clean; tests and evals edit one side to make it differ.

const column = (c) => ({
  name: c.name,
  type: c.type,
  nullable: c.nullable === true,
  pk: c.pk === true,
  unique: c.unique === true,
  ...(c.default === undefined ? {} : { default: c.default }),
  auto_increment: c.auto_increment === true,
});

/** `[{ file, data }]` as readFacts takes them. `keep(table)` drops tables a script would not see. */
export function factsFromModel(model, { source = 'app', keep = () => true } = {}) {
  const byDb = new Map();
  for (const t of model.tables.filter(keep)) {
    const [database, schema, name] = t.id.split('.');
    const tables = byDb.get(database) ?? [];
    tables.push({
      name,
      schema: schema === '_' ? null : schema,
      database,
      evidence: `schema#${name}`,
      columns: t.columns.map(column),
      indexes: (t.indexes ?? []).map((i) => ({ ...i, unique: i.unique === true })),
    });
    byDb.set(database, tables);
  }
  const nameOf = (id) => id.split('.')[2];
  return [...byDb.keys()].sort().map((database) => ({
    file: `${source}-${database}.json`,
    data: {
      source: `${source}-${database}`,
      stack: ['test'],
      tables: byDb.get(database),
      associations: model.relations
        .filter((r) => r.from.table.startsWith(`${database}.`) && r.kind !== 'cross_db')
        .map((r) => ({
          from: { table: nameOf(r.from.table), columns: r.from.columns },
          to: { table: nameOf(r.to.table), columns: r.to.columns },
          constraint: r.kind === 'db_fk',
          evidence: `models#${nameOf(r.from.table)}`,
        })),
    },
  }));
}
