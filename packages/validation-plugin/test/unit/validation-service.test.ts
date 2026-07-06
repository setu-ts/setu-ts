/**
 * Unit tests for ValidationService.
 *
 * Covers validate() success/failure, ZodIssue→ValidationIssue mapping,
 * safeParseSchema() TypeError, middleware() delegation, and real Zod schemas.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { ValidationService } from '../../src/services/validation-service.ts';
import { defaultFormatter } from '../../src/formatters/default-formatter.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fake schema with configurable safeParse behavior. */
function createFakeSchema(opts: {
  success?: boolean;
  data?: unknown;
  issues?: { path?: (string | number)[]; message: string; code?: string }[];
}) {
  return {
    safeParse(_data: unknown) {
      if (opts.success ?? true) {
        return { success: true as const, data: opts.data ?? _data };
      }
      return {
        success: false as const,
        error: { issues: opts.issues ?? [] },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ValidationService — validate', () => {
  const service = new ValidationService(defaultFormatter);

  it('returns Ok on validation success', () => {
    const schema = createFakeSchema({ success: true, data: { name: 'Alice' } });
    const result = service.validate(schema, { name: 'Alice' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value).toEqual({ name: 'Alice' });
    }
  });

  it('returns Err on validation failure', () => {
    const schema = createFakeSchema({
      success: false,
      issues: [{ path: ['name'], message: 'Required', code: 'invalid_type' }],
    });
    const result = service.validate(schema, {});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toEqual([
        { path: 'name', message: 'Required', code: 'invalid_type' },
      ]);
    }
  });

  it('joins nested path with dots', () => {
    const schema = createFakeSchema({
      success: false,
      issues: [{ path: ['address', 'zip'], message: 'Invalid zip' }],
    });
    const result = service.validate(schema, {});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error[0].path).toBe('address.zip');
    }
  });

  it('omits code when undefined on issue', () => {
    const schema = createFakeSchema({
      success: false,
      issues: [{ path: ['x'], message: 'fail' }],
    });
    const result = service.validate(schema, {});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect('code' in result.error[0]).toBe(false);
    }
  });

  it('uses empty path when path is absent', () => {
    const schema = createFakeSchema({
      success: false,
      issues: [{ message: 'top-level error' }],
    });
    const result = service.validate(schema, {});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error[0].path).toBe('');
    }
  });
});

describe('ValidationService — safeParseSchema errors', () => {
  const service = new ValidationService(defaultFormatter);

  it('throws TypeError when schema is null', () => {
    expect(() => service.validate(null, {})).toThrow(TypeError);
  });

  it('throws TypeError when schema has no safeParse', () => {
    expect(() => service.validate({ foo: 'bar' }, {})).toThrow(TypeError);
  });

  it('throws TypeError when schema is a primitive', () => {
    expect(() => service.validate(42, {})).toThrow(TypeError);
  });

  it('throws TypeError when schema is an array', () => {
    expect(() => service.validate([], {})).toThrow(TypeError);
  });
});

describe('ValidationService — middleware', () => {
  it('returns a middleware function', () => {
    const service = new ValidationService(defaultFormatter);
    const schema = createFakeSchema({ success: true });
    const mw = service.middleware(schema, 'body');
    expect(typeof mw).toBe('function');
  });
});

describe('ValidationService — real Zod schema', () => {
  it('validates a real Zod schema and maps ZodIssue to ValidationIssue', async () => {
    // Dynamically import Zod — skip if unavailable.
    // deno-lint-ignore no-explicit-any
    let z: { z: any };
    try {
      const mod = await import('npm:zod@^3.24.0');
      z = mod;
    } catch {
      // Skip if npm:zod is unavailable in the test environment.
      return;
    }

    const service = new ValidationService(defaultFormatter);
    const schema = z.z.object({
      name: z.z.string(),
      age: z.z.number(),
    });

    const result = service.validate(schema, { name: 123, age: 'not-a-number' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toHaveLength(2);
      // First issue: name must be a string
      expect(result.error[0].path).toBe('name');
      expect(result.error[0].code).toBe('invalid_type');
      // Second issue: age must be a number
      expect(result.error[1].path).toBe('age');
      expect(result.error[1].code).toBe('invalid_type');
    }
  });

  it('validates a nested Zod schema with dotted paths', async () => {
    // deno-lint-ignore no-explicit-any
    let z: { z: any };
    try {
      const mod = await import('npm:zod@^3.24.0');
      z = mod;
    } catch {
      return;
    }

    const service = new ValidationService(defaultFormatter);
    const schema = z.z.object({
      address: z.z.object({
        zip: z.z.string().regex(/^\d{5}$/),
      }),
    });

    const result = service.validate(schema, { address: { zip: 'abc' } });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error[0].path).toBe('address.zip');
    }
  });
});
