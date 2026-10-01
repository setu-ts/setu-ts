import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { derToRawSignature } from '../../src/passkeys/signature.ts';

describe('derToRawSignature edge branches', () => {
  it('refuses a long-form length of zero bytes', () => {
    // SEQUENCE with long-form length 0x80 — count 0 is refused.
    const der = new Uint8Array([0x30, 0x80]);
    expect(derToRawSignature(der)).toBeNull();
  });

  it('refuses a long-form length longer than two bytes', () => {
    // SEQUENCE with a 3-byte long-form length — refused outright.
    const der = new Uint8Array([0x30, 0x83, 0x00, 0x00, 0x00]);
    expect(derToRawSignature(der)).toBeNull();
  });

  it('refuses a long-form length cut off mid-encoding', () => {
    // SEQUENCE claiming a 2-byte long-form length but carrying none.
    const der = new Uint8Array([0x30, 0x82]);
    expect(derToRawSignature(der)).toBeNull();
  });

  it('refuses an s element truncated inside its length encoding', () => {
    // r parses; the s INTEGER's length bytes run past the end.
    const der = new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x82]);
    expect(derToRawSignature(der)).toBeNull();
  });

  it('refuses a scalar longer than a P-256 coordinate', () => {
    const longScalar = new Uint8Array(33).fill(1);
    const body = concatTwo(derInteger(longScalar), derInteger(new Uint8Array([1])));
    const der = concatTwo(new Uint8Array([0x30, body.length]), body);
    expect(derToRawSignature(der)).toBeNull();
  });

  it('refuses a long-form length claiming more bytes than the input carries', () => {
    // SEQUENCE with long-form length 0x81 (1 byte follows) but nothing after.
    const der = new Uint8Array([0x30, 0x81]);
    expect(derToRawSignature(der)).toBeNull();
  });

  it('refuses a SEQUENCE cut off before its length', () => {
    expect(derToRawSignature(new Uint8Array([0x30]))).toBeNull();
  });

  it('refuses a body whose length parses but carries no INTEGER', () => {
    // Long-form length 0x81/0x00 parses (zero-length body); the first
    // element read then runs off the input.
    const der = new Uint8Array([0x30, 0x81, 0x00]);
    expect(derToRawSignature(der)).toBeNull();
  });

  it('refuses an INTEGER whose value runs past the input', () => {
    const der = new Uint8Array([0x30, 0x06, 0x02, 0x82, 0x01, 0x01, 0x01, 0x01]);
    expect(derToRawSignature(der)).toBeNull();
  });

  it('refuses an INTEGER whose own length encoding is malformed', () => {
    const der = new Uint8Array([0x30, 0x04, 0x02, 0x80, 0x01, 0x01]);
    expect(derToRawSignature(der)).toBeNull();
  });
});

/** Concatenates two byte strings (the fixture's concat is fixture-private). */
function concatTwo(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Encodes one DER INTEGER (the same construction the fixture uses). */
function derInteger(value: Uint8Array): Uint8Array {
  let body = value;
  if (body.length === 0 || body[0]! >= 0x80) {
    body = concatTwo(new Uint8Array([0x00]), body);
  }
  return concatTwo(new Uint8Array([0x02, body.length]), body);
}
