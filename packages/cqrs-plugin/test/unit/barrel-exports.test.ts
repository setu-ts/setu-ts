/**
 * Barrel exports test.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as exports from '../../src/index.ts';

describe('barrel exports', () => {
  it('should export CqrsPlugin', () => {
    expect(exports.CqrsPlugin).toBeDefined();
    expect(typeof exports.CqrsPlugin).toBe('function');
  });

  it('should export CommandBus', () => {
    expect(exports.CommandBus).toBeDefined();
    expect(typeof exports.CommandBus).toBe('function');
  });

  it('should export QueryBus', () => {
    expect(exports.QueryBus).toBeDefined();
    expect(typeof exports.QueryBus).toBe('function');
  });

  it('should export HandlerNotFoundError', () => {
    expect(exports.HandlerNotFoundError).toBeDefined();
    expect(typeof exports.HandlerNotFoundError).toBe('function');
  });

  it('should re-export common types (type-only, runtime check is no-op)', () => {
    // These are type-only re-exports; at runtime they are undefined.
    // We just verify the module loads without error.
    expect(exports).toBeDefined();
  });
});
