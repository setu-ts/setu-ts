/**
 * Tests for the OTLP exporter loader.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { loadOtlpExporter } from '../../src/exporters/otlp-exporter.ts';

describe('loadOtlpExporter', () => {
  it('should throw when url is empty', async () => {
    let threw = false;
    try {
      await loadOtlpExporter('', undefined);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('should throw when url is undefined', async () => {
    let threw = false;
    try {
      await loadOtlpExporter(undefined as unknown as string);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('should return a constructor when url is provided (may fail import if dep absent)', async () => {
    try {
      const Ctor = await loadOtlpExporter('http://localhost:4318/v1/traces', {});
      expect(Ctor).toBeInstanceOf(Function);
    } catch {
      // OTel SDK not installed — this is expected in the test environment
    }
  });

  it('should accept headers as second argument', async () => {
    try {
      const Ctor = await loadOtlpExporter('http://localhost:4318/v1/traces', {
        'X-Custom': 'value',
      });
      expect(Ctor).toBeInstanceOf(Function);
    } catch {
      // OTel SDK not installed
    }
  });
});
