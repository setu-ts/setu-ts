/**
 * HealthPlugin factory-arm integration — driven through a REAL kernel
 * application. A `HealthPlugin` registered BEFORE a provider plugin at
 * `PLUGIN_PRIORITY.NORMAL`: the factory resolves that capability at `onInit`
 * and `GET /health` reports the indicator with data taken from it. This is the
 * test that fails if factory resolution moves back into `register()`.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { HealthReport, IPlugin } from '@setu-ts/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

import { HealthPlugin } from '../../src/index.ts';

/** A provider plugin that registers a capability the factory resolves. */
function databaseProviderPlugin(): IPlugin {
  return {
    name: 'database-provider',
    version: '1.0.0',
    provides: [CAPABILITIES.DATABASE],
    priority: PLUGIN_PRIORITY.NORMAL,
    register(ctx) {
      ctx.services.register(CAPABILITIES.DATABASE, {
        ping: () => Promise.resolve({ ok: true, latencyMs: 3 }),
      });
    },
  };
}

describe('HealthPlugin indicator factories (through the real kernel)', () => {
  it("a factory resolves a later plugin's capability and the indicator carries its data", async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        HealthPlugin({
          indicators: [
            (services) => ({
              name: 'database',
              check: async () => {
                const db = services.get<{
                  ping: () => Promise<{ ok: boolean; latencyMs: number }>;
                }>(CAPABILITIES.DATABASE);
                const result = await db.ping();
                return { status: result.ok ? 'up' : 'down', data: { latencyMs: result.latencyMs } };
              },
            }),
          ],
        }),
        databaseProviderPlugin(),
      ],
    });
    await app.start();
    try {
      const res = await app.inject({ method: 'GET', url: 'http://localhost/health' });
      expect(res.statusCode).toBe(200);
      const report = res.json<HealthReport>();
      // The factory-built indicator is present, and its data came from the
      // capability it resolved — impossible if the factory ran in register().
      expect(report.checks['database']).toBeDefined();
      expect(report.checks['database'].status).toBe('up');
      expect(report.checks['database'].data).toEqual({ latencyMs: 3 });
    } finally {
      await app.stop();
    }
  });
});
