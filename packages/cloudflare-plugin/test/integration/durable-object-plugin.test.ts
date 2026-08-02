/**
 * The `durableObject` arm driven through a real kernel application.
 *
 * The token the plugin registers under is the token `websocket-plugin` and
 * `sse-plugin` resolve, so resolving it here through the real registry — rather
 * than asserting `provides` — is what proves the wiring reaches a consumer.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { CAPABILITIES } from '@hono-enterprise/common';
import type {
  HealthCheckResult,
  IApplication,
  ILogger,
  IPlugin,
  IRealtimeBackplane,
} from '@hono-enterprise/common';

import { CloudflareBindingMissingError, CloudflarePlugin } from '../../src/index.ts';
import { FakeDurableObjectNamespace } from '../do-fakes.ts';
import { FakeKv, RecordingLogger } from '../fakes.ts';

/** Runs a named health indicator the way `health-plugin` would. */
async function checkHealth(app: IApplication, name: string): Promise<HealthCheckResult> {
  const indicators = app.services.getAll<{ name: string; check: () => Promise<HealthCheckResult> }>(
    CAPABILITIES.HEALTH_INDICATOR,
  );
  const indicator = indicators.find((entry) => entry.name === name);
  if (indicator === undefined) throw new Error(`no indicator named '${name}'`);
  return await indicator.check();
}

describe('CloudflarePlugin durableObject arm', () => {
  it('registers a backplane a consumer can resolve under the committed token', async () => {
    const namespace = new FakeDurableObjectNamespace('realtime');
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CloudflarePlugin({ env: { REALTIME: namespace }, durableObject: { binding: 'REALTIME' } }),
      ],
    });

    await app.start();

    const backplane = app.services.get<IRealtimeBackplane>(CAPABILITIES.REALTIME_BACKPLANE);
    expect(typeof backplane.publish).toBe('function');
    // The origin must be distinct per replica, and comes from runtime.uuid().
    expect(backplane.origin).toMatch(/[0-9a-f-]{8,}/);
    await app.stop();
  });

  it('registers nothing under the token when the arm is omitted', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), CloudflarePlugin({ env: { REALTIME: {} } })],
    });
    await app.start();

    expect(app.services.has(CAPABILITIES.REALTIME_BACKPLANE)).toBe(false);
    await app.stop();
  });

  it('resolves a named instance under its derived token', async () => {
    const namespace = new FakeDurableObjectNamespace('realtime');
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CloudflarePlugin({
          env: { REALTIME: namespace },
          durableObject: { binding: 'REALTIME', name: 'chat' },
        }),
      ],
    });
    await app.start();

    expect(app.services.has('realtime-backplane.chat')).toBe(true);
    expect(app.services.has(CAPABILITIES.REALTIME_BACKPLANE)).toBe(false);
    await app.stop();
  });

  it('fails at register() when the binding is absent, naming what is present', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CloudflarePlugin({
          env: { CACHE_KV: new FakeKv() },
          durableObject: { binding: 'REALTIME' },
        }),
      ],
    });

    await expect(app.start()).rejects.toThrow(CloudflareBindingMissingError);
  });

  it('fails at register() when the binding is not a Durable Object namespace', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CloudflarePlugin({
          env: { REALTIME: new FakeKv() },
          durableObject: { binding: 'REALTIME' },
        }),
      ],
    });

    await expect(app.start()).rejects.toThrow(/Durable Object namespace/);
  });

  it('reports the arm in the cloudflare health indicator', async () => {
    const namespace = new FakeDurableObjectNamespace('realtime');
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CloudflarePlugin({ env: { REALTIME: namespace }, durableObject: { binding: 'REALTIME' } }),
      ],
    });
    await app.start();

    expect((await checkHealth(app, 'cloudflare')).data?.durableObject).toBe(true);
    await app.stop();
  });

  it('publishes through the real object, and defaults the topic to realtime', async () => {
    const namespace = new FakeDurableObjectNamespace('realtime');
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CloudflarePlugin({ env: { REALTIME: namespace }, durableObject: { binding: 'REALTIME' } }),
      ],
    });
    await app.start();

    const backplane = app.services.get<IRealtimeBackplane>(CAPABILITIES.REALTIME_BACKPLANE);
    await backplane.publish({
      kind: 'ws-room',
      origin: backplane.origin,
      name: 'lobby',
      data: 'hi',
    });

    expect(namespace.requestedNames).toEqual(['realtime']);
    await app.stop();
  });

  it('honors a configured topic, so two applications do not cross-talk', async () => {
    const namespace = new FakeDurableObjectNamespace('realtime');
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CloudflarePlugin({
          env: { REALTIME: namespace },
          durableObject: { binding: 'REALTIME', topic: 'app-one' },
        }),
      ],
    });
    await app.start();

    const backplane = app.services.get<IRealtimeBackplane>(CAPABILITIES.REALTIME_BACKPLANE);
    await backplane.connect();

    expect(namespace.requestedNames).toEqual(['app-one']);
    await app.stop();
  });

  it('closes the backplane on shutdown, so no socket outlives the application', async () => {
    const namespace = new FakeDurableObjectNamespace('realtime');
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CloudflarePlugin({ env: { REALTIME: namespace }, durableObject: { binding: 'REALTIME' } }),
      ],
    });
    await app.start();
    const backplane = app.services.get<IRealtimeBackplane>(CAPABILITIES.REALTIME_BACKPLANE);
    await backplane.connect();
    const state = namespace.states.get('realtime')!;
    expect(state.accepted).toHaveLength(1);

    await app.stop();

    // The replica's half was closed, which the fake propagates to the object's
    // membership — a socket surviving shutdown would leak a live connection.
    expect(state.accepted).toHaveLength(0);
  });

  it('reports a publish failure through a logger registered AFTER register()', async () => {
    // The M52b defect class: capturing `ctx.logger` by value at register() time
    // reads `undefined`, because the kernel answers that until a logger exists.
    // A logger registered imperatively afterwards would then be silenced.
    const namespace = new FakeDurableObjectNamespace('realtime');
    const logger = new RecordingLogger();
    const lateLoggerPlugin: IPlugin = {
      name: 'late-logger',
      version: '0.0.0',
      // No `provides`, and registered after — exactly the ordering edge that
      // `optionalDependencies` cannot see.
      register(ctx) {
        ctx.services.register<ILogger>(CAPABILITIES.LOGGER, logger);
      },
    };
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        CloudflarePlugin({ env: { REALTIME: namespace }, durableObject: { binding: 'REALTIME' } }),
        lateLoggerPlugin,
      ],
    });
    await app.start();

    const backplane = app.services.get<IRealtimeBackplane>(CAPABILITIES.REALTIME_BACKPLANE);
    await backplane.connect();
    // Break the live socket, so the next publish fails on send.
    namespace.clients[0]!.failSend = true;

    await backplane.publish({
      kind: 'ws-room',
      origin: backplane.origin,
      name: 'lobby',
      data: 'hi',
    });

    // Fails without the thunk: `ctx.logger` read at register() is undefined,
    // so this report would vanish and the backplane would fail in silence.
    const warning = logger.records.find((record) => record.level === 'warn');
    expect(warning?.message).toContain('backplane publish failed');
    await app.stop();
  });
});
