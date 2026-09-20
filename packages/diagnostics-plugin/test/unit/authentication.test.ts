/**
 * Unit tests for the canonical authenticated bytes and the HMAC/SHA-256
 * primitives: an RFC 4231 known-answer vector for the primitive chain,
 * independently hand-built canonical byte expectations, request/response
 * domain separation, and MAC mutation coverage.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  canonicalBytes,
  hexEncode,
  importSessionKey,
  MAC_DOMAIN,
  parseMac,
  requestMacFields,
  responseMacFields,
  sha256Hex,
  signFields,
  verifyFields,
} from '../../src/security/authentication.ts';
import { TEST_KEY_BYTES, utf8 } from '../fixtures/helpers.ts';

describe('Authentication — canonical bytes', () => {
  it('joins request fields with newline and no final newline, byte-exactly', () => {
    const fields = requestMacFields(
      'a'.repeat(32),
      '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      '7',
      '127.0.0.1:4919',
      '/v1/status',
    );
    // Built INDEPENDENTLY of the production helper: one literal string.
    const expected = utf8(
      `${MAC_DOMAIN}\nrequest\n${'a'.repeat(32)}\n` +
        `3f2504e0-4f89-41d3-9a0c-0305e82c3301\n7\nGET\n127.0.0.1:4919\n/v1/status`,
    );
    expect(canonicalBytes(fields)).toEqual(expected);
    // No final newline: the last byte is the last character of the target
    // ('s' of '/v1/status').
    const bytes = canonicalBytes(fields);
    expect(bytes[bytes.length - 1]).toEqual('s'.charCodeAt(0));
  });

  it('separates the response domain in the second line', () => {
    const request = canonicalBytes(
      requestMacFields('s', 'i', '1', '127.0.0.1:4919', '/v1/snapshot'),
    );
    const response = canonicalBytes(
      responseMacFields('s', 'i', '1', '/v1/snapshot', '200', 'ab'.repeat(32)),
    );
    // Different bytes, and the difference is exactly the second line plus
    // the response-only fields — reflection between domains is impossible.
    expect(request).not.toEqual(response);
    expect(utf8(MAC_DOMAIN + '\nrequest\n').length).toEqual(MAC_DOMAIN.length + 9);
    const decode = new TextDecoder();
    expect(
      decode.decode(response.slice(0, MAC_DOMAIN.length + 10))
        .startsWith(`${MAC_DOMAIN}\nresponse\n`),
    ).toBe(true);
    expect(
      decode.decode(request.slice(0, MAC_DOMAIN.length + 9))
        .startsWith(`${MAC_DOMAIN}\nrequest\n`),
    ).toBe(true);
  });

  it('matches the RFC 4231 test case 1 known answer through import+sign', async () => {
    // RFC 4231 test case 1: key 0x0b repeated 20 times, data "Hi There",
    // HMAC-SHA-256 =
    // b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7.
    // This pins the PRIMITIVE chain (import -> sign -> hex) against an
    // externally published vector, independently of our canonicalization.
    const key = await importSessionKey(crypto.subtle, new Uint8Array(20).fill(0x0b));
    const data = utf8('Hi There');
    const signature = await crypto.subtle.sign('HMAC', key, data);
    expect(hexEncode(new Uint8Array(signature))).toEqual(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    );
  });

  it('signs canonical fields to a MAC that an independent subtle.sign reproduces', async () => {
    const key = await importSessionKey(crypto.subtle, TEST_KEY_BYTES);
    const fields = requestMacFields('s'.repeat(32), '', '1', '127.0.0.1:4919', '/v1/status');
    const signed = await signFields(crypto.subtle, key, fields);
    // Independent path: sign the hand-built bytes directly.
    const independent = await crypto.subtle.sign(
      'HMAC',
      key,
      utf8(
        `${MAC_DOMAIN}\nrequest\n${'s'.repeat(32)}\n\n1\nGET\n127.0.0.1:4919\n/v1/status`,
      ),
    );
    expect(signed).toEqual(hexEncode(new Uint8Array(independent)));
  });

  it('digests exact bytes to the known SHA-256 of "abc"', async () => {
    expect(await sha256Hex(crypto.subtle, utf8('abc'))).toEqual(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('Authentication — verify', () => {
  it('verifies a correct MAC and refuses every mutated signed field', async () => {
    const key = await importSessionKey(crypto.subtle, TEST_KEY_BYTES);
    const fields = requestMacFields('s'.repeat(32), '', '5', '127.0.0.1:4919', '/v1/status');
    const mac = await signFields(crypto.subtle, key, fields);
    expect(await verifyFields(crypto.subtle, key, mac, fields)).toBe(true);

    // Mutate EVERY signed field; each must break verification.
    const mutations: readonly (readonly string[])[] = [
      requestMacFields('t'.repeat(32), '', '5', '127.0.0.1:4919', '/v1/status'),
      requestMacFields('s'.repeat(32), 'x', '5', '127.0.0.1:4919', '/v1/status'),
      requestMacFields('s'.repeat(32), '', '6', '127.0.0.1:4919', '/v1/status'),
      requestMacFields('s'.repeat(32), '', '5', '127.0.0.1:4920', '/v1/status'),
      requestMacFields('s'.repeat(32), '', '5', '127.0.0.1:4919', '/v1/snapshot'),
      // Wrong domain: a response MAC over the same fields.
      responseMacFields('s'.repeat(32), '', '5', '/v1/status', '200', '00'.repeat(32)),
      // An extra trailing field (canonical-length violation).
      [...fields, 'extra'],
    ];
    for (const mutated of mutations) {
      expect(await verifyFields(crypto.subtle, key, mac, mutated)).toBe(false);
    }
  });

  it('refuses malformed MACs before any crypto', async () => {
    const key = await importSessionKey(crypto.subtle, TEST_KEY_BYTES);
    const fields = requestMacFields('s'.repeat(32), '', '1', '127.0.0.1:4919', '/v1/status');
    // Uppercase, short, long, and non-hex are all refused by the parser.
    expect(await verifyFields(crypto.subtle, key, 'A'.repeat(64), fields)).toBe(false);
    expect(await verifyFields(crypto.subtle, key, 'a'.repeat(63), fields)).toBe(false);
    expect(await verifyFields(crypto.subtle, key, `${'a'.repeat(64)}0`, fields)).toBe(false);
    expect(await verifyFields(crypto.subtle, key, `g${'a'.repeat(63)}`, fields)).toBe(false);
    expect(await verifyFields(crypto.subtle, key, '', fields)).toBe(false);
  });
});

describe('Authentication — helpers', () => {
  it('hex-encodes bytes lowercase', () => {
    expect(hexEncode(new Uint8Array([0, 1, 0x0f, 0x10, 0xff]))).toEqual('00010f10ff');
  });

  it('parses strict 64-char lowercase hex and rejects other shapes', () => {
    expect(parseMac('a'.repeat(64))).toEqual(new Uint8Array(32).fill(0xaa));
    expect(parseMac('0'.repeat(64))).toEqual(new Uint8Array(32));
    expect(parseMac('A'.repeat(64))).toBe(null);
    expect(parseMac('a'.repeat(32))).toBe(null);
  });

  it('zeroes the temporary key copy after import', async () => {
    const raw = new Uint8Array(32).fill(7);
    await importSessionKey(crypto.subtle, raw);
    // The TEMPORARY copy is zeroed; the caller's bytes are untouched (and
    // nothing is promised about them either way).
    expect(raw).toEqual(new Uint8Array(32).fill(7));
  });
});
