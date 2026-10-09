/**
 * The tier-C plugin wiring (M109b §3.5): factory resolution with
 * `DatabasePlugin` registered before or after, the verify refusal and its
 * timeout, the missing-scheduler refusal, the scheduled purge (and its
 * removal), and the unconfigured refusals.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  IIdempotencyService,
  ILogger,
  IPlugin,
  IPluginContext,
  IScheduler,
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createDatabaseIdempotencyStore, DatabasePlugin } from '@setu-ts/database-plugin';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { IdempotencyConfigurationError, IdempotencyPlugin } from '../../src/index.ts';
import type { IdempotencyVerifyTimeoutError } from '../../src/index.ts';
import { fakeTransactionalStore } from '../fixtures/fake-transactional-store.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => resolve = r);
  return { promise, resolve };
}

function purgeLogger() {
  const lines: { level: string; message: string }[] = [];
  const logger = {
    level: 'debug',
    debug: (message: string) => lines.push({ level: 'debug', message }),
    info: () => {},
    warn: (message: string) => lines.push({ level: 'warn', message }),
    error: () => {},
  } as unknown as ILogger;
  const plugin: IPlugin = {
    name: 'purge-test-logger',
    version: '1.0.0',
    provides: [CAPABILITIES.LOGGER],
    register(ctx) {
      ctx.services.register(CAPABILITIES.LOGGER, logger);
    },
  };
  return { plugin, lines };
}

/** A fake scheduler recording every job, so the purge is driven at once. */
function fakeSchedulerPlugin(): {
  readonly plugin: IPlugin;
  readonly jobs: Map<string, (payload?: unknown) => unknown>;
  readonly intervals: Map<string, number>;
  readonly removed: string[];
} {
  const jobs = new Map<string, (payload?: unknown) => unknown>();
  const intervals = new Map<string, number>();
  const removed: string[] = [];
  const scheduler = {
    cron: () => Promise.reject(new Error('cron is not used')),
    every: (name: string, intervalMs: number, handler: (payload?: unknown) => unknown) => {
      intervals.set(name, intervalMs);
      jobs.set(name, handler);
      return Promise.resolve();
    },
    delay: () => Promise.reject(new Error('delay is not used')),
    pause: () => Promise.reject(new Error('pause is not used')),
    resume: () => Promise.reject(new Error('resume is not used')),
    remove: (name: string) => {
      removed.push(name);
      jobs.delete(name);
      return Promise.resolve();
    },
    getNextRun: () => Promise.reject(new Error('getNextRun is not used')),
  } as unknown as IScheduler;
  const plugin: IPlugin = {
    name: 'fake-tier-c-scheduler',
    version: '1.0.0',
    provides: [CAPABILITIES.SCHEDULER],
    register(ctx: IPluginContext): void {
      ctx.services.register(CAPABILITIES.SCHEDULER, scheduler);
    },
  };
  return { plugin, jobs, intervals, removed };
}

/** A plugin capturing the idempotency service once every provider registered. */
function capturePlugin(): {
  readonly plugin: IPlugin;
  readonly service: () => IIdempotencyService;
} {
  let captured: IIdempotencyService | undefined;
  const plugin: IPlugin = {
    name: 'tier-c-capture',
    version: '1.0.0',
    register(ctx: IPluginContext): void {
      captured = ctx.services.get<IIdempotencyService>(CAPABILITIES.IDEMPOTENCY);
    },
  };
  return {
    plugin,
    service: () => {
      if (captured === undefined) throw new Error('the idempotency service was not registered');
      return captured;
    },
  };
}

describe('IdempotencyPlugin transactional wiring (M109b §3.5)', () => {
  it('logs a store rejection separately and releases the scheduled purge guard', async () => {
    const scheduler = fakeSchedulerPlugin();
    const logger = purgeLogger();
    let calls = 0;
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        scheduler.plugin,
        logger.plugin,
        IdempotencyPlugin({
          transactional: {
            store: fakeTransactionalStore({
              purge: () => {
                calls++;
                return calls === 1
                  ? Promise.reject(new Error('PRIVATE STORE DATA'))
                  : Promise.resolve(1);
              },
            }),
          },
        }),
      ],
    });
    await app.start();
    try {
      const job = scheduler.jobs.get('idempotency-purge')!;
      const failure = await Promise.resolve(job()).catch((error: unknown) => error);
      expect((failure as Error).message).not.toContain('PRIVATE STORE DATA');
      expect(logger.lines).toEqual([
        { level: 'warn', message: 'idempotency: the transactional purge failed' },
      ]);
      await job();
      expect(calls).toBe(2);
    } finally {
      await app.stop();
    }
  });

  it('skips overlapping scheduled purges even after the first deadline expires', async () => {
    const scheduler = fakeSchedulerPlugin();
    const logger = purgeLogger();
    const release = deferred();
    let calls = 0;
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        scheduler.plugin,
        logger.plugin,
        IdempotencyPlugin({
          transactional: {
            store: fakeTransactionalStore({
              purge: async () => {
                calls++;
                if (calls === 1) await release.promise;
                return 1;
              },
            }),
            storeTimeoutMs: 20,
          },
        }),
      ],
    });
    await app.start();
    const job = scheduler.jobs.get('idempotency-purge')!;
    try {
      const failure = await Promise.resolve(job()).catch((error: unknown) => error);
      expect((failure as { reason: string }).reason).toBe('store-failed');
      for (let i = 0; i < 3; i++) await job();
      expect(calls).toBe(1);
      expect(logger.lines.filter((line) => line.level === 'debug')).toHaveLength(3);
      expect(logger.lines.filter((line) => line.level === 'warn')).toEqual([
        { level: 'warn', message: 'idempotency: the transactional purge timed out' },
      ]);
      release.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await job();
      expect(calls).toBe(2);
    } finally {
      release.resolve();
      await app.stop();
    }
  });

  it('shutdown awaits the in-flight scheduled purge before closing', async () => {
    const scheduler = fakeSchedulerPlugin();
    const started = deferred();
    const release = deferred();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        scheduler.plugin,
        IdempotencyPlugin({
          transactional: {
            store: fakeTransactionalStore({
              purge: async () => {
                started.resolve();
                await release.promise;
                return 1;
              },
            }),
            storeTimeoutMs: 1_000,
          },
        }),
      ],
    });
    await app.start();
    const running = Promise.resolve(scheduler.jobs.get('idempotency-purge')!());
    await started.promise;
    let stopped = false;
    const stopping = app.stop().then(() => {
      stopped = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(stopped).toBe(false);
    } finally {
      release.resolve();
      await running;
      await stopping;
    }
    expect(stopped).toBe(true);
  });

  it('bounds shutdown waiting when an in-flight purge never answers', async () => {
    const scheduler = fakeSchedulerPlugin();
    const logger = purgeLogger();
    const started = deferred();
    const release = deferred();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        scheduler.plugin,
        logger.plugin,
        IdempotencyPlugin({
          transactional: {
            store: fakeTransactionalStore({
              purge: async () => {
                started.resolve();
                await release.promise;
                return 1;
              },
            }),
            storeTimeoutMs: 20,
          },
        }),
      ],
    });
    await app.start();
    const job = scheduler.jobs.get('idempotency-purge')!;
    const running = Promise.resolve(job()).catch((error: unknown) => error);
    await started.promise;
    try {
      await app.stop();
      expect(scheduler.removed).toContain('idempotency-purge');
      expect(logger.lines.some((line) =>
        line.message ===
          'idempotency: the transactional purge timed out'
      )).toBe(true);
      await job();
    } finally {
      release.resolve();
      await running;
    }
  });

  it('resolves the store factory with DatabasePlugin registered AFTER the plugin', async () => {
    const capture = capturePlugin();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        fakeSchedulerPlugin().plugin,
        IdempotencyPlugin({
          transactional: { store: createDatabaseIdempotencyStore(), purge: { schedule: false } },
        }),
        DatabasePlugin({ type: 'memory' }),
        capture.plugin,
      ],
    });
    await app.start();
    try {
      const result = await capture.service().within<number, unknown>(
        { key: 'k-1', namespace: 'orders', scope: 't:u' },
        () => Promise.resolve(5),
      );
      expect(result).toEqual({ value: 5, replayed: false });
    } finally {
      await app.stop();
    }
  });

  it('resolves the store factory with DatabasePlugin registered BEFORE the plugin', async () => {
    const capture = capturePlugin();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DatabasePlugin({ type: 'memory' }),
        fakeSchedulerPlugin().plugin,
        IdempotencyPlugin({
          transactional: { store: createDatabaseIdempotencyStore(), purge: { schedule: false } },
        }),
        capture.plugin,
      ],
    });
    await app.start();
    try {
      expect(await capture.service().purgeTransactional()).toBe(0);
    } finally {
      await app.stop();
    }
  });

  it('rejects start() when a scheduled purge has no scheduler', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        IdempotencyPlugin({ transactional: { store: fakeTransactionalStore() } }),
      ],
    });
    const failure = await app.start().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(IdempotencyConfigurationError);
    expect((failure as IdempotencyConfigurationError).option).toBe('transactional.purge.schedule');
  });

  it('rejects start() with the store refusal unchanged', async () => {
    const refusal = new Error('the backend cannot serve tier C');
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        IdempotencyPlugin({
          transactional: {
            store: fakeTransactionalStore({ verify: () => Promise.reject(refusal) }),
            purge: { schedule: false },
          },
        }),
      ],
    });
    expect(await app.start().catch((error: unknown) => error)).toBe(refusal);
  });

  it('rejects start() with IdempotencyVerifyTimeoutError when verify hangs', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        IdempotencyPlugin({
          transactional: {
            store: fakeTransactionalStore({ verify: () => new Promise(() => {}) }),
            storeTimeoutMs: 20,
            purge: { schedule: false },
          },
        }),
      ],
    });
    const failure = await app.start().catch((error: unknown) => error);
    expect((failure as IdempotencyVerifyTimeoutError).name).toBe(
      'IdempotencyVerifyTimeoutError',
    );
  });

  it('schedules the purge, runs it, and removes the job at shutdown', async () => {
    const scheduler = fakeSchedulerPlugin();
    const purges: [number, number][] = [];
    const store = fakeTransactionalStore({
      purge: (before, limit) => {
        purges.push([before, limit]);
        return Promise.resolve(2);
      },
    });
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        scheduler.plugin,
        IdempotencyPlugin({
          transactional: { store, purge: { intervalMs: 1_234, batch: 7 } },
        }),
      ],
    });
    await app.start();
    try {
      expect(scheduler.intervals.get('idempotency-purge')).toBe(1_234);
      const job = scheduler.jobs.get('idempotency-purge');
      expect(job).toBeDefined();
      await job?.();
      expect(purges).toHaveLength(1);
      expect(purges[0][1]).toBe(7);
      expect(purges[0][0]).toBeGreaterThan(0);
    } finally {
      await app.stop();
    }
    expect(scheduler.removed).toContain('idempotency-purge');
  });

  it('refuses within and purgeTransactional when the option is absent', async () => {
    const capture = capturePlugin();
    const app = createApplication({
      plugins: [RuntimePlugin(), IdempotencyPlugin(), capture.plugin],
    });
    await app.start();
    try {
      const withinFailure = await capture.service()
        .within({ key: 'k', namespace: 'n', scope: 's' }, () => Promise.resolve(1))
        .catch((error: unknown) => error);
      expect((withinFailure as IdempotencyConfigurationError).option).toBe('transactional');
      const purgeFailure = await capture.service().purgeTransactional().catch(
        (error: unknown) => error,
      );
      expect((purgeFailure as IdempotencyConfigurationError).option).toBe('transactional');
    } finally {
      await app.stop();
    }
  });

  it('rejects purgeTransactional as store-failed when the store refuses', async () => {
    const capture = capturePlugin();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        fakeSchedulerPlugin().plugin,
        IdempotencyPlugin({
          transactional: {
            store: fakeTransactionalStore({ purge: () => Promise.reject(new Error('SECRET')) }),
            purge: { schedule: false },
          },
        }),
        capture.plugin,
      ],
    });
    await app.start();
    try {
      const failure = await capture.service().purgeTransactional().catch((error: unknown) => error);
      expect((failure as { readonly reason?: string }).reason).toBe('store-failed');
      expect((failure as Error).message).not.toContain('SECRET');
    } finally {
      await app.stop();
    }
  });

  it('rejects purgeTransactional as store-failed when the purge hangs', async () => {
    const capture = capturePlugin();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        fakeSchedulerPlugin().plugin,
        IdempotencyPlugin({
          transactional: {
            store: fakeTransactionalStore({ purge: () => new Promise(() => {}) }),
            storeTimeoutMs: 20,
            purge: { schedule: false },
          },
        }),
        capture.plugin,
      ],
    });
    await app.start();
    try {
      const failure = await capture.service().purgeTransactional().catch((error: unknown) => error);
      expect((failure as { readonly name?: string }).name).toBe('IdempotencyWithinError');
      expect((failure as { readonly reason?: string }).reason).toBe('store-failed');
    } finally {
      await app.stop();
    }
  });
});
