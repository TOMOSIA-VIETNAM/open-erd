// The personal data map: which columns are marked `pii`, counted per domain
// and table for the summary panel. Pure functions over the embedded data,
// so the counts and their order are tested without a browser.

const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Columns marked `pii`, grouped by domain (cluster key) then table:
 * { total, tables, domains: [{ cluster, count, tables: [{ id, columns }] }] }.
 * Domains and tables with more such columns come first, ties by key; a
 * table's columns stay in model order. Domains and tables without any are
 * left out. `nodes` is the viewer data's `nodes`.
 */
export function piiSummary(nodes) {
  const domains = new Map();
  for (const [id, n] of Object.entries(nodes)) {
    if (n.kind !== 'table') continue;
    const columns = n.columns.filter((c) => c.pii).map((c) => c.name);
    if (columns.length === 0) continue;
    if (!domains.has(n.cluster)) domains.set(n.cluster, []);
    domains.get(n.cluster).push({ id, columns });
  }
  const count = (tables) => tables.reduce((sum, t) => sum + t.columns.length, 0);
  const list = [...domains]
    .map(([cluster, tables]) => ({ cluster, count: count(tables), tables: tables.sort((a, b) => b.columns.length - a.columns.length || byKey(a.id, b.id)) }))
    .sort((a, b) => b.count - a.count || byKey(a.cluster, b.cluster));
  return { total: count(list.flatMap((d) => d.tables)), tables: list.reduce((n, d) => n + d.tables.length, 0), domains: list };
}
