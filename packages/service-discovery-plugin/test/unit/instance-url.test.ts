/**
 * Unit tests for the instance → URL formatter.
 *
 * Expected strings are written out literally, because a slash-joining or
 * bracketing bug type-checks and lints clean.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { instanceUrl } from '../../src/url/instance-url.ts';
import { instance } from '../fixtures/fakes.ts';

describe('instanceUrl', () => {
  it('formats an IPv4 instance with no path', () => {
    expect(instanceUrl(instance({ id: 'a', host: '10.0.0.1', port: 8080 })))
      .toBe('http://10.0.0.1:8080');
  });

  it('brackets an IPv6 literal', () => {
    expect(instanceUrl(instance({ id: 'a', host: '2001:db8::1', port: 8080 })))
      .toBe('http://[2001:db8::1]:8080');
  });

  it('uses https when secure is true', () => {
    expect(instanceUrl(instance({ id: 'a', host: 'svc.internal', port: 443, secure: true })))
      .toBe('https://svc.internal:443');
  });

  it('uses http when secure is explicitly false', () => {
    expect(instanceUrl(instance({ id: 'a', host: 'svc.internal', port: 80, secure: false })))
      .toBe('http://svc.internal:80');
  });

  it('joins a slash-prefixed path with exactly one slash', () => {
    expect(instanceUrl(instance({ id: 'a', host: '10.0.0.1', port: 8080 }), '/invoices'))
      .toBe('http://10.0.0.1:8080/invoices');
  });

  it('joins an unprefixed path with exactly one slash', () => {
    expect(instanceUrl(instance({ id: 'a', host: '10.0.0.1', port: 8080 }), 'invoices'))
      .toBe('http://10.0.0.1:8080/invoices');
  });

  it('treats an empty path as no path', () => {
    expect(instanceUrl(instance({ id: 'a', host: '10.0.0.1', port: 8080 }), ''))
      .toBe('http://10.0.0.1:8080');
  });

  it('brackets IPv6 and joins a path together', () => {
    expect(instanceUrl(instance({ id: 'a', host: 'fe80::1', port: 9000, secure: true }), 'v1/x'))
      .toBe('https://[fe80::1]:9000/v1/x');
  });
});
