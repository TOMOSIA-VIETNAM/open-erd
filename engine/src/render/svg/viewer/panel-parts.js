// What the side panel of a table shows, as plain data so it can be tested
// without a browser: the small chips after a column's name and the tabs of
// the panel.

/**
 * Chips after a column's name, in this order: `NULL` when the column may be
 * empty (nothing when it may not: the absence is the common case), the
 * default value (`= draft`), the generated expression, the number of enum
 * values (expands to the list on click), PII. Each { kind, text, title }.
 */
export function columnBadges(c) {
  const values = Object.keys(c.enum ?? {}).length;
  return [
    c.nullable === true ? { kind: 'null', text: 'NULL', title: 'May be empty (nullable)' } : null,
    c.default !== undefined ? { kind: 'default', text: `= ${c.default}`, title: `Default value: ${c.default}` } : null,
    c.default === undefined && c.autoIncrement ? { kind: 'default', text: '= auto', title: 'Numbered by the database on insert' } : null,
    c.generated !== undefined ? { kind: 'generated', text: 'generated', title: `Generated as ${c.generated}` } : null,
    values > 0 ? { kind: 'enum', text: `${values} ${values === 1 ? 'value' : 'values'}`, title: 'Listed values and their meaning: click to show' } : null,
    c.pii ? { kind: 'pii', text: 'PII', title: 'Personal data' } : null,
  ].filter(Boolean);
}

/**
 * Tabs of a table's panel: Columns, Relations, Indexes with their counts,
 * empty ones left out. `relations` is the number of relation entries the
 * Relations tab lists.
 */
export function panelTabs(node, relations) {
  return [
    { id: 'columns', label: 'Columns', count: node.columns.length },
    { id: 'relations', label: 'Relations', count: relations },
    { id: 'indexes', label: 'Indexes', count: node.indexes?.length ?? 0 },
  ].filter((t) => t.count > 0);
}
