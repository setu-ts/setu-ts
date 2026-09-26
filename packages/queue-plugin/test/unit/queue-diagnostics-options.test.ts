/**
 * M98f — validation of the opt-in queue-observation options. Every refusal is
 * a fixed, value-free `RangeError` raised when `QueuePlugin(...)` is called,
 * before any application exists; an alias is judged by its SHAPE alone.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  compileQueueDiagnosticsPolicy,
  QUEUE_COLLECTOR_ERRORS,
} from '../../src/diagnostics/queue-observation-collector.ts';
import type { QueueDiagnosticsOptions } from '../../src/interfaces/index.ts';
import { QueuePlugin } from '../../src/plugin/queue-plugin.ts';

const CANARY = 'canary-alias-value-SYNTHETIC';

/** A minimal valid option set, overridable per case. */
function options(overrides: Record<string, unknown> = {}): QueueDiagnosticsOptions {
  return {
    enabled: true,
    instanceAlias: 'orders-worker',
    queues: { 'email.send': 'email', 'image.resize': 'images' },
    ...overrides,
  } as unknown as QueueDiagnosticsOptions;
}

/** Asserts a fixed refusal whose message does not echo the canary. */
function expectRefusal(value: unknown, message: string): void {
  let caught: unknown;
  try {
    compileQueueDiagnosticsPolicy(value as QueueDiagnosticsOptions);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RangeError);
  expect((caught as Error).message).toBe(message);
  expect((caught as Error).message).not.toContain(CANARY);
}

describe('compileQueueDiagnosticsPolicy', () => {
  it('compiles a valid policy, keeping declared order and no depth policy by default', () => {
    const policy = compileQueueDiagnosticsPolicy(options());
    expect(policy.instanceAlias).toBe('orders-worker');
    expect(policy.names).toEqual(['email.send', 'image.resize']);
    expect(policy.aliasByName.get('image.resize')).toBe('images');
    expect(policy.depths).toBeNull();
  });

  it('compiles a depth policy at both inclusive bounds', () => {
    expect(
      compileQueueDiagnosticsPolicy(
        options({ depths: { intervalMs: 1_000, timeoutMs: 1, concurrency: 1 } }),
      ).depths,
    ).toEqual({ intervalMs: 1_000, timeoutMs: 1, concurrency: 1 });
    expect(
      compileQueueDiagnosticsPolicy(
        options({ depths: { intervalMs: 300_000, timeoutMs: 30_000, concurrency: 4 } }),
      ).depths,
    ).toEqual({ intervalMs: 300_000, timeoutMs: 30_000, concurrency: 4 });
  });

  it('accepts an alias of exactly 64 UTF-8 bytes, and aliases that merely look sensitive', () => {
    const sixtyFour = 'é'.repeat(32); // 2 bytes each
    const policy = compileQueueDiagnosticsPolicy(
      options({
        instanceAlias: sixtyFour,
        queues: { a: 'redis://host:6379', b: 'Bearer token-looking' },
      }),
    );
    expect(policy.instanceAlias).toBe(sixtyFour);
    expect(policy.aliasByName.get('a')).toBe('redis://host:6379');
  });

  it('refuses a non-object option, an absent or false opt-in', () => {
    expectRefusal(null, QUEUE_COLLECTOR_ERRORS.badOptions);
    expectRefusal([CANARY], QUEUE_COLLECTOR_ERRORS.badOptions);
    expectRefusal(options({ enabled: false }), QUEUE_COLLECTOR_ERRORS.notEnabled);
    expectRefusal(options({ enabled: CANARY }), QUEUE_COLLECTOR_ERRORS.notEnabled);
  });

  it('refuses a missing, empty, oversized or control-bearing instance alias', () => {
    expectRefusal(options({ instanceAlias: 7 }), QUEUE_COLLECTOR_ERRORS.badInstanceAlias);
    expectRefusal(options({ instanceAlias: '' }), QUEUE_COLLECTOR_ERRORS.aliasBytes);
    expectRefusal(options({ instanceAlias: 'x'.repeat(65) }), QUEUE_COLLECTOR_ERRORS.aliasBytes);
    expectRefusal(
      options({ instanceAlias: `${CANARY}\n` }),
      QUEUE_COLLECTOR_ERRORS.aliasControl,
    );
    expectRefusal(
      options({ instanceAlias: `a\u0085b` }),
      QUEUE_COLLECTOR_ERRORS.aliasControl,
    );
  });

  it('refuses a malformed queue map', () => {
    expectRefusal(options({ queues: undefined }), QUEUE_COLLECTOR_ERRORS.badQueues);
    expectRefusal(options({ queues: [CANARY] }), QUEUE_COLLECTOR_ERRORS.badQueues);
    expectRefusal(options({ queues: { a: 1 } }), QUEUE_COLLECTOR_ERRORS.badQueues);
    const tooMany = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`job-${index}`, `alias-${index}`]),
    );
    expectRefusal(options({ queues: tooMany }), QUEUE_COLLECTOR_ERRORS.tooManyQueues);
  });

  it('refuses an empty, 65-byte, control-bearing or duplicate queue alias', () => {
    expectRefusal(options({ queues: { a: '' } }), QUEUE_COLLECTOR_ERRORS.aliasBytes);
    expectRefusal(options({ queues: { a: 'x'.repeat(65) } }), QUEUE_COLLECTOR_ERRORS.aliasBytes);
    expectRefusal(options({ queues: { a: `x\u001by` } }), QUEUE_COLLECTOR_ERRORS.aliasControl);
    expectRefusal(
      options({ queues: { a: CANARY, b: CANARY } }),
      QUEUE_COLLECTOR_ERRORS.duplicateAlias,
    );
  });

  it('accepts exactly 64 approved queues', () => {
    const sixtyFour = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [`job-${index}`, `alias-${index}`]),
    );
    expect(compileQueueDiagnosticsPolicy(options({ queues: sixtyFour })).names.length).toBe(64);
  });

  it('refuses a malformed depth policy on every bound', () => {
    const depths = (value: Record<string, unknown>) =>
      options({ depths: { intervalMs: 1_000, timeoutMs: 100, concurrency: 1, ...value } });
    expectRefusal(options({ depths: CANARY }), QUEUE_COLLECTOR_ERRORS.badDepths);
    expectRefusal(depths({ intervalMs: 999 }), QUEUE_COLLECTOR_ERRORS.badInterval);
    expectRefusal(depths({ intervalMs: 300_001 }), QUEUE_COLLECTOR_ERRORS.badInterval);
    expectRefusal(depths({ intervalMs: 1_000.5 }), QUEUE_COLLECTOR_ERRORS.badInterval);
    expectRefusal(depths({ timeoutMs: 0 }), QUEUE_COLLECTOR_ERRORS.badTimeout);
    expectRefusal(depths({ timeoutMs: 30_001 }), QUEUE_COLLECTOR_ERRORS.badTimeout);
    expectRefusal(depths({ timeoutMs: Number.NaN }), QUEUE_COLLECTOR_ERRORS.badTimeout);
    expectRefusal(depths({ concurrency: 0 }), QUEUE_COLLECTOR_ERRORS.badConcurrency);
    expectRefusal(depths({ concurrency: 5 }), QUEUE_COLLECTOR_ERRORS.badConcurrency);
  });

  it('is enforced when QueuePlugin(...) is called, before any application exists', () => {
    expect(() =>
      QueuePlugin({
        adapter: 'memory',
        diagnostics: { enabled: false } as unknown as QueueDiagnosticsOptions,
      })
    ).toThrow(QUEUE_COLLECTOR_ERRORS.notEnabled);
    expect(() => QueuePlugin({ adapter: 'memory', diagnostics: options() })).not.toThrow();
  });
});
