/**
 * Barrel exports test.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as exports from '../../src/index.ts';
import type { CommandHandlerRegistration, QueryHandlerRegistration } from '../../src/index.ts';

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

  // The two registration types must be NAMEABLE from the barrel, not merely referenced
  // by the options interface. Without the export a consumer could pass an inline literal
  // but could not declare its own array in a variable — which is exactly what
  // `setu generate command-handler`'s barrel does. Asserted by DECLARING one: this
  // compiles only while both types are exported, and `deno task check` covers `test/`.
  it('exports the registration types a consumer needs to declare its own array', () => {
    const commands: readonly CommandHandlerRegistration[] = [
      { type: 'CreateUser', handler: { handle: () => ({ id: '1' }) } },
    ];
    const queries: readonly QueryHandlerRegistration[] = [
      { type: 'GetUser', handler: { handle: () => ({ id: '1' }) } },
    ];

    expect(commands[0]!.type).toBe('CreateUser');
    expect(queries[0]!.type).toBe('GetUser');
  });
});
