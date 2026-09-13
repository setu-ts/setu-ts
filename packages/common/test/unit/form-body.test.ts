/**
 * Tests for {@linkcode parseFormBody} — the ONE parse every
 * `IRequest.formData?()` producer shares (M94b).
 *
 * Each semantic row of plan §1.1 is asserted through the same fixtures the
 * web-`FormData` behaviour was measured against, so the promoted parser and
 * the accessor provably adopt the web standard's answers.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { parseFormBody } from '../../src/form/form-body.ts';
import { UnsupportedFormEncodingError } from '../../src/errors/unsupported-form-encoding.ts';
import { httpStatusHintOf } from '../../src/errors/status-hint.ts';

/** One part of a multipart fixture; `filename` present (even `''`) is emitted. */
interface FixturePart {
  readonly name: string;
  readonly filename?: string;
  readonly mime?: string;
  readonly data: string;
}

/** Builds a multipart body with the given parts, exactly as a browser would. */
function multipartBody(parts: readonly FixturePart[], boundary: string): Uint8Array {
  const out: string[] = [];
  for (const part of parts) {
    out.push(`--${boundary}\r\n`);
    out.push(
      part.filename === undefined
        ? `Content-Disposition: form-data; name="${part.name}"\r\n`
        : `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`,
    );
    if (part.mime !== undefined) out.push(`Content-Type: ${part.mime}\r\n`);
    out.push(`\r\n`);
    out.push(part.data);
    out.push(`\r\n`);
  }
  out.push(`--${boundary}--\r\n`);
  return new TextEncoder().encode(out.join(''));
}

function parseMultipartFixture(parts: readonly FixturePart[], boundary = 'fb94') {
  return parseFormBody(multipartBody(parts, boundary), `multipart/form-data; boundary=${boundary}`);
}

/** Asserts the `415`-branded refusal for one refusable content-type. */
function expectUnsupported(body: Uint8Array, contentType: string | null): void {
  let thrown: unknown;
  try {
    parseFormBody(body, contentType);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(UnsupportedFormEncodingError);
  expect((thrown as Error).name).toBe('UnsupportedFormEncodingError');
  const hint = httpStatusHintOf(thrown);
  expect(hint?.status).toBe(415);
  expect(hint?.title).toBe('Unsupported Media Type');
}

describe('parseFormBody — the web-standard semantic rows (plan §1.1)', () => {
  it('a part declaring a filename is a file', () => {
    const form = parseMultipartFixture([
      { name: 'avatar', filename: 'a.txt', mime: 'text/plain', data: 'JPEGDATA' },
    ]);
    const value = form.get('avatar');
    expect(typeof value).not.toBe('string');
    expect(value).toEqual({
      filename: 'a.txt',
      mimeType: 'text/plain',
      data: new TextEncoder().encode('JPEGDATA'),
    });
  });

  it('a part with NO filename is a string, whatever its Content-Type said', () => {
    const form = parseMultipartFixture([
      { name: 'field', mime: 'text/plain', data: 'x' },
    ]);
    expect(form.get('field')).toBe('x');
  });

  it('an empty filename is STILL a file (the empty file input)', () => {
    // The trap: a truthiness test on `filename` drops this case. The web
    // standard reports a nameless File for `filename=""`; so does the form.
    const form = parseMultipartFixture([
      { name: 'file', filename: '', mime: 'application/octet-stream', data: '' },
    ]);
    const value = form.get('file');
    expect(typeof value).not.toBe('string');
    expect(value).toEqual({
      filename: '',
      mimeType: 'application/octet-stream',
      data: new Uint8Array(0),
    });
  });

  it('repeated names come back in wire order through getAll; get returns the first', () => {
    const form = parseMultipartFixture([
      { name: 'tag', data: 'one' },
      { name: 'other', data: 'x' },
      { name: 'tag', data: 'two' },
    ]);
    expect(form.getAll('tag')).toEqual(['one', 'two']);
    expect(form.get('tag')).toBe('one');
    expect(form.get('other')).toBe('x');
  });

  it('entries() iterates every pair in wire order, files included', () => {
    const form = parseMultipartFixture([
      { name: 'a', data: '1' },
      { name: 'file', filename: 'b.bin', mime: 'application/octet-stream', data: 'zz' },
      { name: 'a', data: '2' },
    ]);
    expect(Array.from(form.entries())).toEqual([
      ['a', '1'],
      ['file', {
        filename: 'b.bin',
        mimeType: 'application/octet-stream',
        data: new TextEncoder().encode('zz'),
      }],
      ['a', '2'],
    ]);
  });

  it('an empty multipart body yields an empty form', () => {
    const form = parseFormBody(
      new TextEncoder().encode('--fb94--\r\n'),
      'multipart/form-data; boundary=fb94',
    );
    expect(form.get('anything')).toBeUndefined();
    expect(form.getAll('anything')).toEqual([]);
    expect(Array.from(form.entries())).toEqual([]);
  });

  it('an UNPARSEABLE multipart body yields an EMPTY form, not a throw (documented limit)', () => {
    // §3.4: the promoted parser's released behaviour is kept — the accessor
    // changes where parsing happens, never what a parse yields.
    const form = parseFormBody(
      new TextEncoder().encode('this is not a multipart body'),
      'multipart/form-data; boundary=fb94',
    );
    expect(form.get('anything')).toBeUndefined();
    expect(form.getAll('anything')).toEqual([]);
    expect(Array.from(form.entries())).toEqual([]);
  });

  it('urlencoded equals the web answer, empty values included', () => {
    const form = parseFormBody(
      new TextEncoder().encode('a&b=&c=1'),
      'application/x-www-form-urlencoded',
    );
    expect(form.get('a')).toBe('');
    expect(form.get('b')).toBe('');
    expect(form.get('c')).toBe('1');
    expect(form.getAll('a')).toEqual(['']);
  });
});

describe('parseFormBody — the 415 refusal (§3.4)', () => {
  const body = new TextEncoder().encode('{"not":"a form"}');

  it('refuses a JSON body', () => {
    expectUnsupported(body, 'application/json');
  });

  it('refuses a missing content-type', () => {
    expectUnsupported(body, null);
  });

  it('refuses a multipart type carrying no boundary', () => {
    expectUnsupported(body, 'multipart/form-data');
  });
});
