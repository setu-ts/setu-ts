/**
 * The registration plugin and construction contract of `createObservedFetch`
 * (M98n §3.2, §3.4): plugin name and version, multi registration without
 * `provides`, the one-application rule with the same-application retry, the
 * close hook, the token literal pinned to `CAPABILITIES`, frozen key sets,
 * and every construction refusal.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type { IOutboundHttpDiagnosticsSource, IPluginContext } from '@setu-ts/common';

import {
  createObservedFetch,
  OBSERVED_FETCH_ERRORS,
  OUTBOUND_HTTP_DIAGNOSTICS_TOKEN,
  SDK_VERSION,
} from '../../src/http/observed-fetch.ts';
import { OUTBOUND_ALIAS_ERRORS } from '../../src/diagnostics/outbound-http-observations.ts';
import manifest from '../../deno.json' with { type: 'json' };

interface Registration {
  token: string;
  service: unknown;
  options: unknown;
}

/** A minimal plugin context recording registrations and close hooks. */
function fakeContext(app: object = {}) {
  const registrations: Registration[] = [];
  const closeHooks: (() => void | Promise<void>)[] = [];
  const ctx = {
    app,
    services: {
      register(token: string, service: unknown, options?: unknown) {
        registrations.push({ token, service, options });
      },
    },
    lifecycle: {
      onClose(fn: () => void | Promise<void>) {
        closeHooks.push(fn);
      },
    },
  } as unknown as IPluginContext;
  return { ctx, registrations, closeHooks };
}

const ok = () => Promise.resolve(new Response(null, { status: 200 }));

describe('createObservedFetch — registration plugin', () => {
  it('pins the token literal to CAPABILITIES and the version to the manifest', () => {
    expect(OUTBOUND_HTTP_DIAGNOSTICS_TOKEN).toBe(CAPABILITIES.OUTBOUND_HTTP_DIAGNOSTICS);
    expect(SDK_VERSION).toBe(manifest.version);
  });

  it('names each helper with a random hex nonce that never equals a token or holds the alias', () => {
    const tokens = new Set<string>(Object.values(CAPABILITIES));
    const names = new Set<string>();
    for (let index = 0; index < 20; index++) {
      const { plugin } = createObservedFetch({ alias: 'secret-alias-canary', fetch: ok });
      expect(plugin.name).toMatch(/^outbound-http-diagnostics-[0-9a-f]{32}$/);
      expect(tokens.has(plugin.name)).toBe(false);
      expect(plugin.name).not.toContain('secret-alias-canary');
      names.add(plugin.name);
    }
    expect(names.size).toBe(20);
  });

  it('declares no provides and no dependencies, and is frozen', () => {
    const observed = createObservedFetch({ alias: 'a', fetch: ok });
    expect(observed.plugin.version).toBe(SDK_VERSION);
    expect(observed.plugin.provides).toBeUndefined();
    expect(observed.plugin.dependencies).toBeUndefined();
    expect(Object.isFrozen(observed.plugin)).toBe(true);
    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.keys(observed).sort()).toEqual(['fetch', 'plugin']);
  });

  it('registers the snapshot-only source under the token as multi and one close hook', async () => {
    const observed = createObservedFetch({ alias: 'payments', fetch: ok });
    const { ctx, registrations, closeHooks } = fakeContext();
    await observed.plugin.register(ctx);
    expect(registrations.length).toBe(1);
    expect(registrations[0]!.token).toBe(CAPABILITIES.OUTBOUND_HTTP_DIAGNOSTICS);
    expect(registrations[0]!.options).toEqual({ multi: true });
    const source = registrations[0]!.service as IOutboundHttpDiagnosticsSource;
    expect(Object.keys(source)).toEqual(['snapshot']);
    expect(Object.isFrozen(source)).toBe(true);
    expect(closeHooks.length).toBe(1);

    await observed.fetch('https://example.test/');
    expect(source.snapshot().state).toBe('ready');
    await closeHooks[0]!();
    expect(source.snapshot().state).toBe('disabled');
    // The wrapper still delegates after close.
    expect((await observed.fetch('https://example.test/')).status).toBe(200);
  });

  it('refuses a second application with a fixed error naming no alias', async () => {
    const observed = createObservedFetch({ alias: 'secret-alias-canary', fetch: ok });
    await observed.plugin.register(fakeContext({ id: 1 }).ctx);
    let message = '';
    try {
      await observed.plugin.register(fakeContext({ id: 2 }).ctx);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(OBSERVED_FETCH_ERRORS.otherApp);
    expect(message).not.toContain('secret-alias-canary');
  });

  it('lets the same application re-register after a failed start and reopens the source', async () => {
    const app = {};
    const observed = createObservedFetch({ alias: 'payments', fetch: ok });
    const first = fakeContext(app);
    await observed.plugin.register(first.ctx);
    await first.closeHooks[0]!(); // the failed start ran close hooks
    const source = first.registrations[0]!.service as IOutboundHttpDiagnosticsSource;
    expect(source.snapshot().state).toBe('disabled');
    const retry = fakeContext(app);
    await observed.plugin.register(retry.ctx);
    // The registry and close hooks survive the rollback, so nothing is re-added.
    expect(retry.registrations.length).toBe(0);
    expect(retry.closeHooks.length).toBe(0);
    await observed.fetch('https://example.test/');
    expect(source.snapshot().state).toBe('ready');
  });
});

describe('createObservedFetch — construction refusals', () => {
  const refusals: readonly [string, unknown, string][] = [
    ['a non-object', 42, OBSERVED_FETCH_ERRORS.shape],
    ['null', null, OBSERVED_FETCH_ERRORS.shape],
    ['an array', [], OBSERVED_FETCH_ERRORS.shape],
    ['an extra key', { alias: 'a', url: 'x' }, OBSERVED_FETCH_ERRORS.extraKey],
    ['a non-string alias', { alias: 7 }, OUTBOUND_ALIAS_ERRORS.type],
    ['an empty alias', { alias: '' }, OUTBOUND_ALIAS_ERRORS.bytes],
    ['a control-character alias', { alias: 'a\nb' }, OUTBOUND_ALIAS_ERRORS.control],
    ['a non-function fetch', { alias: 'a', fetch: 'x' }, OBSERVED_FETCH_ERRORS.fetch],
    ['a non-object timing', { alias: 'a', timing: 5 }, OBSERVED_FETCH_ERRORS.timing],
    ['a null timing', { alias: 'a', timing: null }, OBSERVED_FETCH_ERRORS.timing],
    [
      'a throwing now',
      {
        alias: 'a',
        timing: {
          now() {
            throw new Error('clock-canary');
          },
        },
      },
      OBSERVED_FETCH_ERRORS.timing,
    ],
    ['a NaN now', { alias: 'a', timing: { now: () => Number.NaN } }, OBSERVED_FETCH_ERRORS.timing],
    ['a string now', { alias: 'a', timing: { now: () => '1' } }, OBSERVED_FETCH_ERRORS.timing],
  ];
  for (const [label, options, message] of refusals) {
    it(`refuses ${label} with a fixed message`, () => {
      expect(() => createObservedFetch(options as never)).toThrow(message);
    });
  }

  it('probes { now: performance.now } at construction with the per-runtime outcome', () => {
    const build = () =>
      createObservedFetch({ alias: 'a', fetch: ok, timing: { now: performance.now } });
    // Detached `performance.now` throws on Deno and Node and works on Bun; the
    // refusal is loud where it throws, never a silent latch later.
    if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') {
      expect(build).not.toThrow();
    } else {
      expect(build).toThrow(OBSERVED_FETCH_ERRORS.timing);
    }
  });

  it('refuses without crypto.getRandomValues', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!;
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
      expect(() => createObservedFetch({ alias: 'a', fetch: ok })).toThrow(
        OBSERVED_FETCH_ERRORS.random,
      );
    } finally {
      Object.defineProperty(globalThis, 'crypto', descriptor);
    }
  });

  it('accepts the defaults: no fetch, no timing', () => {
    const observed = createObservedFetch({ alias: 'a' });
    expect(typeof observed.fetch).toBe('function');
  });
});
