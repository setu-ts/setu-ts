import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRedisBackplaneClient } from '../../../src/interfaces/index.ts';
import { RedisBackplane } from '../../../src/transports/redis-backplane.ts';

interface FakeRedisOpts {
  status?: string;
  pingOk?: boolean;
}

/**
 * A minimal ioredis-shaped client with a configurable liveness surface.
 */
function makeClient(opts: FakeRedisOpts = {}): IRedisBackplaneClient {
  const client: Record<string, unknown> = {
    publish: () => Promise.resolve(0),
    subscribe: () => Promise.resolve(0),
    unsubscribe: () => Promise.resolve(0),
    on: () => {},
    off: () => {},
    quit: () => Promise.resolve('OK'),
  };
  if (opts.status !== undefined) {
    client.status = opts.status;
  }
  if (opts.pingOk !== undefined) {
    client.ping = opts.pingOk
      ? () => Promise.resolve('PONG')
      : () => Promise.reject(new Error('no route to host'));
  }
  return client as unknown as IRedisBackplaneClient;
}

/**
 * An ioredis-shaped client whose `ping` is a method reading `this.options`,
 * exactly like the real ioredis. An unbound call throws
 * `TypeError: Cannot read properties of undefined (reading 'options')` — the
 * M70c defect that made the probe report `false` forever against a healthy
 * server.
 */
function makeIoredisShapedClient(): IRedisBackplaneClient {
  const client = {
    status: 'ready',
    options: { lazyConnect: false },
    publish: () => Promise.resolve(0),
    subscribe: () => Promise.resolve(0),
    unsubscribe: () => Promise.resolve(0),
    on: () => {},
    off: () => {},
    quit: () => Promise.resolve('OK'),
    ping() {
      // Unbound (`this === undefined` in strict mode) → TypeError, as ioredis does.
      void this.options;
      return Promise.resolve('PONG');
    },
  };
  return client as unknown as IRedisBackplaneClient;
}

function makeBackplane(publisher: IRedisBackplaneClient, subscriber: IRedisBackplaneClient) {
  return new RedisBackplane(
    { transport: 'redis', client: publisher, subscriber },
    'origin-a',
    'topic',
  );
}

describe('RedisBackplane health (M70c)', () => {
  it('is reachable when both connections are ready and ping', async () => {
    const backplane = makeBackplane(
      makeClient({ status: 'ready', pingOk: true }),
      makeClient({ status: 'ready', pingOk: true }),
    );
    await backplane.connect();
    const probe = backplane.isHealthy;
    expect(typeof probe).toBe('function');
    if (typeof probe === 'function') {
      expect(await probe()).toBe(true);
    }
    await backplane.close();
  });

  it('is unreachable when a healthy publisher sits beside a dead subscriber', async () => {
    // The M47 two-connection property: the pair is checked separately, so one
    // dead half makes the whole backplane unreachable.
    const backplane = makeBackplane(
      makeClient({ status: 'ready', pingOk: true }),
      makeClient({ status: 'end', pingOk: false }),
    );
    await backplane.connect();
    const probe = backplane.isHealthy;
    expect(typeof probe).toBe('function');
    if (typeof probe === 'function') {
      expect(await probe()).toBe(false);
    }
    await backplane.close();
  });

  it('M70c regression: an ioredis-shaped `ping` that reads `this` still reports reachable', async () => {
    // ioredis `ping` reads `this.options`; an unbound call throws TypeError and
    // the probe would report `false` forever against a healthy server.
    const backplane = makeBackplane(makeIoredisShapedClient(), makeIoredisShapedClient());
    await backplane.connect();
    const probe = backplane.isHealthy;
    expect(typeof probe).toBe('function');
    if (typeof probe === 'function') {
      expect(await probe()).toBe(true);
    }
    await backplane.close();
  });

  it('reports unknown (absent isHealthy) when the clients lack the surface', async () => {
    const backplane = makeBackplane(makeClient(), makeClient());
    await backplane.connect();
    // A minimal injected fake has not told us the backend is dead: absence,
    // not false, keeps /ready from failing on upgrade.
    expect(backplane.isHealthy).toBeUndefined();
    await backplane.close();
  });

  it('reports unknown after close', async () => {
    const backplane = makeBackplane(
      makeClient({ status: 'ready', pingOk: true }),
      makeClient({ status: 'ready', pingOk: true }),
    );
    await backplane.connect();
    expect(typeof backplane.isHealthy).toBe('function');
    await backplane.close();
    expect(backplane.isHealthy).toBeUndefined();
  });
});
