import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { httpStatusHintOf } from '@setu-ts/common';
import { HashiCorpVaultProvider } from '../../src/providers/vault.ts';
import { SecretProviderUnavailableError } from '../../src/errors.ts';
import type { IVaultHttp } from '../../src/interfaces/index.ts';

/** A recorded HTTP call. */
interface Call {
  url: string;
  init?: RequestInit;
}

/** Builds a fake `http` returning a fixed response and recording calls. */
function fakeHttp(response: Response, calls: Call[]): IVaultHttp {
  return (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, ...(init ? { init } : {}) });
    return Promise.resolve(response);
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('HashiCorpVaultProvider', () => {
  const base = { address: 'https://vault.example.com/', token: 'tok' };

  it('connect requires address and token', async () => {
    await expect(new HashiCorpVaultProvider({ token: 't' }).connect()).rejects.toThrow(
      'requires options.address',
    );
    await expect(
      new HashiCorpVaultProvider({ address: 'https://v' }).connect(),
    ).rejects.toThrow('requires options.token');
  });

  it('get builds the KV v2 URL, sends the token header, and returns the value', async () => {
    const calls: Call[] = [];
    const provider = new HashiCorpVaultProvider({
      ...base,
      http: fakeHttp(jsonResponse({ data: { data: { value: 's3cret' } } }), calls),
    });
    await provider.connect();
    expect(provider.isReady()).toBe(true);

    expect(await provider.get('database/password')).toBe('s3cret');
    // Trailing slash on address is trimmed; default mount is `secret`.
    expect(calls[0].url).toBe(
      'https://vault.example.com/v1/secret/data/database/password',
    );
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['X-Vault-Token']).toBe('tok');
  });

  it('uses a custom mount', async () => {
    const calls: Call[] = [];
    const provider = new HashiCorpVaultProvider({
      ...base,
      mount: 'kv',
      http: fakeHttp(jsonResponse({ data: { data: { value: 'x' } } }), calls),
    });
    await provider.connect();
    await provider.get('a');
    expect(calls[0].url).toBe('https://vault.example.com/v1/kv/data/a');
  });

  it('returns null on 404 and on a missing value field', async () => {
    const provider404 = new HashiCorpVaultProvider({
      ...base,
      http: fakeHttp(new Response(null, { status: 404 }), []),
    });
    await provider404.connect();
    expect(await provider404.get('x')).toBeNull();

    const providerNoField = new HashiCorpVaultProvider({
      ...base,
      http: fakeHttp(jsonResponse({ data: { data: {} } }), []),
    });
    await providerNoField.connect();
    expect(await providerNoField.get('x')).toBeNull();
  });

  it('throws on a non-404 read error', async () => {
    const provider = new HashiCorpVaultProvider({
      ...base,
      http: fakeHttp(new Response(null, { status: 500 }), []),
    });
    await provider.connect();
    await expect(provider.get('x')).rejects.toThrow('Vault read failed');
  });

  it('set POSTs the value and throws on error', async () => {
    const calls: Call[] = [];
    const provider = new HashiCorpVaultProvider({
      ...base,
      http: fakeHttp(jsonResponse({}, 200), calls),
    });
    await provider.connect();
    await provider.set('a/b', 'v');
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ data: { value: 'v' } });

    const failing = new HashiCorpVaultProvider({
      ...base,
      http: fakeHttp(new Response(null, { status: 403 }), []),
    });
    await failing.connect();
    await expect(failing.set('a', 'v')).rejects.toThrow('Vault write failed');
  });

  it('disconnect clears readiness', async () => {
    const provider = new HashiCorpVaultProvider({
      ...base,
      http: fakeHttp(jsonResponse({}), []),
    });
    await provider.connect();
    await provider.disconnect();
    expect(provider.isReady()).toBe(false);
  });

  it('falls back to global fetch when no http is injected', async () => {
    const original = globalThis.fetch;
    let calledUrl = '';
    globalThis.fetch = ((url: string | URL | Request): Promise<Response> => {
      calledUrl = String(url);
      return Promise.resolve(jsonResponse({ data: { data: { value: 'g' } } }));
    }) as typeof fetch;
    try {
      const provider = new HashiCorpVaultProvider(base);
      await provider.connect();
      expect(await provider.get('k')).toBe('g');
      expect(calledUrl).toBe('https://vault.example.com/v1/secret/data/k');
    } finally {
      globalThis.fetch = original;
    }
  });

  describe('isHealthy (M90b)', () => {
    it('probes /v1/sys/health with no token and no secret read', async () => {
      const calls: Call[] = [];
      const provider = new HashiCorpVaultProvider({
        ...base,
        http: fakeHttp(jsonResponse({ initialized: true, sealed: false }), calls),
      });
      await provider.connect();

      await expect(provider.isHealthy()).resolves.toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://vault.example.com/v1/sys/health');
      expect(calls[0].init?.method).toBe('GET');
      const headers = (calls[0].init?.headers ?? {}) as Record<string, string>;
      expect(headers['X-Vault-Token']).toBeUndefined();
    });

    it('counts any HTTP status as reachable — Vault reports standby/sealed states via status codes', async () => {
      const provider = new HashiCorpVaultProvider({
        ...base,
        http: fakeHttp(new Response(null, { status: 429 }), []),
      });
      await provider.connect();
      await expect(provider.isHealthy()).resolves.toBe(true);
    });

    it('resolves false on a network failure', async () => {
      const provider = new HashiCorpVaultProvider({
        ...base,
        http: (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as IVaultHttp,
      });
      await provider.connect();
      await expect(provider.isHealthy()).resolves.toBe(false);
    });

    it('resolves false with no address configured', async () => {
      const provider = new HashiCorpVaultProvider({});
      await expect(provider.isHealthy()).resolves.toBe(false);
    });
  });
});

/** A timer surface nothing fires until the test calls `fire()`. */
class ManualTimers {
  readonly armed: Array<{ fn: () => void; ms: number }> = [];
  readonly setTimer = (fn: () => void, ms: number): number => {
    this.armed.push({ fn, ms });
    return this.armed.length;
  };
  readonly clearTimer = (): void => {};
  fire(): void {
    const timer = this.armed.at(-1);
    if (timer === undefined) throw new Error('no timer armed');
    timer.fn();
  }
}

/** Lets an in-flight request reach the injected `http`. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('HashiCorpVaultProvider request bound (M101a V8-4)', () => {
  const base = { address: 'https://vault.example.com', token: 'tok' };

  it('rejects a read Vault never answers with a 503-branded error and aborts the request', async () => {
    const timers = new ManualTimers();
    let signal: AbortSignal | null | undefined;
    const provider = new HashiCorpVaultProvider({
      ...base,
      timing: timers,
      http: (_url, init) => {
        signal = init?.signal;
        return new Promise<Response>(() => {});
      },
    });
    await provider.connect();

    const pending = provider.get('database/password');
    await flush();
    expect(timers.armed[0]?.ms).toBe(5000);
    timers.fire();

    const error = await pending.then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(SecretProviderUnavailableError);
    expect(httpStatusHintOf(error)?.status).toBe(503);
    expect((error as SecretProviderUnavailableError).provider).toBe('HashiCorpVaultProvider');
    expect(signal?.aborted).toBe(true);
  });

  it('wraps a transport failure as unavailable, keeping it as the cause', async () => {
    const failure = new TypeError('fetch failed');
    const provider = new HashiCorpVaultProvider({
      ...base,
      http: () => Promise.reject(failure),
    });
    await provider.connect();

    const error = await provider.set('a', 'b').then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(SecretProviderUnavailableError);
    expect((error as Error).cause).toBe(failure);
    // The served sentence is fixed; the driver text stays in the log.
    expect(httpStatusHintOf(error)?.detail).toBe(
      'The secrets provider is temporarily unreachable.',
    );
  });

  it('honors a configured bound, and 0 arms no timer at all', async () => {
    const configured = new ManualTimers();
    const p1 = new HashiCorpVaultProvider({
      ...base,
      requestTimeoutMs: 250,
      timing: configured,
      http: () => Promise.resolve(new Response(null, { status: 404 })),
    });
    await p1.connect();
    expect(await p1.get('x')).toBeNull();
    expect(configured.armed[0]?.ms).toBe(250);

    const disabled = new ManualTimers();
    const p2 = new HashiCorpVaultProvider({
      ...base,
      requestTimeoutMs: 0,
      timing: disabled,
      http: () => Promise.resolve(new Response(null, { status: 404 })),
    });
    await p2.connect();
    expect(await p2.get('x')).toBeNull();
    expect(disabled.armed).toHaveLength(0);
  });

  it('keeps an HTTP error from a Vault that answered as a plain error', async () => {
    const provider = new HashiCorpVaultProvider({
      ...base,
      http: () => Promise.resolve(new Response('boom', { status: 500 })),
    });
    await provider.connect();

    const error = await provider.get('x').then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SecretProviderUnavailableError);
  });

  it('reports false from isHealthy when the bound fires', async () => {
    const timers = new ManualTimers();
    const provider = new HashiCorpVaultProvider({
      ...base,
      timing: timers,
      http: () => new Promise<Response>(() => {}),
    });
    const pending = provider.isHealthy();
    await flush();
    timers.fire();
    expect(await pending).toBe(false);
  });

  const refused: ReadonlyArray<number> = [-1, Number.NaN, Number.POSITIVE_INFINITY];
  for (const value of refused) {
    it(`refuses requestTimeoutMs ${value} at construction`, () => {
      expect(() => new HashiCorpVaultProvider({ ...base, requestTimeoutMs: value })).toThrow(
        RangeError,
      );
    });
  }
});

describe('HashiCorpVaultProvider body bound and address validation (M101a)', () => {
  const base = { address: 'https://vault.example.com', token: 'tok' };

  /** A 200 response whose body sends headers and then never another byte. */
  function stalledBody(): Response {
    return new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) }), {
      status: 200,
    });
  }

  it('bounds the body read: headers then silence rejects 503 instead of hanging', async () => {
    const timers = new ManualTimers();
    const provider = new HashiCorpVaultProvider({
      ...base,
      timing: timers,
      http: () => Promise.resolve(stalledBody()),
    });
    await provider.connect();

    const pending = provider.get('database/password');
    await flush();
    expect(timers.armed).toHaveLength(1);
    timers.fire();

    const error = await pending.then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(SecretProviderUnavailableError);
    expect(httpStatusHintOf(error)?.status).toBe(503);
  });

  it('keeps a malformed JSON body from a Vault that answered as a plain error', async () => {
    const provider = new HashiCorpVaultProvider({
      ...base,
      http: () => Promise.resolve(new Response('{not json', { status: 200 })),
    });
    await provider.connect();

    const error = await provider.get('x').then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SecretProviderUnavailableError);
  });

  it('bounds the body release in isHealthy and a write', async () => {
    const timers = new ManualTimers();
    let cancelled = 0;
    const body = (): Response =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull: () => new Promise(() => {}),
          cancel: () => {
            cancelled++;
            return new Promise(() => {});
          },
        }),
        { status: 200 },
      );
    const provider = new HashiCorpVaultProvider({
      ...base,
      timing: timers,
      http: () => Promise.resolve(body()),
    });
    await provider.connect();

    const health = provider.isHealthy();
    await flush();
    timers.fire();
    expect(await health).toBe(false);

    const write = provider.set('a', 'b');
    await flush();
    timers.fire();
    const error = await write.then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(SecretProviderUnavailableError);
    expect(cancelled).toBe(2);
  });

  const malformed: ReadonlyArray<string> = ['vault.example.com', 'ftp://vault.example.com', '::'];
  for (const address of malformed) {
    it(`connect refuses the malformed address ${JSON.stringify(address)} without echoing it`, async () => {
      const provider = new HashiCorpVaultProvider({ address, token: 'tok' });
      const error = await provider.connect().then(() => undefined, (e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(SecretProviderUnavailableError);
      expect((error as Error).message).toContain('options.address');
      expect((error as Error).message).not.toContain(address);
      expect(provider.isReady()).toBe(false);
    });
  }

  it('connect accepts an http:// address', async () => {
    const provider = new HashiCorpVaultProvider({ address: 'http://127.0.0.1:8200', token: 'tok' });
    await provider.connect();
    expect(provider.isReady()).toBe(true);
  });
});

describe('HashiCorpVaultProvider secret path and body size (M101a security audit)', () => {
  const base = { address: 'https://vault.example.com', token: 'tok' };

  for (const name of ['../../sys/health', 'a/../b', './a', 'a//b', '', 'a/']) {
    it(`refuses ${JSON.stringify(name)} before any request is sent`, async () => {
      const calls: Call[] = [];
      const provider = new HashiCorpVaultProvider({
        ...base,
        http: fakeHttp(jsonResponse({}), calls),
      });
      await provider.connect();
      await expect(provider.get(name)).rejects.toThrow('path segment');
      await expect(provider.set(name, 'v')).rejects.toThrow('path segment');
      expect(calls).toHaveLength(0);
    });
  }

  it('percent-encodes each segment so a name cannot add a query or an encoded dot segment', async () => {
    const calls: Call[] = [];
    const provider = new HashiCorpVaultProvider({
      ...base,
      http: (url) => {
        calls.push({ url });
        return Promise.resolve(jsonResponse({ data: { data: { value: 'v' } } }));
      },
    });
    await provider.connect();
    await provider.get('app db/pass?x=1#f');
    await provider.get('%2e%2e/a');
    expect(calls[0].url).toBe(
      'https://vault.example.com/v1/secret/data/app%20db/pass%3Fx%3D1%23f',
    );
    expect(calls[1].url).toBe('https://vault.example.com/v1/secret/data/%252e%252e/a');
  });

  it('refuses a body over 1 MiB as a plain error and cancels the rest of it', async () => {
    let cancelled = false;
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 65_536;
        controller.enqueue(new Uint8Array(65_536));
      },
      cancel() {
        cancelled = true;
      },
    });
    const provider = new HashiCorpVaultProvider({
      ...base,
      http: () => Promise.resolve(new Response(body, { status: 200 })),
    });
    await provider.connect();
    const error = await provider.get('big').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SecretProviderUnavailableError);
    expect((error as Error).message).toBe('Vault read for big exceeded 1048576 bytes');
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThanOrEqual(1_048_576 + 2 * 65_536);
  });

  it('reads a body of exactly 1 MiB', async () => {
    const prefix = '{"data":{"data":{"value":"';
    const suffix = '"}}}';
    const value = 'x'.repeat(1_048_576 - prefix.length - suffix.length);
    const provider = new HashiCorpVaultProvider({
      ...base,
      http: () => Promise.resolve(new Response(prefix + value + suffix, { status: 200 })),
    });
    await provider.connect();
    expect(await provider.get('exact')).toBe(value);
  });

  it('reads a bodiless 200 as an empty body (a plain JSON error)', async () => {
    const provider = new HashiCorpVaultProvider({
      ...base,
      http: () => Promise.resolve(new Response(null, { status: 200 })),
    });
    await provider.connect();
    const error = await provider.get('a').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyntaxError);
  });

  it('escapes control characters in a name it quotes', async () => {
    const provider = new HashiCorpVaultProvider({
      ...base,
      http: () => Promise.resolve(new Response('no', { status: 500 })),
    });
    await provider.connect();
    await expect(provider.get('a\r\nforged')).rejects.toThrow(
      'Vault read failed for a\\u000d\\u000aforged: HTTP 500',
    );
    await expect(provider.set('a\u007f', 'v')).rejects.toThrow(
      'Vault write failed for a\\u007f: HTTP 500',
    );
  });
});
