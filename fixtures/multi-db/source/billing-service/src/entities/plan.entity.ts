import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export enum BillingInterval {
  Monthly = 'monthly',
  Yearly = 'yearly',
}

@Entity({ name: 'plans', schema: 'public' })
export class Plan {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 40, unique: true })
  code: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ name: 'price_cents', type: 'integer' })
  priceCents: number;

  @Column({ type: 'enum', enum: BillingInterval, enumName: 'billing_interval' })
  interval: BillingInterval;
}
