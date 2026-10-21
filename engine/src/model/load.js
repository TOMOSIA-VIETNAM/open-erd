import { parseDocument } from 'yaml';
import { CONFIG_FILE, CROSS_DB_FILE, configSchema, crossDbFileSchema, modelFileSchema } from './schema.js';
import { joinPath, validateNode } from './validate.js';

// Code-unit comparison: localeCompare depends on the machine's ICU locale,
// which would make output differ between machines.
export function compareStrings(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

const MODEL_FILE = /^model\/[^/]+\.yaml$/;

function parseYaml(file, text, errors) {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    for (const e of doc.errors) {
      const line = e.linePos?.[0]?.line;
      errors.push({ file, path: line ? `line ${line}` : '(root)', message: e.message.split('\n')[0] });
    }
    return undefined;
  }
  return doc.toJS();
}

function validateFile(file, data, spec, errors) {
  for (const e of validateNode(data, spec)) errors.push({ file, ...e });
  return errors.every((e) => e.file !== file);
}

function relationKey(r) {
  return [r.from.table, r.from.columns.join(','), r.to.table, r.to.columns.join(','), r.kind].join('\u0000');
}

/**
 * Parse and validate a workspace given as `{ relativePath: text }`.
 * Returns `{ model, errors }`; `model` is null whenever errors is non-empty so
 * callers cannot render a half-valid workspace.
 */
export function parseWorkspace(files) {
  const errors = [];
  const paths = Object.keys(files).sort(compareStrings);

  let config;
  if (files[CONFIG_FILE] === undefined) {
    errors.push({ file: CONFIG_FILE, path: '(root)', message: 'file not found' });
  } else {
    const data = parseYaml(CONFIG_FILE, files[CONFIG_FILE], errors);
    if (data !== undefined && validateFile(CONFIG_FILE, data, configSchema, errors)) config = data;
  }

  const databases = [];
  // Each entry remembers where it came from so cross-file errors point at the right line.
  const tables = [];
  const relations = [];
  const associations = [];
  for (const file of paths.filter((p) => MODEL_FILE.test(p))) {
    const data = parseYaml(file, files[file], errors);
    if (data === undefined) continue;
    const isCrossDb = file === CROSS_DB_FILE;
    if (!validateFile(file, data, isCrossDb ? crossDbFileSchema : modelFileSchema, errors)) continue;
    if (!isCrossDb) {
      databases.push({ database: data.database, engine: data.engine, file });
      data.tables.forEach((table, i) => tables.push({ table, file, path: joinPath('tables', i), database: data.database }));
    }
    (data.relations ?? []).forEach((relation, i) => relations.push({ relation, file, path: joinPath('relations', i) }));
    (data.polymorphic ?? []).forEach((association, i) =>
      associations.push({ association, file, path: joinPath('polymorphic', i) }),
    );
  }

  const tablesById = new Map();
  for (const { table, file, path, database } of tables) {
    const db = table.id.split('.')[0];
    if (db !== database) {
      errors.push({ file, path: `${path}.id`, message: `table id must start with "${database}.", got ${JSON.stringify(table.id)}` });
    }
    if (tablesById.has(table.id)) {
      errors.push({ file, path: `${path}.id`, message: `duplicate table id ${JSON.stringify(table.id)}` });
    } else {
      tablesById.set(table.id, table);
    }
    const seen = new Set();
    table.columns.forEach((column, i) => {
      if (seen.has(column.name)) {
        errors.push({ file, path: `${path}.columns[${i}].name`, message: `duplicate column ${JSON.stringify(column.name)}` });
      }
      seen.add(column.name);
    });
  }

  for (const { relation, file, path } of relations) {
    for (const end of ['from', 'to']) {
      const target = tablesById.get(relation[end].table);
      if (!target) {
        errors.push({ file, path: `${path}.${end}.table`, message: `unknown table ${JSON.stringify(relation[end].table)}` });
        continue;
      }
      const names = new Set(target.columns.map((c) => c.name));
      relation[end].columns.forEach((name, i) => {
        if (!names.has(name)) {
          errors.push({ file, path: `${path}.${end}.columns[${i}]`, message: `unknown column ${JSON.stringify(name)} in ${target.id}` });
        }
      });
    }
    if (relation.from.columns.length !== relation.to.columns.length) {
      errors.push({ file, path: `${path}.to.columns`, message: 'must have the same number of columns as from.columns' });
    }
  }

  const names = new Set();
  for (const { association: a, file, path } of associations) {
    const owner = tablesById.get(a.table);
    if (!owner) {
      errors.push({ file, path: `${path}.table`, message: `unknown table ${JSON.stringify(a.table)}` });
    } else {
      const columns = new Set(owner.columns.map((c) => c.name));
      for (const field of ['type_column', 'id_column']) {
        if (!columns.has(a[field])) {
          errors.push({ file, path: `${path}.${field}`, message: `unknown column ${JSON.stringify(a[field])} in ${a.table}` });
        }
      }
    }
    const key = `${a.table}\u0000${a.name}`;
    if (names.has(key)) errors.push({ file, path: `${path}.name`, message: `duplicate association ${JSON.stringify(a.name)} on ${a.table}` });
    names.add(key);
    const seen = new Set();
    a.targets.forEach((target, i) => {
      if (!tablesById.has(target)) errors.push({ file, path: `${path}.targets[${i}]`, message: `unknown table ${JSON.stringify(target)}` });
      if (seen.has(target)) errors.push({ file, path: `${path}.targets[${i}]`, message: `duplicate target ${JSON.stringify(target)}` });
      seen.add(target);
    });
  }

  if (config) {
    for (const section of ['hub', 'hidden']) {
      (config[section]?.tables ?? []).forEach((id, i) => {
        if (!tablesById.has(id)) {
          errors.push({ file: CONFIG_FILE, path: `${section}.tables[${i}]`, message: `unknown table ${JSON.stringify(id)}` });
        }
      });
    }
  }

  if (errors.length > 0) return { model: null, errors };
  return {
    model: normalizeModel({
      config,
      databases,
      tables: tables.map((t) => t.table),
      relations: relations.map((r) => r.relation),
      polymorphic: associations.map((a) => a.association),
    }),
    errors,
  };
}

// Sort every set-like collection so identical models always yield identical
// output. Column and enum order are kept as authored: they mirror DDL order and
// value lifecycles, which readers expect to see unchanged.
export function normalizeModel(model) {
  const sortedList = (list) => [...(list ?? [])].sort(compareStrings);
  const config = { ...model.config };
  for (const section of ['hub', 'hidden']) {
    if (config[section]) {
      config[section] = Object.fromEntries(
        Object.keys(config[section]).sort(compareStrings).map((k) => [k, sortedList(config[section][k])]),
      );
    }
  }
  if (config.sources) config.sources = [...config.sources].sort((a, b) => compareStrings(a.name, b.name));
  return {
    config,
    databases: [...model.databases].sort((a, b) => compareStrings(a.database, b.database)),
    tables: [...model.tables].sort((a, b) => compareStrings(a.id, b.id)),
    relations: model.relations
      .map((r) => ({ ...r, evidence: sortedList(r.evidence) }))
      .sort((a, b) => compareStrings(relationKey(a), relationKey(b))),
    polymorphic: (model.polymorphic ?? [])
      .map((a) => ({ ...a, targets: sortedList(a.targets), evidence: sortedList(a.evidence) }))
      .sort((a, b) => compareStrings(a.table, b.table) || compareStrings(a.name, b.name)),
  };
}

export function formatError(e) {
  return `${e.file}: ${e.path}: ${e.message}`;
}
