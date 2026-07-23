import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { HashiCorpVaultProvider } from '../../src/providers/vault.ts';
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
});
