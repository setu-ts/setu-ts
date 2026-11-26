import { describe, expect, it, vi } from 'vitest';
import type { IMessageBroker, ISubscription } from '@setu-ts/common';
import { MessagingBackplane } from '../../src/transports/messaging-backplane.ts';

describe('Messaging backplane close during connect', () => {
  it('rejects connect immediately and retires a late subscription', async () => {
    const gate = Promise.withResolvers<ISubscription>();
    const broker: IMessageBroker = {
      connect: async () => {},
      disconnect: async () => {},
      publish: async () => {},
      subscribe: () => gate.promise,
      request: () => Promise.resolve(undefined as never),
      respond: () => Promise.resolve({ unsubscribe: async () => {} }),
    };
    const backplane = new MessagingBackplane(broker, 'origin', 'frames');
    const result = backplane.connect().catch((error: unknown) => error);
    await Promise.resolve();
    await backplane.close();
    expect(await result).toMatchObject({ message: 'Messaging backplane closed while connecting' });
    const unsubscribe = vi.fn(async () => {});
    gate.resolve({ fanOut: true, unsubscribe });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
