/**
 * End-to-end canary for minimized health observations (M98d): a REAL Deno
 * socket, the REAL kernel application, the REAL runtime-owned listener, the
 * connector, the health plugin's bounded collector, and the signed native
 * client.
 *
 * A canary secret is planted in an indicator's `data` and a canary error
 * string in a rejecting indicator. The test asserts the canary is absent at
 * every layer the minimized observation crosses — the source snapshot, the
 * RAW signed wire bytes (captured below the client), and the client DTO —
 * while the useful status remains present, and that diagnostic reads add no
 * indicator calls. A second case drives the bounded scheduler over real
 * timers: a hung indicator must not stop a healthy one from refreshing. This proves the minimization seam does not
 * leak `data` or error text, not merely that a field is missing by luck.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { CAPABILITIES } from '@setu-ts/common';
import type { IPlugin } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { HealthPlugin } from '@setu-ts/health-plugin';

import { createDiagnosticsClient, DiagnosticsPlugin } from '../../src/index.ts';
import { TEST_KEY_BYTES, TEST_SESSION_ID } from '../fixtures/helpers.ts';

const CANARY_DATA = 'canary-data-secret-0001';
const CANARY_ERROR = 'canary-error-message-0002';

/**
 * A capability plugin that contributes two health indicators: one that
 * resolves with a canary secret in `data`, one that rejects with a canary
 * error. These are the exact values the minimization seam must never carry.
 */
const indicatorCalls: Record<string, number> = { 'db.check': 0, 'cache.check': 0 };

function canaryContributor(): IPlugin {
  return {
    name: 'canary-contributor',
    version: '1.0.0',
    register(ctx) {
      ctx.health.register('db.check', () => {
        indicatorCalls['db.check'] += 1;
        return Promise.resolve({ status: 'up', data: { credential: CANARY_DATA } });
      });
      ctx.health.register('cache.check', () => {
        indicatorCalls['cache.check'] += 1;
        return Promise.reject(new Error(CANARY_ERROR));
      });
    },
  };
}

/** A fetch that records every raw response body the client receives. */
function capturingFetch(frames: string[]): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    frames.push(await response.clone().text());
    return response;
  };
}

async function startHealthDiagnosticsApplication(): Promise<{
  app: ReturnType<typeof createApplication>;
  connectorPort: number;
  httpPort: number;
}> {
  const probe = Deno.listen({ port: 0, hostname: '127.0.0.1' });
  const httpPort = (probe.addr as Deno.NetAddr).port;
  probe.close();
  const connectorProbe = Deno.listen({ port: 0, hostname: '127.0.0.1' });
  const connectorPort = (connectorProbe.addr as Deno.NetAddr).port;
  connectorProbe.close();

  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      DiagnosticsPlugin({
        enabled: true,
        port: connectorPort,
        sessionId: TEST_SESSION_ID,
        sessionKey: TEST_KEY_BYTES,
      }),
      HealthPlugin({
        diagnostics: {
          enabled: true,
          indicators: { 'db.check': 'database', 'cache.check': 'cache' },
        },
      }),
      canaryContributor(),
    ],
    diagnostics: {},
  });
  await app.start({ port: httpPort, hostname: '127.0.0.1' });
  return { app, connectorPort, httpPort };
}

describe('Health observations e2e (M98d canary)', () => {
  it('minimizes health observations end to end: canary absent at every layer, status present', async () => {
    const { app, connectorPort, httpPort } = await startHealthDiagnosticsApplication();
    try {
      // Drive a real health check through the application's own endpoint so
      // the collector observes the settled indicators (reported + failed).
      const health = await fetch(`http://127.0.0.1:${httpPort}/health`);
      // The rejecting indicator makes the aggregate status `down`, which the
      // health plugin maps to 503 — the correct readiness behavior.
      expect(health.status).toEqual(503);

      const callsAfterCheck = { ...indicatorCalls };
      const frames: string[] = [];
      const client = createDiagnosticsClient({
        endpoint: `http://127.0.0.1:${connectorPort}`,
        sessionId: TEST_SESSION_ID,
        sessionKey: TEST_KEY_BYTES,
        subtle: crypto.subtle,
        fetch: capturingFetch(frames),
        timing: { setTimeout, clearTimeout },
      });
      const instanceId = (await client.snapshot()).instanceId as string;

      // The source (resolved under its capability) reports the minimized
      // snapshot: useful status present, canary absent. A single fresh check
      // leaves both observations current, so the inspector state is `ready`.
      const source = app.services.get(CAPABILITIES.HEALTH_DIAGNOSTICS) as {
        snapshot: (instanceId: string) => {
          state: string;
          observations: { indicatorAlias: string; state: string; status?: string }[];
        };
      };
      const sourceSnapshot = source.snapshot(instanceId);
      expect(sourceSnapshot.state).toBe('ready');
      expect(JSON.stringify(sourceSnapshot)).not.toContain(CANARY_DATA);
      expect(JSON.stringify(sourceSnapshot)).not.toContain(CANARY_ERROR);

      // The signed wire frame and the client DTO carry the same minimization:
      // the useful status remains, the canary is absent.
      const healthSnapshot = await client.health();
      await client.health();
      await client.health();
      client.close();

      // Three diagnostic reads ran no indicator: the counts are exactly what
      // the one /health request produced.
      expect(indicatorCalls).toEqual(callsAfterCheck);
      expect(callsAfterCheck).toEqual({ 'db.check': 1, 'cache.check': 1 });

      // The RAW bytes the connector signed and sent — below the client's own
      // parsing — carry neither canary, nor the registered indicator names.
      const healthFrames = frames.filter((frame) => frame.includes('indicatorAlias'));
      expect(healthFrames.length).toBe(3);
      const raw = frames.join('\n');
      expect(raw).not.toContain(CANARY_DATA);
      expect(raw).not.toContain(CANARY_ERROR);
      expect(raw).not.toContain('db.check');
      expect(raw).not.toContain('cache.check');

      expect(healthSnapshot.version).toEqual(1);
      expect(healthSnapshot.instanceId).toEqual(instanceId);
      const database = healthSnapshot.observations.find((o) => o.indicatorAlias === 'database');
      const cache = healthSnapshot.observations.find((o) => o.indicatorAlias === 'cache');
      expect(database?.state).toBe('reported');
      expect(database?.status).toBe('up');
      expect(cache?.state).toBe('failed');
      const wire = JSON.stringify(healthSnapshot);
      expect(wire).not.toContain(CANARY_DATA);
      expect(wire).not.toContain(CANARY_ERROR);
    } finally {
      await app.stop();
    }
  });

  it('keeps a healthy scheduled indicator fresh while another one hangs (real timers)', async () => {
    const connectorProbe = Deno.listen({ port: 0, hostname: '127.0.0.1' });
    const connectorPort = (connectorProbe.addr as Deno.NetAddr).port;
    connectorProbe.close();
    const calls = { hung: 0, ok: 0 };
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DiagnosticsPlugin({
          enabled: true,
          port: connectorPort,
          sessionId: TEST_SESSION_ID,
          sessionKey: TEST_KEY_BYTES,
        }),
        HealthPlugin({
          indicators: [
            {
              name: 'hung.check',
              check: () => {
                calls.hung += 1;
                return new Promise(() => {});
              },
            },
            {
              name: 'ok.check',
              check: () => {
                calls.ok += 1;
                return Promise.resolve({ status: 'up' });
              },
            },
          ],
          diagnostics: {
            enabled: true,
            indicators: { 'hung.check': 'hung', 'ok.check': 'ok' },
            scheduled: {
              indicators: ['hung.check', 'ok.check'],
              intervalMs: 1000,
              timeoutMs: 50,
              concurrency: 2,
            },
          },
        }),
      ],
      diagnostics: {},
    });
    await app.start();
    try {
      // Cycles at ~0 ms, ~1000 ms and ~2000 ms.
      await new Promise((resolve) => setTimeout(resolve, 2_300));
      const client = createDiagnosticsClient({
        endpoint: `http://127.0.0.1:${connectorPort}`,
        sessionId: TEST_SESSION_ID,
        sessionKey: TEST_KEY_BYTES,
        subtle: crypto.subtle,
        fetch,
        timing: { setTimeout, clearTimeout },
      });
      const health = await client.health();
      client.close();
      // The hung callback was never replaced; the healthy one ran on every
      // cycle and its observation is recent, not stuck at the first cycle.
      expect(calls.hung).toBe(1);
      expect(calls.ok).toBeGreaterThanOrEqual(3);
      const [hung, ok] = health.observations;
      expect(hung.state).toBe('timed-out');
      expect(ok.state).toBe('reported');
      expect(ok.origin).toBe('scheduled');
      expect(ok.ageMs!).toBeLessThan(1_000);
    } finally {
      await app.stop();
    }
    // After stop the scheduler is gone: no further indicator calls.
    const stopped = { ...calls };
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(calls).toEqual(stopped);
  });

  it('answers an unsupported health read through the connector when no health plugin is present', async () => {
    const probe = Deno.listen({ port: 0, hostname: '127.0.0.1' });
    const connectorPort = (probe.addr as Deno.NetAddr).port;
    probe.close();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DiagnosticsPlugin({
          enabled: true,
          port: connectorPort,
          sessionId: TEST_SESSION_ID,
          sessionKey: TEST_KEY_BYTES,
        }),
      ],
      diagnostics: {},
    });
    await app.start({ port: 0, hostname: '127.0.0.1' });
    try {
      const client = createDiagnosticsClient({
        endpoint: `http://127.0.0.1:${connectorPort}`,
        sessionId: TEST_SESSION_ID,
        sessionKey: TEST_KEY_BYTES,
        subtle: crypto.subtle,
        fetch,
        timing: { setTimeout, clearTimeout },
      });
      const health = await client.health();
      client.close();
      // The manifest advertises health as implemented (the connector ships the
      // operation); with no registered source the connector answers a typed
      // unsupported snapshot, not an error and not an empty 404.
      expect(health.state).toBe('unsupported');
      expect(health.observations).toEqual([]);
    } finally {
      await app.stop();
    }
  });
});
