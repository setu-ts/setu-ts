import { z } from 'zod';
import { defineIntegrationEvent, onIntegrationEvent } from '@setu-ts/messaging-plugin';
import type { IOutbox, SubscriptionEntry } from '@setu-ts/messaging-plugin';
import type { IDatabaseService, IUnitOfWork } from '@setu-ts/database-plugin';

/** Billing input, with no prompt or completion content. */
export const usageSchema = z.object({
  id: z.string(),
  occurredAt: z.string(),
  tenantId: z.string(),
  principalId: z.string().optional(),
  provider: z.string(),
  model: z.string(),
  usageKnown: z.boolean(),
  inputTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  reasoningTokens: z.number().optional(),
  settledAmount: z.number(),
});
/** One provider call, identified before the provider is invoked. */
export type UsageRecord = z.infer<typeof usageSchema>;
/** Versioned usage event; the producer id is also its deduplication id. */
export const usageRecorded = defineIntegrationEvent({
  type: 'ai.usage-recorded',
  version: 1,
  topic: 'ai.usage-recorded.v1',
  parse: (value) => usageSchema.parse(value),
});

/** Writes a record transactionally to the outbox. @returns The stored envelope id */
export function writeUsage(
  db: IDatabaseService,
  outbox: IOutbox,
  record: UsageRecord,
): Promise<string> {
  return db.transaction((uow) =>
    outbox.write(uow, usageRecorded, record, { options: { deduplicationId: record.id } }),
  );
}

/** The inbox and billing write share the consumer's transaction. @returns Subscription wiring */
export function billingSubscription(): SubscriptionEntry {
  return onIntegrationEvent(
    usageRecorded,
    async (record, _envelope, _metadata, uow: IUnitOfWork) => {
      await uow.getRepository<UsageRecord>('Usage').create(record);
    },
    { inbox: { consumer: 'billing' } },
  );
}
