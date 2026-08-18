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

  it('M70c regression: installs the connection fault listener before createChannel()', async () => {
    // A real backend can reset the socket while the channel is being created
    // (right after a restart, the port is open before the AMQP handshake is
    // ready). The connection `'error'` listener must therefore be installed
    // BEFORE `createChannel()`; otherwise the reset is an unhandled `'error'`
    // event that crashes the host process — a defect a fake can only model by
    // asserting the ordering directly.
    const flags = { errorListenerAttached: false };
    let observedBeforeCreateChannel: boolean | undefined;
    const channel = {
      close: () => Promise.resolve(),
    } as unknown as IAmqpQueueChannel;
    const connectionObj: Record<string, unknown> = {
      createChannel: () => {
        observedBeforeCreateChannel = flags.errorListenerAttached;
        return Promise.resolve(channel);
      },
      close: () => Promise.resolve(),
      on: (event: string): void => {
        if (event === 'error') flags.errorListenerAttached = true;
      },
    };
    const queue = new RabbitMqQueue(new FakeRuntimeServices(), {
      client: connectionObj as unknown as IAmqpQueueConnection,
    });
    await queue.connect();
    expect(observedBeforeCreateChannel).toBe(true);
  });

  it('M70c regression: disconnect() does not throw after the channel already closed', async () => {
    // After a real backend outage amqplib has already torn the channel and
    // connection down, so `close()` on each throws `IllegalOperationError`.
    // `disconnect()` must swallow both and still clear the lifecycle.
    const channel = {
      close: () => Promise.reject(new Error('Channel closed')),
    } as unknown as IAmqpQueueChannel;
    const connectionObj: Record<string, unknown> = {
      createChannel: () => Promise.resolve(channel),
      close: () => Promise.reject(new Error('Connection closed')),
      on: (): void => {},
    };
    const queue = new RabbitMqQueue(new FakeRuntimeServices(), {
      client: connectionObj as unknown as IAmqpQueueConnection,
    });
    await queue.connect();
    await queue.disconnect();
    expect(queue.isReady()).toBe(false);
    expect(queue.isHealthy).toBeUndefined();
  });
});
