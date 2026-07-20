/**
 * Tests for the OTLP exporter loader.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { loadOtlpExporter } from '../../src/exporters/otlp-exporter.ts';

/** Whether `npm:` imports are available in this environment. */
function canImportNpm(): boolean {
  try {
    return Deno.permissions.querySync({ name: 'import' }).state === 'granted';
  } catch {
    return false;
  }
}

describe('loadOtlpExporter', () => {
  it('should throw when url is empty', async () => {
    await expect(loadOtlpExporter('')).rejects.toThrow('url');
  });

  it('should throw when url is undefined', async () => {
    await expect(loadOtlpExporter(undefined as unknown as string)).rejects.toThrow('url');
  });

  it({
    name: 'should return the OTLPTraceExporter constructor when url is provided',
    ignore: !canImportNpm(),
  }, async () => {
    // Guarded (not swallowed): when imports are available the real dep must
    // load and yield a constructor — a failure here is a real failure.
    const Ctor = await loadOtlpExporter('http://localhost:4318/v1/traces');
    expect(Ctor).toBeInstanceOf(Function);
  });
});
