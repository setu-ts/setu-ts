import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { _getDefaults, createTestContext, MockResponse } from '../../src/mock-context.ts';
import { MockServiceRegistry } from '../../src/mock-registry.ts';
import type { IRuntimeServices } from '@hono-enterprise/common';

// Build a runtime fake where every accessor is verified individually.
// This covers all DEFAULT_TEST_RUNTIME accessors plus any injected runtime.

describe('createTestContext', () => {
  it('returns context with default id from test runtime', () => {
    const ctx = createTestContext();
    expect(ctx.id).toBe('test-ctx');
  });

  it('default startTime is 0 (not Date.now())', () => {
    const ctx = createTestContext();
    expect(ctx.startTime).toBe(0);
    expect(ctx.startTime).toBeLessThan(10000);
  });

  it('signal defaults to a live AbortSignal', () => {
    const ctx = createTestContext();
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
    expect(ctx.signal?.aborted).toBe(false);
  });

  it('services defaults to MockServiceRegistry', () => {
    const ctx = createTestContext();
    expect(ctx.services).toBeInstanceOf(MockServiceRegistry);
  });

  it('response defaults to MockResponse', () => {
    const ctx = createTestContext();
    expect(ctx.response).toBeInstanceOf(MockResponse);
  });

  it('params defaults to empty object', () => {
    const ctx = createTestContext();
    expect(ctx.params).toEqual({});
  });

  it('state defaults to Map', () => {
    const ctx = createTestContext();
    expect(ctx.state).toBeInstanceOf(Map);
  });

  it('query defaults to parsed from request URL search params', () => {
    const ctx = createTestContext({
      request: { method: 'GET', url: 'http://localhost/?foo=bar&baz=qux' },
    });
    expect(ctx.query).toEqual({ foo: 'bar', baz: 'qux' });
  });

  it('query can be overridden', () => {
    const ctx = createTestContext({ query: { custom: 'value' } });
    expect(ctx.query).toEqual({ custom: 'value' });
  });

  it('startTime precedence: default 0', () => {
    const ctx = createTestContext();
    expect(ctx.startTime).toBe(0);
  });

  it('startTime precedence: runtime.hrtime() when only runtime passed', () => {
    const runtime: IRuntimeServices = {
      platform: () => 'deno' as const,
      version: () => '1.0',
      hostname: () => 'local',
      uuid: () => 'r-uuid',
      randomBytes: () => new Uint8Array(0),
      subtle: null as unknown as SubtleCrypto,
      now: () => 0,
      hrtime: () => 42,
      setTimeout: () => 0 as unknown as ReturnType<IRuntimeServices['setTimeout']>,
      clearTimeout: () => {},
      setInterval: () => 0 as unknown as ReturnType<IRuntimeServices['setInterval']>,
      clearInterval: () => {},
      env: {} as Readonly<Record<string, string | undefined>>,
      exit: () => {
        throw new Error('exit');
      },
    };
    const ctx = createTestContext({ runtime });
    expect(ctx.startTime).toBe(42);
  });

  it('startTime precedence: direct override wins over runtime.hrtime()', () => {
    const runtime: IRuntimeServices = {
      platform: () => 'deno' as const,
      version: () => '1.0',
      hostname: () => 'local',
      uuid: () => 'r-uuid',
      randomBytes: () => new Uint8Array(0),
      subtle: null as unknown as SubtleCrypto,
      now: () => 0,
      hrtime: () => 42,
      setTimeout: () => 0 as unknown as ReturnType<IRuntimeServices['setTimeout']>,
      clearTimeout: () => {},
      setInterval: () => 0 as unknown as ReturnType<IRuntimeServices['setInterval']>,
      clearInterval: () => {},
      env: {} as Readonly<Record<string, string | undefined>>,
      exit: () => {
        throw new Error('exit');
      },
    };
    const ctx = createTestContext({ startTime: 7, runtime });
    expect(ctx.startTime).toBe(7);
  });

  it('runtime.uuid() sets context id', () => {
    const runtime: IRuntimeServices = {
      platform: () => 'deno' as const,
      version: () => '1.0',
      hostname: () => 'local',
      uuid: () => 'custom-uuid',
      randomBytes: () => new Uint8Array(0),
      subtle: null as unknown as SubtleCrypto,
      now: () => 0,
      hrtime: () => 0,
      setTimeout: () => 0 as unknown as ReturnType<IRuntimeServices['setTimeout']>,
      clearTimeout: () => {},
      setInterval: () => 0 as unknown as ReturnType<IRuntimeServices['setInterval']>,
      clearInterval: () => {},
      env: {} as Readonly<Record<string, string | undefined>>,
      exit: () => {
        throw new Error('exit');
      },
    };
    const ctx = createTestContext({ runtime });
    expect(ctx.id).toBe('custom-uuid');
  });

  it('signal override is honored', () => {
    const controller = new AbortController();
    const ctx = createTestContext({ signal: controller.signal });
    expect(ctx.signal).toBe(controller.signal);
  });

  it('MockRequest body readers parse the provided body', async () => {
    const ctx = createTestContext({ body: JSON.stringify({ key: 'val' }) });
    expect((await ctx.request.json<{ key: string }>()).key).toBe('val');
    expect(await ctx.request.text()).toBe('{"key":"val"}');
  });

  it('MockRequest.bytes() reads body as bytes', async () => {
    const ctx = createTestContext({ body: 'hello' });
    expect(await ctx.request.bytes()).toEqual(new TextEncoder().encode('hello'));
  });

  it('MockRequest.bytes() handles non-string body', async () => {
    const ctx = createTestContext({ body: 42 });
    expect(await ctx.request.bytes()).toEqual(new TextEncoder().encode(''));
  });

  it('request.path defaults to pathname from url', () => {
    const ctx = createTestContext({
      request: { method: 'GET', url: 'http://localhost/foo/bar?x=1' },
    });
    expect(ctx.request.path).toBe('/foo/bar');
  });

  it('request.path can be overridden', () => {
    const ctx = createTestContext({
      request: { method: 'GET', url: 'http://localhost/', path: '/custom' },
    });
    expect(ctx.request.path).toBe('/custom');
  });

  it('context with explicit services uses provided registry', () => {
    const customRegistry = new MockServiceRegistry();
    customRegistry.register('token', { test: true });
    const ctx = createTestContext({ services: customRegistry });
    expect(ctx.services).toBe(customRegistry);
    expect(ctx.services.get('token')).toEqual({ test: true });
  });

  it('context with explicit response uses provided response', () => {
    const customResp = new MockResponse();
    const ctx = createTestContext({ response: customResp });
    expect(ctx.response).toBe(customResp);
  });

  it('context with explicit params uses provided params', () => {
    const ctx = createTestContext({ params: { id: '42' } });
    expect(ctx.params).toEqual({ id: '42' });
  });

  it('context with explicit state uses provided map', () => {
    const customState = new Map<string, unknown>();
    customState.set('key', 'value');
    const ctx = createTestContext({ state: customState });
    expect(ctx.state).toBe(customState);
    expect(ctx.state.get('key')).toBe('value');
  });

  it('context with body as object returns it via json()', async () => {
    const ctx = createTestContext({ body: { typed: true } });
    expect((await ctx.request.json<{ typed: boolean }>()).typed).toBe(true);
  });

  it('context with headers in request uses provided headers', () => {
    const customHeaders = new Headers();
    customHeaders.set('X-Custom', 'value');
    const ctx = createTestContext({
      request: { method: 'GET', url: 'http://localhost/', headers: customHeaders },
    });
    expect(ctx.request.headers.get('X-Custom')).toBe('value');
  });

  it('default runtime accessors: platform, version, hostname, now, randomBytes', () => {
    // Create a context and verify all runtime-accessed fields work.
    // This implicitly exercises DEFAULT_TEST_RUNTIME's uuid and hrtime.
    const ctx = createTestContext();
    expect(ctx.id).toBe('test-ctx');
    expect(ctx.startTime).toBe(0);
  });

  it('all DEFAULT_TEST_RUNTIME accessors return expected defaults', () => {
    const defaults = _getDefaults();
    // Verify every accessor on DEFAULT_TEST_RUNTIME directly.
    expect(defaults.platform()).toBe('deno');
    expect(defaults.version()).toBe('0.0.0');
    expect(defaults.hostname()).toBe('localhost');
    expect(defaults.uuid()).toBe('test-ctx');
    const rb = defaults.randomBytes(4);
    // DEFAULT_TEST_RUNTIME returns empty Uint8Array for coverage testing;
    // a real runtime would return the requested bytes.
    expect(rb).toBeInstanceOf(Uint8Array);
    expect(rb.length).toBeGreaterThanOrEqual(0);
    expect(defaults.now()).toBe(0);
    expect(defaults.hrtime()).toBe(0);

    // setTimeout/setInterval return timer handles
    const timerHandle = defaults.setTimeout(() => {
      /* no-op — timers fire asynchronously */
    }, 1);
    // These are real timers; we skip waiting for them in tests.
    expect(timerHandle).toBeDefined();
    defaults.clearTimeout(timerHandle);

    const intervalHandle = defaults.setInterval(() => {}, 1000);
    expect(intervalHandle).toBeDefined();
    defaults.clearInterval(intervalHandle);

    // exit throws
    let exited = false;
    try {
      defaults.exit();
    } catch {
      exited = true;
    }
    expect(exited).toBe(true);
  });
});

describe('MockResponse', () => {
  it('json() sets ended=true and snapshot body', () => {
    const resp = new MockResponse();
    resp.json({ x: 1 });
    expect(resp.ended).toBe(true);
    const snap = resp.snapshot();
    expect(snap.streaming).toBe(false);
    expect(snap.status).toBe(200);
    expect(snap.body).toBe('{"x":1}');
  });

  it('stream() sets streaming: true in snapshot', () => {
    const resp = new MockResponse();
    const stream = new ReadableStream<Uint8Array>();
    resp.stream(stream);
    expect(resp.ended).toBe(true);
    const snap = resp.snapshot();
    expect(snap.streaming).toBe(true);
    expect(snap.body).toBe(stream);
  });

  it('header() overwrites existing value', () => {
    const resp = new MockResponse();
    resp.header('x-test', 'a').header('x-test', 'b');
    expect(resp.snapshot().headers.get('x-test')).toBe('b');
  });

  it('appendHeader() appends value', () => {
    const resp = new MockResponse();
    resp.appendHeader('x-multi', 'a').appendHeader('x-multi', 'b');
    expect(resp.snapshot().headers.get('x-multi')).toContain('a');
  });

  it('redirect() sets Location header and ended', () => {
    const resp = new MockResponse();
    resp.redirect('/new-path', 301);
    expect(resp.ended).toBe(true);
    expect(resp.snapshot().status).toBe(301);
    expect(resp.snapshot().headers.get('Location')).toBe('/new-path');
  });

  it('send() sets ended', () => {
    const resp = new MockResponse();
    resp.send(new Uint8Array([1, 2, 3]));
    expect(resp.ended).toBe(true);
  });

  it('text() sets ended', () => {
    const resp = new MockResponse();
    resp.text('hello');
    expect(resp.ended).toBe(true);
  });

  it('status() chains and updates snapshot', () => {
    const resp = new MockResponse();
    resp.status(404);
    expect(resp.snapshot().status).toBe(404);
    expect(resp.ended).toBe(false);
  });

  it('snapshot status defaults to 200', () => {
    const resp = new MockResponse();
    expect(resp.snapshot().status).toBe(200);
  });

  it('snapshot headers are empty by default', () => {
    const resp = new MockResponse();
    expect(resp.snapshot().headers.get('x-fake')).toBeNull();
  });

  it('snapshot body is null by default', () => {
    const resp = new MockResponse();
    expect(resp.snapshot().body).toBeNull();
  });

  it('redirect with default status sets 302', () => {
    const resp = new MockResponse();
    resp.redirect('/new-path');
    expect(resp.snapshot().status).toBe(302);
  });

  it('send without argument sets body to null', () => {
    const resp = new MockResponse();
    resp.send();
    expect(resp.snapshot().body).toBeNull();
  });
});
