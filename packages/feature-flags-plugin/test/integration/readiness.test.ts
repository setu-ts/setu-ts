import { expect, it } from 'vitest';
import type { HealthReport } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { HealthPlugin } from '@setu-ts/health-plugin';
import { FeatureFlagsPlugin } from '../../src/index.ts';

it('unhealthy flag provider remains visible in /ready at 200', async () => {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      HealthPlugin({ details: true }),
      FeatureFlagsPlugin({
        provider: 'custom',
        options: {
          instance: {
            type: 'custom',
            isEnabled: () => false,
            start: () => Promise.resolve(),
            stop: () => Promise.resolve(),
            status: () => ({ healthy: false, detail: 'last poll failed' }),
          },
        },
      }),
    ],
  });
  await app.start();
  try {
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json<HealthReport>().checks['feature-flags']).toMatchObject({
      status: 'up',
      data: { healthy: false, detail: 'last poll failed' },
    });
  } finally {
    await app.stop();
  }
});
