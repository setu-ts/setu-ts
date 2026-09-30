import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { IssuerKeySet, MAX_KEYS, MAX_RESPONSE_BYTES } from '../../src/issuers/key-set-cache.ts';
import { compileIssuers } from '../../src/issuers/trusted-issuer.ts';
import type { IAuthHttp, TrustedIssuer } from '../../src/interfaces/index.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { createFakeHttp } from '../fixtures/issuer-tokens.ts';

const JWKS = 'https://idp.test/jwks';
const KEY = { kty: 'RSA', kid: 'k1', n: 'n', e: 'AQAB' };

/**
 * Wraps a `get` into a full `IAuthHttp` whose `post` fails loudly. A key-set or
 * discovery refresh only ever GETs, so a change that starts posting through this
 * seam cannot hide behind a fixture that silently accepted it.
 */
function getOnly(get: Required<IAuthHttp>['get']): IAuthHttp {
  return { get, post: () => Promise.reject(new Error('post is not expected by this fixture')) };
}

function issuer(overrides: Partial<TrustedIssuer> = {}): ReturnType<typeof compileIssuers>[number] {
  return compileIssuers([{
    name: 'idp',
    issuer: 'https://idp.test',
    audience: 'api',
    keys: { jwksUri: JWKS },
    keySet: { ttlMs: 1000, minRefreshIntervalMs: 100, maxStaleMs: 5000 },
    toPrincipal: () => null,
    ...overrides,
  }])[0];
}

function setup(body: unknown = { keys: [KEY] }, overrides: Partial<TrustedIssuer> = {}) {
  const runtime = createFakeRuntime();
  let response: { status?: number; body: unknown } = { body };
  const fake = createFakeHttp({ [JWKS]: () => response });
  const failures: string[] = [];
  const keySet = new IssuerKeySet(issuer(overrides), runtime, fake.http, (_n, reason) => {
    failures.push(reason);
  });
  return {
    runtime,
    keySet,
    calls: fake.calls,
    failures,
    respond: (next: { status?: number; body: unknown }) => {
      response = next;
    },
  };
}

describe('IssuerKeySet', () => {
  it('reports unfetched before the first fetch, then current', async () => {
    const t = setup();
    expect(t.keySet.state()).toBe('unfetched');
    expect(await t.keySet.keys()).toEqual([KEY]);
    expect(t.keySet.state()).toBe('current');
  });

  it('serves from cache within the TTL and refetches past it', async () => {
    const t = setup();
    await t.keySet.keys();
    t.runtime.setHrtime(999);
    await t.keySet.keys();
    expect(t.calls.length).toBe(1);
    t.runtime.setHrtime(1000);
    await t.keySet.keys();
    expect(t.calls.length).toBe(2);
  });

  it('refetches at most once per cooldown for a forced (unknown kid) refresh', async () => {
    const t = setup();
    await t.keySet.keys();
    for (let i = 0; i < 20; i++) {
      await t.keySet.keys(true);
    }
    expect(t.calls.length).toBe(1);
    t.runtime.setHrtime(100);
    await t.keySet.keys(true);
    expect(t.calls.length).toBe(2);
  });

  it('coalesces concurrent refreshes into one fetch', async () => {
    const t = setup();
    await Promise.all([t.keySet.keys(), t.keySet.keys(), t.keySet.keys(true)]);
    expect(t.calls.length).toBe(1);
  });

  it('keeps the last good set on failure, then drops it past maxStaleMs', async () => {
    const t = setup();
    await t.keySet.keys();
    t.respond({ status: 503, body: 'down' });
    t.runtime.setHrtime(2000);
    expect(await t.keySet.keys()).toEqual([KEY]);
    expect(t.keySet.state()).toBe('stale');
    expect(t.failures).toEqual(['http-status']);
    t.runtime.setHrtime(5001);
    expect(t.keySet.state()).toBe('expired');
    expect(await t.keySet.keys()).toBeNull();
    expect(t.keySet.state()).toBe('expired');
  });

  it('refuses malformed, non-object, oversized-key-count and unparseable responses', async () => {
    const cases: Array<[{ status?: number; body: unknown }, string]> = [
      [{ body: { nokeys: true } }, 'key-set-malformed'],
      [{ body: [1] }, 'invalid-json'],
      [{ body: 'not json' }, 'invalid-json'],
      [
        { body: { keys: Array.from({ length: MAX_KEYS + 1 }, () => KEY) } },
        'key-set-too-many-keys',
      ],
    ];
    for (const [response, reason] of cases) {
      const t = setup();
      t.respond(response);
      expect(await t.keySet.keys()).toBeNull();
      expect(t.failures).toEqual([reason]);
    }
  });

  it('drops non-object entries from a key set', async () => {
    const t = setup({ keys: [KEY, null, 'x', [1]] });
    expect(await t.keySet.keys()).toEqual([KEY]);
  });

  it('reports a transport failure with a fixed code and passes the byte limit', async () => {
    const runtime = createFakeRuntime();
    const seen: number[] = [];
    const failures: string[] = [];
    const keySet = new IssuerKeySet(issuer(), runtime, getOnly((_url, { maxBytes }) => {
      seen.push(maxBytes);
      return Promise.reject(new Error('secret-bearing transport message'));
    }), (_n, reason) => failures.push(reason));
    expect(await keySet.keys()).toBeNull();
    expect(failures).toEqual(['key-set-fetch-failed']);
    expect(seen).toEqual([MAX_RESPONSE_BYTES]);
  });

  it('aborts a fetch that exceeds fetchTimeoutMs', async () => {
    const runtime = createFakeRuntime();
    const failures: string[] = [];
    const keySet = new IssuerKeySet(
      issuer({ keySet: { fetchTimeoutMs: 5 } }),
      runtime,
      getOnly(
        (_url, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ),
      (_n, reason) => failures.push(reason),
    );
    expect(await keySet.keys()).toBeNull();
    expect(failures).toEqual(['key-set-fetch-failed']);
  });

  it('refuses a redirect response rather than following it', async () => {
    const t = setup();
    t.respond({ status: 302, body: '' });
    expect(await t.keySet.keys()).toBeNull();
    expect(t.failures).toEqual(['http-status']);
  });

  it('close() aborts an in-flight fetch and stops later refreshes', async () => {
    const runtime = createFakeRuntime();
    let aborted = false;
    let calls = 0;
    const keySet = new IssuerKeySet(issuer(), runtime, getOnly((_url, { signal }) => {
      calls++;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      });
    }), () => {});
    const pending = keySet.keys();
    keySet.close();
    expect(await pending).toBeNull();
    expect(aborted).toBe(true);
    runtime.setHrtime(10_000);
    expect(await keySet.keys()).toBeNull();
    expect(calls).toBe(1);
  });

  it('close() keeps a cached set usable for draining requests', async () => {
    const t = setup();
    await t.keySet.keys();
    t.keySet.close();
    t.runtime.setHrtime(2000);
    expect(await t.keySet.keys()).toEqual([KEY]);
    expect(t.calls.length).toBe(1);
  });

  it('serves a fresh set without waiting on a refresh another caller forced', async () => {
    const runtime = createFakeRuntime();
    let release!: () => void;
    let calls = 0;
    const keySet = new IssuerKeySet(issuer(), runtime, getOnly(() => {
      calls++;
      if (calls === 1) {
        return Promise.resolve({ status: 200, body: JSON.stringify({ keys: [KEY] }) });
      }
      // The forced refresh parks until released, like a blocked endpoint.
      return new Promise((resolve) => {
        release = () => resolve({ status: 200, body: JSON.stringify({ keys: [KEY] }) });
      });
    }), () => {});
    await keySet.keys();
    runtime.setHrtime(100);
    const forced = keySet.keys(true);
    let served = false;
    const normal = keySet.keys().then((keys) => {
      served = true;
      return keys;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(served).toBe(true);
    expect(await normal).toEqual([KEY]);
    release();
    expect(await forced).toEqual([KEY]);
  });

  it('makes a stale caller wait on the in-flight refresh', async () => {
    const t = setup();
    await t.keySet.keys();
    t.runtime.setHrtime(1000);
    const [a, b] = await Promise.all([t.keySet.keys(), t.keySet.keys()]);
    expect(a).toEqual([KEY]);
    expect(b).toEqual([KEY]);
    expect(t.calls.length).toBe(2);
  });
});
