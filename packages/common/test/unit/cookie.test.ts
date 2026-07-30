/**
 * Unit tests for the shared cookie codec.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { parseCookie, serializeCookie } from '../../src/cookie.ts';

describe('parseCookie', () => {
  it('parses simple pairs', () => {
    expect(parseCookie('sid=abc; theme=dark')).toEqual({ sid: 'abc', theme: 'dark' });
  });

  it('returns an empty record for an absent or empty header', () => {
    expect(parseCookie(null)).toEqual({});
    expect(parseCookie(undefined)).toEqual({});
    expect(parseCookie('')).toEqual({});
  });

  it('skips pairs with no "=" and keeps "=" inside a value', () => {
    expect(parseCookie('broken; sid=abc')).toEqual({ sid: 'abc' });
    expect(parseCookie('token=a=b=c')).toEqual({ token: 'a=b=c' });
  });

  it('trims surrounding whitespace from name and value', () => {
    expect(parseCookie('  sid  =  abc  ')).toEqual({ sid: 'abc' });
  });

  it('removes one layer of RFC 6265 quoting', () => {
    expect(parseCookie('sid="abc"')).toEqual({ sid: 'abc' });
    // A single quote character is not a quoted string and stays put.
    expect(parseCookie('sid="abc')).toEqual({ sid: '"abc' });
  });

  it('resolves a repeated name to the first occurrence', () => {
    // Browsers send the most specific cookie first.
    expect(parseCookie('sid=first; sid=second')).toEqual({ sid: 'first' });
  });

  it('skips a pair with an empty name', () => {
    expect(parseCookie('=novalue; sid=abc')).toEqual({ sid: 'abc' });
  });

  it('keeps an empty value', () => {
    expect(parseCookie('sid=')).toEqual({ sid: '' });
  });

  it('percent-decodes values so it round-trips serializeCookie', () => {
    expect(parseCookie('data=a%20b%3Bc')).toEqual({ data: 'a b;c' });
  });

  it('returns a malformed percent-escape verbatim rather than throwing', () => {
    expect(parseCookie('data=100%')).toEqual({ data: '100%' });
    expect(parseCookie('data=%E0%A4%A')).toEqual({ data: '%E0%A4%A' });
  });
});

describe('serializeCookie', () => {
  it('serializes a bare name/value', () => {
    expect(serializeCookie('sid', 'abc')).toBe('sid=abc');
  });

  it('emits every attribute in a stable order', () => {
    expect(
      serializeCookie('sid', 'abc', {
        maxAge: 3600,
        expires: new Date(Date.UTC(2030, 0, 1)),
        domain: 'example.com',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
      }),
    ).toBe(
      'sid=abc; Max-Age=3600; Expires=Tue, 01 Jan 2030 00:00:00 GMT; ' +
        'Domain=example.com; Path=/; HttpOnly; Secure; SameSite=Lax',
    );
  });

  it('omits attributes that were not supplied', () => {
    expect(serializeCookie('sid', 'abc', { path: '/' })).toBe('sid=abc; Path=/');
  });

  it('emits Max-Age=0 for a deletion cookie', () => {
    expect(serializeCookie('sid', '', { maxAge: 0, path: '/' })).toBe('sid=; Max-Age=0; Path=/');
  });

  it('forces Secure when SameSite=None, which browsers require', () => {
    expect(serializeCookie('sid', 'a', { sameSite: 'none' })).toBe('sid=a; Secure; SameSite=None');
  });

  it('does not double up Secure when both are requested', () => {
    const header = serializeCookie('sid', 'a', { sameSite: 'none', secure: true });
    expect(header.match(/Secure/g)?.length).toBe(1);
  });

  it('capitalises each SameSite value canonically', () => {
    expect(serializeCookie('s', 'v', { sameSite: 'strict' })).toContain('SameSite=Strict');
    expect(serializeCookie('s', 'v', { sameSite: 'lax' })).toContain('SameSite=Lax');
  });

  it('percent-encodes the value so it cannot inject attributes', () => {
    const header = serializeCookie('sess', 'v1; Path=/evil; HttpOnly', { path: '/' });
    expect(header).not.toContain('Path=/evil');
    expect(header).toBe('sess=v1%3B%20Path%3D%2Fevil%3B%20HttpOnly; Path=/');
  });

  it('round-trips a hostile value through parseCookie', () => {
    const value = 'v1.kid.iv.sealed; Path=/evil';
    const header = serializeCookie('sess', value, { path: '/' });
    expect(parseCookie(header.split('; ')[0])['sess']).toBe(value);
  });

  it('rejects an invalid cookie name', () => {
    for (const bad of ['', 'has space', 'semi;colon', 'paren()', 'comma,name', 'eq=name']) {
      expect(() => serializeCookie(bad, 'x')).toThrow(TypeError);
    }
  });

  it('accepts the full RFC 6265 token charset', () => {
    expect(() => serializeCookie("a!#$%&'*+-.09AZ^_`az|~", 'x')).not.toThrow();
  });

  it('rejects a non-integer maxAge', () => {
    expect(() => serializeCookie('sid', 'x', { maxAge: 1.5 })).toThrow(TypeError);
    expect(() => serializeCookie('sid', 'x', { maxAge: Number.NaN })).toThrow(TypeError);
  });
});
