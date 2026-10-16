import { expect, it } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { HealthPlugin } from '@setu-ts/health-plugin';
import type { HealthReport } from '@setu-ts/common';
import { ServiceDiscoveryPlugin } from '../../src/index.ts';

it('Kubernetes discovery keeps /ready 200 when its real provider probe succeeds', async () => {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      HealthPlugin(),
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
