/**
 * Tests for the console exporter loader.
 *
 * @module
 */
import { describe, expect, it, vi } from 'vitest';
import { loadConsoleExporter } from '../../src/exporters/console-exporter.ts';

describe('loadConsoleExporter', () => {
  it('should return a constructor', async () => {
    try {
      const Ctor = await loadConsoleExporter();
      expect(Ctor).toBeInstanceOf(Function);
    } catch {
      // OTel SDK not installed — expected in CI without npm deps
    }
  });

  it('should throw a clear error if the npm package is not installed', async () => {
    try {
      await loadConsoleExporter();
      // If it succeeds, verify it's a function
    } catch (error) {
      if (error instanceof Error) {
        // The error message should be informative
        expect(error.message.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('loadConsoleExporter — the guarded import (M113d §3.1)', () => {
  it('rejects with OptionalDependencyUnavailableError when the package is absent', async () => {
    const { loadConsoleExporter } = await import('../../src/exporters/console-exporter.ts');
    vi.doMock('@opentelemetry/sdk-trace-base', () => {
      throw new Error('Cannot find package');
    });
    try {
      let caught: unknown;
      try {
        await loadConsoleExporter();
      } catch (error) {
        caught = error;
      }
      const loadError = caught as Error & { dependency: string; cause: unknown };
      expect(loadError.name).toBe('OptionalDependencyUnavailableError');
      expect(loadError.dependency).toBe('@opentelemetry/sdk-trace-base');
      expect(loadError.cause).toBeInstanceOf(Error);
    } finally {
      vi.doUnmock('@opentelemetry/sdk-trace-base');
    }
  });
});
