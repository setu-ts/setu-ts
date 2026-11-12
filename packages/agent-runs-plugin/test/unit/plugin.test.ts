import { describe, it, expect, vi } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import {
  DatabasePlugin,
  createDatabaseAgentRunStore,
  createDatabaseIdempotencyStore,
} from '@setu-ts/database-plugin';
import { IdempotencyPlugin } from '@setu-ts/idempotency-plugin';
import { CAPABILITIES } from '@setu-ts/common';
import type { IAgentRunService, IIdempotencyService } from '@setu-ts/common';
import { MockServiceRegistry } from '@setu-ts/testing';
import { AgentRunsPlugin } from '../../src/index.ts';
import { definition, harness } from '../fixtures/harness.ts';
describe('AgentRunsPlugin', () => {
  it.each(['plain plugin', 'missing member'])(
    'M139c refuses startup with %s before registering agent runs',
    async (kind) => {
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          DatabasePlugin({ type: 'memory' }),
          kind === 'plain plugin'
            ? IdempotencyPlugin()
            : {
                name: 'old-idempotency',
                version: '1',
                provides: [CAPABILITIES.IDEMPOTENCY],
                register(ctx) {
                  ctx.services.register(CAPABILITIES.IDEMPOTENCY, {} as IIdempotencyService);
                },
              },
          AgentRunsPlugin({ store: createDatabaseAgentRunStore(), definitions: [definition()] }),
        ],
      });
      try {
        await expect(app.start()).rejects.toThrow(
          'Agent runs: register IdempotencyPlugin with a transactional store (transactional: { store: createDatabaseIdempotencyStore(), purge: { schedule: false } }, or register a scheduler) before this plugin.',
        );
        expect(app.services.has(CAPABILITIES.AGENT_RUNS)).toBe(false);
      } finally {
        await app.stop();
      }
    },
  );
  it('runs the sweep timer and masks its error with or without a logger', async () => {
    const h = await harness();
    try {
      for (const hasLogger of [false, true]) {
        const services = new MockServiceRegistry();
        services.register(CAPABILITIES.IDEMPOTENCY, h.deps.idempotency);
        const warn = vi.fn();
        const logger = {
          trace: vi.fn(),
          debug: vi.fn(),
          info: vi.fn(),
          warn,
          error: vi.fn(),
          fatal: vi.fn(),
          child() {
            return this;
          },
          level: 'info' as const,
        };
        if (hasLogger) services.register(CAPABILITIES.LOGGER, logger);
        const closes: (() => void | Promise<void>)[] = [];
        await AgentRunsPlugin({
          store: h.store,
          definitions: [definition()],
          background: () => {},
        }).register({
          ...h.pluginContext,
          runtime: h.runtime,
          services,
          lifecycle: {
            ...h.pluginContext.lifecycle,
            onClose: (fn) => {
              closes.push(fn);
            },
          },
        });
        const service = services.get<IAgentRunService>(CAPABILITIES.AGENT_RUNS);
        vi.spyOn(service, 'sweep').mockRejectedValue(new Error('private'));
        h.fire(5000);
        for (let n = 0; n < 10; n++) await Promise.resolve();
        expect(warn).toHaveBeenCalledTimes(hasLogger ? 1 : 0);
        for (const close of closes) await close();
        expect(h.timers.size).toBe(0);
      }
    } finally {
      await h.close();
    }
  });
  it('validates every numeric option and package identity synchronously', () => {
    const store = createDatabaseAgentRunStore();
    const base = { store, definitions: [definition()] };
    for (const key of [
      'leaseMs',
      'maxClockSkewMs',
      'sweepIntervalMs',
      'sweepBatch',
      'retentionMs',
      'flushIntervalMs',
      'flushChunks',
      'maxLogBytes',
      'pollIntervalMs',
      'maxInputBytes',
    ])
      for (const value of [NaN, Infinity, -1, 0.5])
        expect(() => AgentRunsPlugin({ ...base, [key]: value })).toThrow();
    for (const input of [
      null,
      {},
      { ...base, definitions: [] },
      { ...base, definitions: [definition(), definition()] },
      { ...base, store: {} },
      { ...base, background: false },
      { ...base, leaseMs: 2 },
      { ...base, maxClockSkewMs: 60001 },
    ])
      expect(() => AgentRunsPlugin(input as never)).toThrow();
    const plugin = AgentRunsPlugin(base);
    expect(plugin.provides).toEqual([CAPABILITIES.AGENT_RUNS]);
    expect(plugin.dependencies).toEqual([CAPABILITIES.RUNTIME, CAPABILITIES.IDEMPOTENCY]);
  });
  it('registers a real store and SDK; close clears the interval', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DatabasePlugin({ type: 'memory' }),
        IdempotencyPlugin({
          transactional: { store: createDatabaseIdempotencyStore(), purge: { schedule: false } },
        }),
        AgentRunsPlugin({ store: createDatabaseAgentRunStore(), definitions: [definition()] }),
      ],
    });
    try {
      await app.start();
      expect(app.services.get<IAgentRunService>(CAPABILITIES.AGENT_RUNS)).toHaveProperty('start');
    } finally {
      await app.stop();
    }
  });
  it('registers close before verify and handles store refusal', async () => {
    const h = await harness();
    try {
      const verify = vi.spyOn(h.store, 'verify').mockRejectedValue(new Error('unsupported'));
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          {
            name: 'idem',
            version: '1',
            provides: [CAPABILITIES.IDEMPOTENCY],
            register(ctx) {
              ctx.services.register(CAPABILITIES.IDEMPOTENCY, h.deps.idempotency);
            },
          },
          AgentRunsPlugin({ store: h.store, definitions: [definition()], sweepIntervalMs: 0 }),
        ],
      });
      await expect(app.start()).rejects.toThrow('unsupported');
      await app.stop();
      expect(verify).toHaveBeenCalledOnce();
    } finally {
      await h.close();
    }
  });
});
