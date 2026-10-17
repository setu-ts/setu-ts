import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type { HealthReport, HealthStatus, IHealthService } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { HealthPlugin } from '../../src/index.ts';
import type { HealthPluginOptions } from '../../src/index.ts';

describe('public health details', () => {
  for (const details of [undefined, false, true]) {
    for (const state of ['up', 'degraded', 'down'] as const) {
      it(`projects HTTP only (details=${details}, state=${state})`, async () => {
        const app = createApplication({
          plugins: [
            RuntimePlugin(),
            HealthPlugin({
              ...(details === undefined ? {} : { details }),
              indicators: [
                {
                  name: 'backend',
                  check: () =>
                    Promise.resolve({
                      status: state as HealthStatus,
                      data: { version: 'private-version', hostname: 'private-host' },
                    }),
                },
              ],
            }),
          ],
        });
        await app.start();
        try {
          const full = await app.services.get<IHealthService>(CAPABILITIES.HEALTH).check();
          expect(full.checks.self?.data).toHaveProperty('hostname');
          expect(full.checks.backend?.data).toHaveProperty('version');
          for (const path of ['/health', '/live', '/ready']) {
            const res = await app.inject({ method: 'GET', url: path });
            expect(res.statusCode).toBe(
              path === '/live'
                ? 200
                : path === '/ready'
                  ? state === 'up'
                    ? 200
                    : 503
                  : state === 'down'
                    ? 503
                    : 200,
            );
            const body = res.json<HealthReport>();
            expect(Object.keys(body).sort()).toEqual(['checks', 'status', 'timestamp']);
            expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
            for (const check of Object.values(body.checks)) {
              if (details) {
                expect(check).toHaveProperty('data');
                expect(check).toHaveProperty('latencyMs');
              } else expect(Object.keys(check)).toEqual(['status']);
            }
            if (!details) {
              expect(res.body).not.toContain('hostname');
              expect(res.body).not.toContain('version');
              expect(res.body).not.toContain('latencyMs');
            }
          }
        } finally {
          await app.stop();
        }
      });
    }
  }
  it('refuses non-boolean details at construction', () => {
    for (const details of [null, 0, 'true', {}, []]) {
      expect(() => HealthPlugin({ details } as unknown as HealthPluginOptions)).toThrow(TypeError);
    }
  });
});
