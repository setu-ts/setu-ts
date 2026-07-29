/**
 * Tests for the realtime wire codec.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { decodeFrameData, encodeFrameData } from '../../src/realtime-codec.ts';

describe('encodeFrameData', () => {
  it('passes text through unchanged and does not flag it binary', () => {
    expect(encodeFrameData('hello')).toEqual({ data: 'hello' });
  });

  it('passes an empty string through', () => {
    expect(encodeFrameData('')).toEqual({ data: '' });
  });

  it('base64-encodes binary to a literal, asserted value', () => {
    // Asserted literally rather than round-tripped: an identity-transform bug
    // would survive a round-trip test and fail here.
    expect(encodeFrameData(new Uint8Array([1, 2, 3]))).toEqual({
      data: 'AQID',
      binary: true,
    });
    expect(encodeFrameData(new Uint8Array([0xff, 0x00, 0xff]))).toEqual({
      data: '/wD/',
      binary: true,
    });
  });

  it('encodes an empty byte array', () => {
    expect(encodeFrameData(new Uint8Array([]))).toEqual({ data: '', binary: true });
  });
});

describe('decodeFrameData', () => {
  it('returns text unchanged when the payload is not flagged binary', () => {
    expect(decodeFrameData({ data: 'hello' })).toBe('hello');
    expect(decodeFrameData({ data: 'hello', binary: false })).toBe('hello');
  });

  it('decodes base64 back to the original bytes', () => {
    expect(decodeFrameData({ data: 'AQID', binary: true })).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe('frame codec round-trip', () => {
  it('round-trips text', () => {
    const original = 'a message with ünicode and \n newlines';
    expect(decodeFrameData(encodeFrameData(original))).toBe(original);
  });

  it('round-trips binary across the full byte range', () => {
    const original = new Uint8Array(256);
    for (let index = 0; index < 256; index++) {
      original[index] = index;
    }
    expect(decodeFrameData(encodeFrameData(original))).toEqual(original);
  });

  it('round-trips a payload larger than the chunking threshold', () => {
    // btoa is fed via String.fromCharCode(...chunk); a frame bigger than one
    // chunk is what proves the chunking does not corrupt or truncate.
    const original = new Uint8Array(0x8000 * 2 + 17);
    for (let index = 0; index < original.length; index++) {
      original[index] = index % 256;
    }
    const decoded = decodeFrameData(encodeFrameData(original));
    expect(decoded).toEqual(original);
  });
});
