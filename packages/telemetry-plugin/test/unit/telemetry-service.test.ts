// deno-lint-ignore-file require-await
/**
 * Tests for the telemetry service implementations.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { NoopTelemetryService, TelemetryService } from '../../src/services/telemetry-service.ts';
import type { ISpan, ITelemetryService, SpanOptions } from '@hono-enterprise/common';
import { TELEMETRY_CONTEXT_OPAQUE } from '@hono-enterprise/common';
import { createFakeTracerHost } from '../fixtures/fake-tracer-host.ts';

describe('NoopTelemetryService', () => {
  it('should implement ITelemetryService', () => {
    const service: ITelemetryService = new NoopTelemetryService();
    expect(service).toBeDefined();
    expect(typeof service.withSpan).toBe('function');
  });

  it('should run the callback and return its value', async () => {
    const service = new NoopTelemetryService();
    const result = await service.withSpan('test-span', async (span) => {
      span.setAttribute('key', 'value');
      return 42;
    });
    expect(result).toBe(42);
  });

  it('should pass a NoopSpan to the callback', async () => {
    const service = new NoopTelemetryService();
    let receivedSpan: ISpan | null = null;
    await service.withSpan('test', async (span) => {
      receivedSpan = span;
      return 'done';
    });
    expect(receivedSpan).toBeInstanceOf(Object);
    expect(typeof receivedSpan!.setAttribute).toBe('function');
    expect(typeof receivedSpan!.end).toBe('function');
  });

  it('should run the callback even when it throws, but forward the error', async () => {
    const service = new NoopTelemetryService();
    let callbackInvoked = false;
    try {
      await service.withSpan('test', async (_span) => {
        callbackInvoked = true;
        throw new Error('boom');
      });
    } catch {
      // expected
    }
    expect(callbackInvoked).toBe(true);
  });

  it('should ignore span options', async () => {
    const service = new NoopTelemetryService();
    const opts: SpanOptions = { kind: 'server', attributes: { foo: 'bar' } };
    const result = await service.withSpan('test', async (span) => {
      span.setAttribute('ignored', true);
      return 'ok';
    }, opts);
    expect(result).toBe('ok');
  });

  it('should exercise all NoopSpan methods', async () => {
    const service = new NoopTelemetryService();
    let receivedSpan: ISpan | null = null;
    await service.withSpan('noop-all-methods', async (span) => {
      receivedSpan = span;
      // Exercise every NoopSpan method to achieve coverage
      span.setAttribute('a', 1);
      span.setAttributes({ b: 2, c: 'three' });
      span.setStatus('ok');
      span.setStatus('error');
      span.setStatus('unset');
      span.recordException(new Error('test error'));
      span.end();
    });
    expect(receivedSpan).not.toBeNull();
  });
});

describe('TelemetryService', () => {
  it('should wrap the TracerHost startSpan calls', async () => {
    const fakeHost = createFakeTracerHost();
    const service = new TelemetryService(fakeHost);

    const result = await service.withSpan('my-span', async (span) => {
      span.setAttribute('http.method', 'GET');
      span.setStatus('ok');
      return 'success';
    });

    expect(result).toBe('success');
    expect(fakeHost.recordedSpans).toHaveLength(1);
    expect(fakeHost.recordedSpans[0]!.name).toBe('my-span');
    expect(fakeHost.recordedSpans[0]!.attributes).toEqual({ 'http.method': 'GET' });
    expect(fakeHost.recordedSpans[0]!.status).toBe('ok');
    expect(fakeHost.recordedSpans[0]!.ended).toBe(true);
  });

  it('should call span.end() in finally even when the callback throws', async () => {
    const fakeHost = createFakeTracerHost();
    const service = new TelemetryService(fakeHost);

    try {
      await service.withSpan('error-span', async (span) => {
        span.setAttribute('before-error', true);
        throw new Error('something went wrong');
      });
    } catch {
      // expected
    }

    expect(fakeHost.recordedSpans).toHaveLength(1);
    expect(fakeHost.recordedSpans[0]!.ended).toBe(true);
    expect(fakeHost.recordedSpans[0]!.status).toBe('error');
    expect(fakeHost.recordedSpans[0]!.exceptions).toHaveLength(1);
    expect(fakeHost.recordedSpans[0]!.exceptions[0]!.message).toBe('something went wrong');
  });

  it('should set error status and record exception on callback error', async () => {
    const fakeHost = createFakeTracerHost();
    const service = new TelemetryService(fakeHost);

    try {
      await service.withSpan('exception-span', async (span) => {
        span.setStatus('unset');
        throw new TypeError('type mismatch');
      });
    } catch {
      // expected
    }

    expect(fakeHost.recordedSpans[0]!.status).toBe('error');
    expect(fakeHost.recordedSpans[0]!.exceptions).toHaveLength(1);
    expect(fakeHost.recordedSpans[0]!.exceptions[0]!.name).toBe('TypeError');
  });

  it('should forward the callback return value', async () => {
    const fakeHost = createFakeTracerHost();
    const service = new TelemetryService(fakeHost);

    const result = await service.withSpan('forwarding', async (span) => {
      span.setAttribute('counter', 1);
      return { data: 'forwarded' };
    });

    expect(result).toEqual({ data: 'forwarded' });
  });

  it('should support chained setAttribute calls', async () => {
    const fakeHost = createFakeTracerHost();
    const service = new TelemetryService(fakeHost);

    await service.withSpan('chained', async (span) => {
      span.setAttribute('a', 1).setAttribute('b', 2);
    });

    expect(fakeHost.recordedSpans[0]!.attributes).toEqual({ a: 1, b: 2 });
  });

  it('should support setAttributes', async () => {
    const fakeHost = createFakeTracerHost();
    const service = new TelemetryService(fakeHost);

    await service.withSpan('batch', async (span) => {
      span.setAttributes({ x: 10, y: 20, z: 30 });
    });

    expect(fakeHost.recordedSpans[0]!.attributes).toEqual({ x: 10, y: 20, z: 30 });
  });

  it('should pass SpanOptions.kind to startSpan', async () => {
    const fakeHost = createFakeTracerHost();
    const service = new TelemetryService(fakeHost);

    await service.withSpan('kind-span', () => Promise.resolve(), { kind: 'server' });

    expect(fakeHost.recordedCalls).toHaveLength(1);
    expect(fakeHost.recordedCalls[0]!.type).toBe('startSpan');
    expect(fakeHost.recordedCalls[0]!.args[0]).toBe('kind-span');
    // kind: 'server' maps to 2
    const callArgs = fakeHost.recordedCalls[0]!.args[1] as Record<string, unknown> | undefined;
    expect(callArgs?.kind).toBe(2);
  });

  it('should map all SpanKind values', async () => {
    const fakeHost = createFakeTracerHost();
    const service = new TelemetryService(fakeHost);

    await service.withSpan('internal-span', () => Promise.resolve(), { kind: 'internal' });
    expect(fakeHost.recordedCalls[0]!.args[1]).toHaveProperty('kind', 0);

    fakeHost.recordedCalls.length = 0;
    await service.withSpan('client-span', () => Promise.resolve(), { kind: 'client' });
    expect(fakeHost.recordedCalls[0]!.args[1]).toHaveProperty('kind', 3);

    fakeHost.recordedCalls.length = 0;
    await service.withSpan('producer-span', () => Promise.resolve(), { kind: 'producer' });
    expect(fakeHost.recordedCalls[0]!.args[1]).toHaveProperty('kind', 4);

    fakeHost.recordedCalls.length = 0;
    await service.withSpan('consumer-span', () => Promise.resolve(), { kind: 'consumer' });
    expect(fakeHost.recordedCalls[0]!.args[1]).toHaveProperty('kind', 5);
  });

  it('should pass attributes in SpanOptions', async () => {
    const fakeHost = createFakeTracerHost();
    const service = new TelemetryService(fakeHost);

    await service.withSpan(
      'attrs-span',
      () => Promise.resolve(),
      { attributes: { 'http.method': 'GET', 'custom.tag': 'value' } },
    );

    expect(fakeHost.recordedCalls).toHaveLength(1);
    const callArgs = fakeHost.recordedCalls[0]!.args[1] as Record<string, unknown> | undefined;
    expect(callArgs?.attributes).toEqual({ 'http.method': 'GET', 'custom.tag': 'value' });
  });

  // F5: extractParentContextFromBridge deleted — parentSpan bridge no longer works.
  // This test verifies that parentContext works directly without needing a bridge.
  it('should pass parentContext directly to startSpan', async () => {
    const fakeHost = createFakeTracerHost();
    const service = new TelemetryService(fakeHost);

    await service.withSpan(
      'direct-parent-context',
      () => Promise.resolve(),
      {
        parentContext: {
          _opaque: TELEMETRY_CONTEXT_OPAQUE,
          traceId: 'abc123',
          spanId: 'def456',
          traceFlags: '01',
        },
      },
    );

    // parentContext should be passed directly to startSpan (includes _opaque).
    expect(fakeHost.recordedCalls).toHaveLength(1);
    const callArgs = fakeHost.recordedCalls[0]!.args[1] as Record<string, unknown> | undefined;
    expect(callArgs?.parentContext).toEqual({
      _opaque: TELEMETRY_CONTEXT_OPAQUE,
      traceId: 'abc123',
      spanId: 'def456',
      traceFlags: '01',
    });
  });

  // A2: parentSpan removed from SpanOptions — these tests are deleted:
  // - "should prefer parentContext over parentSpan when both are set"
  // - "should skip parentContext when parentSpan bridge has no _context"
  // - "should not set parentContext when only parentSpan is provided (F5)"

  // F7 regression: OtelSpan.spanContext() normalizes numeric traceFlags to
  // 2-hex string. This test verifies that a fake OTel span returning
  // `traceFlags: 1` (number) gets normalized to `"01"` (string).
  it('should normalize numeric traceFlags to 2-hex string in spanContext (F7)', async () => {
    const fakeHost = {
      startSpan() {
        return {
          setAttribute(_key: string, _value: unknown) {
            /* no-op */
          },
          setAttributes(_attrs: Record<string, unknown>) {
            /* no-op */
          },
          setStatus(_status: string) {
            /* no-op */
          },
          recordException(_error: Error) {
            /* no-op */
          },
          end() {
            /* no-op */
          },
          spanContext() {
            return { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 };
          },
        };
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

    const service = new TelemetryService(fakeHost);

    let capturedCtx: { traceId: string; spanId: string; traceFlags: string } | undefined;
    await service.withSpan('numeric-flags', async (span) => {
      capturedCtx = span.spanContext() as never;
    });

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx!.traceFlags).toBe('01');
    expect(typeof capturedCtx!.traceFlags).toBe('string');
  });

  // F7: normalizeTraceFlags fallback for null traceFlags.
  it('should normalize null traceFlags to "00" in spanContext (F7)', async () => {
    const fakeHost = {
      startSpan() {
        return {
          setAttribute(_key: string, _value: unknown) {
            /* no-op */
          },
          setAttributes(_attrs: Record<string, unknown>) {
            /* no-op */
          },
          setStatus(_status: string) {
            /* no-op */
          },
          recordException(_error: Error) {
            /* no-op */
          },
          end() {
            /* no-op */
          },
          spanContext() {
            return { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: null };
          },
        };
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

    const service = new TelemetryService(fakeHost);

    let capturedCtx: { traceId: string; spanId: string; traceFlags: string } | undefined;
    await service.withSpan('null-flags', async (span) => {
      capturedCtx = span.spanContext() as never;
    });

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx!.traceFlags).toBe('00');
    expect(typeof capturedCtx!.traceFlags).toBe('string');
  });

  // F7: OtelSpan.spanContext() fallback when handle has no spanContext method.
  it('should return empty-string spanContext when handle has no spanContext method (F7)', async () => {
    const fakeHost = {
      startSpan() {
        return {
          setAttribute(_key: string, _value: unknown) {
            /* no-op */
          },
          setAttributes(_attrs: Record<string, unknown>) {
            /* no-op */
          },
          setStatus(_status: string) {
            /* no-op */
          },
          recordException(_error: Error) {
            /* no-op */
          },
          end() {
            /* no-op */
          },
          // No spanContext method — triggers the fallback branch.
        };
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

    const service = new TelemetryService(fakeHost);

    let capturedCtx: { traceId: string; spanId: string; traceFlags: string } | undefined;
    await service.withSpan('no-spanContext-method', async (span) => {
      capturedCtx = span.spanContext() as never;
    });

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx!.traceId).toBe('');
    expect(capturedCtx!.spanId).toBe('');
    expect(capturedCtx!.traceFlags).toBe('');
  });

  // F7: normalizeTraceFlags with undefined traceFlags.
  it('should normalize undefined traceFlags to "00" in spanContext (F7)', async () => {
    const fakeHost = {
      startSpan() {
        return {
          setAttribute(_key: string, _value: unknown) {
            /* no-op */
          },
          setAttributes(_attrs: Record<string, unknown>) {
            /* no-op */
          },
          setStatus(_status: string) {
            /* no-op */
          },
          recordException(_error: Error) {
            /* no-op */
          },
          end() {
            /* no-op */
          },
          spanContext() {
            return { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: undefined };
          },
        };
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

    const service = new TelemetryService(fakeHost);

    let capturedCtx: { traceId: string; spanId: string; traceFlags: string } | undefined;
    await service.withSpan('undefined-flags', async (span) => {
      capturedCtx = span.spanContext() as never;
    });

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx!.traceFlags).toBe('00');
    expect(typeof capturedCtx!.traceFlags).toBe('string');
  });

  // F7: spanContext() fallback when traceId is undefined — triggers raw.traceId ?? ''.
  it('should return empty string traceId when spanContext returns undefined traceId (F7)', async () => {
    const fakeHost = {
      startSpan() {
        return {
          setAttribute(_key: string, _value: unknown) {
            /* no-op */
          },
          setAttributes(_attrs: Record<string, unknown>) {
            /* no-op */
          },
          setStatus(_status: string) {
            /* no-op */
          },
          recordException(_error: Error) {
            /* no-op */
          },
          end() {
            /* no-op */
          },
          spanContext() {
            return { traceId: undefined, spanId: 'b'.repeat(16), traceFlags: 1 };
          },
        };
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

    const service = new TelemetryService(fakeHost);

    let capturedCtx: { traceId: string; spanId: string; traceFlags: string } | undefined;
    await service.withSpan('undefined-traceId', async (span) => {
      capturedCtx = span.spanContext() as never;
    });

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx!.traceId).toBe('');
    expect(capturedCtx!.spanId).toBe('b'.repeat(16));
    expect(capturedCtx!.traceFlags).toBe('01');
  });

  // F7: spanContext() fallback when spanId is undefined — triggers raw.spanId ?? ''.
  it('should return empty string spanId when spanContext returns undefined spanId (F7)', async () => {
    const fakeHost = {
      startSpan() {
        return {
          setAttribute(_key: string, _value: unknown) {
            /* no-op */
          },
          setAttributes(_attrs: Record<string, unknown>) {
            /* no-op */
          },
          setStatus(_status: string) {
            /* no-op */
          },
          recordException(_error: Error) {
            /* no-op */
          },
          end() {
            /* no-op */
          },
          spanContext() {
            return { traceId: 'a'.repeat(32), spanId: undefined, traceFlags: 1 };
          },
        };
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

    const service = new TelemetryService(fakeHost);

    let capturedCtx: { traceId: string; spanId: string; traceFlags: string } | undefined;
    await service.withSpan('undefined-spanId', async (span) => {
      capturedCtx = span.spanContext() as never;
    });

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx!.traceId).toBe('a'.repeat(32));
    expect(capturedCtx!.spanId).toBe('');
    expect(capturedCtx!.traceFlags).toBe('01');
  });

  // F7: spanContext() fallback when both traceId and spanId are undefined — triggers both ?? '' branches.
  it('should return empty strings for both traceId and spanId when spanContext returns both undefined (F7)', async () => {
    const fakeHost = {
      startSpan() {
        return {
          setAttribute(_key: string, _value: unknown) {
            /* no-op */
          },
          setAttributes(_attrs: Record<string, unknown>) {
            /* no-op */
          },
          setStatus(_status: string) {
            /* no-op */
          },
          recordException(_error: Error) {
            /* no-op */
          },
          end() {
            /* no-op */
          },
          spanContext() {
            return { traceId: undefined, spanId: undefined, traceFlags: 1 };
          },
        };
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

    const service = new TelemetryService(fakeHost);

    let capturedCtx: { traceId: string; spanId: string; traceFlags: string } | undefined;
    await service.withSpan('both-undefined', async (span) => {
      capturedCtx = span.spanContext() as never;
    });

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx!.traceId).toBe('');
    expect(capturedCtx!.spanId).toBe('');
    expect(capturedCtx!.traceFlags).toBe('01');
  });
});
