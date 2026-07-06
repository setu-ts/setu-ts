/**
 * Unit tests for error formatters.
 *
 * Covers resolveFormatter selector, each built-in formatter shape,
 * custom formatter passthrough, and the rfc7807 instance field.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { ValidationIssue } from '@hono-enterprise/common';

import { defaultFormatter, nestjsFormatter } from '../../src/formatters/default-formatter.ts';
import { rfc7807Formatter } from '../../src/formatters/rfc7807-formatter.ts';
import { resolveFormatter } from '../../src/formatters/error-formatter.ts';
import type { ValidationErrorFormatter } from '../../src/formatters/error-formatter.ts';
import { createFakeContext } from '../fixtures/fake-runtime.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ISSUES: readonly ValidationIssue[] = [
  { path: 'email', message: 'Invalid email', code: 'invalid_type' },
  { path: 'age', message: 'Must be a number' },
];

describe('resolveFormatter', () => {
  it('resolves "default" to defaultFormatter', () => {
    expect(resolveFormatter('default')).toBe(defaultFormatter);
  });

  it('resolves "rfc7807" to rfc7807Formatter', () => {
    expect(resolveFormatter('rfc7807')).toBe(rfc7807Formatter);
  });

  it('resolves "nestjs" to nestjsFormatter', () => {
    expect(resolveFormatter('nestjs')).toBe(nestjsFormatter);
  });

  it('returns a custom function as-is', () => {
    const custom: ValidationErrorFormatter = () => ({ errors: [] });
    expect(resolveFormatter(custom)).toBe(custom);
  });

  it('uses "default" when format is omitted', () => {
    expect(resolveFormatter()).toBe(defaultFormatter);
  });

  it('throws TypeError for unknown string format', () => {
    // @ts-expect-error — intentionally passing an invalid format
    expect(() => resolveFormatter('unknown')).toThrow(TypeError);
  });
});

describe('defaultFormatter', () => {
  it('produces the documented shape', () => {
    const result = defaultFormatter(ISSUES);

    expect(result.message).toBe('Validation failed with 2 issue(s).');
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toEqual({
      field: 'email',
      message: 'Invalid email',
      code: 'invalid_type',
    });
    expect(result.errors[1]).toEqual({
      field: 'age',
      message: 'Must be a number',
    });
  });

  it('has message key', () => {
    const result = defaultFormatter(ISSUES);
    expect('message' in result).toBe(true);
  });

  it('omits code when undefined on issue', () => {
    const result = defaultFormatter([{ path: 'x', message: 'fail' }]);
    expect('code' in result.errors[0]).toBe(false);
  });
});

describe('nestjsFormatter', () => {
  it('produces the documented NestJS shape', () => {
    const result = nestjsFormatter(ISSUES);

    expect(result.statusCode).toBe(400);
    expect(result.error).toBe('Bad Request');
    expect(result.message).toEqual([
      'email: Invalid email',
      'age: Must be a number',
    ]);
    expect(result.errors).toHaveLength(2);
  });

  it('uses message directly when path is empty', () => {
    const result = nestjsFormatter([{ path: '', message: 'top-level error' }]);
    expect(result.message).toEqual(['top-level error']);
  });

  it('has message key', () => {
    const result = nestjsFormatter(ISSUES);
    expect('message' in result).toBe(true);
  });
});

describe('rfc7807Formatter', () => {
  it('produces the documented RFC 7807 shape', () => {
    const ctx = createFakeContext({ request: { path: '/api/users' } }).ctx;
    const result = rfc7807Formatter(ISSUES, ctx);

    expect(result.type).toBe('https://hono-enterprise.dev/errors/validation');
    expect(result.title).toBe('Validation Error');
    expect(result.status).toBe(400);
    expect(result.detail).toBe('The request contains 2 validation error(s).');
    expect(result.instance).toBe('/api/users');
    expect(result.errors).toHaveLength(2);
  });

  it('has NO message key', () => {
    const ctx = createFakeContext({ request: { path: '/test' } }).ctx;
    const result = rfc7807Formatter(ISSUES, ctx);
    expect('message' in result).toBe(false);
  });

  it('uses empty string for instance when ctx is absent', () => {
    const result = rfc7807Formatter(ISSUES);
    expect(result.instance).toBe('');
  });

  it('instance equals ctx.request.path', () => {
    const ctx = createFakeContext({ request: { path: '/users/42' } }).ctx;
    const result = rfc7807Formatter(ISSUES, ctx);
    expect(result.instance).toBe('/users/42');
  });
});
