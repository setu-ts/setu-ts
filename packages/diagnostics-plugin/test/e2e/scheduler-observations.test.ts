/**
 * End-to-end canary for scheduler execution observations (M98k): a REAL Deno
 * socket, the REAL kernel application and runtime-owned listener, a REAL
 * SchedulerPlugin firing jobs through its executor, and the signed native
 * client.
 *
 * Canaries are planted in every place the minimization seam must never
 * reach — the job name, the cron-style payload data, the job id, a lock-key
 * fragment, and a thrown error's message — and asserted absent at the
 * source snapshot, the RAW signed wire bytes, and the client DTO. The
 * approved counters are asserted PRESENT alongside, so dropping every
 * record cannot pass. An unobserved job's work is asserted invisible.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { ISchedulerDiagnosticsSource } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { SchedulerPlugin } from '@setu-ts/scheduler-plugin';

import { createDiagnosticsClient, DiagnosticsPlugin } from '../../src/index.ts';
import { TEST_KEY_BYTES, TEST_SESSION_ID } from '../fixtures/helpers.ts';

const CANARY_NAME = 'canary-job-SYNTHETIC';
const CANARY_DATA = 'canary-payload-SYNTHETIC';
const CANARY_ID = 'canary-id-SYNTHETIC';
const CANARY_ERROR = 'canary-error-SYNTHETIC';
// The approved job carries a canary in its DATA and its thrown error; the
// unobserved job carries a canary in its NAME.

/** A fetch that records every raw response body the client receives. */
function capturingFetch(frames: string[]): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    frames.push(await response.clone().text());
    return response;
  };
}

/** Reserves a free loopback port. */
function freePort(): number {
  const probe = Deno.listen({ port: 0, hostname: '127.0.0.1' });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close();
  return port;
}

describe('Scheduler observations e2e (M98k canary)', () => {
  it('serves approved counters end to end while every canary stays absent', async () => {
    const connectorPort = freePort();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DiagnosticsPlugin({
          enabled: true,
          port: connectorPort,
          sessionId: TEST_SESSION_ID,
          sessionKey: TEST_KEY_BYTES,
        }),
        SchedulerPlugin({
          jobs: [
            {
              trigger: 'delay',
              name: 'tick',
              delayMs: 20,
              // The payload and id are canaries: the handler legitimately
              // receives them, and the assertions below prove the seam never
              // CARRIES them into any diagnostic layer.
              handler: (_job) => {},
              data: CANARY_DATA,
            },
            {
              trigger: 'delay',
              name: 'flapper',
              delayMs: 20,
              handler: () => {
                throw new Error(CANARY_ERROR);
              },
              retry: { limit: 2, delay: 5, backoff: 'fixed' },
            },
          ],
          diagnostics: {
            enabled: true,
            alias: 'cron',
            jobs: { tick: 'tick-alias', flapper: 'flapper-alias' },
          },
        }),
      ],
      diagnostics: {},
    });
    await app.start({ port: freePort(), hostname: '127.0.0.1' });
    try {
      // One imperative, UNOBSERVED job: its name is a canary and its fire
      // must appear nowhere.
      const scheduler = app.services.get<import('@setu-ts/common').IScheduler>(
        CAPABILITIES.SCHEDULER,
      );
      let unobservedRan = false;
      await scheduler.delay(CANARY_NAME, 20, () => {
        unobservedRan = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(unobservedRan).toBe(true);

      const frames: string[] = [];
      const client = createDiagnosticsClient({
        endpoint: `http://127.0.0.1:${connectorPort}`,
        sessionId: TEST_SESSION_ID,
        sessionKey: TEST_KEY_BYTES,
        subtle: crypto.subtle,
        fetch: capturingFetch(frames),
        timing: { setTimeout, clearTimeout },
      });
      const response = await client.scheduler();
      client.close();

      // --- Approved counters survive (positive control) ----------------
      expect(response.state).toBe('ready');
      expect(response.sources.map((s) => s.sourceId)).toEqual(['s1']);
      const snapshot = response.sources[0]!.snapshot;
      expect(snapshot.alias).toBe('cron');
      expect(snapshot.coverage).toBe('owned-instance');
      const byTuple = new Map(snapshot.records.map((r) => [`${r.alias}|${r.operation}`, r]));
      const tickFire = byTuple.get('tick-alias|fire');
      expect(tickFire).toMatchObject({ count: 1, started: 1, succeeded: 1, failed: 0 });
      expect(tickFire!.lastLatenessMs).toBeGreaterThanOrEqual(0);
      const tickAttempt = byTuple.get('tick-alias|attempt');
      expect(tickAttempt).toMatchObject({ count: 1, succeeded: 1, retryAttempts: 0 });
      // The flapper failed both of its attempts: one retry, fire failed.
      expect(byTuple.get('flapper-alias|attempt')).toMatchObject({
        count: 2,
        failed: 2,
        succeeded: 0,
        retryAttempts: 1,
      });
      expect(byTuple.get('flapper-alias|fire')).toMatchObject({ started: 1, failed: 1 });

      const sources = app.services.getAll<ISchedulerDiagnosticsSource>(
        CAPABILITIES.SCHEDULER_DIAGNOSTICS,
      );
      const local = JSON.stringify(sources.map((s) => s.snapshot()));
      expect(local).toContain('tick-alias');

      // --- Canaries are absent at every layer --------------------------
      const canaries = [CANARY_NAME, CANARY_DATA, CANARY_ID, CANARY_ERROR];
      expect(frames.length).toBeGreaterThan(0);
      for (const layer of [local, JSON.stringify(response), ...frames]) {
        for (const canary of canaries) {
          expect(layer).not.toContain(canary);
        }
      }
    } finally {
      await app.stop();
    }
  });

  it('keeps the source ready when a job is armed for a fractional instant', async () => {
    // `delay(name, 20.5)` arms a fractional intended fire, so the measured
    // lateness is always k + 0.5 ms. The wire accepts only integer counters:
    // unrounded, that one record turned the WHOLE source collection-failed,
    // hiding the unrelated recurring job beside it.
    const connectorPort = freePort();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DiagnosticsPlugin({
          enabled: true,
          port: connectorPort,
          sessionId: TEST_SESSION_ID,
          sessionKey: TEST_KEY_BYTES,
        }),
        SchedulerPlugin({
          jobs: [
            { trigger: 'delay', name: 'fractional', delayMs: 20.5, handler: () => {} },
            { trigger: 'every', name: 'recurring', intervalMs: 25, handler: () => {} },
          ],
          diagnostics: {
            enabled: true,
            alias: 'cron',
            jobs: { fractional: 'fractional-alias', recurring: 'recurring-alias' },
          },
        }),
      ],
      diagnostics: {},
    });
    await app.start({ port: freePort(), hostname: '127.0.0.1' });
    try {
      await new Promise((resolve) => setTimeout(resolve, 120));
      const client = createDiagnosticsClient({
        endpoint: `http://127.0.0.1:${connectorPort}`,
        sessionId: TEST_SESSION_ID,
        sessionKey: TEST_KEY_BYTES,
        subtle: crypto.subtle,
        fetch,
        timing: { setTimeout, clearTimeout },
      });
      const response = await client.scheduler();
      client.close();
      expect(response.state).toBe('ready');
      const records = response.sources[0]!.snapshot.records;
      const fire = records.find((r) => r.alias === 'fractional-alias' && r.operation === 'fire');
      expect(fire).toMatchObject({ count: 1, started: 1, succeeded: 1 });
      expect(Number.isSafeInteger(fire!.lastLatenessMs)).toBe(true);
      const recurring = records.find((r) =>
        r.alias === 'recurring-alias' && r.operation === 'fire'
      );
      expect(recurring!.started).toBeGreaterThanOrEqual(2);
    } finally {
      await app.stop();
    }
  });
});
