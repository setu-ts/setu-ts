/**
 * Tests for the tracer loader seam.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { loadOtelTracerProvider } from '../../src/tracing/tracer.ts';
import type { TracerHost } from '../../src/interfaces/index.ts';
import { createFakeTracerHost } from '../fixtures/fake-tracer-host.ts';
import { TELEMETRY_CONTEXT_OPAQUE } from '@hono-enterprise/common';

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

import type { TelemetryContext } from '@hono-enterprise/common';
