/**
 * Tests for the OTLP exporter loader.
 *
 * @module
 */
import { describe, expect, it, vi } from 'vitest';
import { loadOtlpExporter } from '../../src/exporters/otlp-exporter.ts';

describe('loadOtlpExporter', () => {
  it('should throw when url is empty', async () => {
    await expect(loadOtlpExporter('')).rejects.toThrow('url');
  });

  it('should throw when url is undefined', async () => {
    await expect(loadOtlpExporter(undefined as unknown as string)).rejects.toThrow('url');
  });

  it('should return the OTLPTraceExporter constructor when url is provided', async () => {
    // Not swallowed: the real dep must load and yield a constructor — a failure here is a real failure.
    const Ctor = await loadOtlpExporter('http://localhost:4318/v1/traces');
    expect(Ctor).toBeInstanceOf(Function);
  });
});

describe('loadOtlpExporter — the guarded import (M113d §3.1)', () => {
  it('rejects with OptionalDependencyUnavailableError when the package is absent', async () => {
    const { loadOtlpExporter } = await import('../../src/exporters/otlp-exporter.ts');
    vi.doMock('@opentelemetry/exporter-trace-otlp-http', () => {
      throw new Error('Cannot find package');
    });
    try {
      let caught: unknown;
      try {
        await loadOtlpExporter('http://127.0.0.1:4318');
      } catch (error) {
        caught = error;
      }
      const loadError = caught as Error & { dependency: string; cause: unknown };
      expect(loadError.name).toBe('OptionalDependencyUnavailableError');
      expect(loadError.dependency).toBe('@opentelemetry/exporter-trace-otlp-http');
      expect(loadError.cause).toBeInstanceOf(Error);
    } finally {
      vi.doUnmock('@opentelemetry/exporter-trace-otlp-http');
    }
  });
});
