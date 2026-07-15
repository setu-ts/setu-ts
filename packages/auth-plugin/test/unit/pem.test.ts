/**
 * Tests for PEM to DER conversion utility.
 */

import { beforeAll, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { pemToDer } from '../../src/utils/pem.ts';

describe('pemToDer', () => {
  let publicKeyPem: string;
  let privateKeyPem: string;
  let publicKeyDer: Uint8Array;
  let privateKeyDer: Uint8Array;

  beforeAll(async () => {
    // Generate a real RSA key pair for testing
    const keyPair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    );

    const [spki, pkcs8] = await Promise.all([
      crypto.subtle.exportKey('spki', keyPair.publicKey),
      crypto.subtle.exportKey('pkcs8', keyPair.privateKey),
    ]);

    publicKeyDer = new Uint8Array(spki);
    privateKeyDer = new Uint8Array(pkcs8);

    publicKeyPem = formatPem(publicKeyDer, 'PUBLIC KEY');
    privateKeyPem = formatPem(privateKeyDer, 'PRIVATE KEY');
  });

  it('decodes a PUBLIC KEY PEM to the expected DER bytes', () => {
    const decoded = pemToDer(publicKeyPem, 'PUBLIC KEY');
    expect(decoded).toEqual(publicKeyDer);
  });

  it('decodes a PRIVATE KEY PEM to the expected DER bytes', () => {
    const decoded = pemToDer(privateKeyPem, 'PRIVATE KEY');
    expect(decoded).toEqual(privateKeyDer);
  });

  it('handles CRLF line endings', () => {
    const crlfPem = publicKeyPem.replace(/\n/g, '\r\n');
    const decoded = pemToDer(crlfPem, 'PUBLIC KEY');
    expect(decoded).toEqual(publicKeyDer);
  });

  it('handles trailing whitespace in armor lines', () => {
    const lines = publicKeyPem.split('\n');
    const padded = lines.map((line, index) => {
      if (index === 0 || index === lines.length - 1) {
        return line + '   ';
      }
      return line;
    }).join('\n');
    const decoded = pemToDer(padded, 'PUBLIC KEY');
    expect(decoded).toEqual(publicKeyDer);
  });

  it('handles a trailing newline (OpenSSL key-file format)', () => {
    expect(pemToDer(publicKeyPem + '\n', 'PUBLIC KEY')).toEqual(publicKeyDer);
    expect(pemToDer(privateKeyPem + '\n', 'PRIVATE KEY')).toEqual(privateKeyDer);
  });

  it('handles surrounding blank lines', () => {
    const decoded = pemToDer('\n' + publicKeyPem + '\r\n\n', 'PUBLIC KEY');
    expect(decoded).toEqual(publicKeyDer);
  });

  it('round-trips into subtle.importKey (SPKI public key)', async () => {
    const der = pemToDer(publicKeyPem, 'PUBLIC KEY');
    const key = await crypto.subtle.importKey(
      'spki',
      copyToBuffer(der),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      true,
      ['verify'],
    );
    expect(key).toBeDefined();
    expect(key.type).toBe('public');
  });

  it('round-trips into subtle.importKey (PKCS8 private key)', async () => {
    const der = pemToDer(privateKeyPem, 'PRIVATE KEY');
    const key = await crypto.subtle.importKey(
      'pkcs8',
      copyToBuffer(der),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      true,
      ['sign'],
    );
    expect(key).toBeDefined();
    expect(key.type).toBe('private');
  });

  it('throws when the BEGIN label does not match', () => {
    expect(() => pemToDer(publicKeyPem, 'PRIVATE KEY')).toThrow(
      'PEM must start with "-----BEGIN PRIVATE KEY-----"',
    );
  });

  it('throws when the END label does not match', () => {
    const lines = publicKeyPem.split('\n');
    const tampered = [...lines.slice(0, -1), '-----END PRIVATE KEY-----'].join('\n');
    expect(() => pemToDer(tampered, 'PUBLIC KEY')).toThrow(
      'PEM must end with "-----END PUBLIC KEY-----"',
    );
  });

  it('throws when PEM has no key data', () => {
    const empty = '-----BEGIN PUBLIC KEY-----\n-----END PUBLIC KEY-----';
    expect(() => pemToDer(empty, 'PUBLIC KEY')).toThrow('PEM contains no key data');
  });
});

/**
 * Copy bytes into a fresh ArrayBuffer (satisfies BufferSource for Web Crypto).
 */
function copyToBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

/**
 * Format DER bytes as a PEM string.
 */
function formatPem(der: Uint8Array, label: string): string {
  const binary = String.fromCharCode(...der);
  const base64 = btoa(binary);
  const lines: string[] = [`-----BEGIN ${label}-----`];
  for (let i = 0; i < base64.length; i += 64) {
    lines.push(base64.slice(i, i + 64));
  }
  lines.push(`-----END ${label}-----`);
  return lines.join('\n');
}
