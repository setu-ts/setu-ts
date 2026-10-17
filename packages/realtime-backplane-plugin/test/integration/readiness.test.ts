import { expect, it } from 'vitest';
import type { HealthReport, IRealtimeBackplane } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { HealthPlugin } from '@setu-ts/health-plugin';
import { RealtimeBackplanePlugin } from '../../src/index.ts';

it('unreachable fan-out remains visible in /ready at 200', async () => {
  const instance: IRealtimeBackplane = {
    origin: 'm113b',
    connect: () => Promise.resolve(),
    close: () => Promise.resolve(),
    publish: () => Promise.resolve(),
    subscribe: () => Promise.resolve(() => {}),
    isHealthy: () => Promise.resolve(false),
  };
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      HealthPlugin({ details: true }),
      RealtimeBackplanePlugin({ transport: 'custom', instance }),
    ],
  });
  await app.start();
  try {
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json<HealthReport>().checks['realtime-backplane']).toMatchObject({
      status: 'up',
      data: { reachable: false },
    });
  } finally {
    await app.stop();
  }
});
