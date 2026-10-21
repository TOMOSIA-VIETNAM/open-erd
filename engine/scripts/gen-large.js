// Dev-only: writes a synthetic workspace for scale tests. The same preset
// always gives the same files (seeded PRNG, fixed name lists), so timings and
// screenshots of two runs compare the same drawing.
//
// Presets:
//   150     1 PostgreSQL database, 10 domains, 150 tables
//   1000    3 databases (PostgreSQL, MySQL, MongoDB), 40 domains, 1000 tables
//   tenant  schema-per-tenant: shared public schema plus one tenant schema
//           modelled once, declared with 500 tenant copies
// Relation density follows real schemas: about 1.3 foreign keys per table,
// mostly inside the domain, some to a few coupled domains and databases, a few hub
// tables (users, organizations) referenced from many places, one declared
// hub column (created_by, drawn as badges), and polymorphic associations.
//
// Usage: node scripts/gen-large.js <150|1000|tenant> <out dir>
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stringify } from 'yaml';

export const PRESETS = {
  150: { databases: [{ name: 'app', engine: 'postgresql', schema: 'public', domains: 10, tables: 150 }] },
  1000: {
    databases: [
      { name: 'core', engine: 'postgresql', schema: 'public', domains: 18, tables: 480 },
      { name: 'commerce', engine: 'mysql', schema: '_', domains: 14, tables: 340 },
      { name: 'events', engine: 'mongodb', schema: '_', domains: 8, tables: 180 },
    ],
  },
  tenant: {
    databases: [
      { name: 'saas', engine: 'postgresql', schema: 'public', domains: 3, tables: 24 },
      { name: 'saas', engine: 'postgresql', schema: 'tenant', domains: 6, tables: 96, tenants: 500 },
    ],
  },
};

const DOMAINS = [
  'Accounts', 'Billing', 'Catalog', 'Orders', 'Shipping', 'Inventory', 'Payments', 'Support', 'Marketing', 'Analytics',
  'Identity', 'Content', 'Search', 'Messaging', 'Reviews', 'Loyalty', 'Pricing', 'Tax', 'Fulfillment', 'Returns',
  'Suppliers', 'Warehouse', 'Scheduling', 'Projects', 'Documents', 'Compliance', 'Audit', 'Reporting', 'Notifications', 'Integrations',
  'Learning', 'Forums', 'Media', 'Campaigns', 'Contracts', 'Assets', 'Fleet', 'Payroll', 'Recruiting', 'Surveys',
];
const NOUNS = [
  'items', 'entries', 'records', 'events', 'settings', 'profiles', 'requests', 'batches', 'rules', 'versions',
  'snapshots', 'links', 'tags', 'notes', 'groups', 'members', 'plans', 'quotas', 'limits', 'logs',
  'jobs', 'schedules', 'templates', 'attachments', 'comments', 'approvals', 'tokens', 'sessions', 'metrics', 'reports',
];
const TYPES = ['varchar(255)', 'integer', 'bigint', 'boolean', 'timestamp with time zone', 'text', 'numeric(12,2)', 'jsonb', 'date', 'uuid'];
const FIELDS = ['name', 'code', 'status', 'title', 'amount', 'quantity', 'description', 'starts_at', 'ends_at', 'priority', 'locale', 'external_ref', 'payload', 'position', 'is_active'];

// mulberry32: tiny, fast and identical on every platform.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const slug = (s) => s.toLowerCase();

/** Files of preset `name` as { relativePath: yamlText }. */
export function generateFiles(name) {
  const preset = PRESETS[name];
  if (!preset) throw new Error(`unknown preset "${name}" (one of ${Object.keys(PRESETS).join(', ')})`);
  const random = prng(Number.parseInt(name, 36));
  const pick = (list) => list[Math.floor(random() * list.length)];

  // Tables per database file; a tenant schema shares its file with public.
  const files = new Map();
  const all = [];
  let domainOffset = 0;
  for (const db of preset.databases) {
    if (!files.has(db.name)) {
      files.set(db.name, { schema_version: 1, database: db.name, engine: db.engine, tables: [], relations: [], polymorphic: [] });
    }
    const file = files.get(db.name);
    if (db.tenants) file.tenant_schemas = [{ schema: db.schema, count: db.tenants, note: 'One schema per customer company.' }];
    const domains = DOMAINS.slice(domainOffset, domainOffset + db.domains);
    domainOffset += db.domains;
    for (let i = 0; i < db.tables; i++) {
      // Domains get uneven sizes, as real ones do: the first ones are larger.
      const domain = domains[Math.min(domains.length - 1, Math.floor(domains.length * random() ** 1.3))];
      const id = `${db.name}.${db.schema}.${slug(domain)}_${NOUNS[i % NOUNS.length]}_${i}`;
      const columns = [{ name: 'id', type: 'bigint', pk: true }];
      const extra = 3 + Math.floor(random() * 10);
      for (let c = 0; c < extra; c++) columns.push({ name: `${FIELDS[(i + c) % FIELDS.length]}${c >= FIELDS.length ? c : ''}`, type: pick(TYPES) });
      columns.push({ name: 'created_by', type: 'bigint', nullable: true });
      const t = { id, domain, columns, db: db.name, schema: db.schema, engine: db.engine };
      file.tables.push(t);
      all.push(t);
    }
  }

  // Hub tables: the first table of the first database is "users" (declared a
  // hub column target), the second "organizations" (referenced from many
  // domains, not declared, so it draws lines and stresses the router).
  const [users, organizations] = all;
  users.id = users.id.replace(/[^.]+$/, 'users');
  organizations.id = organizations.id.replace(/[^.]+$/, 'organizations');

  const crossDb = [];
  const relation = (from, column, to, kind) => ({
    from: { table: from.id, columns: [column] },
    to: { table: to.id, columns: ['id'] },
    cardinality: 'n-1',
    optional: random() < 0.4,
    kind,
    evidence: [kind === 'db_fk' ? 'db' : `app:src/models/${from.id.split('.')[2]}.ts`],
    review: random() < 0.8 ? 'reviewed' : 'pending',
  });
  const byDomain = new Map();
  for (const t of all) {
    const key = `${t.db}/${t.domain}`;
    if (!byDomain.has(key)) byDomain.set(key, []);
    byDomain.get(key).push(t);
  }
  // Domains are coupled to a few others, not to all of them: each one
  // references the two core domains of its database (accounts, catalog...)
  // and its neighbour in name order; other databases are reached through
  // their first core domain.
  const keysOf = (db) => [...byDomain.keys()].filter((k) => k.startsWith(`${db}/`)).sort();
  const coupled = (t) => {
    const keys = keysOf(t.db);
    const own = `${t.db}/${t.domain}`;
    const next = keys[(keys.indexOf(own) + 1) % keys.length];
    return [...new Set([...keys.slice(0, 2), next])].filter((k) => k !== own).flatMap((k) => byDomain.get(k));
  };
  const remote = (t) => [...files.keys()].filter((db) => db !== t.db).flatMap((db) => keysOf(db).slice(0, 1).flatMap((k) => byDomain.get(k)));
  for (const [index, t] of all.entries()) {
    if (t !== users) files.get(t.db).relations.push(relation(t, 'created_by', users, users.db === t.db ? 'db_fk' : 'cross_db'));
    if (index < 2) continue;
    // About 1.3 drawn foreign keys per table: 0, 1, 2 or 3.
    const r = random();
    const count = r < 0.15 ? 0 : r < 0.6 ? 1 : r < 0.9 ? 2 : 3;
    const seen = new Set();
    for (let k = 0; k < count; k++) {
      const roll = random();
      const same = byDomain.get(`${t.db}/${t.domain}`).filter((o) => o !== t);
      let target;
      if (roll < 0.06) target = organizations;
      else if (roll < 0.72 && same.length > 0) target = pick(same);
      else if ((roll < 0.97 || files.size === 1) && coupled(t).length > 0) target = pick(coupled(t));
      else if (files.size > 1) target = pick(remote(t));
      else continue;
      if (seen.has(target.id)) continue;
      seen.add(target.id);
      const column = `${target.id.split('.')[2]}_id`;
      t.columns.push({ name: column, type: 'bigint', nullable: true });
      const kind = target.db !== t.db ? 'cross_db' : t.engine === 'mongodb' ? 'inferred' : random() < 0.85 ? 'db_fk' : 'declared';
      const rel = relation(t, column, target, kind);
      if (target.db === t.db) files.get(t.db).relations.push(rel);
      else crossDb.push(rel);
    }
    // One polymorphic association per ~50 tables, targeting 2-4 tables of the
    // same database.
    if (index % 50 === 7) {
      const local = all.filter((o) => o.db === t.db && o !== t);
      const targets = [...new Set(Array.from({ length: 2 + Math.floor(random() * 3) }, () => pick(local).id))];
      t.columns.push({ name: 'subject_type', type: 'varchar(64)' }, { name: 'subject_id', type: 'bigint' });
      files.get(t.db).polymorphic.push({
        name: 'subject',
        table: t.id,
        type_column: 'subject_type',
        id_column: 'subject_id',
        optional: false,
        targets,
        evidence: [`app:src/models/${t.id.split('.')[2]}.ts`],
        review: 'reviewed',
      });
    }
  }

  const out = {
    'open-erd.yaml': stringify({ schema_version: 1, sources: [{ name: 'app' }], hub: { columns: ['created_by'] } }),
  };
  for (const [db, file] of files) {
    const tables = file.tables.map(({ id, domain, columns }) => ({ id, domain, columns }));
    out[`model/${db}.yaml`] = stringify({ ...file, tables });
  }
  if (crossDb.length > 0) out['model/cross-db.yaml'] = stringify({ schema_version: 1, relations: crossDb });
  return out;
}

/** Writes preset `name` into `dir` (created if needed). */
export async function generateWorkspace(name, dir) {
  await mkdir(join(dir, 'model'), { recursive: true });
  for (const [path, text] of Object.entries(generateFiles(name))) await writeFile(join(dir, path), text);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [name, dir] = process.argv.slice(2);
  if (!name || !dir) {
    console.error('Usage: node scripts/gen-large.js <150|1000|tenant> <out dir>');
    process.exit(1);
  }
  await generateWorkspace(name, dir);
  console.log(`wrote preset ${name} to ${dir}`);
}
