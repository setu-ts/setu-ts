/**
 * Integration tests for the health plugin — driven through a REAL kernel
 * application (`createApplication` + `app.start` + `app.inject`), so the
 * endpoints run through the actual router and the `onInit` drain runs inside
 * the kernel lifecycle. A fake plugin context cannot prove that a
 * contribution pushed via `ctx.health.register(...)` is actually drained and
 * appears in the aggregated report, nor that the per-endpoint status-code
 * matrix holds end-to-end (plan §3.2 / §3.3 / §3.7 / §6).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { HealthReport, HealthStatus, IPlugin, IPluginContext } from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';

import { HealthPlugin } from '../../src/index.ts';

/**
 * A fake capability plugin that self-registers a health indicator the same
 * way the database/cache/queue plugins do — via `ctx.health.register(...)`.
 */
function contributingPlugin(name: string, status: HealthStatus): IPlugin {
  return {
    name: `${name}-contributor`,
    version: '1.0.0',
    register(ctx: IPluginContext): void {
      ctx.health.register(name, () => Promise.resolve({ status, data: { probe: name } }));
    },
  };
}

async function boot(...contributors: IPlugin[]) {
  const app = createApplication({
    plugins: [RuntimePlugin(), HealthPlugin(), ...contributors],
  });
  await app.start();
  return app;
}

describe('HealthPlugin integration (through the real kernel)', () => {
  it('registers a resolvable IHealthService under the health token', async () => {
    const app = await boot();
    try {
      expect(app.services.has(CAPABILITIES.HEALTH)).toBe(true);
    } finally {
      await app.stop();
    }
  });

  it('drains a contributed indicator and returns the RFC-shaped report on GET /health', async () => {
    const app = await boot(contributingPlugin('db', 'up'));
    try {
      const res = await app.inject({ method: 'GET', url: 'http://localhost/health' });
      expect(res.statusCode).toBe(200);

      const report = res.json<HealthReport>();

      // Exact top-level shape — no stray/forbidden fields.
      expect(Object.keys(report).sort()).toEqual(['checks', 'status', 'timestamp']);
      expect(report.status).toBe('up');

      // timestamp is a real ISO-8601 wall-clock string that round-trips.
      expect(new Date(report.timestamp).toISOString()).toBe(report.timestamp);

      // The contributed indicator was actually drained at onInit and appears.
      expect(Object.keys(report.checks).sort()).toEqual(['db', 'self']);
      expect(report.checks.db.status).toBe('up');
      expect(report.checks.db.data).toEqual({ probe: 'db' });
      expect(typeof report.checks.db.latencyMs).toBe('number');
      expect(report.checks.db.latencyMs).toBeGreaterThanOrEqual(0);

      // The self indicator carries runtime diagnostics.
      expect(report.checks.self.status).toBe('up');
      expect(report.checks.self.data).toEqual(
        expect.objectContaining({
          platform: expect.any(String),
          version: expect.any(String),
          hostname: expect.any(String),
        }),
      );
    } finally {
      await app.stop();
    }
  });

  it('serves only the self indicator on GET /live', async () => {
    const app = await boot(contributingPlugin('db', 'down'));
    try {
      const res = await app.inject({ method: 'GET', url: 'http://localhost/live' });

      // Liveness must never cascade-fail on a downstream outage.
      expect(res.statusCode).toBe(200);

      const report = res.json<HealthReport>();
      expect(Object.keys(report.checks)).toEqual(['self']);
      expect(report.status).toBe('up');
    } finally {
      await app.stop();
    }
  });

  it('excludes the self indicator from GET /ready and is 200 when all contributors are up', async () => {
    const app = await boot(contributingPlugin('db', 'up'));
    try {
      const res = await app.inject({ method: 'GET', url: 'http://localhost/ready' });
      expect(res.statusCode).toBe(200);

      const report = res.json<HealthReport>();
      expect(Object.keys(report.checks)).toEqual(['db']);
      expect(report.status).toBe('up');
    } finally {
      await app.stop();
    }
  });

  it('keeps /health at 200 but fails /ready with 503 on a degraded contributor', async () => {
    const app = await boot(contributingPlugin('cache', 'degraded'));
    try {
      const health = await app.inject({ method: 'GET', url: 'http://localhost/health' });
      // Degraded stays 200 so operators see detail without a hard restart.
      expect(health.statusCode).toBe(200);
      expect(health.json<HealthReport>().status).toBe('degraded');

      const ready = await app.inject({ method: 'GET', url: 'http://localhost/ready' });
      // Readiness must pull the pod from rotation while degraded.
      expect(ready.statusCode).toBe(503);
      expect(ready.json<HealthReport>().status).toBe('degraded');
    } finally {
      await app.stop();
    }
  });

  it('fails both /health and /ready with 503 on a down contributor', async () => {
    const app = await boot(contributingPlugin('db', 'down'));
    try {
      const health = await app.inject({ method: 'GET', url: 'http://localhost/health' });
      expect(health.statusCode).toBe(503);
      expect(health.json<HealthReport>().status).toBe('down');

      const ready = await app.inject({ method: 'GET', url: 'http://localhost/ready' });
      expect(ready.statusCode).toBe(503);
      expect(ready.json<HealthReport>().status).toBe('down');
    } finally {
      await app.stop();
    }
  });
});
