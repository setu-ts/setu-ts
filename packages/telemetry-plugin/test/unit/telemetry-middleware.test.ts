// deno-lint-ignore-file require-await
/**
 * Tests for the telemetry middleware.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { telemetryMiddleware } from '../../src/middleware/telemetry-middleware.ts';
import type { ISpan, ITelemetryService, NextFunction } from '@hono-enterprise/common';
import { TELEMETRY_CONTEXT_OPAQUE } from '@hono-enterprise/common';
import { TELEMETRY_SPAN_KEY } from '../../src/interfaces/index.ts';
import { createFakeTracerHost } from '../fixtures/fake-tracer-host.ts';
import { TelemetryService } from '../../src/services/telemetry-service.ts';

describe('telemetryMiddleware', () => {
  interface RecordedSpan {
    name: string;
    attributes: Record<string, unknown>;
    status: string | null;
    ended: boolean;
  }

  function createFakeService(): {
    service: ITelemetryService;
    recordedSpans: RecordedSpan[];
    capturedOptions: Array<{ kind?: string; parentContext?: unknown; parentSpan?: unknown }>;
  } {
    const recordedSpans: RecordedSpan[] = [];
    const capturedOptions: Array<{ kind?: string; parentContext?: unknown; parentSpan?: unknown }> =
      [];

    const service: ITelemetryService = {
      async withSpan<T>(
        name: string,
        fn: (span: ISpan) => Promise<T>,
        options?: { kind?: string; parentContext?: unknown; parentSpan?: unknown },
      ): Promise<T> {
        capturedOptions.push(options ?? {});
        const fakeSpan: ISpan & {
          _attrs: Record<string, unknown>;
          _status: string | null;
          _ended: boolean;
          _traceId: string;
          _spanId: string;
        } = {
          _attrs: {},
          _status: null,
          _ended: false,
          _traceId: '0'.repeat(32),
          _spanId: '0'.repeat(16),
          setAttribute(key, value) {
            this._attrs[key] = value;
            return this;
          },
          setAttributes(attrs) {
            for (const [k, v] of Object.entries(attrs)) {
              this._attrs[k] = v;
            }
            return this;
          },
          setStatus(status) {
            this._status = status;
          },
          recordException(_error: Error) {
            // no-op
          },
          end() {
            this._ended = true;
          },
          spanContext() {
            return { traceId: this._traceId, spanId: this._spanId, traceFlags: '01' };
          },
        };
        try {
          return await fn(fakeSpan as ISpan);
        } finally {
          // Mirror TelemetryService.withSpan: own span.end() exactly once.
          fakeSpan.end();
          recordedSpans.push({
            name,
            attributes: { ...fakeSpan._attrs },
            status: fakeSpan._status,
            ended: fakeSpan._ended,
          });
        }
      },
    };

    return { service, recordedSpans, capturedOptions };
  }

  function createMockContext(
    method: string,
    path: string,
    requestHeaders: Record<string, string> = {},
    responseStatus = 200,
  ) {
    const responseHeaders = new Map<string, string>();
    const state = new Map<string, unknown>();

    return {
      id: 'req-123',
      request: {
        method: method as never,
        url: `http://localhost${path}`,
        path,
        headers: new Headers(requestHeaders) as Headers,
        json: async () => ({}),
        text: async () => '',
        bytes: async () => new Uint8Array(),
      },
      response: {
        snapshot: () => ({
          status: responseStatus,
          headers: new Headers(responseHeaders) as Headers,
          body: null,
        }),
        header: (name: string, value: string) => {
          responseHeaders.set(name, value);
        },
      },
      services: {} as never,
      params: {},
      query: {},
      state,
      // F6 fix: monotonic-style value (matches runtime.hrtime() contract, not Date.now()).
      startTime: performance.now(),
    };
  }

  it('should start a span named METHOD /path', async () => {
    const { service, recordedSpans } = createFakeService();
    const tracerHost = createFakeTracerHost();
    const middleware = telemetryMiddleware(service, tracerHost);

    const ctx = createMockContext('GET', '/users');

    let nextCalled = false;
    const next: NextFunction = async () => {
      nextCalled = true;
    };

    await middleware(ctx as never, next);

    expect(nextCalled).toBe(true);
    expect(recordedSpans).toHaveLength(1);
    expect(recordedSpans[0]!.name).toBe('GET /users');
    expect(recordedSpans[0]!.ended).toBe(true);
  });

  it('should store the span on ctx.state under TELEMETRY_SPAN_KEY', async () => {
    const { service } = createFakeService();
    const tracerHost = createFakeTracerHost();
    const middleware = telemetryMiddleware(service, tracerHost);

    const ctx = createMockContext('POST', '/orders');

    await middleware(ctx as never, async () => {});

    const storedSpan = ctx.state.get(TELEMETRY_SPAN_KEY);
    expect(storedSpan).toBeDefined();
  });

  it('should set http.method attribute', async () => {
    const { service, recordedSpans } = createFakeService();
    const tracerHost = createFakeTracerHost();
    const middleware = telemetryMiddleware(service, tracerHost);

    const ctx = createMockContext('DELETE', '/items/1');
    await middleware(ctx as never, async () => {});

    expect(recordedSpans[0]!.attributes['http.method']).toBe('DELETE');
  });

  it('should set http.url attribute', async () => {
    const { service, recordedSpans } = createFakeService();
    const tracerHost = createFakeTracerHost();
    const middleware = telemetryMiddleware(service, tracerHost);

    const ctx = createMockContext('PUT', '/items/1');
    await middleware(ctx as never, async () => {});

    expect(recordedSpans[0]!.attributes['http.url']).toBe('http://localhost/items/1');
  });

  it('should set http.route attribute', async () => {
    const { service, recordedSpans } = createFakeService();
    const tracerHost = createFakeTracerHost();
    const middleware = telemetryMiddleware(service, tracerHost);

    const ctx = createMockContext('PATCH', '/items/1');
    await middleware(ctx as never, async () => {});

    expect(recordedSpans[0]!.attributes['http.route']).toBe('/items/1');
  });

  it('should set http.status_code from response snapshot', async () => {
    const { service, recordedSpans } = createFakeService();
    const tracerHost = createFakeTracerHost();
    const middleware = telemetryMiddleware(service, tracerHost);

    const ctx = createMockContext('GET', '/data', {}, 201);
    await middleware(ctx as never, async () => {});

    expect(recordedSpans[0]!.attributes['http.status_code']).toBe(201);
  });

  it('should set status error when http status >= 400', async () => {
    const { service, recordedSpans } = createFakeService();
    const tracerHost = createFakeTracerHost();
    const middleware = telemetryMiddleware(service, tracerHost);

    const ctx = createMockContext('GET', '/error', {}, 500);
    await middleware(ctx as never, async () => {});

    expect(recordedSpans[0]!.status).toBe('error');
  });

  it('should set status ok when http status < 400', async () => {
    const { service, recordedSpans } = createFakeService();
    const tracerHost = createFakeTracerHost();
    const middleware = telemetryMiddleware(service, tracerHost);

    const ctx = createMockContext('GET', '/success', {}, 200);
    await middleware(ctx as never, async () => {});

    expect(recordedSpans[0]!.status).toBe('ok');
  });

  it('should end the span in finally even when next() throws', async () => {
    const { service, recordedSpans } = createFakeService();
    const tracerHost = createFakeTracerHost();
    const middleware = telemetryMiddleware(service, tracerHost);

    const ctx = createMockContext('GET', '/fail');
    let errorThrown = false;

    try {
      await middleware(ctx as never, async () => {
        throw new Error('handler error');
      });
    } catch (e) {
      errorThrown = true;
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toBe('handler error');
    }

    expect(errorThrown).toBe(true);
    expect(recordedSpans).toHaveLength(1);
    expect(recordedSpans[0]!.ended).toBe(true);
    expect(recordedSpans[0]!.status).toBe('error');
  });

  it('should record exception when next() throws', async () => {
    const { service, recordedSpans } = createFakeService();
    const tracerHost = createFakeTracerHost();
    const middleware = telemetryMiddleware(service, tracerHost);

    const ctx = createMockContext('GET', '/throw');
    let errorThrown = false;

    try {
      await middleware(ctx as never, async () => {
        throw new Error('boom');
      });
    } catch {
      errorThrown = true;
    }

    expect(errorThrown).toBe(true);
    expect(recordedSpans).toHaveLength(1);
    expect(recordedSpans[0]!.status).toBe('error');
  });

  // --- F1 fix: exactly-once end() test ---

  /**
   * F1 regression test: asserts that withSpan ends the span EXACTLY ONCE.
   *
   * The real TelemetryService.withSpan owns span.end() in its finally block.
   * If the middleware ALSO called span.end(), the counter would be 2.
   * This is the test that would have caught the double-end bug.
   */
  it('should call end() EXACTLY ONCE through real TelemetryService path (F1 regression)', async () => {
    // Count end() invocations on the underlying span handle.
    let endCount = 0;

    const fakeSpan = {
      _attrs: {} as Record<string, unknown>,
      _status: null as string | null,
      _ended: false as boolean,
      _traceId: '0'.repeat(32),
      _spanId: '0'.repeat(16),
      setAttribute(key: string, value: unknown) {
        this._attrs[key] = value;
        return this;
      },
      setAttributes(attrs: Record<string, unknown>) {
        for (const [k, v] of Object.entries(attrs)) {
          this._attrs[k] = v;
        }
        return this;
      },
      setStatus(status: string) {
        this._status = status;
      },
      recordException(_error: Error) {
        // no-op
      },
      end() {
        endCount++;
        this._ended = true;
      },
      spanContext() {
        return { traceId: this._traceId, spanId: this._spanId, traceFlags: '01' };
      },
    };

    const tracerHost = {
      startSpan() {
        return fakeSpan;
      },
      extractContext() {
        return { _opaque: TELEMETRY_CONTEXT_OPAQUE };
      },
      injectContext() {
        return {};
      },
      shutdown: async () => {},
      forceFlush: async () => {},
    } as never;

    // Use the REAL TelemetryService (not a fake).
    const service = new TelemetryService(tracerHost);
    const middlewareFn = telemetryMiddleware(service, tracerHost);

    const ctx = createMockContext('GET', '/exact-once');
    await middlewareFn(ctx as never, async () => {});

    // F1 assertion: end() must be called EXACTLY ONCE by withSpan's finally.
    // If the middleware also called end(), endCount would be 2.
    expect(endCount).toBe(1);
    expect(fakeSpan._ended).toBe(true);
  });

  // --- Propagation tests (C1, C2, R2) ---

  it('should extract traceparent from request headers and pass parentContext', async () => {
    const { service, capturedOptions } = createFakeService();
    const tracerHost = createFakeTracerHost();
    const middleware = telemetryMiddleware(service, tracerHost);

    const ctx = createMockContext('GET', '/propagate', {
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    });
    await middleware(ctx as never, async () => {});

    // N4 fix: the middleware now passes parentContext directly (no bridge).
    expect(capturedOptions).toHaveLength(1);
    const pc = capturedOptions[0]!.parentContext as
      | { traceId?: string; spanId?: string }
      | undefined;
    expect(pc).toBeDefined();
    expect(pc?.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(pc?.spanId).toBe('b7ad6b7169203331');
    expect(capturedOptions[0]!.kind).toBe('server');
  });

  it('should set traceparent response header with valid W3C format', async () => {
    const { service } = createFakeService();
    const tracerHost = createFakeTracerHost();
    const middleware = telemetryMiddleware(service, tracerHost);

    // Incoming traceparent
    const ctx = createMockContext('GET', '/resp-header', {
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    });
    await middleware(ctx as never, async () => {});

    // The response header should be set from the span's own spanContext().
    const respHeader = ctx.response.snapshot().headers.get('traceparent');
    expect(respHeader).toBeDefined();
    // Verify W3C format: 00-<32hex>-<16hex>-<2hex>
    expect(respHeader).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
  });

  it('should propagate incoming traceId into response traceparent', async () => {
    const { service, capturedOptions } = createFakeService();
    const tracerHost = createFakeTracerHost();
    const middleware = telemetryMiddleware(service, tracerHost);

    const incomingTraceId = '0af7651916cd43dd8448eb211c80319c';
    const ctx = createMockContext('GET', '/propagate-id', {
      traceparent: `00-${incomingTraceId}-b7ad6b7169203331-01`,
    });
    await middleware(ctx as never, async () => {});

    // N4 fix: verify parentContext was passed with the incoming traceId.
    const pc = capturedOptions[0]!.parentContext as { traceId?: string } | undefined;
    expect(pc?.traceId).toBe(incomingTraceId);

    // The fake span's spanContext returns zeros — the response header carries
    // whatever the fake span produces (zeros in this case).
    const respHeader = ctx.response.snapshot().headers.get('traceparent');
    expect(respHeader).toBeDefined();
    // Verify W3C format is valid.
    expect(respHeader).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
  });

  it('should produce a valid traceparent when no incoming traceparent', async () => {
    const { service } = createFakeService();
    const tracerHost = createFakeTracerHost();
    const middleware = telemetryMiddleware(service, tracerHost);

    const ctx = createMockContext('GET', '/new-trace');
    await middleware(ctx as never, async () => {});

    // Even without an incoming traceparent, injectContext generates a fresh traceId/spanId
    const respHeader = ctx.response.snapshot().headers.get('traceparent');
    expect(respHeader).toBeDefined();
    // Should be valid W3C format
    expect(respHeader).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
  });

  it('should fall back gracefully when traceparent header is invalid', async () => {
    const { service, recordedSpans } = createFakeService();
    const tracerHost = createFakeTracerHost();
    const middleware = telemetryMiddleware(service, tracerHost);

    const ctx = createMockContext('GET', '/invalid-parent', {
      traceparent: 'invalid-format',
    });
    await middleware(ctx as never, async () => {});

    expect(recordedSpans).toHaveLength(1);
    expect(recordedSpans[0]!.ended).toBe(true);
  });
});
