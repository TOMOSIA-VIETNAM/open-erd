import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Customer } from './customer.entity';
import { Plan } from './plan.entity';

export enum SubscriptionState {
  Trialing = 'trialing',
  Active = 'active',
  PastDue = 'past_due',
  Canceled = 'canceled',
}

@Entity({ name: 'subscriptions' })
export class Subscription {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Customer, (c) => c.subscriptions, { nullable: false })
  @JoinColumn({ name: 'customer_id' })
  customer: Customer;

  // Cross-schema FK: tenant schema -> public.plans.
  @ManyToOne(() => Plan, { nullable: false })
  @JoinColumn({ name: 'plan_id' })
  plan: Plan;

  @Column({ type: 'enum', enum: SubscriptionState, default: SubscriptionState.Trialing })
  state: SubscriptionState;

  @Column({ name: 'current_period_end', type: 'timestamptz' })
  currentPeriodEnd: Date;
}
