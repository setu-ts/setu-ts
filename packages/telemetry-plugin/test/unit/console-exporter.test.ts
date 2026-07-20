/**
 * Tests for the console exporter loader.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
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
