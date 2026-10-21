import { fileURLToPath } from 'node:url';
import { readWorkspaceFiles } from '../../cli.js';
import { normalizeModel, parseWorkspace } from '../../src/model/load.js';

export const SHOP = fileURLToPath(new URL('../fixtures/workspace-shop', import.meta.url));
// Three databases (PostgreSQL, MySQL, MongoDB) with cross-DB relations, hubs,
// a collapsible join table, polymorphic associations and a self-reference.
export const MULTI = fileURLToPath(new URL('../fixtures/workspace-multi', import.meta.url));

export async function loadWorkspace(dir) {
  const { model, errors } = parseWorkspace(await readWorkspaceFiles(dir));
  if (errors.length > 0) throw new Error(JSON.stringify(errors));
  return model;
}

export const loadShop = () => loadWorkspace(SHOP);
export const loadMulti = () => loadWorkspace(MULTI);

export function table(id, domain, columns) {
  return { id, domain, columns: [{ name: 'id', type: 'bigint', pk: true }, ...columns.map(([name, type]) => ({ name, type }))] };
}

export function fk(from, column, to) {
  return {
    from: { table: from, columns: [column] },
    to: { table: to, columns: ['id'] },
    cardinality: 'n-1',
    optional: false,
    kind: 'db_fk',
    evidence: ['db'],
    review: 'reviewed',
  };
}

/** Model with tables/relations added and tables (plus their relations) removed. */
export function changeModel(model, { add = [], relations = [], remove = [], databases = [] }) {
  const gone = new Set(remove);
  return normalizeModel({
    ...model,
    databases: [...model.databases, ...databases],
    tables: [...model.tables.filter((t) => !gone.has(t.id)), ...add],
    relations: [...model.relations.filter((r) => !gone.has(r.from.table) && !gone.has(r.to.table)), ...relations],
  });
}
