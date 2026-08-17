import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IAmqpQueueChannel, IAmqpQueueConnection } from '../../../src/interfaces/index.ts';
import { RabbitMqQueue } from '../../../src/adapters/rabbitmq-queue.ts';
import { FakeRuntimeServices } from '../../fixtures/fake-runtime.ts';

/**
 * A minimal AMQP connection that records `on?` listeners so a test can fire a
 * fault. `withOn` controls whether the connection exposes `on?` at all — a
 * connection without it is *unknown* reachability.
 */
function makeConnection(withOn: boolean): {
  connection: IAmqpQueueConnection;
  fire: (event: string) => void;
} {
  const listeners = new Map<string, Array<(err?: unknown) => void>>();
  const channel = {
    close: () => Promise.resolve(),
  } as unknown as IAmqpQueueChannel;
  const connectionObj: Record<string, unknown> = {
    createChannel: () => Promise.resolve(channel),
    close: () => Promise.resolve(),
  };
  if (withOn) {
    connectionObj.on = (event: string, listener: (err?: unknown) => void): void => {
      const arr = listeners.get(event) ?? [];
      arr.push(listener);
      listeners.set(event, arr);
    };
  }
  const fire = (event: string): void => {
    for (const listener of listeners.get(event) ?? []) {
      listener(new Error(`${event}`));
    }
  };
  return { connection: connectionObj as unknown as IAmqpQueueConnection, fire };
}

describe('RabbitMqQueue health (M70c)', () => {
  it('is reachable while the connection has not faulted', async () => {
    const { connection } = makeConnection(true);
    const queue = new RabbitMqQueue(new FakeRuntimeServices(), { client: connection });
    await queue.connect();
    const probe = queue.isHealthy;
    expect(typeof probe).toBe('function');
    if (typeof probe === 'function') {
      expect(await probe()).toBe(true);
    }
  });

  it('is unreachable once the connection fires a fault event', async () => {
    const { connection, fire } = makeConnection(true);
    const queue = new RabbitMqQueue(new FakeRuntimeServices(), { client: connection });
    await queue.connect();
    const probe = queue.isHealthy;
    expect(typeof probe).toBe('function');
    fire('close');
    if (typeof probe === 'function') {
      expect(await probe()).toBe(false);
    }
    // The 'error' event faults too.
    fire('error');
    if (typeof probe === 'function') {
      expect(await probe()).toBe(false);
    }
  });

  it('reports unknown (absent isHealthy) when the connection has no on?', async () => {
    const { connection } = makeConnection(false);
    const queue = new RabbitMqQueue(new FakeRuntimeServices(), { client: connection });
    await queue.connect();
    expect(queue.isHealthy).toBeUndefined();
  });

  it('reports unknown after disconnect', async () => {
    const { connection } = makeConnection(true);
    const queue = new RabbitMqQueue(new FakeRuntimeServices(), { client: connection });
    await queue.connect();
    expect(typeof queue.isHealthy).toBe('function');
    await queue.disconnect();
    expect(queue.isHealthy).toBeUndefined();
  });
});
