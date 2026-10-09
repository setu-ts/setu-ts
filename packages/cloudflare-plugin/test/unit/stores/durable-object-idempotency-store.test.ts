/**
 * `DurableObjectIdempotencyStore` through a gated fake (M109a §3.15).
 *
 * The fake reproduces the input gate — one Durable Object executes one request
 * at a time — by serialising every `fetch` per object name.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRuntimeServices } from '@setu-ts/common';
import {
  IdempotencyObjectCore,
  type IIdempotencyObjectState,
} from '../../../src/durable-objects/idempotency-object.ts';
import { DurableObjectIdempotencyStore } from '../../../src/stores/durable-object-idempotency-store.ts';
import { CloudflareBindingMissingError, CloudflareUnsupportedError } from '../../../src/errors.ts';

const hex = (char: string): string => char.repeat(64);

/** A runtime with real timers (for the deadline) and a fixed clock. */
function runtime(): IRuntimeServices {
  return {
    platform: () => 'cloudflare-workers',
    version: () => '0.0.0',
    hostname: () => 'localhost',
    uuid: () => 'uuid',
    randomBytes: (length) => new Uint8Array(length),
    subtle: crypto.subtle,
    now: () => 0,
    hrtime: () => 0,
    setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
    setInterval: () => 0,
    clearInterval: () => {},
    env: {},
    exit: () => {
      throw new Error('exit');
    },
  };
}

/** A storage fake. */
class FakeStorage {
  readonly map = new Map<string, unknown>();
  readonly alarms: number[] = [];
  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.map.get(key) as T | undefined);
  }
  put<T>(key: string, value: T): Promise<void> {
    this.map.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.map.delete(key));
  }
  setAlarm(ms: number): Promise<void> {
    this.alarms.push(ms);
    return Promise.resolve();
  }
}

/** A gated object stub: every fetch is serialised behind the previous one. */
class GatedStub {
  #queue: Promise<unknown> = Promise.resolve();
  readonly #core: IdempotencyObjectCore;
  constructor(core: IdempotencyObjectCore) {
    this.#core = core;
  }
  fetch(input: string | Request, init?: RequestInit): Promise<Response> {
    const run = (): Promise<Response> => this.#core.fetch(new Request(input as string, init));
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => {});
    return result;
  }
}

/** A namespace fake that creates one gated object per name. */
class FakeNamespace {
  readonly names: string[] = [];
  readonly storages = new Map<string, FakeStorage>();
  readonly #stubs = new Map<string, GatedStub>();
  idFromName(name: string): unknown {
    this.names.push(name);
    if (!this.#stubs.has(name)) {
      const storage = new FakeStorage();
      this.storages.set(name, storage);
      this.#stubs.set(
        name,
        new GatedStub(new IdempotencyObjectCore({ storage } as IIdempotencyObjectState)),
      );
    }
    return name;
  }
  get(id: unknown): GatedStub {
    return this.#stubs.get(String(id)) as GatedStub;
  }
}

/** Builds a connected store over a fake namespace. */
async function build(
  options: Partial<{ namespace: string; binding: string; timeoutMs: number }> = {},
) {
  const namespace = new FakeNamespace();
  const store = new DurableObjectIdempotencyStore(namespace, {
    namespace: 'shop',
    binding: 'IDEMPOTENCY',
    ...options,
  });
  await store.connect(runtime());
  return { namespace, store };
}

/** A claim request. */
function claimRequest(over: Record<string, unknown> = {}) {
  return {
    key: hex('a'),
    scope: hex('b'),
    fingerprint: hex('c'),
    token: 'tok',
    leaseMs: 1_000,
    ttlMs: 60_000,
    ...over,
  };
}

describe('DurableObjectIdempotencyStore (M109a §3.15)', () => {
  it('advertises its kind and record limit', async () => {
    const { store } = await build();
    expect(store.name).toBe('durable-object');
    expect(store.maxRecordBytes).toBe(120_000);
  });

  it('names the object idempotency:<namespace>:<key>', async () => {
    const { namespace, store } = await build();
    await store.claim(claimRequest());
    expect(namespace.names).toEqual([`idempotency:shop:${hex('a')}`]);
  });

  it('claims, completes and replays across the object boundary', async () => {
    const { store } = await build();
    expect(await store.claim(claimRequest())).toEqual({ outcome: 'claimed', takeover: false });
    expect(await store.claim(claimRequest({ token: 'two' }))).toEqual({ outcome: 'in-progress' });
    expect(await store.complete(hex('a'), 'tok', 'the-record', 60_000)).toBe('settled');
    expect(await store.claim(claimRequest({ token: 'two' }))).toEqual({
      outcome: 'completed',
      record: 'the-record',
    });
  });

  it('grants exactly one claim among 50 concurrent REAL-serialised claims', async () => {
    const { store } = await build();
    const results = await Promise.all(
      Array.from(
        { length: 50 },
        (_unused, index) => store.claim(claimRequest({ token: `t${index}` })),
      ),
    );
    expect(results.filter((result) => result.outcome === 'claimed')).toHaveLength(1);
    expect(results.filter((result) => result.outcome === 'in-progress')).toHaveLength(49);
  });

  it('refuses a missing namespace and a non-namespace binding', () => {
    expect(() => new DurableObjectIdempotencyStore(new FakeNamespace(), { namespace: 'Bad' }))
      .toThrow(TypeError);
    expect(() => new DurableObjectIdempotencyStore({}, { namespace: 'ok' })).toThrow(
      CloudflareBindingMissingError,
    );
  });

  it('rejects before connect', async () => {
    const store = new DurableObjectIdempotencyStore(new FakeNamespace(), { namespace: 'shop' });
    await expect(store.claim(claimRequest())).rejects.toThrow(
      'durable object idempotency store: not connected',
    );
  });

  it('maps a non-2xx answer to CloudflareUnsupportedError', async () => {
    const namespace = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: () => Promise.resolve(new Response('nope', { status: 404 })) }),
    };
    const store = new DurableObjectIdempotencyStore(namespace, {
      namespace: 'shop',
      binding: 'IDEMPOTENCY',
    });
    await store.connect(runtime());
    await expect(store.claim(claimRequest())).rejects.toBeInstanceOf(CloudflareUnsupportedError);
  });

  it('maps a wrong-shaped 2xx answer to a named error', async () => {
    const namespace = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: () => Promise.resolve(Response.json({ outcome: 'wat' })) }),
    };
    const store = new DurableObjectIdempotencyStore(namespace, { namespace: 'shop' });
    await store.connect(runtime());
    await expect(store.claim(claimRequest())).rejects.toThrow(
      'durable object idempotency store: unexpected answer from /claim',
    );
  });

  it('bounds a hung object with the deadline', async () => {
    const namespace = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: () => new Promise<Response>(() => {}) }),
    };
    const store = new DurableObjectIdempotencyStore(namespace, {
      namespace: 'shop',
      timeoutMs: 20,
    });
    await store.connect(runtime());
    await expect(store.claim(claimRequest())).rejects.toThrow(
      'durable object idempotency store: no answer within 20 ms',
    );
  });

  it('validates keyPrefix, binding and timeoutMs', () => {
    const namespace = new FakeNamespace();
    expect(() => new DurableObjectIdempotencyStore(namespace, { namespace: 'ok', keyPrefix: '' }))
      .toThrow(
        RangeError,
      );
    expect(() =>
      new DurableObjectIdempotencyStore(namespace, {
        namespace: 'ok',
        binding: 5 as unknown as string,
      })
    ).toThrow(TypeError);
    expect(() => new DurableObjectIdempotencyStore(namespace, { namespace: 'ok', timeoutMs: -1 }))
      .toThrow(
        RangeError,
      );
  });

  it('releases a held claim and reports lost for a stale one', async () => {
    const { store } = await build();
    await store.claim(claimRequest());
    expect(await store.release(hex('a'), 'tok')).toBe('settled');
    expect(await store.release(hex('a'), 'tok')).toBe('lost');
  });

  it('maps a wrong-shaped settle answer to a named error', async () => {
    const namespace = {
      idFromName: (name: string) => name,
      get: () => ({ fetch: () => Promise.resolve(Response.json({ result: 'wat' })) }),
    };
    const store = new DurableObjectIdempotencyStore(namespace, { namespace: 'shop' });
    await store.connect(runtime());
    await expect(store.complete(hex('a'), 't', 'r', 1_000)).rejects.toThrow(
      'durable object idempotency store: unexpected answer from /complete',
    );
    await expect(store.release(hex('a'), 't')).rejects.toThrow(
      'durable object idempotency store: unexpected answer from /release',
    );
  });

  it('completes through the object and reports a stale token lost', async () => {
    const { store } = await build();
    await store.claim(claimRequest());
    expect(await store.complete(hex('a'), 'nope', 'r', 1_000)).toBe('lost');
  });
});
