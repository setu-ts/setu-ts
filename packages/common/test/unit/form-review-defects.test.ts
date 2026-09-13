/**
 * Regression guards for the four defects PR #290's review found.
 *
 * Each is a real shape a client can send, and each failed SILENTLY before the
 * fix — a truncated value, a dropped field, a non-form body entering form
 * parsing. The three multipart ones were pre-existing in the parser this
 * milestone promoted out of `storage-plugin`; promoting it is what made them
 * reachable from the CSRF verifier and from every application calling
 * `formData()`, so they are fixed where they now live.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { formEncodingOf, parseFormBody } from '../../src/index.ts';
import type { FormFile } from '../../src/index.ts';

const B = 'AaB03x';
const CT = `multipart/form-data; boundary=${B}`;
const enc = (value: string) => new TextEncoder().encode(value);

/** Builds a multipart body from raw part blocks. */
function multipart(parts: readonly string[]): Uint8Array {
  return enc(parts.map((part) => `--${B}\r\n${part}\r\n`).join('') + `--${B}--\r\n`);
}

describe('boundary-like bytes inside a part value (review finding 1)', () => {
  it('keeps a field value containing the raw --boundary sequence intact', () => {
    // Before the fix this returned 'pref': the match was taken mid-value and
    // the two bytes a real delimiter's CRLF occupies were stripped as well.
    const value = 'prefix--AaB03xsuffix';
    const form = parseFormBody(
      multipart([`Content-Disposition: form-data; name="v"\r\n\r\n${value}`]),
      CT,
    );
    expect(form.get('v')).toBe(value);
  });

  it('keeps file bytes containing a boundary-like line intact', () => {
    const contents = `AAA\r\n--${B}-NOT-A-DELIMITER\r\nBBB`;
    const form = parseFormBody(
      multipart([
        `Content-Disposition: form-data; name="f"; filename="x.bin"\r\n\r\n${contents}`,
      ]),
      CT,
    );
    const file = form.get('f') as FormFile;
    expect(new TextDecoder().decode(file.data)).toBe(contents);
    expect(file.data.length).toBe(enc(contents).length);
  });

  it('keeps a value whose boundary-like run is FOLLOWED by a line break', () => {
    // The two delimiter conditions are independent, and this input isolates the
    // preceding-CRLF one: `--AaB03x` here IS followed by a CRLF (so the
    // trailing check passes) but is NOT preceded by one, so only the leading
    // check can reject it. Without this case a revert of that check passed.
    const value = `line--${B}\r\nmore`;
    const form = parseFormBody(
      multipart([`Content-Disposition: form-data; name="v"\r\n\r\n${value}`]),
      CT,
    );
    expect(form.get('v')).toBe(value);
  });

  it('still finds the real delimiter, so later parts are not swallowed', () => {
    const form = parseFormBody(
      multipart([
        `Content-Disposition: form-data; name="a"\r\n\r\nhas--${B}inside`,
        'Content-Disposition: form-data; name="b"\r\n\r\nsecond',
      ]),
      CT,
    );
    expect(form.get('a')).toBe(`has--${B}inside`);
    expect(form.get('b')).toBe('second');
  });
});

describe('part header field names are case-insensitive (review finding 2)', () => {
  for (const field of ['Content-Disposition', 'content-disposition', 'CONTENT-DISPOSITION']) {
    it(`reads the field name from ${field}`, () => {
      const form = parseFormBody(
        multipart([`${field}: form-data; name="_csrf"\r\n\r\nTOKEN`]),
        CT,
      );
      // Before the fix every casing but the first arrived as 'unknown', so a
      // CSRF token was never found and an upload was never delivered.
      expect(form.get('_csrf')).toBe('TOKEN');
      expect([...form.entries()].map(([name]) => name)).toEqual(['_csrf']);
    });
  }

  it('reads a lowercase content-type as the file MIME type', () => {
    const form = parseFormBody(
      multipart([
        'content-disposition: form-data; name="f"; filename="a.txt"\r\n' +
        'content-type: text/plain\r\n\r\nhi',
      ]),
      CT,
    );
    expect((form.get('f') as FormFile).mimeType).toBe('text/plain');
  });
});

describe('the classifier matches a media type, not a substring (review finding 3)', () => {
  const NOT_FORMS = [
    // A suffixed media type is a different type.
    'application/x-www-form-urlencoded-v2',
    'multipart/form-data-v2; boundary=x',
    // A supported type appearing inside an unrelated parameter is not the type.
    'text/plain; note="application/x-www-form-urlencoded"',
    'application/json; description="multipart/form-data; boundary=x"',
    // `boundary=` matching inside a DIFFERENT parameter name supplies nothing.
    'multipart/form-data; xboundary=q',
    // A boundary parameter with no usable value cannot delimit anything.
    'multipart/form-data',
    'multipart/form-data; boundary=',
    'multipart/form-data; boundary=""',
  ] as const;

  for (const contentType of NOT_FORMS) {
    it(`refuses ${contentType}`, () => {
      expect(formEncodingOf(contentType)).toBeUndefined();
    });
  }

  const FORMS = [
    ['multipart/form-data; boundary=x', 'multipart'],
    ['MULTIPART/FORM-DATA; BOUNDARY="x"', 'multipart'],
    ['  multipart/form-data ; boundary = x ', 'multipart'],
    ['multipart/form-data; boundary="a;b"', 'multipart'],
    ['application/x-www-form-urlencoded', 'urlencoded'],
    ['APPLICATION/X-WWW-FORM-URLENCODED; charset=UTF-8', 'urlencoded'],
  ] as const;

  for (const [contentType, expected] of FORMS) {
    it(`accepts ${contentType}`, () => {
      expect(formEncodingOf(contentType)).toBe(expected);
    });
  }

  it('parses a quoted boundary containing a semicolon end to end', () => {
    // The agreement that matters: a header the classifier accepts must parse.
    // A bare `split(';')` would cut this boundary in half.
    const boundary = 'a;b';
    const body = new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="v"\r\n\r\nok\r\n--${boundary}--\r\n`,
    );
    const contentType = `multipart/form-data; boundary="${boundary}"`;
    expect(formEncodingOf(contentType)).toBe('multipart');
    expect(parseFormBody(body, contentType).get('v')).toBe('ok');
  });
});

describe('content-type parameter parsing edge cases', () => {
  it('ignores a bare parameter token carrying no value', () => {
    // `; charset` with no `=` is malformed but real; it must not consume the
    // boundary that follows it, and must not be read as a parameter name.
    expect(formEncodingOf('multipart/form-data; charset; boundary=x')).toBe('multipart');
  });

  it('ignores a parameter with an empty name', () => {
    expect(formEncodingOf('multipart/form-data; =oops; boundary=x')).toBe('multipart');
  });

  it('honours a quoted-pair escape inside a parameter value', () => {
    // RFC 9110 quoted-pair: the escaped quote does not end the value, so the
    // boundary is `a"b` and the parameter list does not run on past it.
    const boundary = 'a"b';
    const contentType = 'multipart/form-data; boundary="a\\"b"; charset=utf-8';
    expect(formEncodingOf(contentType)).toBe('multipart');

    const body = new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="v"\r\n\r\nok\r\n--${boundary}--\r\n`,
    );
    expect(parseFormBody(body, contentType).get('v')).toBe('ok');
  });

  it('takes the FIRST occurrence of a repeated parameter', () => {
    // Matches how `Headers` and this package's cookie codec resolve a repeat.
    const body = new TextEncoder().encode(
      '--one\r\nContent-Disposition: form-data; name="v"\r\n\r\nok\r\n--one--\r\n',
    );
    const contentType = 'multipart/form-data; boundary=one; boundary=two';
    expect(formEncodingOf(contentType)).toBe('multipart');
    expect(parseFormBody(body, contentType).get('v')).toBe('ok');
  });
});

describe('multipart delimiter and header edge cases', () => {
  it('yields no parts for a wholly bare-LF body — a documented limit, not a regression', () => {
    // Measured on this branch AND before it: `dataStart` is `headerEnd + 4`,
    // which hardcodes a CRLF CRLF header separator, so a `\n\n` body loses its
    // data offset and no part survives. The delimiter scan accepts a bare LF,
    // but completing LF support is new capability, not a review fix — this
    // pins the limit so it is a stated contract rather than a latent surprise.
    const body = new TextEncoder().encode(
      `--${B}\nContent-Disposition: form-data; name="v"\n\nok\n--${B}--\n`,
    );
    expect([...parseFormBody(body, CT).entries()]).toEqual([]);
  });

  it('skips a part header line carrying no colon', () => {
    const form = parseFormBody(
      multipart([
        `junk-line-without-a-colon\r\nContent-Disposition: form-data; name="v"\r\n\r\nok`,
      ]),
      CT,
    );
    expect(form.get('v')).toBe('ok');
  });
});
