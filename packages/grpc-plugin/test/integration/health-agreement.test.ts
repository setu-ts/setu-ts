/**
 * M70c X7-8 reproduction — the two health faces of one process must agree.
 *
 * Before this milestone the gRPC bridge reported a `degraded` process as
 * `SERVING` (so gRPC clients kept load-balancing onto it) while the health
 * plugin's `/ready` already returned 503 (so Kubernetes took it out of
 * rotation). This test drives a real kernel app with one degraded indicator
 * and asserts both faces say the same thing: `/ready` is 503 AND
 * `Health/Check` is `NOT_SERVING`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { HealthPlugin } from '@setu-ts/health-plugin';
import { GrpcPlugin } from '../../src/plugin/grpc-plugin.ts';
import type { IHealthIndicator } from '@setu-ts/common';

/** An indicator that reports degraded — the process is impaired but running. */
function degradedIndicator(): IHealthIndicator {
  return {
    name: 'impairment',
    check: () => Promise.resolve({ status: 'degraded', data: { reason: 'under stress' } }),
  };
}

async function withApp(
  app: ReturnType<typeof createApplication>,
  body: (app: ReturnType<typeof createApplication>) => Promise<void>,
): Promise<void> {
  await app.start({ port: 0 });
  try {
    await body(app);
  } finally {
    await app.stop();
  }
}

describe('gRPC ↔ HTTP health agreement (M70c X7-8)', () => {
  it('a degraded process is NOT_SERVING over gRPC and 503 over /ready', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        HealthPlugin({ indicators: [degradedIndicator()] }),
        GrpcPlugin(),
      ],
    });

    await withApp(app, async (running) => {
      // HTTP face: readiness is 503 because a degraded indicator is not up.
      const ready = await running.fetch(new Request('http://localhost/ready'));
      expect(ready.status).toBe(503);

      // gRPC face: the whole-server Check must agree — NOT_SERVING, not SERVING.
      const check = await running.fetch(
        new Request('http://localhost/grpc.health.v1.Health/Check', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ service: '' }),
        }),
      );
      expect(check.status).toBe(200);
      expect(await check.json()).toEqual({ status: 'NOT_SERVING' });
    });
  });

  it('a healthy process is SERVING over gRPC and 200 over /ready', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), HealthPlugin(), GrpcPlugin()],
    });

    await withApp(app, async (running) => {
      const ready = await running.fetch(new Request('http://localhost/ready'));
      expect(ready.status).toBe(200);

      const check = await running.fetch(
        new Request('http://localhost/grpc.health.v1.Health/Check', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ service: '' }),
        }),
      );
      expect(check.status).toBe(200);
      expect(await check.json()).toEqual({ status: 'SERVING' });
    });
  });
});
