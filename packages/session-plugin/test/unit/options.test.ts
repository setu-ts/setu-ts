/**
 * Unit tests for option resolution and defaults.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { resolveCsrfConfig, resolveSessionConfig } from '../../src/options.ts';

describe('resolveSessionConfig', () => {
  it('applies secure defaults', () => {
    expect(resolveSessionConfig()).toEqual({
      mode: 'encrypt',
      cookieName: 'hono_session',
      cookiePath: '/',
      cookieSameSite: 'lax',
      cookieSecure: true,
      cookieHttpOnly: true,
      maxAgeSeconds: 7200,
      maxAgeMs: 7_200_000,
      rolling: false,
      maxCookieBytes: 4096,
    });
  });

  it('omits the optional keys rather than setting them undefined', () => {
    const config = resolveSessionConfig();
    // exactOptionalPropertyTypes: an absent option must be an absent key.
    expect('cookieDomain' in config).toBe(false);
    expect('idleTimeoutMs' in config).toBe(false);
  });

  it('includes the optional keys when supplied', () => {
    const config = resolveSessionConfig({
      cookie: { domain: 'example.com' },
      idleTimeoutMs: 900_000,
    });
    expect(config.cookieDomain).toBe('example.com');
    expect(config.idleTimeoutMs).toBe(900_000);
  });

  it('derives maxAgeMs from maxAge', () => {
    expect(resolveSessionConfig({ maxAge: 60 }).maxAgeMs).toBe(60_000);
  });

  it('carries every cookie override through', () => {
    const config = resolveSessionConfig({
      cookie: {
        name: 'sid',
        path: '/app',
        sameSite: 'strict',
        secure: false,
        httpOnly: false,
      },
    });
    expect(config.cookieName).toBe('sid');
    expect(config.cookiePath).toBe('/app');
    expect(config.cookieSameSite).toBe('strict');
    expect(config.cookieSecure).toBe(false);
    expect(config.cookieHttpOnly).toBe(false);
  });

  it('accepts the sign mode', () => {
    expect(resolveSessionConfig({ mode: 'sign' }).mode).toBe('sign');
  });

  it('rejects a non-positive or non-finite maxAge', () => {
    for (const maxAge of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveSessionConfig({ maxAge }), String(maxAge)).toThrow(TypeError);
    }
  });

  it('rejects a non-positive maxCookieBytes', () => {
    expect(() => resolveSessionConfig({ maxCookieBytes: 0 })).toThrow(TypeError);
  });

  it('rejects a non-positive idleTimeoutMs', () => {
    expect(() => resolveSessionConfig({ idleTimeoutMs: -5 })).toThrow(TypeError);
  });

  it('names the offending option in the error', () => {
    expect(() => resolveSessionConfig({ maxAge: 0 })).toThrow("'maxAge'");
  });
});

describe('resolveCsrfConfig', () => {
  it('applies defaults', () => {
    const config = resolveCsrfConfig();
    expect(config.fieldName).toBe('_csrf');
    expect('headerName' in config).toBe(false);
    expect([...config.ignoreMethods].sort()).toEqual(['GET', 'HEAD', 'OPTIONS']);
  });

  it('upper-cases the ignore list so comparison is case-insensitive', () => {
    const config = resolveCsrfConfig({ ignoreMethods: ['get', 'trace'] });
    expect(config.ignoreMethods.has('GET')).toBe(true);
    expect(config.ignoreMethods.has('TRACE')).toBe(true);
  });

  it('carries the field and header overrides', () => {
    const config = resolveCsrfConfig({
      fieldName: 'authenticity_token',
      headerName: 'x-csrf-token',
    });
    expect(config.fieldName).toBe('authenticity_token');
    expect(config.headerName).toBe('x-csrf-token');
  });

  it('accepts an empty ignore list, making every method verified', () => {
    expect(resolveCsrfConfig({ ignoreMethods: [] }).ignoreMethods.size).toBe(0);
  });
});
