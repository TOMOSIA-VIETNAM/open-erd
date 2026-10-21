import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { Subscription } from './subscription.entity';

@Entity({ name: 'customers' })
export class Customer {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  email: string;

  @Column({ name: 'company_name', type: 'varchar', length: 200, nullable: true })
  companyName: string | null;

  @Column({ name: 'tax_id', type: 'varchar', length: 40, nullable: true })
  taxId: string | null;

  @OneToMany(() => Subscription, (s) => s.customer)
  subscriptions: Subscription[];
}
