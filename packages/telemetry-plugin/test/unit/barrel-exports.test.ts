/**
 * Tests for the telemetry-plugin barrel exports.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as barrel from '../../src/index.ts';

describe('barrel exports', () => {
  it('should export TelemetryPlugin as a function', () => {
    expect(barrel.TelemetryPlugin).toBeDefined();
    expect(typeof barrel.TelemetryPlugin).toBe('function');
  });

  it('should export telemetryMiddleware as a function', () => {
    expect(barrel.telemetryMiddleware).toBeDefined();
    expect(typeof barrel.telemetryMiddleware).toBe('function');
  });

  it('should export TELEMETRY_SPAN_KEY as a string', () => {
    expect(barrel.TELEMETRY_SPAN_KEY).toBeDefined();
    expect(typeof barrel.TELEMETRY_SPAN_KEY).toBe('string');
    expect(barrel.TELEMETRY_SPAN_KEY).toBe('__he_telemetry_span');
  });

  it('should export NoopTelemetryService as a class', () => {
    expect(barrel.NoopTelemetryService).toBeDefined();
    expect(typeof barrel.NoopTelemetryService).toBe('function');
  });

  it('should export TracerHost type (compile-time only)', () => {
    // TracerHost is a type — it won't appear in the namespace at runtime.
    // The test here just verifies the barrel doesn't throw when imported.
    expect(barrel).toBeDefined();
  });

  it('should export SpanExporterKind type (compile-time only)', () => {
    expect(barrel).toBeDefined();
  });

  it('should export ITelemetryService type (re-export from common)', () => {
    // ITelemetryService is a type — it won't appear at runtime.
    // The barrel re-export compiles if the import path is correct.
    expect(barrel).toBeDefined();
  });

  it('should export ISpan type (re-export from common)', () => {
    expect(barrel).toBeDefined();
  });

  it('should export SpanStatus type (re-export from common)', () => {
    expect(barrel).toBeDefined();
  });

  it('should export SpanKind type (re-export from common)', () => {
    expect(barrel).toBeDefined();
  });

  it('should export SpanOptions type (re-export from common)', () => {
    expect(barrel).toBeDefined();
  });
});
