# multi-db

Two services, two databases: `billing-service` (TypeORM, PostgreSQL `billing`) and `catalog-service` (Sequelize, MySQL `catalog`). 15 tables.

- Cross-service ids with no FK: `invoice_lines.product_id` -> catalog `products` (via `src/clients/catalog-client.ts#getProduct`) and `stock_reservations.invoice_id` -> billing `invoices` (via `src/clients/billing-client.js#getInvoice`). Both are `cross_db` in `model/cross-db.yaml`.
- Schema-per-tenant: tenant tables have no `schema` in their entity and resolve through `search_path` = `tenant_<slug>` (`src/db/tenant-schema.ts`). Expected models them once under schema `tenant`, declared in `tenant_schemas` (no `count`: the number of tenants is only in the database); `plans`/`tenants` stay in `public`. Cross-schema FK `subscriptions.plan_id` -> `public.plans`.
- Partitioned table: `usage_events` is `PARTITION BY RANGE (occurred_at)` with monthly partitions; expected has one table (composite PK `id, occurred_at`) with `partition: { method: range, columns: [occurred_at], interval: month }`, partitions are not tables.
- `usage_events.subscription_id` has no FK and no relation decorator: `inferred` from `src/services/usage-service.ts#recordUsage`.
- Sequelize `product_images.product_id` has no `references` in the migration, only `belongsTo`: `declared`. Self-reference `categories.parent_id`.
- Enums: TypeORM `type: 'enum'` (TS enums) and Sequelize `ENUM(...)`.
