import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  readSizingOptions,
  resolveMaxWorkers,
  validateSizingOptions,
} from '../../src/services/sizing.ts';
import { WorkerPoolPlugin, WorkerPoolService } from '../../src/index.ts';
import type { WorkerPoolPluginOptions } from '../../src/index.ts';
import { budgetLimitOf } from '../../src/services/worker-pool-service.ts';
import { createFakeRuntime, FakeHost, FakeTimers } from '../fixtures/fakes.ts';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import type { IWorkerPool } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';

describe('worker sizing', () => {
  it('refuses a non-number maxWorkers with the documented RangeError, Symbol included', () => {
    // A template literal throws TypeError for a Symbol before the RangeError is built.
    for (
      const [value, rendered] of [
        [Symbol('cap'), 'Symbol(cap)'],
        ['4', '4'],
        [4n, '4'],
        [null, 'null'],
      ] as const
    ) {
      const options = { maxWorkers: value } as unknown as WorkerPoolPluginOptions;
      expect(() => validateSizingOptions(options)).toThrow(RangeError);
      expect(() => validateSizingOptions(options)).toThrow(`received ${rendered}`);
    }
  });

  it('reads each option once, so an accessor cannot change the validated value', () => {
    let reads = 0;
    const options = {
      get maxWorkers(): number {
        reads++;
        return reads === 1 ? 2 : 1e15;
      },
    };
    const service = new WorkerPoolService(options, createFakeRuntime(new FakeTimers()));
    expect(reads).toBe(1);
    expect(budgetLimitOf(service)).toBe(2);
  });

  for (const value of [0, -1, 1.5, NaN, Infinity]) {
    it(`refuses startupTimeoutMs ${value}: a startup deadline cannot be disabled`, () => {
      const options = { startupTimeoutMs: value };
      expect(() => WorkerPoolPlugin(options)).toThrow(RangeError);
      expect(() => WorkerPoolPlugin(options)).toThrow(
        `startupTimeoutMs must be a positive safe integer; received ${value}`,
      );
      expect(() => new WorkerPoolService(options, createFakeRuntime(new FakeTimers())))
        .toThrow(RangeError);
    });
  }

  it('defaults startupTimeoutMs to 10 000 ms and keeps a configured value', () => {
    expect(readSizingOptions().startupTimeoutMs).toBe(10_000);
    expect(readSizingOptions({ startupTimeoutMs: 250 }).startupTimeoutMs).toBe(250);
  });

  it('does not let an Infinity legacy pool size make the derived budget unbounded', () => {
    const options = { defaultPoolSize: Infinity, pools: { a: { size: Infinity }, b: { size: 3 } } };
    expect(resolveMaxWorkers(options, readSizingOptions(options), 4)).toBe(4);
  });

  for (const value of [NaN, 0, -1, 1.5, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    it(`refuses maxWorkers ${value} at both entry points`, () => {
      const options = { maxWorkers: value };
      for (
        const construct of [
          () => validateSizingOptions(options),
          () => WorkerPoolPlugin(options),
          () => new WorkerPoolService(options, createFakeRuntime(new FakeTimers())),
        ]
      ) {
        expect(construct).toThrow(RangeError);
        expect(construct).toThrow(`received ${value}`);
      }
    });
  }
  it('accepts omitted, positive safe integers and Infinity', () => {
    validateSizingOptions();
    validateSizingOptions({});
    for (const maxWorkers of [1, 64, Number.MAX_SAFE_INTEGER, Infinity]) {
      expect(() => validateSizingOptions({ maxWorkers })).not.toThrow();
    }
  });
  it('resolves parallelism, default size, sum of listed sizes and explicit limits', () => {
    expect(resolveMaxWorkers(undefined, readSizingOptions(undefined), 4)).toBe(4);
    expect(resolveMaxWorkers({ defaultPoolSize: 8 }, readSizingOptions({ defaultPoolSize: 8 }), 4))
      .toBe(8);
    expect(
      resolveMaxWorkers(
        { pools: { a: { size: 6 }, b: { size: 7 }, c: {} } },
        readSizingOptions({ pools: { a: { size: 6 }, b: { size: 7 }, c: {} } }),
        4,
      ),
    ).toBe(13);
    expect(
      resolveMaxWorkers(
        { maxWorkers: 1, defaultPoolSize: 8 },
        readSizingOptions({ maxWorkers: 1, defaultPoolSize: 8 }),
        4,
      ),
    ).toBe(1);
    expect(
      resolveMaxWorkers({ maxWorkers: Infinity }, readSizingOptions({ maxWorkers: Infinity }), 4),
    ).toBe(Infinity);
  });
  for (const entry of ['factory', 'service']) {
    it(`keeps valid modules usable with NaN legacy sizes through ${entry}`, async () => {
      const host = new FakeHost();
      const options = {
        host,
        defaultPoolSize: NaN,
        pools: { bad: { size: NaN }, good: { size: 1 } },
      };
      const app = createApplication({ plugins: [RuntimePlugin(), WorkerPoolPlugin(options)] });
      if (entry === 'factory') await app.start();
      const pool: IWorkerPool = entry === 'factory'
        ? app.services.get<IWorkerPool>(CAPABILITIES.WORKER_POOL)
        : new WorkerPoolService(options, createFakeRuntime(new FakeTimers()));
      try {
        const task = pool.run('good', 42).then(
          (result) => ({ result }),
          (error: Error) => ({ error }),
        );
        expect(host.handles).toHaveLength(1);
        host.handles[0].emitReady();
        host.handles[0].replyOk(42);
        await expect(task).resolves.toEqual({ result: 42 });
        expect(resolveMaxWorkers(options, readSizingOptions(options), 2)).toBe(2);
      } finally {
        if (entry === 'factory') await app.stop();
        else await pool.shutdown();
      }
    });
  }
});
