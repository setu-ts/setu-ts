/**
 * The binding registry is what turns a deployment mistake into a message that
 * names the mistake, so the error content is asserted, not only the throw.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { BindingRegistry } from '../../../src/bindings/binding-registry.ts';
import { CloudflareBindingMissingError } from '../../../src/index.ts';
import { FakeKv, FakeR2 } from '../../fakes.ts';

const noopWaitUntil = (): void => {};

function registry(): {
  kv: FakeKv;
  r2: FakeR2;
  d1: object;
  bindings: BindingRegistry;
} {
  const kv = new FakeKv();
  const r2 = new FakeR2();
  const d1 = { prepare: () => {}, batch: () => {} };
  return {
    kv,
    r2,
    d1,
    bindings: new BindingRegistry(
      { CACHE_KV: kv, UPLOADS: r2, DB: d1 },
      { API_KEY: 'secret', REGION: 'weur' },
      noopWaitUntil,
    ),
  };
}

describe('BindingRegistry', () => {
  it('reports which bindings are present', () => {
    const { bindings } = registry();
    expect(bindings.has('CACHE_KV')).toBe(true);
    expect(bindings.has('NOPE')).toBe(false);
  });

  it('lists binding names in sorted order', () => {
    const { bindings } = registry();
    expect(bindings.names()).toEqual(['CACHE_KV', 'DB', 'UPLOADS']);
  });

  it('exposes the string variables separately from the bindings', () => {
    const { bindings } = registry();
    expect(bindings.vars()).toEqual({ API_KEY: 'secret', REGION: 'weur' });
  });

  it('returns each binding through its typed accessor', () => {
    const { kv, r2, d1, bindings } = registry();
    expect(bindings.kv('CACHE_KV')).toBe(kv);
    expect(bindings.r2('UPLOADS')).toBe(r2);
    expect(bindings.d1('DB')).toBe(d1);
    expect(bindings.get<FakeKv>('CACHE_KV')).toBe(kv);
  });

  it('serves the queue, service and durable-object escape hatches', () => {
    const queue = { send: () => {}, sendBatch: () => {} };
    const service = { fetch: () => {} };
    const namespace = { idFromName: () => {}, get: () => {} };
    const bindings = new BindingRegistry(
      { JOBS: queue, BILLING: service, ROOMS: namespace },
      {},
      noopWaitUntil,
    );

    expect(bindings.queue('JOBS')).toBe(queue);
    expect(bindings.service('BILLING')).toBe(service);
    expect(bindings.durableObject('ROOMS')).toBe(namespace);
  });

  it('throws naming the binding and the ones that are available', () => {
    const { bindings } = registry();

    expect(() => bindings.kv('SESSIONS')).toThrow(CloudflareBindingMissingError);
    try {
      bindings.kv('SESSIONS');
    } catch (error) {
      expect(String(error)).toContain("'SESSIONS'");
      expect(String(error)).toContain('CACHE_KV, DB, UPLOADS');
      expect(String(error)).toContain('wrangler.toml');
    }
  });

  it('says "(none)" rather than an empty list when nothing is bound', () => {
    const bindings = new BindingRegistry({}, {}, noopWaitUntil);
    try {
      bindings.get('ANYTHING');
    } catch (error) {
      expect(String(error)).toContain('(none)');
    }
    expect(() => bindings.get('ANYTHING')).toThrow(CloudflareBindingMissingError);
  });

  it('rejects a present binding of the wrong shape, naming what was expected', () => {
    const { bindings } = registry();

    // UPLOADS is an R2 bucket; asking for it as KV is a wrangler.toml mistake.
    expect(() => bindings.kv('UPLOADS')).toThrow(CloudflareBindingMissingError);
    try {
      bindings.kv('UPLOADS');
    } catch (error) {
      expect(String(error)).toContain('a KV namespace');
    }

    expect(() => bindings.r2('CACHE_KV')).toThrow(CloudflareBindingMissingError);
    try {
      bindings.r2('CACHE_KV');
    } catch (error) {
      expect(String(error)).toContain('an R2 bucket');
    }
  });

  it('rejects a Durable Object binding of the wrong shape', () => {
    const { bindings } = registry();

    // Before the guard this cast through silently, and the application booted
    // clean and failed on the first `idFromName` with a bare TypeError — the
    // same hole M52c's review closed for D1.
    expect(() => bindings.durableObject('CACHE_KV')).toThrow(CloudflareBindingMissingError);
    try {
      bindings.durableObject('CACHE_KV');
    } catch (error) {
      expect(String(error)).toContain('a Durable Object namespace');
      expect(String(error)).toContain('CACHE_KV');
    }
  });

  it('reports an absent Durable Object binding with the names that are present', () => {
    const { bindings } = registry();

    try {
      bindings.durableObject('ROOMS');
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CloudflareBindingMissingError);
      expect(String(error)).toContain('ROOMS');
      expect(String(error)).toContain('CACHE_KV');
    }
  });

  it('accepts a binding carrying only a partial Durable Object shape as wrong', () => {
    const bindings = new BindingRegistry(
      { ROOMS: { idFromName: () => {} } },
      {},
      noopWaitUntil,
    );

    expect(() => bindings.durableObject('ROOMS')).toThrow(CloudflareBindingMissingError);
  });

  it('treats an inherited Object.prototype key as absent, agreeing with has()', () => {
    // The binding record is a plain object, so a bare index read would resolve
    // `constructor` to the Object constructor and `toString` to a function —
    // neither a binding, and both contradicting has(), which is own-key.
    const { bindings } = registry();

    for (const inherited of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(bindings.has(inherited)).toBe(false);
      expect(() => bindings.get(inherited)).toThrow(CloudflareBindingMissingError);
      expect(() => bindings.kv(inherited)).toThrow(CloudflareBindingMissingError);
    }
  });

  it('names an inherited key as absent, not as the wrong shape', () => {
    const { bindings } = registry();
    try {
      bindings.kv('constructor');
    } catch (error) {
      // "not present" is the truth; "present but not a KV namespace" would send
      // the reader looking at a wrangler.toml stanza that does not exist.
      expect(String(error)).toContain('is not present');
      expect(String(error)).not.toContain('is present but');
    }
  });

  it('delegates waitUntil to the host it was built with', () => {
    const seen: Promise<unknown>[] = [];
    const bindings = new BindingRegistry({}, {}, (p) => {
      seen.push(p);
    });

    bindings.waitUntil(Promise.resolve('done'));
    expect(seen).toHaveLength(1);
  });
});
