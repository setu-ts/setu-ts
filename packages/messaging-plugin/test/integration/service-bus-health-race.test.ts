/**
 * The V8-1 race through a real kernel application (M101a §3.2).
 *
 * `0.8.0` shipped a Service Bus outage reported as healthy: a failed publish
 * was recorded, but `reachability()` then AWAITED the management probe
 * before answering `false`, and the `messaging` indicator bounds that call
 * with the same 2 s the probe is bounded with. A probe that cannot reach the
 * namespace — the shape of a real outage — lost the race to the indicator's
 * own bound, which reported `reachable: 'unknown'` → `up`, and cached it for
 * 5 s. The suite that should have caught it asserted `broker.reachability()`
 * directly, one layer below the race.
 *
 * This file drives the race where it lives — through `/health` and `/ready`
 * on a kernel app, with the runtime's real timers — using an injected
 * transport whose management probe never settles, so it runs in CI. The
 * real-emulator counterpart is `service-bus-outage-real.test.ts`
 * (local-only).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type { IMessageBroker } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { HealthPlugin } from '@setu-ts/health-plugin';
import { MessagingPlugin } from '../../src/index.ts';
import type { IServiceBusTransport } from '../../src/brokers/service-bus-broker.ts';

interface HealthBody {
  readonly status: string;
  readonly checks: Record<string, { status: string; data?: Record<string, unknown> }>;
}

function hungProbeTransport(): IServiceBusTransport {
  return {
    send: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5671')),
    open: () => Promise.resolve({ close: () => Promise.resolve() }),
    createSubscription: () => Promise.resolve(),
    deleteSubscription: () => Promise.resolve(),
    close: () => Promise.resolve(),
    // The management plane cannot be reached either, and the call never
    // returns — what a paused or partitioned namespace looks like.
    isHealthy: () => new Promise<boolean>(() => {}),
  };
}

describe('Service Bus outage through /health and /ready (M101a V8-1)', () => {
  it('a rejected publish answers /health 503 and /ready 503 at once, not up after the probe bound', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        HealthPlugin(),
        MessagingPlugin({ broker: 'service-bus', client: hungProbeTransport() }),
      ],
    });
    await app.start();
    try {
      const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
      await expect(broker.publish('orders', { id: 1 })).rejects.toThrow('ECONNREFUSED');

      const started = performance.now();
      const health = await app.fetch(new Request('http://localhost/health'));
      const elapsed = performance.now() - started;
      const body = (await health.json()) as HealthBody;

      expect(health.status).toBe(503);
      expect(body.checks['messaging']?.status).toBe('down');
      expect(body.checks['messaging']?.data?.['reachable']).toBe(false);
      // Answered from the recorded outcome — not after the 2 s bound that
      // used to fire first and report `up`.
      expect(elapsed).toBeLessThan(1_000);

      const ready = await app.fetch(new Request('http://localhost/ready'));
      await ready.body?.cancel();
      expect(ready.status).toBe(503);
    } finally {
      await app.stop();
    }
  });
});
