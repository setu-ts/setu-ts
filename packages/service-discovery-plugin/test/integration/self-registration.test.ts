/**
 * Integration tests for Consul self-registration, driven through a real
 * kernel application's start/stop lifecycle.
 *
 * The ordering assertion is the point: deregistration must run BEFORE the
 * application starts refusing requests, which is what the new `onStopping`
 * hook exists for.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES } from '@setu-ts/common';
import type { ILogger } from '@setu-ts/common';

import { ServiceDiscoveryPlugin } from '../../src/index.ts';
import { createFakeHttp, type FakeHttp } from '../fixtures/fakes.ts';

const SELF = { serviceName: 'orders', id: 'orders-1', address: '10.0.0.7', port: 3000 };

function appWith(http: FakeHttp, extra: { drainDelayMs?: number } = {}) {
  return createApplication({
    plugins: [
      RuntimePlugin(),
      ServiceDiscoveryPlugin({
        provider: 'consul',
        address: 'http://consul:8500',
        http,
        selfRegistration: { ...SELF, ...extra },
      }),
    ],
  });
}

describe('Consul self-registration through the application lifecycle', () => {
  it('registers during start() with the mandatory default check', async () => {
    const http = createFakeHttp([{ text: '' }]);
    const app = appWith(http);

    await app.start();

    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].url).toBe('http://consul:8500/v1/agent/service/register');
    const body = JSON.parse(String(http.calls[0].init?.body));
    expect(body.ID).toBe('orders-1');
    expect(body.Check).toEqual({
      HTTP: 'http://10.0.0.7:3000/health',
      Interval: '10s',
      DeregisterCriticalServiceAfter: '60s',
    });

    await app.stop();
  });

  it('deregisters during stop()', async () => {
    const http = createFakeHttp([{ text: '' }, { text: '' }]);
    const app = appWith(http);
    await app.start();

    await app.stop();

    expect(http.calls).toHaveLength(2);
    expect(http.calls[1].url).toBe('http://consul:8500/v1/agent/service/deregister/orders-1');
    expect(http.calls[1].init?.method).toBe('PUT');
  });

  it('deregisters BEFORE the application starts refusing requests', async () => {
    const http = createFakeHttp([{ text: '' }, { text: '' }]);
    const app = appWith(http);
    await app.start();

    const stopping = app.stop();
    // The deregistration is in flight; the application is still serving, so a
    // request arriving now must NOT get the shutting-down 503.
    const during = await app.inject({ method: 'GET', url: 'http://localhost/anything' });
    expect(during.statusCode).not.toBe(503);

    await stopping;
  });

  it('awaits drainDelayMs after deregistering, while still serving', async () => {
    const http = createFakeHttp([{ text: '' }, { text: '' }]);
    const app = appWith(http, { drainDelayMs: 40 });
    await app.start();

    const started = Date.now();
    await app.stop();
    const elapsed = Date.now() - started;

    // Wall-clock is legitimate here: the drain delay is a real sleep the test
    // is measuring, not a monotonic duration the framework computes.
    expect(elapsed).toBeGreaterThanOrEqual(35);
    expect(http.calls).toHaveLength(2);
  });

  it('a rejecting deregistration is logged and still lets stop() resolve', async () => {
    const http = createFakeHttp([{ text: '' }, { status: 500, text: 'boom' }]);
    const warnings: string[] = [];
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        FakeLoggerPlugin((message) => warnings.push(message)),
        ServiceDiscoveryPlugin({
          provider: 'consul',
          address: 'http://consul:8500',
          http,
          selfRegistration: SELF,
        }),
      ],
    });
    await app.start();

    await app.stop();

    expect(warnings.some((w) => w.includes('deregistration failed'))).toBe(true);
  });

  it('skips the drain delay when deregistration failed', async () => {
    const http = createFakeHttp([{ text: '' }, { error: new Error('unreachable') }]);
    const app = appWith(http, { drainDelayMs: 5_000 });
    await app.start();

    const started = Date.now();
    await app.stop();
    // A failed deregistration means there is nothing to propagate, so holding
    // the window open would only delay shutdown for no benefit.
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

/** A logger plugin stand-in that captures warnings. */
function FakeLoggerPlugin(onWarn: (message: string) => void) {
  const logger: ILogger = {
    level: 'info',
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: (message: string) => onWarn(message),
    error: () => {},
    fatal: () => {},
    child: () => logger,
  };
  return {
    name: 'fake-logger',
    version: '0.0.0',
    provides: [CAPABILITIES.LOGGER],
    register(ctx: { services: { register: (t: string, s: object) => void } }): void {
      ctx.services.register(CAPABILITIES.LOGGER, logger);
    },
  };
}
