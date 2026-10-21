import { MigrationInterface, QueryRunner } from 'typeorm';

// Run once per tenant with search_path set to tenant_<slug> (see src/db/tenant-schema.ts).
export class TenantSchema1700000000100 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TYPE subscriptions_state_enum AS ENUM ('trialing', 'active', 'past_due', 'canceled')`);
    await q.query(`CREATE TYPE invoices_status_enum AS ENUM ('draft', 'open', 'paid', 'void')`);
    await q.query(`CREATE TYPE payments_method_enum AS ENUM ('card', 'bank_transfer', 'credit')`);
    await q.query(`
      CREATE TABLE customers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email varchar(255) NOT NULL,
        company_name varchar(200),
        tax_id varchar(40)
      )`);
    await q.query(`
      CREATE TABLE subscriptions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id uuid NOT NULL REFERENCES customers(id),
        plan_id integer NOT NULL REFERENCES public.plans(id),
        state subscriptions_state_enum NOT NULL DEFAULT 'trialing',
        current_period_end timestamptz NOT NULL
      )`);
    await q.query(`
      CREATE TABLE invoices (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id uuid NOT NULL REFERENCES customers(id),
        subscription_id uuid REFERENCES subscriptions(id),
        status invoices_status_enum NOT NULL DEFAULT 'draft',
        total_cents bigint NOT NULL,
        issued_at timestamptz
      )`);
    await q.query(`
      CREATE TABLE invoice_lines (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
        product_id bigint,
        description varchar(255) NOT NULL,
        quantity integer NOT NULL,
        unit_price_cents integer NOT NULL
      )`);
    await q.query(`
      CREATE TABLE payments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        invoice_id uuid NOT NULL REFERENCES invoices(id),
        method payments_method_enum NOT NULL,
        amount_cents bigint NOT NULL,
        gateway_ref varchar(80),
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    // No FK on subscription_id: rows are bulk-loaded from the metering pipeline.
    await q.query(`
      CREATE TABLE usage_events (
        id bigint NOT NULL,
        occurred_at timestamptz NOT NULL,
        subscription_id uuid NOT NULL,
        metric varchar(60) NOT NULL,
        quantity integer NOT NULL,
        PRIMARY KEY (id, occurred_at)
      ) PARTITION BY RANGE (occurred_at)`);
    await q.query(`
      CREATE TABLE usage_events_2026_01 PARTITION OF usage_events
        FOR VALUES FROM ('2026-01-01') TO ('2026-02-01')`);
    await q.query(`
      CREATE TABLE usage_events_2026_02 PARTITION OF usage_events
        FOR VALUES FROM ('2026-02-01') TO ('2026-03-01')`);
  }

  async down(q: QueryRunner): Promise<void> {
    for (const t of ['usage_events', 'payments', 'invoice_lines', 'invoices', 'subscriptions', 'customers']) {
      await q.query(`DROP TABLE ${t}`);
    }
  }
}
