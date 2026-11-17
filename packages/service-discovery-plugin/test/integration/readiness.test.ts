import { describe, expect, it } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { HealthPlugin } from '@setu-ts/health-plugin';
import type { HealthReport } from '@setu-ts/common';
import { ServiceDiscoveryPlugin } from '../../src/index.ts';
import { createFakeHttp, createFakeRuntime } from '../fixtures/fakes.ts';
import {
  loggerPlugin,
  RecordingLogger,
} from '../../../common/test/fixtures/redis-connection-errors.ts';

it('Kubernetes discovery keeps /ready 200 when its real provider probe succeeds', async () => {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      HealthPlugin({ details: true }),
      ServiceDiscoveryPlugin({
        provider: 'kubernetes',
        namespace: 'default',
        apiServer: 'https://kube.test',
        token: 'test-token',
        http: {
          request: () =>
            Promise.resolve({ ok: true, status: 200, headers: new Headers(), text: '{}' }),
          stream: () => Promise.reject(new Error('unused stream')),
        },
      }),
    ],
  });
  await app.start();
  try {
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json<HealthReport>().checks['service-discovery']).toMatchObject({
      status: 'up',
      data: { reachable: true },
    });
  } finally {
    await app.stop();
  }
});

describe.each(['consul', 'kubernetes'] as const)('%s discovery readiness probe budget', (kind) => {
  it('coalesces 50 concurrent /ready requests and re-probes after the 5 s TTL', async () => {
    const runtime = createFakeRuntime();
    const http = createFakeHttp([{ text: '{}' }]);
    const app = createApplication({
      plugins: [
        RuntimePlugin({ platform: 'node', adapters: { node: () => runtime } }),
        HealthPlugin({ details: true }),
        ServiceDiscoveryPlugin(
          kind === 'consul'
            ? { provider: 'consul', address: 'https://consul.test', http }
            : {
                provider: 'kubernetes',
                namespace: 'default',
                apiServer: 'https://kube.test',
                token: 'test-token',
                http,
              },
        ),
      ],
    });
    await app.start();
    try {
      const responses = await Promise.all(
        Array.from({ length: 50 }, () => app.inject({ method: 'GET', url: '/ready' })),
      );
      for (const response of responses) {
        expect(response.statusCode).toBe(200);
        expect(response.json<HealthReport>().checks['service-discovery']).toMatchObject({
          status: 'up',
          data: { reachable: true },
        });
      }
      expect(http.calls).toHaveLength(1);
      runtime.advance(4999);
      expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
      expect(http.calls).toHaveLength(1);
      runtime.advance(1);
      expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
      expect(http.calls).toHaveLength(2);
    } finally {
      await app.stop();
    }
  });
});

describe('M139f X10-3: a failing readiness probe logs its reason', () => {
  it('logs one warn naming the TLS cause, repeats at debug, and the recovery at info', async () => {
    const runtime = createFakeRuntime();
    const logger = new RecordingLogger();
    const tls = new TypeError('fetch failed', {
      cause: new Error('invalid peer certificate: UnknownIssuer'),
    });
    const http = createFakeHttp([{ error: tls }, { error: tls }, { error: tls }, { text: '{}' }]);
    const app = createApplication({
      plugins: [
        RuntimePlugin({ platform: 'node', adapters: { node: () => runtime } }),
        loggerPlugin(logger),
        HealthPlugin(),
        ServiceDiscoveryPlugin({
          provider: 'kubernetes',
          namespace: 'default',
          apiServer: 'https://kube.test',
          token: 'test-token',
          http,
        }),
      ],
    });
    await app.start();
    try {
      // Three failing probes, one per 5 s cache window: the pod is not ready,
      // and nothing else (no application request) carries the cause.
      for (let probe = 0; probe < 3; probe++) {
        expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(503);
        runtime.advance(5000);
      }
      expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
      const entries = logger.forSource('service-discovery-plugin: kubernetes');
      expect(entries.map((entry) => entry.level)).toEqual(['warn', 'debug', 'debug', 'info']);
      expect(entries[0]?.message).toContain('UnknownIssuer');
    } finally {
      await app.stop();
    }
  });
});
