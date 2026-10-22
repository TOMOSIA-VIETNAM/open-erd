import { parseDocument } from 'yaml';
import { clusterKey } from '../layout/clusters.js';
import { CONFIG_FILE, CROSS_DB_FILE, DOMAIN_VIEW_PREFIX, configSchema, crossDbFileSchema, modelFileSchema } from './schema.js';
import { columnEntries } from './columns.js';
import { joinPath, validateNode } from './validate.js';

// Code-unit comparison: localeCompare depends on the machine's ICU locale,
// which would make output differ between machines.
export function compareStrings(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

const MODEL_FILE = /^model\/[^/]+\.yaml$/;

/** Parsed YAML of `file`, or undefined after pushing its syntax errors. */
export function parseYaml(file, text, errors) {
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
      databases.push({
        database: data.database,
        engine: data.engine,
        file,
        ...(data.tenant_schemas ? { tenant_schemas: data.tenant_schemas } : {}),
        ...(data.topology ? { topology: data.topology } : {}),
      });
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
    // An entity name shares the namespace of columns: `items.event` must
    // resolve to exactly one thing.
    (table.embedded ?? []).forEach((entity, i) => {
      const at = `${path}.embedded[${i}]`;
      if (seen.has(entity.name)) errors.push({ file, path: `${at}.name`, message: `${JSON.stringify(entity.name)} is already a column or embedded entity` });
      seen.add(entity.name);
      const inner = new Set();
      entity.columns.forEach((column, k) => {
        if (inner.has(column.name)) errors.push({ file, path: `${at}.columns[${k}].name`, message: `duplicate column ${JSON.stringify(column.name)}` });
        inner.add(column.name);
      });
    });
  }

  const columnsOf = new Map([...tablesById].map(([id, t]) => [id, new Set(columnEntries(t).map((e) => e.path))]));
  const checkColumns = (file, path, tableId, names) => {
    names.forEach((name, i) => {
      if (!columnsOf.get(tableId).has(name)) {
        errors.push({ file, path: `${path}[${i}]`, message: `unknown column ${JSON.stringify(name)} in ${tableId}` });
      }
    });
  };
  for (const { table, file, path } of tables) {
    if (tablesById.get(table.id) !== table) continue;
    if (table.sources) {
      if ((table.kind ?? 'table') === 'table') {
        errors.push({ file, path: `${path}.sources`, message: 'only a view or materialized_view has sources' });
      }
      table.sources.forEach((id, i) => {
        if (!tablesById.has(id)) errors.push({ file, path: `${path}.sources[${i}]`, message: `unknown table ${JSON.stringify(id)}` });
        else if (id === table.id) errors.push({ file, path: `${path}.sources[${i}]`, message: 'a view cannot read from itself' });
      });
    }
    if (table.sti && !columnsOf.get(table.id).has(table.sti.column)) {
      errors.push({ file, path: `${path}.sti.column`, message: `unknown column ${JSON.stringify(table.sti.column)} in ${table.id}` });
    }
    if (table.partition) checkColumns(file, `${path}.partition.columns`, table.id, table.partition.columns);
    (table.unique ?? []).forEach((key, i) => checkColumns(file, `${path}.unique[${i}]`, table.id, key));
    (table.indexes ?? []).forEach((index, i) => checkColumns(file, `${path}.indexes[${i}].columns`, table.id, index.columns));
  }

  for (const db of databases) {
    (db.tenant_schemas ?? []).forEach((t, i) => {
      if (!tables.some((x) => x.database === db.database && x.table.id.split('.')[1] === t.schema)) {
        errors.push({ file: db.file, path: `tenant_schemas[${i}].schema`, message: `no table of ${db.database} is in schema ${JSON.stringify(t.schema)}` });
      }
    });
  }

  for (const { relation, file, path } of relations) {
    for (const end of ['from', 'to']) {
      const target = tablesById.get(relation[end].table);
      if (!target) {
        errors.push({ file, path: `${path}.${end}.table`, message: `unknown table ${JSON.stringify(relation[end].table)}` });
        continue;
      }
      checkColumns(file, `${path}.${end}.columns`, target.id, relation[end].columns);
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
      for (const field of ['type_column', 'id_column']) {
        if (!columnsOf.get(owner.id).has(a[field])) {
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
    const lists = [
      ['hub', config.hub],
      ['hidden', config.hidden],
      ['ignore_missing', config.ignore_missing],
      ...Object.keys(config.profiles ?? {})
        .sort(compareStrings)
        .map((name) => [joinPath(joinPath('profiles', name), 'hide'), config.profiles[name].hide]),
    ];
    for (const [section, list] of lists) {
      (list?.tables ?? []).forEach((id, i) => {
        if (!tablesById.has(id)) {
          errors.push({ file: CONFIG_FILE, path: `${section}.tables[${i}]`, message: `unknown table ${JSON.stringify(id)}` });
        }
      });
    }
    // A misspelt hidden column would silently stay in shared output.
    for (const [section, hide] of lists.slice(1)) {
      (hide?.columns ?? []).forEach((ref, i) => {
        const [tableId, name] = splitColumnRef(ref);
        const table = tablesById.get(tableId);
        const known = table && (columnsOf.get(tableId).has(name) || (table.embedded ?? []).some((e) => e.name === name));
        if (!known) errors.push({ file: CONFIG_FILE, path: `${section}.columns[${i}]`, message: `unknown column ${JSON.stringify(ref)}` });
      });
    }
    const view = config.default_view ?? '';
    if (view.startsWith(DOMAIN_VIEW_PREFIX) && !tables.some(({ table: t }) => clusterKey(t) === view.slice(DOMAIN_VIEW_PREFIX.length))) {
      errors.push({ file: CONFIG_FILE, path: 'default_view', message: `no domain ${JSON.stringify(view.slice(DOMAIN_VIEW_PREFIX.length))} (expected domain:<db>/<domain> of a table)` });
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

/**
 * `table` with its deprecated `unique` keys turned into unique indexes, so
 * everything after load reads one field (`indexes`). A key already declared
 * as a unique index is not added twice.
 */
export function withIndexes(table) {
  if (!table.unique) return table;
  const { unique, ...rest } = table;
  const declared = new Set((table.indexes ?? []).filter((i) => i.unique).map((i) => i.columns.join('\u0000')));
  const converted = unique.filter((key) => !declared.has(key.join('\u0000'))).map((columns) => ({ columns, unique: true }));
  return { ...rest, indexes: [...(table.indexes ?? []), ...converted] };
}

const indexKey = (i) => [i.columns.join(','), i.name ?? '', i.unique ? '1' : '0', i.where ?? '', i.using ?? ''].join('\u0000');

// Sort every set-like collection so identical models always yield identical
// output. Column and enum order are kept as authored: they mirror DDL order and
// value lifecycles, which readers expect to see unchanged.
export function normalizeModel(model) {
  const sortedList = (list) => [...(list ?? [])].sort(compareStrings);
  const sortedLists = (section) =>
    Object.fromEntries(Object.keys(section).sort(compareStrings).map((k) => [k, sortedList(section[k])]));
  const config = { ...model.config };
  for (const section of ['hub', 'hidden', 'ignore_missing']) {
    if (config[section]) config[section] = sortedLists(config[section]);
  }
  if (config.profiles) {
    config.profiles = Object.fromEntries(
      Object.keys(config.profiles)
        .sort(compareStrings)
        .map((name) => {
          const p = config.profiles[name];
          return [name, { ...p, ...(p.drop_notes ? { drop_notes: sortedList(p.drop_notes) } : {}), ...(p.hide ? { hide: sortedLists(p.hide) } : {}) }];
        }),
    );
  }
  if (config.sources) config.sources = [...config.sources].sort((a, b) => compareStrings(a.name, b.name));
  return {
    config,
    databases: [...model.databases]
      .map((db) => (db.tenant_schemas ? { ...db, tenant_schemas: [...db.tenant_schemas].sort((a, b) => compareStrings(a.schema, b.schema)) } : db))
      .sort((a, b) => compareStrings(a.database, b.database)),
    // STI subclasses, partition and index columns keep authored order:
    // it is the class hierarchy and the index column order.
    tables: [...model.tables]
      .map(withIndexes)
      .map((t) => ({
        ...t,
        ...(t.sources ? { sources: sortedList(t.sources) } : {}),
        ...(t.indexes ? { indexes: [...t.indexes].sort((a, b) => compareStrings(indexKey(a), indexKey(b))) } : {}),
      }))
      .sort((a, b) => compareStrings(a.id, b.id)),
    relations: model.relations
      .map((r) => ({ ...r, evidence: sortedList(r.evidence) }))
      .sort((a, b) => compareStrings(relationKey(a), relationKey(b))),
    polymorphic: (model.polymorphic ?? [])
      .map((a) => ({ ...a, targets: sortedList(a.targets), evidence: sortedList(a.evidence) }))
      .sort((a, b) => compareStrings(a.table, b.table) || compareStrings(a.name, b.name)),
  };
}

/** `<table id>.<column path>` split into the table id and the path. */
export function splitColumnRef(ref) {
  const parts = ref.split('.');
  return [parts.slice(0, 3).join('.'), parts.slice(3).join('.')];
}

export function formatError(e) {
  return `${e.file}: ${e.path}: ${e.message}`;
}
