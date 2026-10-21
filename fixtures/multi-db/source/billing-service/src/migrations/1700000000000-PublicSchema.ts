import { MigrationInterface, QueryRunner } from 'typeorm';

export class PublicSchema1700000000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TYPE public.billing_interval AS ENUM ('monthly', 'yearly')`);
    await q.query(`CREATE TYPE public.tenants_status_enum AS ENUM ('trial', 'active', 'suspended')`);
    await q.query(`
      CREATE TABLE public.plans (
        id serial PRIMARY KEY,
        code varchar(40) NOT NULL UNIQUE,
        name varchar(120) NOT NULL,
        price_cents integer NOT NULL,
        interval public.billing_interval NOT NULL
      )`);
    await q.query(`
      CREATE TABLE public.tenants (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        slug varchar(63) NOT NULL UNIQUE,
        name varchar(200) NOT NULL,
        status public.tenants_status_enum NOT NULL DEFAULT 'trial',
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE public.tenants`);
    await q.query(`DROP TABLE public.plans`);
  }
}
