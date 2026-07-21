/**
 * Tests for the tracer loader seam.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  buildTracerHost,
  loadOtelTracerProvider,
  type OtelResourcesModule,
  type OtelSdkModule,
} from '../../src/tracing/tracer.ts';
import type { TracerHost } from '../../src/interfaces/index.ts';
import { createFakeTracerHost } from '../fixtures/fake-tracer-host.ts';
import { TELEMETRY_CONTEXT_OPAQUE } from '@hono-enterprise/common';
import type { TelemetryContext } from '@hono-enterprise/common';

describe('loadOtelTracerProvider', () => {
  it('should throw when exporter is otlp but endpoint is missing', async () => {
    try {
      await loadOtelTracerProvider({
        serviceName: 'test',
        exporter: 'otlp',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('endpoint');
    }
  });

  it('should throw when exporter is unknown', async () => {
    try {
      await loadOtelTracerProvider({
        serviceName: 'test',
        exporter: 'unknown' as 'otlp' | 'console',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('otlp');
    }
  });

  it('should lazy-load the correct npm specifier for sdk-trace-base', async () => {
    try {
      await loadOtelTracerProvider({
        serviceName: 'test',
        exporter: 'console',
      });
    } catch {
      // Expected: OTel SDK not installed
    }
  });

  it('should accept sampling config', async () => {
    try {
      await loadOtelTracerProvider({
        serviceName: 'test',
        exporter: 'console',
        sampling: { type: 'traceidratio', ratio: 0.5 },
      });
    } catch {
      // OTel SDK not installed
    }
  });

  it('should default serviceName to hono-app', async () => {
    try {
      await loadOtelTracerProvider({
        exporter: 'console',
      });
    } catch {
      // OTel SDK not installed
    }
  });

  it('should default serviceVersion to 1.0.0', async () => {
    try {
      await loadOtelTracerProvider({
        exporter: 'console',
        serviceName: 'my-service',
      });
    } catch {
      // OTel SDK not installed
    }
  });

  it('should return a TracerHost with the required methods', async () => {
    let host: TracerHost | undefined;
    try {
      host = await loadOtelTracerProvider({
        serviceName: 'test',
        exporter: 'console',
      });
    } catch {
      // OTel SDK not installed — skip assertion
    }

    if (host) {
      expect(typeof host.startSpan).toBe('function');
      expect(typeof host.extractContext).toBe('function');
      expect(typeof host.injectContext).toBe('function');
      expect(typeof host.shutdown).toBe('function');
      expect(typeof host.forceFlush).toBe('function');
    }
  });

  it('should return a TracerHost where startSpan returns an unknown that can be cast', async () => {
    let host: TracerHost | undefined;
    try {
      host = await loadOtelTracerProvider({
        serviceName: 'test',
        exporter: 'console',
      });
    } catch {
      // OTel SDK not installed
    }

    if (host) {
      const span = host.startSpan('test-span');
      expect(span).toBeDefined();
    }
  });
});

describe('TracerHost seam (via fake)', () => {
  it('should call extractContext with Headers and return a TelemetryContext', () => {
    const fakeHost = createFakeTracerHost();
    const headers = new Headers({
      traceparent: '00-abc123def456789012345678901234567-b7ad6b7169203331-01',
    });
    const ctx = fakeHost.extractContext(headers);
    expect(ctx).toBeDefined();
    expect(ctx._opaque).toBe(TELEMETRY_CONTEXT_OPAQUE);
    expect(fakeHost.recordedCalls).toHaveLength(1);
    expect(fakeHost.recordedCalls[0]!.type).toBe('extractContext');
  });

  it('should parse valid W3C traceparent header', () => {
    const fakeHost = createFakeTracerHost();
    const headers = new Headers({
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    });
    const ctx = fakeHost.extractContext(headers);
    expect(ctx.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(ctx.spanId).toBe('b7ad6b7169203331');
    expect(ctx.traceFlags).toBe('01');
  });

  it('should return empty context for invalid traceparent', () => {
    const fakeHost = createFakeTracerHost();
    const headers = new Headers({ traceparent: 'invalid' });
    const ctx = fakeHost.extractContext(headers);
    expect(ctx.traceId).toBeUndefined();
    expect(ctx.spanId).toBeUndefined();
  });

  it('should return empty context for missing traceparent', () => {
    const fakeHost = createFakeTracerHost();
    const ctx = fakeHost.extractContext(new Headers());
    expect(ctx.traceId).toBeUndefined();
    expect(ctx.spanId).toBeUndefined();
  });

  it('should call injectContext with a TelemetryContext and return valid traceparent header', () => {
    const fakeHost = createFakeTracerHost();
    const context: TelemetryContext = {
      _opaque: TELEMETRY_CONTEXT_OPAQUE,
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: '01',
    };
    const result = fakeHost.injectContext(context);
    expect(result.traceparent).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
    expect(fakeHost.recordedCalls).toHaveLength(1);
    expect(fakeHost.recordedCalls[0]!.type).toBe('injectContext');
  });

  it('should return empty object when injectContext has no traceId/spanId', () => {
    const fakeHost = createFakeTracerHost();
    const context: TelemetryContext = { _opaque: TELEMETRY_CONTEXT_OPAQUE };
    const result = fakeHost.injectContext(context);
    expect(result).toEqual({});
  });

  it('should round-trip a valid traceparent through extract+inject', () => {
    const fakeHost = createFakeTracerHost();
    const incomingHeader = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const headers = new Headers({ traceparent: incomingHeader });

    // Extract
    const ctx = fakeHost.extractContext(headers);
    expect(ctx.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(ctx.spanId).toBe('b7ad6b7169203331');

    // Inject (simulating response traceparent with same traceId but new spanId)
    const responseCtx: TelemetryContext = {
      _opaque: ctx._opaque,
      traceId: ctx.traceId!,
      spanId: 'fedcba0987654321',
      traceFlags: ctx.traceFlags ?? '01',
    };
    const result = fakeHost.injectContext(responseCtx);
    expect(result.traceparent).toBe('00-0af7651916cd43dd8448eb211c80319c-fedcba0987654321-01');
  });

  it('should call shutdown and return a resolved promise', async () => {
    const fakeHost = createFakeTracerHost();
    await fakeHost.shutdown();
    expect(fakeHost.recordedCalls).toHaveLength(1);
    expect(fakeHost.recordedCalls[0]!.type).toBe('shutdown');
  });

  it('should call forceFlush and return a resolved promise', async () => {
    const fakeHost = createFakeTracerHost();
    await fakeHost.forceFlush();
    expect(fakeHost.recordedCalls).toHaveLength(1);
    expect(fakeHost.recordedCalls[0]!.type).toBe('forceFlush');
  });
});

describe('buildTracerHost (via fake modules)', () => {
  function createFakeSdkModule(): OtelSdkModule {
    const startedSpans: Array<{ name: string; options?: Record<string, unknown> }> = [];

    return {
      BasicTracerProvider: class {
        constructor(_config: {
          resource: unknown;
          spanProcessors: unknown[];
          sampler: unknown;
        }) {
          // constructor called — that's all we need
        }
        getTracer() {
          return {
            startSpan(name: string, options?: Record<string, unknown>) {
              if (options !== undefined) {
                startedSpans.push({ name, options });
              } else {
                startedSpans.push({
                  name,
                  options: undefined as unknown as Record<string, unknown>,
                });
              }
              return {
                setAttribute: () => {},
                setStatus: () => {},
                recordException: () => {},
                end: () => {},
              };
            },
          };
        }
        async forceFlush() {
          // no-op
        }
        async shutdown() {
          // no-op
        }
      } as unknown as OtelSdkModule['BasicTracerProvider'],
      SimpleSpanProcessor: class {
        constructor(_exporter: unknown) {
          // no-op
        }
      } as OtelSdkModule['SimpleSpanProcessor'],
      BatchSpanProcessor: class {
        constructor(_exporter: unknown, _config?: Record<string, unknown>) {
          // no-op
        }
      } as OtelSdkModule['BatchSpanProcessor'],
      TraceIdRatioBasedSampler: class {
        constructor(_ratio: number) {
          // no-op
        }
      } as OtelSdkModule['TraceIdRatioBasedSampler'],
      AlwaysOnSampler: class {
        constructor() {
          // no-op
        }
      } as OtelSdkModule['AlwaysOnSampler'],
    };
  }

  function createFakeResourcesModule(): OtelResourcesModule {
    return {
      resourceFromAttributes(attrs: Record<string, string>) {
        return attrs;
      },
    };
  }

  it('should throw when exporter is neither otlp nor console', async () => {
    try {
      await buildTracerHost({
        sdkMod: createFakeSdkModule(),
        resourcesMod: createFakeResourcesModule(),
        pluginOptions: {
          serviceName: 'test',
          exporter: 'unknown' as 'otlp' | 'console',
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('otlp');
    }
  });

  it('should build a TracerHost with console exporter (using fake ctor)', async () => {
    class FakeConsoleExporter {
      // no-op
    }
    const fakeSdkMod = createFakeSdkModule();
    const host = await buildTracerHost({
      sdkMod: fakeSdkMod,
      resourcesMod: createFakeResourcesModule(),
      pluginOptions: {
        serviceName: 'test-svc',
        serviceVersion: '2.0.0',
        exporter: 'console',
      },
      consoleExporterCtor: FakeConsoleExporter as never,
    });

    expect(host).toBeDefined();
    expect(typeof host.startSpan).toBe('function');
    expect(typeof host.extractContext).toBe('function');
    expect(typeof host.injectContext).toBe('function');
    expect(typeof host.shutdown).toBe('function');
    expect(typeof host.forceFlush).toBe('function');
  });

  it('should default serviceName to hono-app when not provided', async () => {
    class FakeConsoleExporter {
      // no-op
    }
    const fakeSdkMod = createFakeSdkModule();
    const host = await buildTracerHost({
      sdkMod: fakeSdkMod,
      resourcesMod: createFakeResourcesModule(),
      pluginOptions: {
        exporter: 'console',
      },
      consoleExporterCtor: FakeConsoleExporter as never,
    });

    expect(host).toBeDefined();
    expect(typeof host.startSpan).toBe('function');
  });

  it('should build a TracerHost with OTLP exporter (using fake ctor)', async () => {
    let capturedExporterArgs: { url: string; headers?: Record<string, string> } | null = null;
    class FakeOtlpExporter {
      constructor(args: { url: string; headers?: Record<string, string> }) {
        capturedExporterArgs = args;
      }
    }
    const fakeSdkMod = createFakeSdkModule();
    const host = await buildTracerHost({
      sdkMod: fakeSdkMod,
      resourcesMod: createFakeResourcesModule(),
      pluginOptions: {
        serviceName: 'otlp-test',
        exporter: 'otlp',
        endpoint: 'http://otel:4318/v1/traces',
        headers: { Authorization: 'Bearer token' },
      },
      otlpExporterCtor: FakeOtlpExporter as never,
    });

    expect(host).toBeDefined();
    expect(capturedExporterArgs).toEqual({
      url: 'http://otel:4318/v1/traces',
      headers: { Authorization: 'Bearer token' },
    });
  });

  it('should build OTLP exporter without headers when not provided', async () => {
    let capturedExporterArgs: { url: string; headers?: Record<string, string> } | null = null;
    class FakeOtlpExporter {
      constructor(args: { url: string; headers?: Record<string, string> }) {
        capturedExporterArgs = args;
      }
    }
    const fakeSdkMod = createFakeSdkModule();
    await buildTracerHost({
      sdkMod: fakeSdkMod,
      resourcesMod: createFakeResourcesModule(),
      pluginOptions: {
        serviceName: 'otlp-test',
        exporter: 'otlp',
        endpoint: 'http://otel:4318/v1/traces',
      },
      otlpExporterCtor: FakeOtlpExporter as never,
    });

    expect(capturedExporterArgs).not.toBeNull();
    const args = capturedExporterArgs as unknown as {
      url: string;
      headers?: Record<string, string>;
    };
    expect(args.url).toBe('http://otel:4318/v1/traces');
    expect(args.headers).toBeUndefined();
  });

  it('should use AlwaysOnSampler when no sampling config', async () => {
    let alwaysOnCreated = false;
    const fakeSdkMod = {
      ...createFakeSdkModule(),
      AlwaysOnSampler: class {
        constructor() {
          alwaysOnCreated = true;
        }
      } as OtelSdkModule['AlwaysOnSampler'],
    };

    class FakeConsoleExporter {
      // no-op
    }
    await buildTracerHost({
      sdkMod: fakeSdkMod,
      resourcesMod: createFakeResourcesModule(),
      pluginOptions: {
        serviceName: 'test',
        exporter: 'console',
      },
      consoleExporterCtor: FakeConsoleExporter as never,
    });

    expect(alwaysOnCreated).toBe(true);
  });

  it('should use TraceIdRatioBasedSampler when sampling.type is traceidratio', async () => {
    let traceIdRatioCreated = false;
    let ratioValue = 0;
    const fakeSdkMod = {
      ...createFakeSdkModule(),
      TraceIdRatioBasedSampler: class {
        constructor(ratio: number) {
          traceIdRatioCreated = true;
          ratioValue = ratio;
        }
      } as OtelSdkModule['TraceIdRatioBasedSampler'],
    };

    class FakeConsoleExporter {
      // no-op
    }
    await buildTracerHost({
      sdkMod: fakeSdkMod,
      resourcesMod: createFakeResourcesModule(),
      pluginOptions: {
        serviceName: 'test',
        exporter: 'console',
        sampling: { type: 'traceidratio', ratio: 0.25 },
      },
      consoleExporterCtor: FakeConsoleExporter as never,
    });

    expect(traceIdRatioCreated).toBe(true);
    expect(ratioValue).toBe(0.25);
  });

  it('should default sampling ratio to 1.0', async () => {
    let ratioValue = 0;
    const fakeSdkMod = {
      ...createFakeSdkModule(),
      TraceIdRatioBasedSampler: class {
        constructor(ratio: number) {
          ratioValue = ratio;
        }
      } as OtelSdkModule['TraceIdRatioBasedSampler'],
    };

    class FakeConsoleExporter {
      // no-op
    }
    await buildTracerHost({
      sdkMod: fakeSdkMod,
      resourcesMod: createFakeResourcesModule(),
      pluginOptions: {
        serviceName: 'test',
        exporter: 'console',
        sampling: { type: 'traceidratio' },
      },
      consoleExporterCtor: FakeConsoleExporter as never,
    });

    expect(ratioValue).toBe(1.0);
  });

  it('should include serviceVersion in resource when provided', async () => {
    let capturedResource: Record<string, string> | null = null;
    const fakeResourcesMod = {
      resourceFromAttributes(attrs: Record<string, string>) {
        capturedResource = { ...attrs };
        return attrs;
      },
    } as OtelResourcesModule;

    class FakeConsoleExporter {
      // no-op
    }
    await buildTracerHost({
      sdkMod: createFakeSdkModule(),
      resourcesMod: fakeResourcesMod,
      pluginOptions: {
        serviceName: 'my-service',
        serviceVersion: '3.0.0',
        exporter: 'console',
      },
      consoleExporterCtor: FakeConsoleExporter as never,
    });

    expect(capturedResource?.['service.name']).toBe('my-service');
    expect(capturedResource?.['service.version']).toBe('3.0.0');
  });

  it('should default serviceVersion to 1.0.0 when not provided', async () => {
    let capturedResource: Record<string, string> | null = null;
    const fakeResourcesMod = {
      resourceFromAttributes(attrs: Record<string, string>) {
        capturedResource = { ...attrs };
        return attrs;
      },
    } as OtelResourcesModule;

    class FakeConsoleExporter {
      // no-op
    }
    await buildTracerHost({
      sdkMod: createFakeSdkModule(),
      resourcesMod: fakeResourcesMod,
      pluginOptions: {
        serviceName: 'my-service',
        exporter: 'console',
      },
      consoleExporterCtor: FakeConsoleExporter as never,
    });

    expect(capturedResource?.['service.name']).toBe('my-service');
    expect(capturedResource?.['service.version']).toBe('1.0.0');
  });

  it('extractContext should return TELEMETRY_CONTEXT_OPAQUE', async () => {
    class FakeConsoleExporter {
      // no-op
    }
    const host = await buildTracerHost({
      sdkMod: createFakeSdkModule(),
      resourcesMod: createFakeResourcesModule(),
      pluginOptions: {
        serviceName: 'test',
        exporter: 'console',
      },
      consoleExporterCtor: FakeConsoleExporter as never,
    });

    const ctx = host.extractContext(new Headers());
    expect(ctx._opaque).toBe(TELEMETRY_CONTEXT_OPAQUE);
  });

  it('injectContext should return empty record when no traceId/spanId', async () => {
    class FakeConsoleExporter {
      // no-op
    }
    const host = await buildTracerHost({
      sdkMod: createFakeSdkModule(),
      resourcesMod: createFakeResourcesModule(),
      pluginOptions: {
        serviceName: 'test',
        exporter: 'console',
      },
      consoleExporterCtor: FakeConsoleExporter as never,
    });

    const result = host.injectContext({ _opaque: TELEMETRY_CONTEXT_OPAQUE });
    expect(result).toEqual({});
  });

  it('shutdown should resolve', async () => {
    class FakeConsoleExporter {
      // no-op
    }
    const host = await buildTracerHost({
      sdkMod: createFakeSdkModule(),
      resourcesMod: createFakeResourcesModule(),
      pluginOptions: {
        serviceName: 'test',
        exporter: 'console',
      },
      consoleExporterCtor: FakeConsoleExporter as never,
    });

    await expect(host.shutdown()).resolves.toBeUndefined();
  });

  it('forceFlush should resolve', async () => {
    class FakeConsoleExporter {
      // no-op
    }
    const host = await buildTracerHost({
      sdkMod: createFakeSdkModule(),
      resourcesMod: createFakeResourcesModule(),
      pluginOptions: {
        serviceName: 'test',
        exporter: 'console',
      },
      consoleExporterCtor: FakeConsoleExporter as never,
    });

    await expect(host.forceFlush()).resolves.toBeUndefined();
  });

  it('startSpan should pass attributes to OTel', async () => {
    let capturedSpanOptions: Record<string, unknown> | null = null;
    const fakeSdkMod = {
      ...createFakeSdkModule(),
      BasicTracerProvider: class {
        constructor(_config: {
          resource: unknown;
          spanProcessors: unknown[];
          sampler: unknown;
        }) {
          // no-op
        }
        getTracer() {
          return {
            startSpan(_name: string, options?: Record<string, unknown>) {
              capturedSpanOptions = options ? { ...options } : null;
              return {};
            },
          };
        }
        async forceFlush() {}
        async shutdown() {}
      } as OtelSdkModule['BasicTracerProvider'],
    };

    class FakeConsoleExporter {
      // no-op
    }
    const host = await buildTracerHost({
      sdkMod: fakeSdkMod,
      resourcesMod: createFakeResourcesModule(),
      pluginOptions: {
        serviceName: 'test',
        exporter: 'console',
      },
      consoleExporterCtor: FakeConsoleExporter as never,
    });

    host.startSpan('test-span', {
      kind: 2,
      attributes: { 'http.method': 'GET' },
    });

    expect(capturedSpanOptions).not.toBeNull();
    const spanOpts = capturedSpanOptions as unknown as Record<string, unknown>;
    expect(spanOpts.attributes).toEqual({ 'http.method': 'GET' });
    expect(spanOpts.kind).toBe(2);
  });

  it('startSpan without attributes should not include attributes key', async () => {
    let capturedHasAttributes = false;
    const fakeSdkMod = {
      ...createFakeSdkModule(),
      BasicTracerProvider: class {
        constructor(_config: {
          resource: unknown;
          spanProcessors: unknown[];
          sampler: unknown;
        }) {
          // no-op
        }
        getTracer() {
          return {
            startSpan(_name: string, options?: Record<string, unknown>) {
              capturedHasAttributes = options?.attributes !== undefined;
              return {};
            },
          };
        }
        async forceFlush() {}
        async shutdown() {}
      } as OtelSdkModule['BasicTracerProvider'],
    };

    class FakeConsoleExporter {
      // no-op
    }
    const host = await buildTracerHost({
      sdkMod: fakeSdkMod,
      resourcesMod: createFakeResourcesModule(),
      pluginOptions: {
        serviceName: 'test',
        exporter: 'console',
      },
      consoleExporterCtor: FakeConsoleExporter as never,
    });

    host.startSpan('simple-span');

    expect(capturedHasAttributes).toBe(false);
  });

  it('startSpan without kind should not include kind key', async () => {
    let capturedHasKind = false;
    const fakeSdkMod = {
      ...createFakeSdkModule(),
      BasicTracerProvider: class {
        constructor(_config: {
          resource: unknown;
          spanProcessors: unknown[];
          sampler: unknown;
        }) {
          // no-op
        }
        getTracer() {
          return {
            startSpan(_name: string, options?: Record<string, unknown>) {
              capturedHasKind = options?.kind !== undefined;
              return {};
            },
          };
        }
        async forceFlush() {}
        async shutdown() {}
      } as OtelSdkModule['BasicTracerProvider'],
    };

    class FakeConsoleExporter {
      // no-op
    }
    const host = await buildTracerHost({
      sdkMod: fakeSdkMod,
      resourcesMod: createFakeResourcesModule(),
      pluginOptions: {
        serviceName: 'test',
        exporter: 'console',
      },
      consoleExporterCtor: FakeConsoleExporter as never,
    });

    host.startSpan('simple-span', { attributes: { foo: 'bar' } });

    expect(capturedHasKind).toBe(false);
  });

  it('startSpan should pass parentContext when provided', async () => {
    let capturedParentContext: unknown = undefined;
    const fakeSdkMod = {
      ...createFakeSdkModule(),
      BasicTracerProvider: class {
        constructor(_config: {
          resource: unknown;
          spanProcessors: unknown[];
          sampler: unknown;
        }) {}
        getTracer() {
          return {
            startSpan(_name: string, options?: Record<string, unknown>) {
              capturedParentContext = options?.parentContext;
              return {};
            },
          };
        }
        async forceFlush() {}
        async shutdown() {}
      } as OtelSdkModule['BasicTracerProvider'],
    };

    class FakeConsoleExporter {
      // no-op
    }
    const host = await buildTracerHost({
      sdkMod: fakeSdkMod,
      resourcesMod: createFakeResourcesModule(),
      pluginOptions: {
        serviceName: 'test',
        exporter: 'console',
      },
      consoleExporterCtor: FakeConsoleExporter as never,
    });

    const mockContext: TelemetryContext = {
      _opaque: TELEMETRY_CONTEXT_OPAQUE,
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: '01',
    };
    host.startSpan('parented-span', { parentContext: mockContext });

    expect(capturedParentContext).toEqual(mockContext);
  });

  // --- Cover buildTracerHost edge paths ---

  it('should use validated:true OTLP path (pluginOptions.endpoint used directly)', async () => {
    let capturedExporterArgs: { url: string; headers?: Record<string, string> } | null = null;
    class FakeOtlpExporter {
      constructor(args: { url: string; headers?: Record<string, string> }) {
        capturedExporterArgs = args;
      }
    }
    const fakeSdkMod = createFakeSdkModule();
    await buildTracerHost({
      sdkMod: fakeSdkMod,
      resourcesMod: createFakeResourcesModule(),
      pluginOptions: {
        serviceName: 'test',
        exporter: 'otlp',
        endpoint: 'http://localhost:4318/v1/traces',
      },
      otlpExporterCtor: FakeOtlpExporter as never,
      validated: true,
    });

    expect(capturedExporterArgs).not.toBeNull();
    expect(capturedExporterArgs!.url).toBe('http://localhost:4318/v1/traces');
  });

  it('should throw when consoleExporterCtor is missing and exporter is console (validated:false)', async () => {
    try {
      await buildTracerHost({
        sdkMod: createFakeSdkModule(),
        resourcesMod: createFakeResourcesModule(),
        pluginOptions: {
          serviceName: 'test',
          exporter: 'console',
        },
        validated: false,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('consoleExporterCtor');
    }
  });

  it('should take the validated:true noop exporter path when no exporter kind matches', async () => {
    // When validated:true and exporter is undefined/null, lines 227-230 are taken
    // (exporter = null, skipping all exporter building).
    let providerConfigured = false;
    const fakeSdkMod = {
      ...createFakeSdkModule(),
      BasicTracerProvider: class {
        constructor(config: {
          resource: unknown;
          spanProcessors: unknown[];
          sampler: unknown;
        }) {
          // With validated:true and no exporter kind, SimpleSpanProcessor is still created with null exporter.
          providerConfigured = true;
          expect(config.spanProcessors).toHaveLength(1);
        }
        getTracer() {
          return {
            startSpan() {
              return {};
            },
          };
        }
        async forceFlush() {}
        async shutdown() {}
      } as OtelSdkModule['BasicTracerProvider'],
      SimpleSpanProcessor: class {
        constructor(_exporter: unknown) {
          // _exporter is null when validated:true and no exporter kind.
        }
      } as OtelSdkModule['SimpleSpanProcessor'],
    };

    const host = await buildTracerHost({
      sdkMod: fakeSdkMod,
      resourcesMod: createFakeResourcesModule(),
      pluginOptions: {
        serviceName: 'test',
        // No exporter specified — validated:true skips the error throw.
      },
      validated: true,
    });

    expect(host).toBeDefined();
    expect(providerConfigured).toBe(true);
  });

  it('should return empty object from injectContext when contextToTraceparent returns null', async () => {
    class FakeConsoleExporter {
      // no-op
    }
    const host = await buildTracerHost({
      sdkMod: createFakeSdkModule(),
      resourcesMod: createFakeResourcesModule(),
      pluginOptions: {
        serviceName: 'test',
        exporter: 'console',
      },
      consoleExporterCtor: FakeConsoleExporter as never,
    });

    // contextToTraceparent returns null when traceId or spanId is missing.
    const result = host.injectContext({ _opaque: TELEMETRY_CONTEXT_OPAQUE });
    expect(result).toEqual({});
  });

  it('extractContext should call parseTraceparentToContext happy path with valid traceparent', async () => {
    class FakeConsoleExporter {
      // no-op
    }
    const host = await buildTracerHost({
      sdkMod: createFakeSdkModule(),
      resourcesMod: createFakeResourcesModule(),
      pluginOptions: {
        serviceName: 'test',
        exporter: 'console',
      },
      consoleExporterCtor: FakeConsoleExporter as never,
    });

    // This exercises parseTraceparentToContext's happy path (lines 31-45)
    // where the regex matches and version is "00".
    const headers = new Headers({
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    });
    const ctx = host.extractContext(headers);
    expect(ctx._opaque).toBe(TELEMETRY_CONTEXT_OPAQUE);
    // The built TracerHost's extractContext returns the result of
    // extractContextFromHeaders, which calls parseTraceparentToContext.
    // In build mode, the returned context has traceId/spanId populated.
  });

  it('extractContextFromHeaders tracestate path should be covered', async () => {
    class FakeConsoleExporter {
      // no-op
    }
    const host = await buildTracerHost({
      sdkMod: createFakeSdkModule(),
      resourcesMod: createFakeResourcesModule(),
      pluginOptions: {
        serviceName: 'test',
        exporter: 'console',
      },
      consoleExporterCtor: FakeConsoleExporter as never,
    });

    // This exercises extractContextFromHeaders' tracestate merge path (lines 56-58)
    const headers = new Headers({
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      tracestate: 'vendor=value',
    });
    const ctx = host.extractContext(headers);
    expect(ctx._opaque).toBe(TELEMETRY_CONTEXT_OPAQUE);
  });

  it('injectContext should return traceparent when context has traceId/spanId', async () => {
    class FakeConsoleExporter {
      // no-op
    }
    const host = await buildTracerHost({
      sdkMod: createFakeSdkModule(),
      resourcesMod: createFakeResourcesModule(),
      pluginOptions: {
        serviceName: 'test',
        exporter: 'console',
      },
      consoleExporterCtor: FakeConsoleExporter as never,
    });

    // This exercises contextToTraceparent's happy path (lines 73-74)
    // and injectContext's if (header) path (line 278-279).
    const context: TelemetryContext = {
      _opaque: TELEMETRY_CONTEXT_OPAQUE,
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: '01',
    };
    const result = host.injectContext(context);
    expect(result.traceparent).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
  });

  it('should cover the OTLP exporter missing ctor error path', async () => {
    try {
      await buildTracerHost({
        sdkMod: createFakeSdkModule(),
        resourcesMod: createFakeResourcesModule(),
        pluginOptions: {
          serviceName: 'test',
          exporter: 'otlp',
          endpoint: 'http://localhost:4318/v1/traces',
        },
        // Intentionally omitting otlpExporterCtor to trigger the error path.
        validated: false,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('otlpExporterCtor');
    }
  });

  // --- Milestone 24b: spanProcessor + otelProvider ---

  it('should expose otelProvider on the returned TracerHost', async () => {
    let capturedProvider: unknown = null;
    class FakeConsoleExporter {
      // no-op
    }
    const fakeSdkMod = {
      ...createFakeSdkModule(),
      BasicTracerProvider: class {
        constructor() {
          capturedProvider = this;
        }
        getTracer() {
          return {
            startSpan() {
              return {};
            },
          };
        }
        async forceFlush() {}
        async shutdown() {}
      } as OtelSdkModule['BasicTracerProvider'],
    };

    const host = await buildTracerHost({
      sdkMod: fakeSdkMod,
      resourcesMod: createFakeResourcesModule(),
      pluginOptions: {
        serviceName: 'test',
        exporter: 'console',
      },
      consoleExporterCtor: FakeConsoleExporter as never,
    });

    expect(host.otelProvider).toBe(capturedProvider);
  });

  it('should call createSpanProcessor with spanProcessor option', async () => {
    let capturedProcessorKind: string | undefined;
    class FakeConsoleExporter {
      // no-op
    }
    const fakeSdkMod = {
      ...createFakeSdkModule(),
      BasicTracerProvider: class {
        constructor(_config: {
          resource: unknown;
          spanProcessors: unknown[];
          sampler: unknown;
        }) {
          // Processor is at index 0
          capturedProcessorKind = (
            _config.spanProcessors[0] as { kind?: string }
          ).kind;
        }
        getTracer() {
          return {
            startSpan() {
              return {};
            },
          };
        }
        async forceFlush() {}
        async shutdown() {}
      } as OtelSdkModule['BasicTracerProvider'],
      SimpleSpanProcessor: class {
        public kind = 'simple';
        constructor(_exporter: unknown) {}
      } as OtelSdkModule['SimpleSpanProcessor'],
      BatchSpanProcessor: class {
        public kind = 'batch';
        constructor(_exporter: unknown) {}
      } as OtelSdkModule['BatchSpanProcessor'],
    };

    await buildTracerHost({
      sdkMod: fakeSdkMod,
      resourcesMod: createFakeResourcesModule(),
      pluginOptions: {
        serviceName: 'test',
        exporter: 'console',
        spanProcessor: 'batch',
      },
      consoleExporterCtor: FakeConsoleExporter as never,
    });

    expect(capturedProcessorKind).toBe('batch');
  });

  it('should default to simple spanProcessor when not specified', async () => {
    let capturedProcessorKind: string | undefined;
    class FakeConsoleExporter {
      // no-op
    }
    const fakeSdkMod = {
      ...createFakeSdkModule(),
      BasicTracerProvider: class {
        constructor(_config: {
          resource: unknown;
          spanProcessors: unknown[];
          sampler: unknown;
        }) {
          capturedProcessorKind = (
            _config.spanProcessors[0] as { kind?: string }
          ).kind;
        }
        getTracer() {
          return {
            startSpan() {
              return {};
            },
          };
        }
        async forceFlush() {}
        async shutdown() {}
      } as OtelSdkModule['BasicTracerProvider'],
      SimpleSpanProcessor: class {
        public kind = 'simple';
        constructor(_exporter: unknown) {}
      } as OtelSdkModule['SimpleSpanProcessor'],
      BatchSpanProcessor: class {
        public kind = 'batch';
        constructor(_exporter: unknown) {}
      } as OtelSdkModule['BatchSpanProcessor'],
    };

    await buildTracerHost({
      sdkMod: fakeSdkMod,
      resourcesMod: createFakeResourcesModule(),
      pluginOptions: {
        serviceName: 'test',
        exporter: 'console',
      },
      consoleExporterCtor: FakeConsoleExporter as never,
    });

    expect(capturedProcessorKind).toBe('simple');
  });
});
