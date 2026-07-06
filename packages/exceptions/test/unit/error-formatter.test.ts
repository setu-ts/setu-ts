/**
 * Unit tests for the error formatter selector and default formatter.
 *
 * Covers `selectFormatter` resolution, the default formatter shape, custom
 * formatter passthrough, and the one-implementation-two-entry-points rule
 * (driving both built-in formatters under a non-default configuration).
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { defaultFormatter, selectFormatter } from '../../src/formatters/error-formatter.ts';
import type { ErrorHandlerFormatter } from '../../src/formatters/error-formatter.ts';
import { rfc7807Formatter } from '../../src/formatters/rfc7807-formatter.ts';
import { HttpError } from '../../src/errors/http-error.ts';
import { badRequest, notFound } from '../../src/errors/exceptions.ts';

describe('selectFormatter', () => {
  it('resolves "default" to defaultFormatter', () => {
    expect(selectFormatter('default')).toBe(defaultFormatter);
  });

  it('resolves "rfc7807" to rfc7807Formatter', () => {
    expect(selectFormatter('rfc7807')).toBe(rfc7807Formatter);
  });

  it('returns a custom function as-is', () => {
    const custom: ErrorHandlerFormatter = () => ({ custom: true });
    expect(selectFormatter(custom)).toBe(custom);
  });

  it('defaults to defaultFormatter when format is omitted', () => {
    expect(selectFormatter()).toBe(defaultFormatter);
  });

  it('throws TypeError for an unknown string format', () => {
    expect(() => selectFormatter('unknown' as never)).toThrow(TypeError);
  });
});

describe('defaultFormatter', () => {
  it('produces statusCode + message for an HttpError', () => {
    const error = notFound('gone');
    const body = defaultFormatter(error);

    expect(body.statusCode).toBe(404);
    expect(body.message).toBe('gone');
  });

  it('includes details when the HttpError has them', () => {
    const error = badRequest('bad', { field: 'email' });
    const body = defaultFormatter(error);

    expect(body.details).toEqual({ field: 'email' });
  });

  it('omits details when the HttpError has none', () => {
    const error = notFound('gone');
    const body = defaultFormatter(error);

    expect('details' in body).toBe(false);
  });

  it('defaults status to 500 for a generic Error', () => {
    const body = defaultFormatter(new Error('boom'));
    expect(body.statusCode).toBe(500);
    expect(body.message).toBe('boom');
  });

  it('does NOT include RFC 7807 fields (type/title)', () => {
    const body = defaultFormatter(notFound('gone'));
    expect('type' in body).toBe(false);
    expect('title' in body).toBe(false);
  });
});

describe('format equivalence (one implementation, two entry points)', () => {
  it('both built-in formatters produce the correct status for the same error', () => {
    const error = new HttpError(418, "I'm a teapot");
    const defaultBody = defaultFormatter(error);
    const rfcBody = rfc7807Formatter(error);

    expect(defaultBody.statusCode).toBe(418);
    expect(rfcBody.status).toBe(418);
  });

  it('driving via selectFormatter("rfc7807") matches rfc7807Formatter directly', () => {
    const error = notFound('gone');
    const viaSelector = selectFormatter('rfc7807')(error);
    const direct = rfc7807Formatter(error);

    expect(viaSelector).toEqual(direct);
  });

  it('driving via selectFormatter("default") matches defaultFormatter directly', () => {
    const error = badRequest('nope');
    const viaSelector = selectFormatter('default')(error);
    const direct = defaultFormatter(error);

    expect(viaSelector).toEqual(direct);
  });
});
