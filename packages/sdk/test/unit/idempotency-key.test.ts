/**
 * Key validation, generation and client wiring (M109b §3.8, §3.13): one key on
 * every attempt, both key sources validated, the two conflicts refused, and the
 * option shape refused at `createClient`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IClientTiming } from '../../src/http/contracts.ts';
import {
  generateIdempotencyKey,
  resolveClientIdempotencyOptions,
  validateIdempotencyKey,
} from '../../src/http/idempotency-key.ts';
import { createClient } from '../../src/sdk.ts';

/** A no-wait timing. */
function timing(): IClientTiming {
  return { now: () => 0, sleep: () => Promise.resolve() };
}

/** A fetch recording every attempt's headers and answering a scripted status. */
function recordingFetch(statuses: readonly number[]) {
  const keys: (string | null)[] = [];
  let call = 0;
  const fetch = (_input: RequestInfo, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    keys.push(headers.get('Idempotency-Key'));
    const status = statuses[Math.min(call, statuses.length - 1)];
    call++;
    return Promise.resolve(
      new Response(status === 204 ? null : '{}', {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  };
  return { fetch, keys, calls: () => call };
}

describe('validateIdempotencyKey (M109b §3.13)', () => {
  it('accepts a key of 1–255 printable characters', () => {
    expect(validateIdempotencyKey('a'.repeat(255), 'field')).toBe('a'.repeat(255));
    expect(validateIdempotencyKey('k-1', 'field')).toBe('k-1');
  });

  it('refuses every unusable key, naming the field and never the value', () => {
    for (const value of ['', ' '.repeat(2), 'a'.repeat(256), 'a\u0000b', 'a"b', 'caf\u00e9']) {
      let message = '';
      try {
        validateIdempotencyKey(value, 'ClientRequest.idempotencyKey');
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('ClientRequest.idempotencyKey');
      expect(message).not.toContain(value === '' ? '@@' : value);
    }
  });
});

describe('generateIdempotencyKey (M109b §3.8)', () => {
  it('mints 32 lower-case hex characters', () => {
    expect(generateIdempotencyKey()).toMatch(/^[0-9a-f]{32}$/);
    expect(generateIdempotencyKey()).not.toBe(generateIdempotencyKey());
  });
});

describe('resolveClientIdempotencyOptions (M109b §3.8, §3.13)', () => {
  it('defaults to POST/PATCH and the Idempotency-Key header', () => {
    const resolved = resolveClientIdempotencyOptions({});
    expect([...resolved.methods]).toEqual(['POST', 'PATCH']);
    expect(resolved.header).toBe('Idempotency-Key');
    expect(resolved.generateKey()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('upper-cases the methods and keeps a custom header and minter', () => {
    const resolved = resolveClientIdempotencyOptions({
      methods: ['post', 'delete'],
      header: 'X-Request-Id',
      generateKey: () => 'fixed-key',
    });
    expect([...resolved.methods]).toEqual(['POST', 'DELETE']);
    expect(resolved.header).toBe('X-Request-Id');
    expect(resolved.generateKey()).toBe('fixed-key');
  });

  it('refuses a malformed options object', () => {
    expect(() => resolveClientIdempotencyOptions({ methods: [] })).toThrow(RangeError);
    expect(() => resolveClientIdempotencyOptions({ methods: new Array(17).fill('GET') })).toThrow(
      RangeError,
    );
    expect(() => resolveClientIdempotencyOptions({ methods: ['not a token'] })).toThrow(RangeError);
    expect(() => resolveClientIdempotencyOptions({ header: 'not a token' })).toThrow(RangeError);
    expect(() => resolveClientIdempotencyOptions({ generateKey: 'x' as unknown as () => string }))
      .toThrow(TypeError);
  });
});

describe('createClient idempotency wiring (M109b §3.8)', () => {
  it('never repeats a keyed POST after a 2xx interceptor throws a non-object', async () => {
    for (const thrown of ['interceptor failed', null, undefined, 7, () => 'thrown function']) {
      const { fetch, calls } = recordingFetch([200]);
      const client = createClient({
        baseUrl: 'http://x',
        fetch,
        timing: timing(),
        retry: { limit: 3, delay: 1, backoff: 'fixed' },
        responseInterceptors: [() => {
          throw thrown;
        }],
      });
      let caught: unknown = Symbol('not thrown');
      try {
        await client.request({ method: 'POST', path: 'orders', idempotencyKey: 'mine' });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(thrown);
      expect(calls()).toBe(1);
    }
  });

  it('never repeats a keyed POST when reading a 2xx response body fails', async () => {
    const failure = new Error('response stream failed');
    let calls = 0;
    const client = createClient({
      baseUrl: 'http://x',
      fetch: () => {
        calls++;
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(failure);
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      },
      timing: timing(),
      retry: { limit: 3, delay: 1, backoff: 'fixed' },
    });
    await expect(client.request({ method: 'POST', path: 'orders', idempotencyKey: 'mine' }))
      .rejects.toBe(failure);
    expect(calls).toBe(1);
  });

  it('sets ONE key across every keyed attempt', async () => {
    const { fetch, keys, calls } = recordingFetch([500, 500, 200]);
    const client = createClient({
      baseUrl: 'http://x',
      fetch,
      timing: timing(),
      retry: { limit: 3, delay: 1, backoff: 'fixed' },
      idempotency: {},
    });
    await client.request({ method: 'POST', path: 'orders', json: {} });
    expect(calls()).toBe(3);
    expect(keys).toHaveLength(3);
    expect(keys[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(keys).size).toBe(1);
  });

  it('leaves an unkeyed POST exactly as before (no retry, no header)', async () => {
    const { fetch, keys, calls } = recordingFetch([500]);
    const client = createClient({
      baseUrl: 'http://x',
      fetch,
      timing: timing(),
      retry: { limit: 3, delay: 1, backoff: 'fixed' },
    });
    await expect(client.request({ method: 'POST', path: 'orders', json: {} })).rejects.toThrow();
    expect(calls()).toBe(1);
    expect(keys).toEqual([null]);
  });

  it('sends a caller\u2019s key on a POST and retries its 409', async () => {
    const { fetch, keys, calls } = recordingFetch([409, 200]);
    const client = createClient({
      baseUrl: 'http://x',
      fetch,
      timing: timing(),
      retry: { limit: 2, delay: 1, backoff: 'fixed' },
    });
    await client.request({ method: 'POST', path: 'orders', json: {}, idempotencyKey: 'mine' });
    expect(calls()).toBe(2);
    expect(keys).toEqual(['mine', 'mine']);
  });

  it('refuses a static default header and a per-request conflict', async () => {
    expect(() =>
      createClient({ baseUrl: 'http://x', headers: { 'Idempotency-Key': 'x' }, idempotency: {} })
    ).toThrow(/must not set 'Idempotency-Key'/);

    const { fetch, calls } = recordingFetch([200]);
    const client = createClient({ baseUrl: 'http://x', fetch, timing: timing() });
    await expect(
      client.request({
        method: 'POST',
        path: 'orders',
        json: {},
        idempotencyKey: 'mine',
        headers: { 'Idempotency-Key': 'other' },
      }),
    ).rejects.toThrow(/must not set both idempotencyKey/);
    expect(calls()).toBe(0);
  });

  it('validates a generated key\u2019s output on every call, before any network call', async () => {
    const { fetch, calls } = recordingFetch([200]);
    const client = createClient({
      baseUrl: 'http://x',
      fetch,
      timing: timing(),
      idempotency: { generateKey: () => 'bad key' },
    });
    await expect(client.request({ method: 'POST', path: 'orders', json: {} })).rejects.toThrow(
      /idempotency.generateKey\(\)/,
    );
    expect(calls()).toBe(0);
  });

  it('refuses an invalid key and header shape at createClient', () => {
    expect(() => createClient({ baseUrl: 'http://x', idempotency: { header: 'bad header' } }))
      .toThrow(
        RangeError,
      );
    const { fetch } = recordingFetch([200]);
    const client = createClient({ baseUrl: 'http://x', fetch, timing: timing() });
    return expect(
      client.request({ method: 'POST', path: 'orders', json: {}, idempotencyKey: 'bad key' }),
    ).rejects.toThrow(RangeError);
  });
});
