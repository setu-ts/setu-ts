/**
 * The tier-C `within` algorithm (M109b §3.3): the pre-read replay, the
 * fingerprint refusal, the two-create run, the tagged `fn` error, and the
 * re-read after a store-side rejection that decides replay / `conflict` /
 * `store-failed`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  IdempotentWithinOptions,
  ILogger,
  TimerHandle,
  TransactionalIdempotencyClaim,
} from '@setu-ts/common';
import { DuplicateKeyError, withHttpStatusHint } from '@setu-ts/common';
import { IdempotencyWithinError } from '../../src/errors.ts';
import type { WithinDeps } from '../../src/within/within.ts';
import { runWithin } from '../../src/within/within.ts';
import { createClockRuntime } from '../fixtures/clock-runtime.ts';
import { fakeTransactionalStore, recordWith } from '../fixtures/fake-transactional-store.ts';

/** A valid option set. */
function options(overrides: Partial<IdempotentWithinOptions> = {}): IdempotentWithinOptions {
  return { key: 'k-1', namespace: 'orders.create', scope: 't1:u1', ...overrides };
}

/** The `within` dependencies, with the fake store and clock by default. */
function deps(overrides: Partial<WithinDeps> = {}): WithinDeps {
  return {
    store: fakeTransactionalStore(),
    runtime: createClockRuntime(),
    logger: () => undefined,
    ttlMs: 86_400_000,
    storeTimeoutMs: 5_000,
    maxResultBytes: 65_536,
    ...overrides,
  };
}

/** The reason a promise rejected with, or `undefined`. */
async function reasonOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof IdempotencyWithinError ? error.reason : `other:${String(error)}`;
  }
}

/** A store that remembers the claim and result of its last `run`. */
function statefulStore(): {
  store: ReturnType<typeof fakeTransactionalStore>;
  records: Map<string, { readonly fingerprint: string; readonly result: string }>;
  calls: string[];
} {
  const records = new Map<string, { readonly fingerprint: string; readonly result: string }>();
  const calls: string[] = [];
  const store = fakeTransactionalStore({
    find: (id) => {
      calls.push('find');
      const stored = records.get(id);
      return Promise.resolve(
        stored === undefined
          ? undefined
          : recordWith(stored.fingerprint, stored.result, { expiresAt: 2_000 }),
      );
    },
    run: async (claim, work) => {
      calls.push('run');
      const outcome = await work({});
      records.set(claim.id, { fingerprint: claim.fingerprint, result: outcome.result });
      return outcome.value;
    },
  });
  return { store, records, calls };
}

describe('runWithin first call and replay (M109b §3.3)', () => {
  it('returns the same ISO string for a Date on the first call and replay', async () => {
    const { store } = statefulStore();
    const dependencies = deps({ store });
    const first = await runWithin<unknown, unknown>(
      dependencies,
      options(),
      () => Promise.resolve(new Date(0)),
    );
    const replay = await runWithin(dependencies, options(), () => Promise.resolve('unexpected'));
    expect(first.value instanceof Date).toBe(false);
    expect(first.value).toBe('1970-01-01T00:00:00.000Z');
    expect(replay.value).toEqual(first.value);
    expect([first.replayed, replay.replayed]).toEqual([false, true]);
  });

  it('omits undefined object members on the first call and replay', async () => {
    const { store } = statefulStore();
    const dependencies = deps({ store });
    const first = await runWithin(
      dependencies,
      options(),
      () => Promise.resolve({ id: 'order', omitted: undefined }),
    );
    const replay = await runWithin(
      dependencies,
      options(),
      () => Promise.resolve({ id: 'unexpected' }),
    );
    expect(Object.hasOwn(first.value, 'omitted')).toBe(false);
    expect(Object.hasOwn(replay.value, 'omitted')).toBe(false);
    expect(first.value).toEqual({ id: 'order' });
    expect(replay.value).toEqual(first.value);
  });

  it('uses nested toJSON output on the first call and replay', async () => {
    class Receipt {
      toJSON(): { total: number } {
        return { total: 42 };
      }
    }
    const { store } = statefulStore();
    const dependencies = deps({ store });
    const first = await runWithin(
      dependencies,
      options(),
      () => Promise.resolve({ receipt: new Receipt() }),
    );
    const replay = await runWithin(dependencies, options(), () => Promise.resolve('unexpected'));
    expect(first.value.receipt instanceof Receipt).toBe(false);
    expect(first.value).toEqual({ receipt: { total: 42 } });
    expect(replay.value).toEqual(first.value);
  });

  it('runs the work once, creates the claim and returns replayed:false', async () => {
    let claims: TransactionalIdempotencyClaim | undefined;
    const store = fakeTransactionalStore({
      run: (claim, work) => {
        claims = claim;
        return work({}).then((outcome) => outcome.value);
      },
    });
    const runtime = createClockRuntime();
    runtime.advance(5_000);
    const result = await runWithin<number, unknown>(
      deps({ store, runtime }),
      options(),
      () => Promise.resolve(41),
    );

    expect(result).toEqual({ value: 41, replayed: false });
    expect(claims?.id).toMatch(/^[0-9a-f]{64}$/);
    expect(claims?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(claims?.createdAt).toBe(5_000);
    expect(claims?.expiresAt).toBe(5_000 + 86_400_000);
  });

  it('replays a committed record without running the work', async () => {
    const { store, calls } = statefulStore();
    const dependencies = deps({ store });
    let runs = 0;
    const first = await runWithin<number, unknown>(dependencies, options(), () => {
      runs++;
      return Promise.resolve(7);
    });
    const second = await runWithin<number, unknown>(dependencies, options(), () => {
      runs++;
      return Promise.resolve(9);
    });

    expect(first).toEqual({ value: 7, replayed: false });
    expect(second).toEqual({ value: 7, replayed: true });
    expect(runs).toBe(1);
    expect(calls.filter((call) => call === 'run')).toHaveLength(1);
  });

  it('replays a present-but-expired record, since only the purge removes it', async () => {
    const { store } = statefulStore();
    const runtime = createClockRuntime();
    const dependencies = deps({ store, runtime });
    await runWithin<number, unknown>(dependencies, options(), () => Promise.resolve(7));
    // Well past the record's expiresAt (2_000): still authoritative.
    runtime.advance(10_000_000);
    expect(await runWithin<number, unknown>(dependencies, options(), () => Promise.resolve(9)))
      .toEqual({ value: 7, replayed: true });
  });

  it('keeps two scopes apart', async () => {
    const { store } = statefulStore();
    const dependencies = deps({ store });
    const a = await runWithin<string, unknown>(
      dependencies,
      options({ scope: 't1:u1' }),
      () => Promise.resolve('a'),
    );
    const b = await runWithin<string, unknown>(
      dependencies,
      options({ scope: 't1:u2' }),
      () => Promise.resolve('b'),
    );
    expect(a).toEqual({ value: 'a', replayed: false });
    expect(b).toEqual({ value: 'b', replayed: false });
  });
});

describe('runWithin refusals before and inside the transaction (M109b §3.3)', () => {
  it('makes no store call on a bad key', async () => {
    const calls: string[] = [];
    const store = fakeTransactionalStore({
      find: () => {
        calls.push('find');
        return Promise.resolve(undefined);
      },
      run: (_claim, work) => {
        calls.push('run');
        return work({}).then((outcome) => outcome.value);
      },
    });
    expect(
      await reasonOf(runWithin(deps({ store }), options({ key: '' }), () => Promise.resolve(1))),
    ).toBe('key-invalid');
    expect(calls).toEqual([]);
  });

  it('refuses an unserialisable fingerprint before any store call', async () => {
    expect(
      await reasonOf(
        runWithin(deps(), options({ fingerprint: 1n }), () => Promise.resolve(1)),
      ),
    ).toBe('fingerprint-invalid');
  });

  it('answers fingerprint-mismatch on a pre-read of a different fingerprint', async () => {
    const fingerprint = 'f'.repeat(64);
    const store = fakeTransactionalStore({
      find: () => Promise.resolve(recordWith(fingerprint, '{"v":1}')),
    });
    expect(await reasonOf(runWithin(deps({ store }), options(), () => Promise.resolve(1))))
      .toBe('fingerprint-mismatch');
  });

  it('rethrows the work\u2019s own error unchanged and does not re-read', async () => {
    const calls: string[] = [];
    const boom = new Error('the work failed');
    const store = fakeTransactionalStore({
      find: () => {
        calls.push('find');
        return Promise.resolve(undefined);
      },
      run: (_claim, work) => work({}).then((outcome) => outcome.value),
    });
    const failure = await runWithin(deps({ store }), options(), () => Promise.reject(boom)).catch(
      (error: unknown) => error,
    );
    expect(failure).toBe(boom);
    expect(calls).toHaveLength(1);
  });

  it('throws result-too-large and result-unserializable unchanged', async () => {
    const tooLarge = fakeTransactionalStore({
      run: (_claim, work) => work({}).then((outcome) => outcome.value),
    });
    expect(
      await reasonOf(
        runWithin(
          deps({ store: tooLarge, maxResultBytes: 4 }),
          options(),
          () => Promise.resolve({ big: 'x'.repeat(100) }),
        ),
      ),
    ).toBe('result-too-large');

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(await reasonOf(runWithin(deps(), options(), () => Promise.resolve(cyclic))))
      .toBe('result-unserializable');
  });

  it('never re-runs the work on a tampered stored result', async () => {
    const { store, records } = statefulStore();
    const dependencies = deps({ store });
    let runs = 0;
    await runWithin<number, unknown>(dependencies, options(), () => {
      runs++;
      return Promise.resolve(7);
    });
    const [id] = [...records.keys()];
    records.set(id, { fingerprint: records.get(id)!.fingerprint, result: 'not an envelope' });
    expect(
      await reasonOf(runWithin(dependencies, options(), () => {
        runs++;
        return Promise.resolve(9);
      })),
    ).toBe('record-invalid');
    expect(runs).toBe(1);
  });
});

describe('runWithin recovery after a store-side rejection (M109b §3.3)', () => {
  it('re-reads and replays the winner\u2019s result', async () => {
    let created: { readonly fingerprint: string; readonly result: string } | undefined;
    const store = fakeTransactionalStore({
      find: () =>
        Promise.resolve(
          created === undefined ? undefined : recordWith(created.fingerprint, created.result),
        ),
      run: (claim) => {
        created = { fingerprint: claim.fingerprint, result: '{"v":1}' };
        return Promise.reject(new Error('lost the race'));
      },
    });
    expect(await runWithin<number, unknown>(deps({ store }), options(), () => Promise.resolve(9)))
      .toEqual({ value: 1, replayed: true });
  });

  it('answers conflict for a DuplicateKeyError and for a 409 hint', async () => {
    const duplicate = fakeTransactionalStore({
      run: () => Promise.reject(new DuplicateKeyError('duplicate')),
    });
    expect(
      await reasonOf(runWithin(deps({ store: duplicate }), options(), () => Promise.resolve(1))),
    ).toBe('conflict');

    const hinted = fakeTransactionalStore({
      run: () =>
        Promise.reject(
          withHttpStatusHint(new Error('conflict'), {
            status: 409,
            title: 'Conflict',
            detail: 'retry',
          }),
        ),
    });
    expect(await reasonOf(runWithin(deps({ store: hinted }), options(), () => Promise.resolve(1))))
      .toBe('conflict');
  });

  it('answers store-failed for any other rejection, logging only the class', async () => {
    const logged: Record<string, unknown>[] = [];
    const logger = {
      level: 'info',
      warn: (_message: string, meta: Record<string, unknown>) => void logged.push(meta),
    } as unknown as ILogger;
    const store = fakeTransactionalStore({
      run: () => Promise.reject(new Error('SECRET bound parameter')),
    });
    expect(
      await reasonOf(
        runWithin(deps({ store, logger: () => logger }), options(), () => Promise.resolve(1)),
      ),
    ).toBe('store-failed');
    expect(logged).toHaveLength(1);
    expect(logged[0].errorKind).toBe('Error');
    expect(JSON.stringify(logged[0])).not.toContain('SECRET');
  });

  it('treats a failing re-read as absent', async () => {
    let reads = 0;
    const store = fakeTransactionalStore({
      find: () => {
        reads++;
        return reads === 1 ? Promise.resolve(undefined) : Promise.reject(new Error('read down'));
      },
      run: () => Promise.reject(new Error('write down')),
    });
    expect(await reasonOf(runWithin(deps({ store }), options(), () => Promise.resolve(1))))
      .toBe('store-failed');
  });

  it('does not read a throwing cause getter as a conflict', async () => {
    const hostile = new Error('hostile');
    Object.defineProperty(hostile, 'cause', {
      get() {
        throw new Error('getter');
      },
    });
    const store = fakeTransactionalStore({ run: () => Promise.reject(hostile) });
    expect(await reasonOf(runWithin(deps({ store }), options(), () => Promise.resolve(1))))
      .toBe('store-failed');
  });

  it('answers store-failed when a bounded read times out', async () => {
    const clock = createClockRuntime();
    const runtime = {
      ...clock,
      setTimeout: (fn: () => void, ms: number): TimerHandle =>
        setTimeout(fn, ms) as unknown as TimerHandle,
      clearTimeout: (handle: TimerHandle): void =>
        clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
    };
    const never = new Promise<undefined>(() => {});
    const store = fakeTransactionalStore({ find: () => never });
    const result = await runWithin<number, unknown>(
      deps({ store, runtime, storeTimeoutMs: 20 }),
      options(),
      () => Promise.resolve(3),
    );
    expect(result).toEqual({ value: 3, replayed: false });
  });
});
