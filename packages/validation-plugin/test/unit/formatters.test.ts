/**
 * Unit tests for error formatters.
 *
 * Covers resolveFormatter selector, each built-in formatter shape,
 * custom formatter passthrough, and the rfc7807 instance field.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { ValidationIssue } from '@setu-ts/common';

import { defaultFormatter, nestjsFormatter } from '../../src/formatters/default-formatter.ts';
import { rfc7807Formatter } from '../../src/formatters/rfc7807-formatter.ts';
import { rfc9457Formatter } from '../../src/formatters/rfc9457-formatter.ts';
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

  it('resolves "rfc9457" to rfc9457Formatter', () => {
    expect(resolveFormatter('rfc9457')).toBe(rfc9457Formatter);
  });

  it('resolves the deprecated "rfc7807" to rfc7807Formatter', () => {
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

    expect(result.type).toBe('https://setu-ts.dev/errors/validation');
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

  it('omits instance when ctx is absent (RFC 7807 wants a URI reference)', () => {
    const result = rfc7807Formatter(ISSUES);
    expect('instance' in result).toBe(false);
  });

  it('instance equals ctx.request.path', () => {
    const ctx = createFakeContext({ request: { path: '/users/42' } }).ctx;
    const result = rfc7807Formatter(ISSUES, ctx);
    expect(result.instance).toBe('/users/42');
  });
});

describe('rfc9457Formatter', () => {
  it('produces the documented RFC 9457 shape', () => {
    const ctx = createFakeContext({ request: { path: '/api/users' } }).ctx;
    const result = rfc9457Formatter(ISSUES, ctx);

    expect(result.type).toBe('https://setu-ts.dev/errors/validation');
    expect(result.title).toBe('Validation Error');
    expect(result.status).toBe(400);
    expect(result.detail).toBe('The request contains 2 validation error(s).');
    expect(result.instance).toBe('/api/users');
    expect(result.errors).toHaveLength(2);
  });

  it('has NO message key (RFC 9457 uses "detail")', () => {
    const ctx = createFakeContext({ request: { path: '/test' } }).ctx;
    expect('message' in rfc9457Formatter(ISSUES, ctx)).toBe(false);
  });

  it('omits instance when ctx is absent (RFC 9457 wants a URI reference)', () => {
    expect('instance' in rfc9457Formatter(ISSUES)).toBe(false);
  });

  it('keeps a concrete type URI rather than about:blank', () => {
    // A validation failure defines an `errors` extension member, so it has
    // semantics beyond its status code and is a distinct problem type — the
    // one case RFC 9457 §4.2's about:blank does NOT cover. This is why this
    // formatter's body is unchanged while the exceptions package's moved.
    expect(rfc9457Formatter(ISSUES).type).not.toBe('about:blank');
  });

  it('agrees with @setu-ts/exceptions on the validation problem type URI', () => {
    // The two packages cannot share a constant (AI_GUIDELINES §2.2), so the
    // agreement is pinned here and by the mirror assertion in the exceptions
    // package's problem-details tests. Drift on either side would make one
    // problem type report under two different URIs.
    expect(rfc9457Formatter(ISSUES).type).toBe('https://setu-ts.dev/errors/validation');
  });

  it('carries the field/message/code errors shape unchanged', () => {
    // Pins the scope decision: realigning to RFC 9457 §3's illustrated
    // `{ detail, pointer }` shape was explicitly declined for this milestone.
    const result = rfc9457Formatter(ISSUES);
    for (const entry of result.errors) {
      expect(typeof entry.field).toBe('string');
      expect(typeof entry.message).toBe('string');
    }
  });
});

describe('the deprecated rfc7807Formatter alias', () => {
  it('IS the same object as rfc9457Formatter', () => {
    // Unlike @setu-ts/exceptions — where the two formats disagree on `type` and
    // must be separate objects — this formatter's body was already valid under
    // RFC 9457, so there is one implementation with two names. The media-type
    // membership set in validation-middleware.ts relies on this.
    expect(rfc7807Formatter).toBe(rfc9457Formatter);
  });

  it('produces a byte-identical body, so migrating changes nothing on the wire', () => {
    const ctx = createFakeContext({ request: { path: '/api/users' } }).ctx;
    expect(JSON.stringify(rfc7807Formatter(ISSUES, ctx)))
      .toBe(JSON.stringify(rfc9457Formatter(ISSUES, ctx)));
  });
});
