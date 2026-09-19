#!/usr/bin/env -S deno run --allow-read --allow-env
// deno-lint-ignore-file no-console -- console output is the script's purpose (AI_GUIDELINES §11.6)
/**
 * Paired throughput/latency benchmark for kernel diagnostics (M98a §3.6).
 *
 * Runs the SAME composed application in two modes — `--mode=disabled` (no
 * diagnostics option: no collector, no instrumentation on any path) and
 * `--mode=enabled` (explicit `diagnostics` option) — and reports per-request
 * throughput plus median and p95 latency across a synchronous route and an
 * async route with five middleware stages.
 *
 * Acceptance budget (plan §3.6): on the same machine/runtime after a fixed
 * warm-up, the enabled median must be ≥90% of the DISABLED-against-PRE-CHANGE
 * baseline and the disabled run of THIS tree ≥98% of that baseline; p95 at
 * most 110%. The baseline harness copy and its output are archived under
 * `.tmp/` by the verification run; a miss is work to resolve, not a budget
 * to weaken.
 *
 * Usage:
 *   deno run --allow-read --allow-env scripts/benchmark-kernel-diagnostics.ts --mode=disabled
 *   deno run --allow-read --allow-env scripts/benchmark-kernel-diagnostics.ts --mode=enabled
 *
 * @module
 */

import { CAPABILITIES } from '@setu-ts/common';
import type { IPlugin } from '@setu-ts/common';
import { createApplication } from '../packages/kernel/src/index.ts';
import type { IKernelApplication } from '../packages/kernel/src/index.ts';
import { createFakeRuntime } from '../packages/kernel/test/fixtures/fake-runtime.ts';

const args = new Map(Deno.args.map((arg) => {
  const [key, value] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));
const mode = args.get('mode') ?? 'disabled';
if (mode !== 'disabled' && mode !== 'enabled') {
  console.error(`unknown mode '${mode}': expected --mode=disabled or --mode=enabled`);
  Deno.exit(2);
}

const WARMUP_REQUESTS = 2_000;
const MAX_MEASURED_REQUESTS = 20_000;
const WINDOW_MS = 10_000;

/** An empty synchronous route and an async route with five middleware stages. */
function buildApp(diagnostics: Record<string, never> | undefined): IKernelApplication {
  const fake = createFakeRuntime();
  const runtime: IPlugin = {
    name: 'bench-runtime',
    version: '1.0.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx) {
      ctx.services.register(CAPABILITIES.RUNTIME, fake.runtime);
    },
  };
  return createApplication({
    plugins: [
      runtime,
      {
        name: 'bench',
        version: '1.0.0',
        register(ctx) {
          ctx.router.get('/sync', (ctx) => ctx.response.json({ route: 'sync' }));
          ctx.router.get('/async', {
            handler: async (ctx) => {
              await Promise.resolve();
              return ctx.response.json({ route: 'async' });
            },
            middleware: [
              (_ctx, next) => next(),
              (_ctx, next) => next(),
              (_ctx, next) => next(),
              (_ctx, next) => next(),
              (_ctx, next) => next(),
            ],
          });
        },
      },
    ],
    ...(diagnostics !== undefined ? { diagnostics } : {}),
  });
}

interface RunResult {
  readonly mode: string;
  readonly served: number;
  readonly throughputPerSecond: number;
  readonly medianMs: number;
  readonly p95Ms: number;
}

/** Warms up, then measures until the request count or the window expires. */
async function run(): Promise<RunResult> {
  const app = buildApp(mode === 'enabled' ? {} : undefined);
  await app.start();
  for (let i = 0; i < WARMUP_REQUESTS; i++) {
    await app.inject({ method: 'GET', url: i % 2 === 0 ? '/sync' : '/async' });
  }
  const latencies: number[] = [];
  const started = performance.now();
  let served = 0;
  while (served < MAX_MEASURED_REQUESTS && performance.now() - started < WINDOW_MS) {
    const at = performance.now();
    const response = await app.inject({
      method: 'GET',
      url: served % 2 === 0 ? '/sync' : '/async',
    });
    if (response.statusCode !== 200) {
      console.error(`unexpected status ${response.statusCode} — aborting run`);
      Deno.exit(1);
    }
    latencies.push(performance.now() - at);
    served++;
  }
  const elapsedMs = performance.now() - started;
  await app.stop();
  const sorted = [...latencies].sort((a, b) => a - b);
  const percentile = (fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
  return {
    mode,
    served,
    throughputPerSecond: Number((served / (elapsedMs / 1000)).toFixed(1)),
    medianMs: Number(percentile(0.5).toFixed(3)),
    p95Ms: Number(percentile(0.95).toFixed(3)),
  };
}

const result = await run();
console.log(JSON.stringify(result, null, 2));
