/**
 * Tests for `pemToDer` — PEM to DER decoding for the FCM signing key.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { pemToDer } from '../../src/providers/pem.ts';

/** Wraps base64 in a PRIVATE KEY envelope. */
function envelope(base64: string, eol = '\n'): string {
  return `-----BEGIN PRIVATE KEY-----${eol}${base64}${eol}-----END PRIVATE KEY-----`;
}

describe('pemToDer', () => {
  it('decodes a PKCS#8 body to the original bytes', () => {
    const original = new Uint8Array([0x30, 0x82, 0x01, 0x22, 0x00, 0xff]);
    const base64 = btoa(String.fromCharCode(...original));

    expect(pemToDer(envelope(base64), 'PRIVATE KEY')).toEqual(original);
  });

  it('tolerates CRLF line endings and surrounding blank lines', () => {
    const original = new Uint8Array([1, 2, 3, 4]);
    const base64 = btoa(String.fromCharCode(...original));
    // Shape a service-account key takes after a JSON or env-var round trip.
    const pem = `\r\n${envelope(base64, '\r\n')}\r\n\r\n`;

    expect(pemToDer(pem, 'PRIVATE KEY')).toEqual(original);
  });

  it('joins a multi-line base64 body', () => {
    const original = new Uint8Array(Array.from({ length: 96 }, (_, i) => i));
    const base64 = btoa(String.fromCharCode(...original));
    const wrapped = base64.match(/.{1,64}/g)!.join('\n');

    expect(pemToDer(envelope(wrapped), 'PRIVATE KEY')).toEqual(original);
  });

  it('throws when the header is missing or mislabelled', () => {
    expect(() =>
      pemToDer('-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PRIVATE KEY-----', 'PRIVATE KEY')
    )
      .toThrow('PEM must start with "-----BEGIN PRIVATE KEY-----"');
  });

  it('throws when the footer is missing', () => {
    expect(() => pemToDer('-----BEGIN PRIVATE KEY-----\nAAAA', 'PRIVATE KEY'))
      .toThrow('PEM must end with "-----END PRIVATE KEY-----"');
  });

  it('throws when the body is empty', () => {
    expect(() => pemToDer(envelope(''), 'PRIVATE KEY')).toThrow('PEM contains no key data');
  });
});
