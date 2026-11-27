/** Explicit opt-in container faults. The reviewer runs this suite alone with an external restore trap. */
import { describe, expect, it } from 'vitest';
import { run as runProcess } from '../../../../test/node-helpers.ts';
import { CAPABILITIES, resolveProbeTiming, withDeadline } from '@setu-ts/common';
import type { IMessageBroker } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin, createNodeRuntimeServices } from '@setu-ts/runtime';
import { HealthPlugin } from '@setu-ts/health-plugin';
import { MessagingPlugin, PublishTimeoutError } from '../../src/index.ts';

const container = process.env['SERVICE_BUS_EMULATOR_CONTAINER'];
const runtime = createNodeRuntimeServices();
const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => runtime.setTimeout(resolve, ms));

async function docker(action: 'pause' | 'unpause' | 'stop' | 'start'): Promise<void> {
  const result = await runProcess('docker', { args: [action, container!] });
  if (!result.success)
    throw new Error(`docker ${action} failed: ${new TextDecoder().decode(result.stderr)}`);
}

/** Every cleanup runs; the proof's original rejection always wins. */
async function cleanup(
  steps: readonly (() => Promise<unknown>)[],
  originalFailed: boolean,
): Promise<void> {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (!originalFailed && errors.length > 0)
    throw new AggregateError(errors, 'Service Bus outage cleanup failed');
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function entityNotFound(error: unknown): boolean {
  // Administration uses RestError; AMQP operations use translated ServiceBusError codes.
  return hasCode(error, 'MessageEntityNotFoundError') || hasCode(error, 'MessagingEntityNotFound');
}

describe.skipIf(!container)('Service Bus controlled emulator outages', () => {
  it.each(['paused publish', 'consume-only readiness'] as const)(
    'proves %s and restores the emulator',
    { timeout: 120000 },
    async (proof) => {
      const connectionString = process.env['SERVICEBUS_CONNECTION_STRING'];
      const adminConnectionString = process.env['SERVICEBUS_ADMIN_CONNECTION_STRING'];
      expect(connectionString).toBeTruthy();
      expect(adminConnectionString).toBeTruthy();
      const { ServiceBusAdministrationClient, ServiceBusClient } =
        await import('@azure/service-bus');
      const admin = new ServiceBusAdministrationClient(adminConnectionString!);
      const topic = `m143m-outage-${runtime.uuid()}`;
      const subscription = 'm143m-outage-consumer';
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          HealthPlugin({ details: true }),
          MessagingPlugin({
            broker: 'service-bus',
            connectionString: connectionString!,
            adminConnectionString: adminConnectionString!,
            publishTimeoutMs: 3000,
            consumerRetry: false,
            retryOptions:
              proof === 'paused publish'
                ? { maxRetries: 3, timeoutInMs: 60000 }
                : { maxRetries: 0, timeoutInMs: 1000 },
          }),
        ],
      });
      let created = false;
      let restore: 'unpause' | 'start' | undefined;
      let originalFailed = false;
      let missingEntity: { error: unknown } | undefined;
      const recreateEntities = async (): Promise<void> => {
        const deadline = runtime.hrtime() + 60000;
        let lastError: unknown;
        const timedOut = (): Error =>
          new Error('Service Bus emulator entities were not recreated within 60000 ms', {
            cause: lastError,
          });
        const create = async (
          step: (abortSignal: AbortSignal) => Promise<unknown>,
        ): Promise<void> => {
          const remainingMs = deadline - runtime.hrtime();
          if (remainingMs <= 0) throw timedOut();
          // Bound the caller too: an SDK retry sleep may ignore the abort signal.
          await withDeadline(
            async (abortSignal) => {
              if (abortSignal.aborted || runtime.hrtime() >= deadline) throw timedOut();
              try {
                await step(abortSignal);
              } catch (error) {
                if (hasCode(error, 'MessageEntityAlreadyExistsError')) return;
                if (entityNotFound(error)) missingEntity = { error };
                // Keep the last driver failure, not the deadline's abort rejection.
                if (!abortSignal.aborted) lastError = error;
                throw error;
              }
            },
            {
              timeoutMs: remainingMs,
              onTimeout: timedOut,
              timing: resolveProbeTiming(runtime),
            },
          );
        };
        while (runtime.hrtime() < deadline) {
          try {
            await create((abortSignal) => admin.createTopic(topic, { abortSignal }));
            await create((abortSignal) =>
              admin.createSubscription(topic, subscription, { abortSignal }),
            );
            missingEntity = undefined;
            return;
          } catch {
            // Every failure retries the whole pair, including not-found during warmup.
          }
          const remainingMs = deadline - runtime.hrtime();
          if (remainingMs > 0) await wait(Math.min(250, remainingMs));
        }
        throw timedOut();
      };
      const status = async (): Promise<number> => {
        const response = await app.fetch(new Request('http://localhost/ready'));
        await response.body?.cancel();
        return response.status;
      };
      const waitForEmulator = async (): Promise<void> => {
        // A missing dynamic entity cannot recover by waiting; finally must not
        // spend another recovery window probing it after the proof found it absent.
        if (missingEntity !== undefined) throw missingEntity.error;
        const deadline = runtime.hrtime() + 60000;
        let lastError: unknown;
        while (runtime.hrtime() < deadline) {
          const client = new ServiceBusClient(connectionString!, {
            retryOptions: { maxRetries: 0, timeoutInMs: 1000 },
          });
          const receiver = client.createReceiver(topic, subscription);
          try {
            await withDeadline((abortSignal) => receiver.peekMessages(1, { abortSignal }), {
              timeoutMs: 1000,
              onTimeout: () => new Error('Service Bus emulator peek timed out'),
              timing: resolveProbeTiming(runtime),
            });
            return;
          } catch (error) {
            if (entityNotFound(error)) {
              missingEntity = { error };
              throw error;
            }
            lastError = error;
          } finally {
            await cleanup([() => receiver.close(), () => client.close()], true);
          }
          await wait(250);
        }
        throw new Error('Service Bus emulator did not recover', { cause: lastError });
      };
      try {
        await admin.createTopic(topic);
        created = true;
        await admin.createSubscription(topic, subscription);
        await app.start();
        const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
        if (proof === 'paused publish') {
          await broker.publish(topic, { phase: 'warm' });
          restore = 'unpause';
          await docker('pause');
          const start = runtime.hrtime();
          await expect(broker.publish(topic, { phase: 'paused' })).rejects.toBeInstanceOf(
            PublishTimeoutError,
          );
          expect(runtime.hrtime() - start).toBeLessThan(4000);
          await docker('unpause');
          await waitForEmulator();
          restore = undefined;
        } else {
          // This application never publishes, including during recovery.
          await broker.subscribe(topic, () => {}, { queue: subscription });
          await waitForEmulator();
          expect(await status()).toBe(200);
          restore = 'start';
          await docker('stop');
          const cachePeriodMs = 5000;
          const probeBoundMs = 2000;
          const marginMs = 500;
          const deadline = runtime.hrtime() + cachePeriodMs + probeBoundMs + marginMs;
          let stopped = await status();
          while (stopped !== 503 && runtime.hrtime() < deadline) {
            await wait(50);
            stopped = await status();
          }
          expect(stopped).toBe(503);
          expect(runtime.hrtime()).toBeLessThanOrEqual(deadline);
          await docker('start');
          restore = undefined;
          // Restart re-seeds the emulator and discards these dynamic entities.
          await recreateEntities();
          await waitForEmulator();
          const recoveredBy = runtime.hrtime() + 15000;
          let recovered = await status();
          while (recovered !== 200 && runtime.hrtime() < recoveredBy) {
            await wait(100);
            recovered = await status();
          }
          expect(recovered).toBe(200);
        }
      } catch (error) {
        originalFailed = true;
        throw error;
      } finally {
        const restoreAction = restore;
        await cleanup(
          [
            ...(restoreAction === undefined ? [] : [() => docker(restoreAction)]),
            ...(restoreAction === 'start' ? [recreateEntities] : []),
            ...(created ? [waitForEmulator] : []),
            () => app.stop(),
            ...(created ? [() => admin.deleteTopic(topic)] : []),
          ],
          originalFailed,
        );
      }
    },
  );
});
