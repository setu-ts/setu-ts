/**
 * HealthPlugin factory-arm integration — driven through a REAL kernel
 * application. A `HealthPlugin` registered BEFORE a provider plugin at
 * `PLUGIN_PRIORITY.NORMAL`: the factory resolves that capability at `onInit`
 * and `GET /health` reports the indicator with data taken from it.
 *
 * This fails if factory resolution moves back into `register()` — but only
 * because the lookup happens in the factory BODY. An earlier version resolved
 * lazily inside `check()`, which runs at request time, and it passed with
 * resolution moved into `register()` while its own comment claimed that was
 * impossible. The body placement is the assertion; the priority gap is what
 * makes it bite.
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
            // Resolved in the FACTORY BODY, not inside `check`. That is what makes
            // this test discriminate: `HealthPlugin` registers at priority 100 and
            // the provider at 500, so a factory invoked during `register()` finds no
            // `database` capability and `start()` rejects. Resolving lazily inside
            // `check` would defer the lookup to request time, where every plugin has
            // long since registered — and the test would pass either way. (Verified:
            // with resolution moved back into `register()`, this fails and the lazy
            // shape did not.)
            (services) => {
              const db = services.get<{
                ping: () => Promise<{ ok: boolean; latencyMs: number }>;
              }>(CAPABILITIES.DATABASE);
              return {
                name: 'database',
                check: async () => {
                  const result = await db.ping();
                  return {
                    status: result.ok ? 'up' : 'down',
                    data: { latencyMs: result.latencyMs },
                  };
                },
              };
            },
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
      // capability the factory BODY resolved — unreachable if the factory ran in
      // register(), where the priority-500 provider has not registered yet.
      expect(report.checks['database']).toBeDefined();
      expect(report.checks['database'].status).toBe('up');
      expect(report.checks['database'].data).toEqual({ latencyMs: 3 });
    } finally {
      await app.stop();
    }
  });
});
