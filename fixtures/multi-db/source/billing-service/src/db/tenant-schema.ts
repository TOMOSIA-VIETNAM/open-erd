import { DataSource, EntityManager } from 'typeorm';

// Every tenant owns one Postgres schema named tenant_<slug>. Entities without an
// explicit `schema` resolve through search_path, so the same tables exist once
// per tenant. Shared tables (plans, tenants) live in `public`.
export function tenantSchemaName(slug: string): string {
  return `tenant_${slug.replace(/[^a-z0-9_]/g, '_')}`;
}

export async function withTenant<T>(
  dataSource: DataSource,
  slug: string,
  work: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  return dataSource.transaction(async (manager) => {
    await manager.query(`SET LOCAL search_path TO ${tenantSchemaName(slug)}, public`);
    return work(manager);
  });
}
