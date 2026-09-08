/**
 * X34-2 — `TracerHost.activeSpanContext`, at the layer where the OTel context
 * is actually reachable.
 *
 * `TelemetryService.activeSpanContext` merely delegates, so its own suite
 * cannot exercise these branches; without this file the method is covered only
 * incidentally by `logger-plugin`'s integration test, which leaves
 * `tracer.ts` below its own package's per-file bar.
 */
import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { contextToTraceparent, TELEMETRY_CONTEXT_OPAQUE } from '@setu-ts/common';

import { TelemetryService } from '../../src/services/telemetry-service.ts';
import { buildTracerHost, setOtelApi } from '../../src/tracing/tracer.ts';
import type { OtelResourcesModule, OtelSdkModule } from '../../src/tracing/tracer.ts';

/** The minimal SDK surface `buildTracerHost` destructures. */
function fakeSdk(): OtelSdkModule {
  return {
    BasicTracerProvider: class {
      constructor(_config: { resource: unknown; spanProcessors: unknown[]; sampler: unknown }) {}
      getTracer() {
        return { startSpan: () => ({ end() {} }) };
      }
      shutdown() {
        return Promise.resolve();
      }
      forceFlush() {
        return Promise.resolve();
      }
    },
    SimpleSpanProcessor: class {
      constructor(_exporter: unknown) {}
    },
    BatchSpanProcessor: class {
      constructor(_exporter: unknown) {}
    },
    TraceIdRatioBasedSampler: class {
      constructor(_ratio: number) {}
    },
    AlwaysOnSampler: class {},
  } as unknown as OtelSdkModule;
}

/** The minimal resources surface `buildTracerHost` destructures. */
function fakeResources(): OtelResourcesModule {
  return { resourceFromAttributes: () => ({}) } as unknown as OtelResourcesModule;
}

/** Builds a host with span activation on, which is what declares the member. */
function host(contextActivation = true) {
  return buildTracerHost({
    sdkMod: fakeSdk(),
    resourcesMod: fakeResources(),
    pluginOptions: { serviceName: 'probe', exporter: 'console' },
    consoleExporterCtor: class {} as never,
    validated: true,
    contextActivation,
  });
}

/** Installs a fake `@opentelemetry/api` reporting one active span. */
function installApi(activeSpan: { spanContext(): unknown } | undefined): void {
  setOtelApi(
    {
      trace: {
        wrapSpanContext: () => ({}),
        setSpan: () => ({}),
        getActiveSpan: () => activeSpan,
      },
      context: {
        active: () => ({}),
        with: <T>(_c: unknown, fn: () => Promise<T>) => fn(),
        setGlobalContextManager: () => true,
      },
    } as never,
  );
}

afterEach(() => {
  // Module-level state: restored so a fake cannot leak into another file's
  // no-api assertions.
  setOtelApi(null);
});

describe('TracerHost.activeSpanContext', () => {
  it('reports the active span, normalizing OTel numeric traceFlags to 2-hex', () => {
    installApi({
      spanContext: () => ({
        traceId: '0af7651916cd43dd8448eb211c80319c',
        spanId: 'b7ad6b7169203331',
        // OTel reports this as a NUMBER; the contract is a 2-char hex string.
        traceFlags: 1,
      }),
    });

    expect(host().activeSpanContext?.()).toEqual({
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: '01',
    });
  });

  it('reports undefined when no span is active', () => {
    installApi(undefined);
    expect(host().activeSpanContext?.()).toBeUndefined();
  });

  it('reports undefined when the API was never installed', () => {
    setOtelApi(null);
    expect(host().activeSpanContext?.()).toBeUndefined();
  });

  it('treats an all-empty span context as nothing active', () => {
    // A non-recording span reports empty identifiers. Enriching a record with
    // those would join it to a trace that does not exist, which is worse than
    // not joining it at all.
    installApi({ spanContext: () => ({ traceId: '', spanId: '', traceFlags: '' }) });
    expect(host().activeSpanContext?.()).toBeUndefined();
  });

  it('treats a missing spanId as nothing active', () => {
    installApi({ spanContext: () => ({ traceId: 'a'.repeat(32), traceFlags: '01' }) });
    expect(host().activeSpanContext?.()).toBeUndefined();
  });

  it('treats a missing traceId as nothing active', () => {
    installApi({ spanContext: () => ({ spanId: 'b'.repeat(16), traceFlags: '01' }) });
    expect(host().activeSpanContext?.()).toBeUndefined();
  });

  it('treats a W3C ALL-ZERO trace id as nothing active', () => {
    // `00000000000000000000000000000000` is what OTel reports for an INVALID
    // span context. The shared codec refuses to format it, so the producer side
    // propagates nothing; returning it here would let a log record name a trace
    // that no other signal can carry.
    installApi({
      spanContext: () => ({ traceId: '0'.repeat(32), spanId: 'b'.repeat(16), traceFlags: '01' }),
    });
    expect(host().activeSpanContext?.()).toBeUndefined();
  });

  it('treats a W3C all-zero SPAN id as nothing active', () => {
    installApi({
      spanContext: () => ({ traceId: 'a'.repeat(32), spanId: '0'.repeat(16), traceFlags: '01' }),
    });
    expect(host().activeSpanContext?.()).toBeUndefined();
  });

  it('treats a malformed (wrong-length) trace id as nothing active', () => {
    installApi({
      spanContext: () => ({ traceId: 'abc', spanId: 'b'.repeat(16), traceFlags: '01' }),
    });
    expect(host().activeSpanContext?.()).toBeUndefined();
  });

  it('treats a non-hex trace id as nothing active', () => {
    installApi({
      spanContext: () => ({ traceId: 'z'.repeat(32), spanId: 'b'.repeat(16), traceFlags: '01' }),
    });
    expect(host().activeSpanContext?.()).toBeUndefined();
  });

  it('accepts exactly what the producer side would propagate', () => {
    // The read path and the write path must agree on which contexts are real:
    // anything this returns must be formattable by the codec the queue uses.
    const context = {
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: '01',
    };
    installApi({ spanContext: () => context });
    const read = host().activeSpanContext?.();
    expect(read).toEqual(context);
    expect(
      contextToTraceparent({ _opaque: TELEMETRY_CONTEXT_OPAQUE, ...read! }),
    ).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
  });

  it('defaults unreadable traceFlags to "00" rather than dropping the span', () => {
    installApi({
      spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }),
    });
    expect(host().activeSpanContext?.()?.traceFlags).toBe('00');
  });

  it('is OMITTED entirely when span activation is off', () => {
    // Without a context manager nothing is ever active, so a host that cannot
    // activate could only ever answer `undefined`. Omitting says "cannot see",
    // which is the answer a consumer can act on.
    const built = host(false);
    expect(built.activeSpanContext).toBeUndefined();
    expect('activeSpanContext' in built).toBe(false);
    expect('activate' in built).toBe(false);
  });
});

describe('OtelSpan.setAttributes fallback', () => {
  it('loops individual setAttribute calls for a span with no native batch method', async () => {
    // Older OTel spans expose only `setAttribute`. The fallback existed with no
    // test, so extracting `normalizeTraceFlags` out of this file made it the
    // last uncovered block in it.
    const written: Array<[string, unknown]> = [];
    const span = {
      setAttribute: (key: string, value: unknown) => written.push([key, value]),
      setStatus: () => {},
      recordException: () => {},
      end: () => {},
    };
    const service = new TelemetryService({
      startSpan: () => span,
      extractContext: () => ({ _opaque: Symbol.for('he.telemetry.context') } as never),
      injectContext: () => ({}),
      shutdown: () => Promise.resolve(),
      forceFlush: () => Promise.resolve(),
    });

    await service.withSpan('op', (s) => {
      s.setAttributes({ 'a.one': 1, 'a.two': 'two' });
      return Promise.resolve();
    });

    expect(written).toEqual([['a.one', 1], ['a.two', 'two']]);
  });
});
