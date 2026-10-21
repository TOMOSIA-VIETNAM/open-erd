import { EntityManager } from 'typeorm';
import { Subscription } from '../entities/subscription.entity';
import { UsageEvent } from '../entities/usage-event.entity';

// usage_events.subscription_id has no relation decorator and no FK; the link
// to subscriptions exists only in this lookup.
export async function recordUsage(
  manager: EntityManager,
  event: { id: string; subscriptionId: string; metric: string; quantity: number; occurredAt: Date },
): Promise<void> {
  const subscription = await manager.findOneBy(Subscription, { id: event.subscriptionId });
  if (!subscription) throw new Error(`unknown subscription ${event.subscriptionId}`);
  await manager.insert(UsageEvent, event);
}

export async function usageForSubscription(manager: EntityManager, subscriptionId: string) {
  return manager.find(UsageEvent, { where: { subscriptionId } });
}
