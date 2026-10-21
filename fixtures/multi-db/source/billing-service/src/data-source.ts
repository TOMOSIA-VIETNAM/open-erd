import { DataSource } from 'typeorm';
import { Plan } from './entities/plan.entity';
import { Tenant } from './entities/tenant.entity';
import { Customer } from './entities/customer.entity';
import { Subscription } from './entities/subscription.entity';
import { Invoice } from './entities/invoice.entity';
import { InvoiceLine } from './entities/invoice-line.entity';
import { Payment } from './entities/payment.entity';
import { UsageEvent } from './entities/usage-event.entity';

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: [Plan, Tenant, Customer, Subscription, Invoice, InvoiceLine, Payment, UsageEvent],
  migrations: ['src/migrations/*.ts'],
  synchronize: false,
});
