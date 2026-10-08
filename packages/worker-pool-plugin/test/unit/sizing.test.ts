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
        ['4', '"4"'], // strings are quoted, so control characters are escaped
        [4n, '4'],
        [null, 'null'],
      ] as const
    ) {
      const options = { maxWorkers: value } as unknown as WorkerPoolPluginOptions;
      expect(() => validateSizingOptions(options)).toThrow(RangeError);
      expect(() => validateSizingOptions(options)).toThrow(`received ${rendered}`);
    }
  });

  it('checks the per-call timeoutMs it uses: an accessor cannot pass the check then disable it', async () => {
    const host = new FakeHost();
    const timers = new FakeTimers();
    const service = new WorkerPoolService({ host }, createFakeRuntime(timers));
    let reads = 0;
    const options = {
      get timeoutMs(): number {
        reads++;
        return reads === 1 ? 50 : NaN; // valid to the check, NaN to a second read
      },
    };
    const task = service.run('m', 1, options).catch((error: Error) => error.name);
    expect(reads).toBe(1);
    host.handles[0].emitReady();
    timers.fire(); // the 50 ms task timer must exist and fire
    await expect(task).resolves.toBe('WorkerTaskTimeoutError');
    await service.shutdown();
  });

  it('uses the validated plugin and per-pool timeouts, read once, and ignores inherited pools', async () => {
    const host = new FakeHost();
    const timers = new FakeTimers();
    let poolReads = 0;
    const pool = {
      get taskTimeoutMs(): number {
        poolReads++;
        return poolReads === 1 ? 50 : -1;
      },
    };
    const inherited = Object.create({ 'inherited': { taskTimeoutMs: NaN } });
    const options = { host, pools: Object.assign(inherited, { m: pool }) };
    const service = new WorkerPoolService(options, createFakeRuntime(timers));
    expect(poolReads).toBe(1);
    const task = service.run('m', 1).catch((error: Error) => error.name);
    host.handles[0].emitReady();
    timers.fire();
    await expect(task).resolves.toBe('WorkerTaskTimeoutError');
    // The inherited entry was neither validated nor applied: its module gets
    // the plugin default (30 000 ms), so a fired task-scale timer leaves it running.
    const other = service.run('inherited', 2);
    host.handles[1].emitReady();
    host.handles[1].replyOk('ran');
    await expect(other).resolves.toBe('ran');
    expect(poolReads).toBe(1);
    await service.shutdown();
  });

  it('renders a refused value bounded and escaped', () => {
    const value = `${'x'.repeat(10_000)}\r\nforged`;
    let message = '';
    try {
      validateSizingOptions({ maxWorkers: value } as unknown as WorkerPoolPluginOptions);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.length).toBeLessThan(200);
    expect(message).not.toContain('\n');
    const hostile = {
      toString: () => {
        throw new Error('boom');
      },
    };
    expect(() =>
      validateSizingOptions({ maxWorkers: hostile } as unknown as WorkerPoolPluginOptions)
    )
      .toThrow('received [unprintable object]');
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

  for (const value of [0, -1, 1.5, NaN, Infinity, 2 ** 31, 2 ** 40, Number.MAX_SAFE_INTEGER]) {
    it(`refuses startupTimeoutMs ${value}: a startup deadline cannot be disabled`, () => {
      const options = { startupTimeoutMs: value };
      expect(() => WorkerPoolPlugin(options)).toThrow(RangeError);
      expect(() => WorkerPoolPlugin(options)).toThrow(
        `startupTimeoutMs must be a positive integer no greater than 2147483647; received ${value}`,
      );
      expect(() => new WorkerPoolService(options, createFakeRuntime(new FakeTimers())))
        .toThrow(RangeError);
    });
  }

  for (const value of [NaN, -1, 1.5, 2 ** 31, Infinity]) {
    it(`refuses taskTimeoutMs ${value} plugin-wide and per pool, at both entry points`, () => {
      // Before: NaN and negatives silently disabled the timeout; 2^31+ fired at ~1 ms.
      const message = `must be 0 (disabled) or a positive integer no greater than 2147483647; ` +
        `received ${value}`;
      for (
        const options of [
          { taskTimeoutMs: value },
          { pools: { 'file:///t.ts': { taskTimeoutMs: value } } },
        ]
      ) {
        expect(() => WorkerPoolPlugin(options)).toThrow(RangeError);
        expect(() => WorkerPoolPlugin(options)).toThrow(message);
        expect(() => new WorkerPoolService(options, createFakeRuntime(new FakeTimers())))
          .toThrow(message);
      }
      expect(() => WorkerPoolPlugin({ pools: { 'file:///t.ts': { taskTimeoutMs: value } } }))
        .toThrow('pools["file:///t.ts"].taskTimeoutMs');
    });
  }

  it('accepts 0, 1 and the largest timer delay for taskTimeoutMs', () => {
    for (const taskTimeoutMs of [0, 1, 2_147_483_647]) {
      expect(() => readSizingOptions({ taskTimeoutMs, pools: { a: { taskTimeoutMs } } }))
        .not.toThrow();
    }
  });

  it('rejects an out-of-range per-call timeoutMs without admitting the task', async () => {
    const host = new FakeHost();
    const service = new WorkerPoolService({ host }, createFakeRuntime(new FakeTimers()));
    for (const timeoutMs of [NaN, -5, 2 ** 31]) {
      await expect(service.run('m', 1, { timeoutMs })).rejects.toThrow(
        `timeoutMs must be 0 (disabled) or a positive integer no greater than 2147483647; ` +
          `received ${timeoutMs}`,
      );
    }
    expect(host.handles).toHaveLength(0);
    expect(service.stats()).toEqual([]);
    await service.shutdown();
  });

  it('defaults startupTimeoutMs to 10 000 ms and keeps a configured value', () => {
    expect(readSizingOptions().startupTimeoutMs).toBe(10_000);
    expect(readSizingOptions({ startupTimeoutMs: 250 }).startupTimeoutMs).toBe(250);
    // The largest delay a runtime timer honours; one more overflows to ~1 ms.
    expect(readSizingOptions({ startupTimeoutMs: 2_147_483_647 }).startupTimeoutMs)
      .toBe(2_147_483_647);
  });

  it('does not let an Infinity legacy pool size make the derived budget unbounded', () => {
    const options = { defaultPoolSize: Infinity, pools: { a: { size: Infinity }, b: { size: 3 } } };
    expect(resolveMaxWorkers(readSizingOptions(options), 4)).toBe(4);
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
    expect(resolveMaxWorkers(readSizingOptions(undefined), 4)).toBe(4);
    expect(resolveMaxWorkers(readSizingOptions({ defaultPoolSize: 8 }), 4))
      .toBe(8);
    expect(
      resolveMaxWorkers(readSizingOptions({ pools: { a: { size: 6 }, b: { size: 7 }, c: {} } }), 4),
    ).toBe(13);
    expect(
      resolveMaxWorkers(readSizingOptions({ maxWorkers: 1, defaultPoolSize: 8 }), 4),
    ).toBe(1);
    expect(
      resolveMaxWorkers(readSizingOptions({ maxWorkers: Infinity }), 4),
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
        expect(resolveMaxWorkers(readSizingOptions(options), 2)).toBe(2);
      } finally {
        if (entry === 'factory') await app.stop();
        else await pool.shutdown();
      }
    });
  }
});
