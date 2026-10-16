import { expect, it } from 'vitest';
import type { HealthReport } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { HealthPlugin } from '@setu-ts/health-plugin';
import { WorkerPoolPlugin } from '../../src/index.ts';

it('no worker host remains visible in /ready at 200', async () => {
  const app = createApplication({
    plugins: [
      RuntimePlugin({ platform: 'cloudflare-workers' }),
      HealthPlugin(),
      WorkerPoolPlugin(),
    ],
  });
  await app.start();
  try {
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json<HealthReport>().checks['worker-pool']).toMatchObject({
      status: 'up',
      data: { available: false },
    });
  } finally {
    await app.stop();
  }
});
