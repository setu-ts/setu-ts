/**
 * Unit tests for the fingerprint and canonical-JSON walker (plan §3.6, §3.20).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IngressContext, IRequest, IRequestContext } from '@setu-ts/common';
import {
  canonicalJson,
  CanonicalJsonError,
  payloadFingerprint,
  queryOf,
  requestFingerprint,
} from '../../src/core/fingerprint.ts';

/** A minimal request context for fingerprinting. */
function context(request: {
  method?: string;
  path?: string;
  url?: string;
  contentType?: string | null;
  body?: Uint8Array;
}): IRequestContext {
  const headers = new Headers();
  if (request.contentType !== null && request.contentType !== undefined) {
    headers.set('content-type', request.contentType);
  }
  const fake = {
    method: request.method ?? 'POST',
    path: request.path ?? '/orders',
    url: request.url ?? 'https://example.test/orders',
    headers,
    bytes: () => Promise.resolve(request.body ?? new Uint8Array()),
  } as unknown as IRequest;
  return { request: fake } as unknown as IRequestContext;
}

describe('requestFingerprint (M109a §3.6)', () => {
  it('differs by method', async () => {
    const a = await requestFingerprint(crypto.subtle, context({ method: 'POST' }), 'request');
    const b = await requestFingerprint(crypto.subtle, context({ method: 'PUT' }), 'request');
    expect(a).not.toBe(b);
  });

  it('differs by path', async () => {
    const a = await requestFingerprint(crypto.subtle, context({ path: '/a' }), 'request');
    const b = await requestFingerprint(crypto.subtle, context({ path: '/b' }), 'request');
    expect(a).not.toBe(b);
  });

  it('differs by raw query order', async () => {
    const a = await requestFingerprint(crypto.subtle, context({ url: '/x?a=1&b=2' }), 'request');
    const b = await requestFingerprint(crypto.subtle, context({ url: '/x?b=2&a=1' }), 'request');
    expect(a).not.toBe(b);
  });

  it('differs by content-type', async () => {
    const a = await requestFingerprint(
      crypto.subtle,
      context({ contentType: 'application/json' }),
      'request',
    );
    const b = await requestFingerprint(
      crypto.subtle,
      context({ contentType: 'text/plain' }),
      'request',
    );
    expect(a).not.toBe(b);
  });

  it('differs by one body byte', async () => {
    const a = await requestFingerprint(
      crypto.subtle,
      context({ body: new Uint8Array([1, 2]) }),
      'request',
    );
    const b = await requestFingerprint(
      crypto.subtle,
      context({ body: new Uint8Array([1, 3]) }),
      'request',
    );
    expect(a).not.toBe(b);
  });

  it('re-hashes a custom function result', async () => {
    const digest = await requestFingerprint(crypto.subtle, context({}), () => 'custom');
    expect(digest).toBe(await requestFingerprint(crypto.subtle, context({}), () => 'custom'));
  });

  it('reads the raw query including the question mark', () => {
    expect(queryOf('https://x/y?a=1')).toBe('?a=1');
    expect(queryOf('https://x/y')).toBe('');
  });
});

describe('canonicalJson (M109a §3.20)', () => {
  it('is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });

  it('fingerprints top-level undefined as the empty body', () => {
    expect(canonicalJson(undefined)).toBe('');
  });

  it('writes non-finite numbers as null', () => {
    expect(canonicalJson({ n: Number.POSITIVE_INFINITY })).toBe('{"n":null}');
    expect(canonicalJson({ n: Number.NaN })).toBe('{"n":null}');
  });

  it('writes a Date as its ISO string and refuses an invalid Date', () => {
    expect(canonicalJson(new Date('2020-01-01T00:00:00.000Z'))).toBe('"2020-01-01T00:00:00.000Z"');
    expect(() => canonicalJson(new Date('nonsense'))).toThrow(CanonicalJsonError);
  });

  it('turns an undefined array element into null and skips an undefined object entry', () => {
    expect(canonicalJson([1, undefined, 2])).toBe('[1,null,2]');
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it('handles nested arrays and objects', () => {
    expect(canonicalJson({ list: [{ z: 1 }] })).toBe('{"list":[{"z":1}]}');
  });

  it('refuses a Map, Set, function, symbol, bigint and class instance at depth 3, naming the path', () => {
    const cases: unknown[] = [
      new Map(),
      new Set(),
      () => 1,
      Symbol('s'),
      1n,
      new (class Widget {})(),
    ];
    for (const value of cases) {
      expect(() => canonicalJson({ a: { b: [value] } })).toThrow(CanonicalJsonError);
    }
    try {
      canonicalJson({ a: { b: [new Map()] } });
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as CanonicalJsonError).message).toContain('$.a.b[0]');
    }
  });

  it('refuses a cycle with CanonicalJsonError, not RangeError', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(CanonicalJsonError);
  });

  it('refuses a value deeper than 64', () => {
    let deep: unknown = 0;
    for (let i = 0; i < 70; i++) deep = [deep];
    expect(() => canonicalJson(deep)).toThrow(CanonicalJsonError);
  });
});

describe('payloadFingerprint (M109a §3.7)', () => {
  it('ignores queue attempts and uses name + data', async () => {
    const one: IngressContext = {
      kind: 'queue',
      name: 'email.send',
      payload: { id: 'j1', name: 'email.send', data: { to: 'a' }, attempts: 1 },
    };
    const two: IngressContext = { ...one, payload: { ...one.payload as object, attempts: 3 } };
    expect(await payloadFingerprint(crypto.subtle, one, 'payload')).toBe(
      await payloadFingerprint(crypto.subtle, two, 'payload'),
    );
  });

  it('re-hashes a custom function result', async () => {
    const ctx: IngressContext = { kind: 'messaging', name: 't', payload: 1 };
    expect(await payloadFingerprint(crypto.subtle, ctx, () => 'p')).toBe(
      await payloadFingerprint(crypto.subtle, ctx, () => 'p'),
    );
  });
});
