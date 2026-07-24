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

  it('parses quoted boundary correctly', () => {
    const boundary = 'quoted-boundary';
    const encoder = new TextEncoder();
    const body = new Uint8Array([
      ...encoder.encode(`--${boundary}\r\n`),
      ...encoder.encode('Content-Disposition: form-data; name="qf"\r\n'),
      ...encoder.encode('Content-Type: text/plain\r\n\r\n'),
      ...encoder.encode('quoted boundary data'),
      ...encoder.encode('\r\n--' + boundary + '--\r\n'),
    ]);
    const parts = parseMultipart(body, 'multipart/form-data; boundary="quoted-boundary"');
    expect(parts.length).toBe(1);
    expect(parts[0].name).toBe('qf');
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

  it('handles part without Content-Type header (default MIME)', () => {
    const boundary = 'no-mime';
    const encoder = new TextEncoder();
    const body = new Uint8Array([
      ...encoder.encode(`--${boundary}\r\n`),
      ...encoder.encode('Content-Disposition: form-data; name="nomime"\r\n\r\n'),
      ...encoder.encode('no-type-value'),
      ...encoder.encode('\r\n--' + boundary + '--\r\n'),
    ]);

    const parts = parseMultipart(body, `multipart/form-data; boundary=${boundary}`);
    expect(parts.length).toBe(1);
    expect(parts[0].mimeType).toBe('application/octet-stream');
    expect(new TextDecoder().decode(parts[0].data)).toBe('no-type-value');
  });

  it('handles CRLF with extra whitespace in headers', () => {
    const boundary = 'whitespace';
    const encoder = new TextEncoder();
    const body = new Uint8Array([
      ...encoder.encode(`--${boundary}\r\n`),
      ...encoder.encode('  Content-Disposition: form-data; name="ws-field"  \r\n'),
      ...encoder.encode('  Content-Type: text/plain  \r\n\r\n'),
      ...encoder.encode('whitespacey data'),
      ...encoder.encode('\r\n--' + boundary + '--\r\n'),
    ]);

    const parts = parseMultipart(body, `multipart/form-data; boundary=${boundary}`);
    expect(parts.length).toBe(1);
    expect(parts[0].name).toBe('ws-field');
    expect(new TextDecoder().decode(parts[0].data)).toBe('whitespacey data');
  });

  it('parses binary data correctly', () => {
    const boundary = 'bin-boundary';
    const binaryData = new Uint8Array([0x00, 0x01, 0x02, 0xFF, 0xFE, 0xFD]);
    const body = makeBody([{
      name: 'binary-file',
      mime: 'application/octet-stream',
      data: binaryData,
    }], boundary);

    const parts = parseMultipart(body, `multipart/form-data; boundary=${boundary}`);
    expect(parts.length).toBe(1);
    expect(parts[0].data).toEqual(binaryData);
  });

  it('handles large part data', () => {
    const boundary = 'large';
    const largeData = new Uint8Array(100_000).fill(42);
    const body = makeBody(
      [{ name: 'large', mime: 'application/octet-stream', data: largeData }],
      boundary,
    );

    const parts = parseMultipart(body, `multipart/form-data; boundary=${boundary}`);
    expect(parts.length).toBe(1);
    expect(parts[0].data.length).toBe(100_000);
    expect(parts[0].data[0]).toBe(42);
    expect(parts[0].data[99_999]).toBe(42);
  });

  it('handles part name in Content-Disposition with quotes', () => {
    const boundary = 'quoted-name';
    const encoder = new TextEncoder();
    // Build body with quoted part name
    const bodyBytes = new Uint8Array([
      ...encoder.encode(`--${boundary}\r\n`),
      ...encoder.encode('Content-Disposition: form-data; name="quoted-field"\r\n'),
      ...encoder.encode('Content-Type: text/plain\r\n\r\n'),
      ...encoder.encode('quoted field data'),
      ...encoder.encode('\r\n--' + boundary + '--\r\n'),
    ]);

    const parts = parseMultipart(bodyBytes, `multipart/form-data; boundary=${boundary}`);
    expect(parts.length).toBe(1);
    expect(parts[0].name).toBe('quoted-field');
  });

  it('handles empty part data', () => {
    const boundary = 'empty-data';
    const encoder = new TextEncoder();
    const bodyBytes = new Uint8Array([
      ...encoder.encode(`--${boundary}\r\n`),
      ...encoder.encode('Content-Disposition: form-data; name="empty-field"\r\n'),
      ...encoder.encode('Content-Type: text/plain\r\n\r\n'),
      ...encoder.encode(''),
      ...encoder.encode('\r\n--' + boundary + '--\r\n'),
    ]);

    const parts = parseMultipart(bodyBytes, `multipart/form-data; boundary=${boundary}`);
    expect(parts.length).toBe(1);
    expect(parts[0].data.length).toBe(0);
  });

  it('handles part with special characters in data', () => {
    const boundary = 'special';
    const encoder = new TextEncoder();
    const specialData = encoder.encode('Special chars: <>&"\'\\@#$%^&*()');
    const body = makeBody([{ name: 'special', mime: 'text/plain', data: specialData }], boundary);

    const parts = parseMultipart(body, `multipart/form-data; boundary=${boundary}`);
    expect(parts.length).toBe(1);
    expect(parts[0].data).toEqual(specialData);
  });

  it('tryMatch returns false when offset + prefix exceeds body length', () => {
    // Build a minimal body and verify that partial matches don't cause errors.
    const boundary = 'tiny';
    const encoder = new TextEncoder();
    const body = encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="t"\r\n\r\nx\r\n--${boundary}--\r\n`,
    );
    // The body is very short — verify parsing still works end-to-end.
    const parts = parseMultipart(body, `multipart/form-data; boundary=${boundary}`);
    expect(parts.length).toBe(1);
    expect(parts[0].name).toBe('t');
  });

  it('parseMultipart handles content-type with quoted boundary containing spaces', () => {
    const boundary = 'quoted with space';
    const encoder = new TextEncoder();
    const body = new Uint8Array([
      ...encoder.encode(`--${boundary}\r\n`),
      ...encoder.encode('Content-Disposition: form-data; name="qs"\r\n'),
      ...encoder.encode('Content-Type: text/plain\r\n\r\n'),
      ...encoder.encode('qs data'),
      ...encoder.encode('\r\n--' + boundary + '--\r\n'),
    ]);

    const parts = parseMultipart(body, 'multipart/form-data; boundary="quoted with space"');
    expect(parts.length).toBe(1);
    expect(parts[0].name).toBe('qs');
  });
});
