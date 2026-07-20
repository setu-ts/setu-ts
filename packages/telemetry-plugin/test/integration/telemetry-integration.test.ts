// deno-lint-ignore-file require-await
/**
 * Integration test for the telemetry plugin with a fake TracerHost.
 *
 * Exercises the real plugin path (real mode with tracerProviderFactory)
 * and verifies the middleware + service work together.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { TelemetryPlugin } from '../../src/plugin/telemetry-plugin.ts';
import { TELEMETRY_SPAN_KEY } from '../../src/interfaces/index.ts';
import type { ISpan, ITelemetryService } from '@hono-enterprise/common';
import type { TracerHost } from '../../src/interfaces/index.ts';

describe('telemetry integration (fake TracerHost)', () => {
  it('should register the service and middleware, then execute a request span', async () => {
    const recordedSpans: Array<{ name: string; attributes: Record<string, unknown> }> = [];

    const fakeHost: TracerHost = {
      startSpan(name, options) {
        recordedSpans.push({
          name,
          attributes: (options?.attributes as Record<string, unknown>) ?? {},
        });
        return {
          setAttribute(k: string, v: unknown) {
            recordedSpans[recordedSpans.length - 1]!.attributes[k] = v;
            return this;
          },
          setAttributes(attrs: Record<string, unknown>) {
            for (const [k, v] of Object.entries(attrs)) {
              recordedSpans[recordedSpans.length - 1]!.attributes[k] = v;
            }
            return this;
          },
          setStatus(_status: unknown) {
            return this;
          },
          recordException(_error: Error) {
            return this;
          },
          end() {
            return this;
          },
        } as unknown as ISpan;
      },
      extractContext() {
        return { _opaque: Symbol.for('test') } as never;
      },
      injectContext() {
        return {};
      },
      shutdown: async () => {},
      forceFlush: async () => {},
    };

    const registered = new Map<string, unknown>();
    let middlewareAdded = false;
    let middlewareFn: ((ctx: never, next: () => Promise<void>) => Promise<void>) | undefined;
    const shutdownHooks: Array<() => Promise<void>> = [];

    const mockCtx = {
      services: {
        register<T>(token: string, service: T) {
          registered.set(token, service);
        },
        get<T>(token: string): T {
          return registered.get(token) as T;
        },
      },
      middleware: {
        add(fn: unknown) {
          middlewareAdded = true;
          middlewareFn = fn as never;
        },
      },
      lifecycle: {
        onShutdown(fn: () => Promise<void>) {
          shutdownHooks.push(fn);
        },
      },
      runtime: { uuid: () => 'mock-uuid' },
      router: {},
    } as never;

    const plugin = TelemetryPlugin({
      serviceName: 'integration-test',
      exporter: 'console',
      tracerProviderFactory: async () => fakeHost,
    });
    await plugin.register(mockCtx);

    // Verify service is registered
    const service = registered.get('telemetry') as ITelemetryService;
    expect(service).toBeDefined();
    expect(typeof service.withSpan).toBe('function');

    // Verify middleware is registered
    expect(middlewareAdded).toBe(true);

    // Execute the middleware
    expect(middlewareFn).toBeDefined();

    const state = new Map<string, unknown>();
    const responseHeaders = new Map<string, string>();
    let responseStatus = 200;

    const ctx = {
      id: 'req-abc',
      request: {
        method: 'GET',
        url: 'http://localhost/test',
        path: '/test',
        headers: new Headers() as Headers,
        json: async () => ({}),
        text: async () => '',
        bytes: async () => new Uint8Array(),
      },
      response: {
        status(code: number) {
          responseStatus = code;
          return this;
        },
        header(name: string, value: string) {
          responseHeaders.set(name, value);
          return this;
        },
        snapshot() {
          return {
            status: responseStatus,
            headers: new Headers(responseHeaders) as Headers,
            body: null,
          };
        },
      },
      services: {} as never,
      params: {},
      query: {},
      state,
      startTime: Date.now(),
    } as never;

    await middlewareFn!(ctx, async () => {});

    // Verify the span was recorded
    expect(recordedSpans).toHaveLength(1);
    expect(recordedSpans[0]!.name).toBe('GET /test');
    expect(recordedSpans[0]!.attributes['http.method']).toBe('GET');
    expect(recordedSpans[0]!.attributes['http.status_code']).toBe(200);

    // Verify span was stored on ctx.state
    expect(state.has(TELEMETRY_SPAN_KEY)).toBe(true);
  });

  it('should work in noop mode without any OTel dependency', async () => {
    const registered = new Map<string, unknown>();

    const mockCtx = {
      services: {
        register<T>(token: string, service: T) {
          registered.set(token, service);
        },
        get<T>(token: string): T {
          return registered.get(token) as T;
        },
      },
      middleware: {
        add(_fn: unknown, _options?: unknown) {
          // no-op
        },
      },
      lifecycle: {
        onShutdown(_fn: () => Promise<void>) {
          // no-op
        },
      },
      runtime: { uuid: () => 'mock-uuid' },
      router: {},
    } as never;

    const plugin = TelemetryPlugin({ serviceName: 'noop-test' });
    await plugin.register(mockCtx);

    const service = registered.get('telemetry') as ITelemetryService;
    expect(service).toBeDefined();

    // withSpan should run the callback and return its value
    const result = await service.withSpan('noop-span', async (span) => {
      span.setAttribute('key', 'value');
      return 'noop-result';
    });

    expect(result).toBe('noop-result');
  });
});
