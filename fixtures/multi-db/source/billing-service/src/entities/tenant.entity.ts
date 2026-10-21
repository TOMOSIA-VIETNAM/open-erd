import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export enum TenantStatus {
  Trial = 'trial',
  Active = 'active',
  Suspended = 'suspended',
}

// One row per tenant; `slug` names the tenant's schema (see db/tenant-schema.ts).
@Entity({ name: 'tenants', schema: 'public' })
export class Tenant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 63, unique: true })
  slug: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'enum', enum: TenantStatus, default: TenantStatus.Trial })
  status: TenantStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
