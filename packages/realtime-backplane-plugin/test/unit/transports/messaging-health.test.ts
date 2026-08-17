import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IMessageBroker } from '@setu-ts/common';
import { MessagingBackplane } from '../../../src/transports/messaging-backplane.ts';

function brokerWith(overrides: Record<string, unknown> = {}): IMessageBroker {
  return {
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    publish: () => Promise.resolve(),
    subscribe: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
    request: () => Promise.resolve(null as never),
    respond: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
    ...overrides,
  };
}

describe('MessagingBackplane health (M70c)', () => {
  it('delegates to the broker isHealthy when present (true)', async () => {
    const backplane = new MessagingBackplane(
      brokerWith({ isHealthy: () => Promise.resolve(true) }),
      'origin-a',
      'topic',
    );
    const probe = backplane.isHealthy;
    expect(typeof probe).toBe('function');
    if (typeof probe === 'function') {
      expect(await probe()).toBe(true);
    }
  });

  it('delegates to the broker isHealthy when present (false)', async () => {
    const backplane = new MessagingBackplane(
      brokerWith({ isHealthy: () => Promise.resolve(false) }),
      'origin-a',
      'topic',
    );
    const probe = backplane.isHealthy;
    expect(typeof probe).toBe('function');
    if (typeof probe === 'function') {
      expect(await probe()).toBe(false);
    }
  });

  it('reports unknown (absent isHealthy) when the broker omits it', () => {
    const backplane = new MessagingBackplane(brokerWith(), 'origin-a', 'topic');
    // Absence — not false — is how a boolean port member expresses unknown:
    // the indicator must not lie and say the broker is down.
    expect(backplane.isHealthy).toBeUndefined();
  });
});
