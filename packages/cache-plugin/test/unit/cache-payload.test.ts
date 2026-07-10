import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { decodePayload, encodePayload } from '../../src/utils/cache-payload.ts';

describe('cache-payload', () => {
  describe('encodePayload', () => {
    it('encodes a Uint8Array body as base64', () => {
      const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      const headers = new Headers();
      headers.set('content-type', 'application/octet-stream');
      const payload = encodePayload({ status: 200, headers, body: bytes });

      expect(payload.status).toBe(200);
      expect(payload.bodyEncoding).toBe('base64');
      expect(payload.body).toBe('SGVsbG8=');
      expect(payload.headers).toEqual([['content-type', 'application/octet-stream']]);
    });

    it('encodes a string body as-is without encoding flag', () => {
      const headers = new Headers();
      headers.set('content-type', 'text/plain');
      const payload = encodePayload({ status: 200, headers, body: 'plain text' });

      expect(payload.status).toBe(200);
      expect(payload.bodyEncoding).toBeUndefined();
      expect(payload.body).toBe('plain text');
    });

    it('encodes null body', () => {
      const payload = encodePayload({ status: 204, headers: new Headers(), body: null });

      expect(payload.status).toBe(204);
      expect(payload.body).toBeNull();
      expect(payload.bodyEncoding).toBeUndefined();
    });

    it('copies all headers from the Headers object', () => {
      const headers = new Headers();
      headers.set('x-foo', 'bar');
      headers.set('x-baz', 'qux');
      const payload = encodePayload({ status: 200, headers, body: null });

      expect(payload.headers.length).toBe(2);
      expect(payload.headers).toContainEqual(['x-foo', 'bar']);
      expect(payload.headers).toContainEqual(['x-baz', 'qux']);
    });
  });

  describe('decodePayload', () => {
    it('decodes a base64 payload back to Uint8Array', () => {
      const payload = {
        status: 200,
        headers: [['content-type', 'application/octet-stream']] as Array<[string, string]>,
        body: 'SGVsbG8=',
        bodyEncoding: 'base64' as const,
      };
      const decoded = decodePayload(payload);

      expect(decoded.status).toBe(200);
      expect(decoded.headers).toEqual([['content-type', 'application/octet-stream']]);
      expect(decoded.bodyBytes).toBeInstanceOf(Uint8Array);
      expect(decoded.bodyBytes).toEqual(new Uint8Array([72, 101, 108, 108, 111]));
    });

    it('passes string body through without decoding', () => {
      const payload = {
        status: 200,
        headers: [['content-type', 'text/plain']] as Array<[string, string]>,
        body: 'hello string',
      };
      const decoded = decodePayload(payload);

      expect(decoded.bodyBytes).toBe('hello string');
    });

    it('passes null body through', () => {
      const payload = {
        status: 204,
        headers: [] as Array<[string, string]>,
        body: null,
      };
      const decoded = decodePayload(payload);

      expect(decoded.bodyBytes).toBeNull();
    });
  });

  describe('round-trip', () => {
    it('Uint8Array survives encode→decode round-trip', () => {
      const original = new Uint8Array([0, 128, 255, 1]);
      const headers = new Headers();
      headers.set('content-type', 'application/pdf');
      const encoded = encodePayload({ status: 200, headers, body: original });
      const decoded = decodePayload(encoded);

      expect(decoded.bodyBytes).toBeInstanceOf(Uint8Array);
      expect(decoded.bodyBytes).toEqual(original);
      expect(decoded.status).toBe(200);
    });

    it('String body survives encode→decode round-trip', () => {
      const original = '{"key": "value"}';
      const encoded = encodePayload({ status: 200, headers: new Headers(), body: original });
      const decoded = decodePayload(encoded);

      expect(decoded.bodyBytes).toBe(original);
    });
  });
});
