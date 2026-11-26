import { describe, expect, it } from 'vitest';
import type { ISubscription, QueueSettlementState, SubscribeOptions } from '../../src/index.ts';

describe('independent delivery and intentional discard contracts', () => {
  it('keeps fanOut optional and records explicit confirmation and discard', async () => {
    const plain: SubscribeOptions = {};
    const independent: SubscribeOptions = { fanOut: true };
    const subscription: ISubscription = { fanOut: true, unsubscribe: () => Promise.resolve() };
    const settlement: QueueSettlementState = 'discarded';
    expect(plain.fanOut).toBeUndefined();
    expect(independent.fanOut).toBe(true);
    expect(subscription.fanOut).toBe(true);
    expect(settlement).toBe('discarded');
    await subscription.unsubscribe();
  });
});
