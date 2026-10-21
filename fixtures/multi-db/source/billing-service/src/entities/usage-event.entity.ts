import { Column, Entity, PrimaryColumn } from 'typeorm';

// Partitioned by month on occurred_at (see migrations/1700000000100-TenantSchema.ts).
// The partition key must be part of the primary key.
@Entity({ name: 'usage_events' })
export class UsageEvent {
  @PrimaryColumn({ type: 'bigint' })
  id: string;

  @PrimaryColumn({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt: Date;

  @Column({ name: 'subscription_id', type: 'uuid' })
  subscriptionId: string;

  @Column({ type: 'varchar', length: 60 })
  metric: string;

  @Column({ type: 'integer' })
  quantity: number;
}
