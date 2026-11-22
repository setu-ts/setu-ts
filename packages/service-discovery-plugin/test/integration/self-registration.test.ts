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
import { describe, expect, it } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES, describeError } from '@setu-ts/common';
import type { ILogger } from '@setu-ts/common';

import { ServiceDiscoveryPlugin } from '../../src/index.ts';
import { createFakeHttp, type FakeHttp } from '../fixtures/fakes.ts';

const SELF = { serviceName: 'orders', id: 'orders-1', address: '10.0.0.7', port: 3000 };

it('replaces a crashed process registration across two application starts on one agent', async () => {
  const entries = new Map<string, unknown>();
  const http = {
    ...createFakeHttp(),
    request: (_url: string, init?: RequestInit) => {
      if (init?.body !== undefined) {
        const body = JSON.parse(String(init.body)) as { ID: string };
        entries.set(body.ID, body);
      }
      // Retain the entry to model a previous process that died before deregistering.
      return Promise.resolve({ ok: true, status: 200, headers: new Headers(), text: '' });
    },
  };
  for (let n = 0; n < 2; n++) {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        ServiceDiscoveryPlugin({
          provider: 'consul',
          address: 'http://consul.test',
          http,
          selfRegistration: { serviceName: 'orders', address: '10.0.0.7', port: 3000 },
        }),
      ],
    });
    await app.start();
    await app.stop();
  }
  expect([...entries.keys()]).toEqual(['orders-10.0.0.7-3000']);
});

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
  it('V12-57 masks URL credentials in deregistration warnings', async () => {
    const error = new Error('failed http://user:pass@consul:8500/x');
    const http = createFakeHttp([{ text: '' }, { error }]);
    const warnings: Array<{ message: string; meta: unknown }> = [];
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        FakeLoggerPlugin((message, meta) => warnings.push({ message, meta })),
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
    const warning = warnings.find((w) => w.message === 'service-discovery: deregistration failed');
    expect(warning?.meta).toEqual({ error: describeError(error) });
    expect(JSON.stringify(warning)).not.toContain('pass');
  });
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
function FakeLoggerPlugin(onWarn: (message: string, meta?: unknown) => void) {
  const logger: ILogger = {
    level: 'info',
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: (message: string, meta) => onWarn(message, meta),
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

describe('a Consul address with credentials (V12-52)', () => {
  it('fails start() with a fixed message and sends nothing', async () => {
    const http = createFakeHttp([{ text: '' }]);
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        ServiceDiscoveryPlugin({
          provider: 'consul',
          address: 'http://ops:canary-pw-52@consul:8500',
          http,
          selfRegistration: SELF,
        }),
      ],
    });

    let caught: unknown;
    try {
      await app.start();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const chain: string[] = [];
    for (let link: unknown = caught; link instanceof Error; link = link.cause) {
      chain.push(String(link), link.message, link.stack ?? '');
    }
    expect(chain.join('\n')).toContain(
      'The Consul address must be an absolute URL without credentials',
    );
    expect(chain.join('\n')).not.toContain('canary');
    expect(http.calls).toHaveLength(0);
  });
});
