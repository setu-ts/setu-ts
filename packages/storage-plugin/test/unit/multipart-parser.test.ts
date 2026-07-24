/**
 * Tests for the zero-dependency {@linkcode parseMultipart} parser.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { parseMultipart } from '../../src/multipart/multipart-parser.ts';

/** Helper: build a multipart body with a known boundary. */
function makeBody(
  parts: Array<{ name: string; mime: string; data: Uint8Array }>,
  boundary: string,
): Uint8Array {
  const encoder = new TextEncoder();
  const segments: Uint8Array[] = [];

  for (const part of parts) {
    segments.push(encoder.encode(`--${boundary}\r\n`));
    segments.push(encoder.encode(
      `Content-Disposition: form-data; name="${part.name}"\r\n`,
    ));
    segments.push(encoder.encode(`Content-Type: ${part.mime}\r\n\r\n`));
    segments.push(part.data);
    segments.push(encoder.encode('\r\n'));
  }

  segments.push(encoder.encode(`--${boundary}--\r\n`));

  const totalLength = segments.reduce((sum, s) => sum + s.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const seg of segments) {
    result.set(seg, offset);
    offset += seg.length;
  }
  return result;
}

describe('parseMultipart', () => {
  it('parses a single-part body correctly', () => {
    const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
    const text = new TextEncoder().encode('Hello, world!');
    const body = makeBody([{ name: 'field1', mime: 'text/plain', data: text }], boundary);
    const contentType = `multipart/form-data; boundary=${boundary}`;

    const parts = parseMultipart(body, contentType);
    expect(parts.length).toBe(1);
    expect(parts[0].name).toBe('field1');
    expect(parts[0].mimeType).toBe('text/plain');
    expect(parts[0].data).toEqual(text);
  });

  it('parses multiple parts', () => {
    const boundary = 'abc123';
    const part1Data = new TextEncoder().encode('text content');
    const part2Data = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
    const body = makeBody([
      { name: 'text', mime: 'text/plain', data: part1Data },
      { name: 'binary', mime: 'application/octet-stream', data: part2Data },
    ], boundary);

    const parts = parseMultipart(body, `multipart/form-data; boundary=${boundary}`);
    expect(parts.length).toBe(2);
    expect(parts[0].name).toBe('text');
    expect(parts[0].mimeType).toBe('text/plain');
    expect(parts[0].data).toEqual(part1Data);
    expect(parts[1].name).toBe('binary');
    expect(parts[1].data).toEqual(part2Data);
  });

  it('uses default MIME type when not specified', () => {
    // Build body without Content-Type header.
    const boundary = 'simple';
    const encoder = new TextEncoder();
    const segments: Uint8Array[] = [
      encoder.encode(`--${boundary}\r\n`),
      encoder.encode('Content-Disposition: form-data; name="f"\r\n\r\n'),
      encoder.encode('value'),
      encoder.encode('\r\n'),
      encoder.encode(`--${boundary}--\r\n`),
    ];
    const totalLength = segments.reduce((s, b) => s + b.length, 0);
    const body = new Uint8Array(totalLength);
    let offset = 0;
    for (const seg of segments) {
      body.set(seg, offset);
      offset += seg.length;
    }

    const parts = parseMultipart(body, `multipart/form-data; boundary=${boundary}`);
    expect(parts.length).toBe(1);
    expect(parts[0].mimeType).toBe('application/octet-stream');
  });

  it('throws when no boundary in content-type', () => {
    const body = new Uint8Array([]);
    expect(() => parseMultipart(body, 'text/plain')).toThrow('Missing boundary');
  });

  it('returns empty array for empty body', () => {
    const body = new Uint8Array([]);
    const parts = parseMultipart(body, 'multipart/form-data; boundary=x');
    expect(parts.length).toBe(0);
  });

  it('handles part whose value contains the boundary substring', () => {
    const boundary = 'XYZ';
    // Data that literally contains "---XYZ" — should NOT be treated as final boundary.
    const partData = new TextEncoder().encode('line1\r\n---XYZ\r\nline2');
    const body = makeBody([{ name: 'tricky', mime: 'text/plain', data: partData }], boundary);
    const parts = parseMultipart(body, `multipart/form-data; boundary=${boundary}`);
    expect(parts.length).toBe(1);
    expect(parts[0].name).toBe('tricky');
  });
});
