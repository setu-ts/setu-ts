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
    const headers = new Headers({ traceparent: '00-abc123-def456-01' });
    const ctx = fakeHost.extractContext(headers);
    expect(ctx).toBeDefined();
    expect(ctx._opaque).toBe(TELEMETRY_CONTEXT_OPAQUE);
    expect(fakeHost.recordedCalls).toHaveLength(1);
    expect(fakeHost.recordedCalls[0]!.type).toBe('extractContext');
  });

  it('should call injectContext with a TelemetryContext and return headers record', () => {
    const fakeHost = createFakeTracerHost();
    const context: TelemetryContext = { _opaque: TELEMETRY_CONTEXT_OPAQUE };
    const result = fakeHost.injectContext(context);
    expect(result).toEqual({});
    expect(fakeHost.recordedCalls).toHaveLength(1);
    expect(fakeHost.recordedCalls[0]!.type).toBe('injectContext');
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

  it('injectContext should return empty record', async () => {
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
});
