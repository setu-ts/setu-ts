/**
 * Real Service Bus outage gate (M95b §3.3) — the 2×2 the letter was opened
 * for. Against this emulator the management probe resolves `undefined` in
 * BOTH states (no TLS listener for administration), so `0.6.0` answered
 * `up`/200 whether the broker was running or stopped and the indicator
 * discriminated in neither state. The data-plane evidence window (§3.2) is
 * what carries the signal here, which is why the publishes are LOAD-BEARING
 * rather than setup: a poll-only variant cannot pass its own stopped cell.
 *
 * The sequence this suite asserts is the `0.6.0` row of the §0 table — `up`
 * while running, `down` while stopped, `up` again after restart — plus the
 * assertion that the running and stopped answers DIFFER, which is the one
 * thing neither shipped version had. Each health answer is preceded by the
 * publish §3.2 reads: a successful publish before the first `up`, a
 * rejected publish against the stopped emulator before the `down`, and
 * another successful publish after restart. The broker is constructed with
 * `retryOptions: { maxRetries: 0 }` (the M90b escape hatch) so the stopped
 * publish rejects inside the test budget instead of consuming the SDK's
 * default retry schedule.
 *
 * M101a (V8-1) rewrote it to run through a kernel application: the
 * original constructed the BROKER and asserted `broker.reachability()`, one
 * layer below the race that shipped in `0.8.0` — the `messaging` indicator
 * bounded that call with the same 2 s the management probe used, so the
 * probe's timeout lost to the indicator's and `/ready` answered 200 through a
 * stopped emulator. The stopped cell now samples `/health` and `/ready` at
 * +0 s, +3 s and +7 s, the last past the indicator's 5 s cache, which is the
 * window `0.8.0` answered `up` in.
 *
 * Guarded on `SERVICEBUS_CONNECTION_STRING` (no underscore between SERVICE
 * and BUS — the TEST guard variable the documented emulator command sets;
 * `SERVICE_BUS_CONNECTION_STRING` is the DEPLOYMENT variable and using it
 * here would make the suite skip under the documented command). Local-only
 * by decision (§3.4): the emulator is not repeatable against a persistent
 * container and the image is large; `test/apps-gate.test.ts` records that
 * absence as deliberate. The suite restarts the container itself and leaves
 * it running, so a second run works.
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

const connectionString = Deno.env.get('SERVICEBUS_CONNECTION_STRING');
const skipReal = connectionString === undefined;

async function docker(args: string[]): Promise<string> {
  const out = await new Deno.Command('docker', { args }).output();
  if (!out.success) {
    throw new Error(
      `docker ${args.join(' ')} failed: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
  return new TextDecoder().decode(out.stdout);
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface HealthBody {
  readonly checks: Record<string, { status: string; data?: Record<string, unknown> }>;
}

describe('REAL Service Bus outage through /health and /ready (M95b §3.3, M101a §3.2)', {
  ignore: skipReal,
}, () => {
  it('publish → 200; stop → publish rejects → 503 at +0/+3/+7 s; restart → publish → 200', async () => {
    // he-sb is the emulator container the documented run command names; its
    // AMQP port is published on 5673 (5672 is RabbitMQ's).
    const containerId = (await docker(['ps', '-q', '--filter', 'name=he-sb'])).trim();
    expect(containerId).not.toBe('');

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        HealthPlugin(),
        MessagingPlugin({
          broker: 'service-bus',
          connectionString: connectionString ?? '',
          retryOptions: { maxRetries: 0 },
        }),
      ],
    });
    const statusOf = async (path: string): Promise<number> => {
      const response = await app.fetch(new Request(`http://localhost${path}`));
      await response.body?.cancel();
      return response.status;
    };
    const messagingCheck = async (): Promise<{ status: string; reachable: unknown }> => {
      const response = await app.fetch(new Request('http://localhost/health'));
      const body = (await response.json()) as HealthBody;
      const check = body.checks['messaging'];
      return { status: check?.status ?? 'absent', reachable: check?.data?.['reachable'] };
    };

    await app.start();
    try {
      const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);

      // (running) a successful publish IS the data-plane evidence: with the
      // management probe resolving `undefined` against this emulator in
      // every state, only the recorded success can answer `up`.
      await broker.publish('orders-roundtrip', { phase: 'running' });
      expect(await statusOf('/ready')).toBe(200);

      // (stopped) a real stop. The publish against the dead namespace is
      // awaited to its rejection — a status-less network failure, exactly
      // the shape the evidence predicate records.
      await docker(['stop', containerId]);
      await wait(1_000);
      let stoppedError: unknown = undefined;
      try {
        await broker.publish('orders-roundtrip', { phase: 'stopped' });
      } catch (error) {
        stoppedError = error;
      }
      expect(stoppedError).toBeDefined();

      for (const delayMs of [0, 3_000, 4_000]) {
        await wait(delayMs);
        expect(await messagingCheck()).toEqual({ status: 'down', reachable: false });
        expect(await statusOf('/ready')).toBe(503);
      }

      // (restart) the container returns; a successful publish re-records
      // evidence and the answer returns to `up`.
      await docker(['start', containerId]);
      let reconnected = false;
      for (let i = 0; i < 60 && !reconnected; i++) {
        await wait(1_000);
        try {
          await broker.publish('orders-roundtrip', { phase: 'recovered' });
          reconnected = true;
        } catch {
          // The emulator is still coming up; retry.
        }
      }
      expect(reconnected).toBe(true);
      // The indicator caches for 5 s, so the recovery is observed after it.
      await wait(5_500);
      expect(await statusOf('/ready')).toBe(200);
    } finally {
      // Leave the container RUNNING: R11 records that a second consecutive
      // run against a stopped or dirty emulator fails for reasons unrelated
      // to the change.
      await new Deno.Command('docker', { args: ['start', containerId] }).output();
      await app.stop().catch(() => {});
    }
  });
});
