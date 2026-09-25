/**
 * Unit tests for `validateConfig` (M98e test home): the schema boundary
 * stays value-free — a schema's own error text can carry configuration
 * values, and the validator never propagates them across startup.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { type StructuralSchema, validateConfig } from '../../src/validators/config-validator.ts';

describe('validateConfig | value-free errors', () => {
  it('returns the parsed output when the schema accepts it', () => {
    const schema: StructuralSchema<unknown> = {
      parse(input: unknown): Record<string, unknown> {
        return { ...(input as Record<string, string>), PORT: 8080 };
      },
    };
    expect(validateConfig({ PORT: '8080' }, schema)).toEqual({ PORT: 8080 });
  });

  it('never propagates a schema error that quotes a value', () => {
    const SECRET = 'canary-secret-SYNTHETIC';
    const schema: StructuralSchema<unknown> = {
      parse(_input: unknown): unknown {
        throw new Error(`invalid enum value: ${SECRET}`);
      },
    };
    try {
      validateConfig({ TOKEN: SECRET }, schema);
      throw new Error('expected validateConfig to throw');
    } catch (error) {
      expect((error as Error).message).toEqual('Configuration validation failed.');
      // The value stays on the schema side of the boundary.
      expect((error as Error).message).not.toContain(SECRET);
    }
  });

  it('refuses a null, array, or non-object schema output', () => {
    for (const output of [null, undefined, [], 'string', 42]) {
      const schema: StructuralSchema<unknown> = {
        parse(): unknown {
          return output;
        },
      };
      expect(() => validateConfig({}, schema)).toThrow(/Configuration validation failed/);
    }
  });
});
