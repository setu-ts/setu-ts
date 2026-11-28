import { run as runProcess } from '../../../../test/node-helpers.ts';
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
import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type { IMessageBroker } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { HealthPlugin } from '@setu-ts/health-plugin';
import { MessagingPlugin } from '../../src/index.ts';
import { ServiceBusBroker, JsonSerializer, adaptServiceBusModule } from '../../src/index.ts';
import type { ServiceBusSdkModule } from '../../src/index.ts';
import { createNodeRuntimeServices } from '@setu-ts/runtime';

const connectionString = process.env['SERVICEBUS_CONNECTION_STRING'];
const skipReal = connectionString === undefined;

/** Probe backend support before making a claim about the reply inbox lifetime. */
async function supportsIdleLifetime(
  admin: import('@azure/service-bus').ServiceBusAdministrationClient,
  topic: string,
): Promise<boolean> {
  const subscription = 'm143m-idle-capability';
  await admin.createSubscription(topic, subscription, { autoDeleteOnIdle: 'PT5M' });
  const readback = (await admin.getSubscription(topic, subscription)).autoDeleteOnIdle;
  if (/^P10675199DT2H48M5(?:\.4775807)?S$/.test(readback)) return false;
  expect(readback).toMatch(/^PT(5M|300S)$/);
  return true;
}

async function cleanupSteps(
  steps: readonly (() => Promise<unknown>)[],
  originalFailed: boolean,
): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (!originalFailed && failures.length > 0)
    throw new AggregateError(failures, 'Service Bus test cleanup failed');
}

describe('Service Bus proof cleanup', () => {
  it('runs every step in order and aggregates failures in order', async () => {
    const calls: string[] = [];
    const firstFailure = new Error('first cleanup failed');
    const thirdFailure = new Error('third cleanup failed');
    const failure: unknown = await cleanupSteps(
      [
        () => {
          calls.push('first');
          return Promise.reject(firstFailure);
        },
        () => {
          calls.push('middle');
          return Promise.resolve();
        },
        () => {
          calls.push('third');
          return Promise.reject(thirdFailure);
        },
      ],
      false,
    ).catch((error: unknown) => error);

    expect(calls).toEqual(['first', 'middle', 'third']);
    expect(failure).toBeInstanceOf(AggregateError);
    const failures = (failure as AggregateError).errors;
    expect(failures).toHaveLength(2);
    expect(failures[0]).toBe(firstFailure);
    expect(failures[1]).toBe(thirdFailure);
  });

  it('preserves the original proof error while attempting every cleanup', async () => {
    const calls: string[] = [];
    const original = new Error('original proof failed');
    const disconnectFailure = new Error('disconnect failed');
    const deleteFailure = new Error('first delete failed');
    const proof = async (): Promise<void> => {
      let originalFailed = false;
      try {
        throw original;
      } catch (error) {
        originalFailed = true;
        throw error;
      } finally {
        await cleanupSteps(
          [
            () => {
              calls.push('disconnect');
              return Promise.reject(disconnectFailure);
            },
            () => {
              calls.push('delete-first');
              return Promise.reject(deleteFailure);
            },
            () => {
              calls.push('delete-second');
              return Promise.resolve();
            },
          ],
          originalFailed,
        );
      }
    };

    await expect(proof()).rejects.toBe(original);
    expect(calls).toEqual(['disconnect', 'delete-first', 'delete-second']);
  });
});

describe(
  'Service Bus idle lifetime SDK control',
  { skip: skipReal || !process.env['SERVICEBUS_ADMIN_CONNECTION_STRING'] },
  () => {
    it('probes backend support for a five-minute idle lifetime', async (context) => {
      const { ServiceBusAdministrationClient } = await import('@azure/service-bus');
      const admin = new ServiceBusAdministrationClient(
        process.env['SERVICEBUS_ADMIN_CONNECTION_STRING']!,
      );
      const topic = `m143m-idle-${createNodeRuntimeServices().uuid()}`;
      let created = false;
      let originalFailed = false;
      try {
        await admin.createTopic(topic);
        created = true;
        if (!(await supportsIdleLifetime(admin, topic)))
          await context.annotate('autoDeleteOnIdle not honoured by this backend');
      } catch (error) {
        originalFailed = true;
        throw error;
      } finally {
        await cleanupSteps(created ? [() => admin.deleteTopic(topic)] : [], originalFailed);
      }
    });
  },
);

describe(
  'Service Bus bounded consumer operations',
  { skip: skipReal || !process.env['SERVICEBUS_ADMIN_CONNECTION_STRING'] },
  () => {
    it.for(['consumer concurrency', 'reply inbox idle deletion'] as const)(
      'proves %s through the SDK',
      { timeout: 60000 },
      async (proof, context) => {
        const sdk = await import('@azure/service-bus');
        const { ServiceBusAdministrationClient } = sdk;
        const inboxRequests: string[] = [];
        class RecordingAdministrationClient extends ServiceBusAdministrationClient {
          constructor(value: string) {
            super(value);
            this.pipeline.addPolicy({
              name: 'm143m-idle-request-proof',
              sendRequest(request, next) {
                if (
                  request.method === 'PUT' &&
                  request.url.includes('rr-inbox-') &&
                  typeof request.body === 'string'
                )
                  inboxRequests.push(request.body);
                return next(request);
              },
            });
          }
        }
        const runtime = createNodeRuntimeServices();
        const adminConnectionString = process.env['SERVICEBUS_ADMIN_CONNECTION_STRING']!;
        const admin = new ServiceBusAdministrationClient(adminConnectionString);
        const topic = 'm143m-' + runtime.uuid();
        const replies = topic + '-reply';
        const subscription = 'm143m-worker';
        const broker = new ServiceBusBroker(runtime, new JsonSerializer(), {
          client: adaptServiceBusModule(
            {
              ...sdk,
              ServiceBusAdministrationClient: RecordingAdministrationClient,
            } as unknown as ServiceBusSdkModule,
            {
              connectionString: connectionString!,
              adminConnectionString,
              retryOptions: { maxRetries: 0, timeoutInMs: 2000 },
            },
          ),
          replyTopic: replies,
          maxConcurrentCalls: 4,
          publishTimeoutMs: 2000,
          consumerRetry: false,
          retryOptions: { maxRetries: 0, timeoutInMs: 2000 },
        });
        const release = Promise.withResolvers<void>();
        let entered = 0;
        let completed = 0;
        const topics: string[] = [];
        const until = async (predicate: () => boolean): Promise<void> => {
          const end = runtime.hrtime() + 15000;
          while (!predicate() && runtime.hrtime() < end)
            await new Promise<void>((resolve) => runtime.setTimeout(resolve, 20));
          expect(predicate()).toBe(true);
        };
        let originalFailed = false;
        try {
          await admin.createTopic(topic);
          topics.push(topic);
          await admin.createTopic(replies);
          topics.push(replies);
          await admin.createSubscription(topic, subscription);
          await broker.connect();
          if (proof === 'consumer concurrency') {
            await broker.subscribe(
              topic,
              async () => {
                entered++;
                await release.promise;
                completed++;
              },
              { queue: subscription },
            );
            for (let n = 0; n < 4; n++) await broker.publish(topic, { n });
            await until(() => entered === 4);
            expect(completed).toBe(0);
            release.resolve();
            await until(() => completed === 4);
          } else {
            const honoursIdle = await supportsIdleLifetime(admin, replies);
            await admin.deleteSubscription(replies, 'm143m-idle-capability');
            if (!honoursIdle)
              await context.annotate('autoDeleteOnIdle not honoured by this backend');
            // The missing request channel is never provisioned; opening the inbox happens first.
            await broker.request(topic, {}, { timeoutMs: 1000 }).catch(() => {});
            const inboxes = [];
            for await (const entry of admin.listSubscriptions(replies)) inboxes.push(entry);
            expect(inboxes).toHaveLength(1);
            const inbox = await admin.getSubscription(replies, inboxes[0]!.subscriptionName);
            expect(inboxRequests).toHaveLength(1);
            expect(inboxRequests[0]).toMatch(/<AutoDeleteOnIdle[^>]*>PT300S<\/AutoDeleteOnIdle>/);
            if (honoursIdle) expect(inbox.autoDeleteOnIdle).toMatch(/^PT(5M|300S)$/);
            await broker.disconnect();
            const remaining = [];
            for await (const entry of admin.listSubscriptions(replies)) remaining.push(entry);
            expect(remaining).toHaveLength(0);
          }
        } catch (error) {
          originalFailed = true;
          throw error;
        } finally {
          release.resolve();
          await cleanupSteps(
            [
              () => broker.disconnect(),
              ...topics.reverse().map((name) => () => admin.deleteTopic(name)),
            ],
            originalFailed,
          );
        }
      },
    );
  },
);

async function docker(args: string[]): Promise<string> {
  const out = await runProcess('docker', { args });
  if (!out.success) {
    throw new Error(`docker ${args.join(' ')} failed: ${new TextDecoder().decode(out.stderr)}`);
  }
  return new TextDecoder().decode(out.stdout);
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface HealthBody {
  readonly checks: Record<string, { status: string; data?: Record<string, unknown> }>;
}

describe(
  'REAL Service Bus outage through /health and /ready (M95b §3.3, M101a §3.2)',
  {
    skip: skipReal,
  },
  () => {
    it('publish → 200; stop → publish rejects → 503 at +0/+3/+7 s; restart → publish → 200', async () => {
      // he-sb is the emulator container the documented run command names; its
      // AMQP port is published on 5673 (5672 is RabbitMQ's).
      const containerId = (await docker(['ps', '-q', '--filter', 'name=he-sb'])).trim();
      expect(containerId).not.toBe('');

      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          HealthPlugin({ details: true }),
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
        await runProcess('docker', { args: ['start', containerId] });
        await app.stop().catch(() => {});
      }
    });
  },
);
