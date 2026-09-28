/**
 * `RealtimeBackplanePlugin` supplies the Redis transport's connection-error
 * reporter: backed by the application's logger by default, and replaced — not
 * joined — by one the caller configures.
 *
 * A real kernel app over a fake `ioredis` module, so the plugin's own wiring
 * is what runs; the real-server proof is `connection-errors-real.test.ts`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { ConnectionErrorReporter } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { RealtimeBackplanePlugin } from '../../src/index.ts';
import type { IRedisBackplaneClient, IRedisModule } from '../../src/index.ts';
import {
  loggerPlugin,
  RecordingLogger,
} from '../../../common/test/fixtures/redis-connection-errors.ts';

const SOURCE = 'realtime-backplane-plugin: redis transport';

/** Just enough of a connection to open; records lifecycle listeners. */
class FakeClient implements IRedisBackplaneClient {
  readonly listeners = new Map<string, Array<(value: unknown) => void>>();
  publish(): Promise<number> {
    return Promise.resolve(0);
  }
  subscribe(): Promise<unknown> {
    return Promise.resolve(1);
  }
  unsubscribe(): Promise<unknown> {
    return Promise.resolve(0);
  }
  on(event: string, listener: (channel: string, message: string) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener as unknown as (value: unknown) => void);
    this.listeners.set(event, list);
  }
  off(): void {}
  quit(): Promise<unknown> {
    return Promise.resolve('OK');
  }
  emit(event: string, value?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

function fakeModule(): { module: IRedisModule; clients: FakeClient[] } {
  const clients: FakeClient[] = [];
  return {
    clients,
    module: {
      create: (): IRedisBackplaneClient => {
        const client = new FakeClient();
        clients.push(client);
        return client;
      },
    },
  };
}

describe('RealtimeBackplanePlugin: redis connection errors', () => {
  it('reports a built connection error to the application logger by default', async () => {
    const logger = new RecordingLogger();
    const { module, clients } = fakeModule();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        loggerPlugin(logger),
        RealtimeBackplanePlugin({ transport: 'redis', url: 'redis://127.0.0.1:1', module }),
      ],
    });
    await app.start();
    try {
      clients[1].emit('error', new Error('connect ECONNREFUSED'));
      clients[0].emit('error', new Error('connect ECONNREFUSED'));

      expect(logger.forSource(SOURCE).map((entry) => [entry.level, entry.message])).toEqual([
        ['warn', `${SOURCE}: connection error: connect ECONNREFUSED`],
        ['debug', `${SOURCE}: connection error repeated: connect ECONNREFUSED`],
      ]);
    } finally {
      await app.stop();
    }
  });

  it("uses the caller's reporter instead of the logger when one is configured", async () => {
    const logger = new RecordingLogger();
    const reported: unknown[] = [];
    const reporter: ConnectionErrorReporter = {
      report: (error) => reported.push(error),
      recovered: () => {},
    };
    const { module, clients } = fakeModule();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        loggerPlugin(logger),
        RealtimeBackplanePlugin({
          transport: 'redis',
          url: 'redis://127.0.0.1:1',
          module,
          connectionErrorReporter: reporter,
        }),
      ],
    });
    await app.start();
    try {
      const error = new Error('connect ECONNREFUSED');
      clients[0].emit('error', error);

      expect(reported).toEqual([error]);
      expect(logger.forSource(SOURCE)).toEqual([]);
    } finally {
      await app.stop();
    }
  });
});
