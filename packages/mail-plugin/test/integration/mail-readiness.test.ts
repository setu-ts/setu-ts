import { describe, expect, it } from 'vitest';
import type { HealthReport } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { HealthPlugin } from '@setu-ts/health-plugin';
import { MailPlugin } from '../../src/index.ts';

describe('mail readiness through the kernel', () => {
  it.each([false, true])(
    'reports an SMTP outage without draining unless included (%s)',
    async (include) => {
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          HealthPlugin({
            details: true,
            ...(include ? { readiness: { include: ['mail'] } } : {}),
          }),
          MailPlugin({
            provider: 'smtp',
            options: {
              transport: {
                sendMail: () => Promise.resolve({}),
                verify: () => Promise.reject(new Error('smtp unavailable')),
              },
            },
          }),
        ],
      });
      await app.start();
      try {
        const ready = await app.inject({ method: 'GET', url: '/ready' });
        expect(ready.statusCode).toBe(include ? 503 : 200);
        expect(Object.keys(ready.json<HealthReport>().checks)).toEqual(include ? ['mail'] : []);
        const health = await app.inject({ method: 'GET', url: '/health' });
        expect(health.statusCode).toBe(503);
        expect(health.json<HealthReport>().checks.mail).toMatchObject({
          status: 'down',
          data: { reachable: false },
        });
      } finally {
        await app.stop();
      }
    },
  );
});
