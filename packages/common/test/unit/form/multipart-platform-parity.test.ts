/**
 * The §3.4 normative table, asserted against LITERALS rather than against the
 * host runtime.
 *
 * R18 measured the two runtimes disagreeing on three of the six rows — Node's
 * `Response.formData()` THROWS on a nameless part and on an unparseable
 * disposition where Deno drops the part and keeps its siblings; it PRESERVES a
 * quoted-empty `name=""` where Deno drops it; and it matches the parameter
 * NAME case-insensitively (`NAME=x` → `x`) where Deno does not — so a
 * Deno-only parity test would silently pin one runtime's choices as the
 * contract. Each row here asserts our documented answer, and each row the
 * runtimes diverge on carries their measured answers as a comment, so a future
 * reader sees the choice was made rather than inherited.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { parseMultipart } from '../../../src/form/multipart-parser.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Builds a multipart body whose parts carry RAW Content-Disposition lines. */
function bodyWith(dispositions: readonly string[], boundary: string): Uint8Array {
  const segments: string[] = [];
  for (const disposition of dispositions) {
    segments.push(`--${boundary}\r\n`);
    segments.push(`Content-Disposition: ${disposition}\r\n\r\n`);
    segments.push('DATA\r\n');
  }
  segments.push(`--${boundary}--\r\n`);
  return encoder.encode(segments.join(''));
}

function parse(dispositions: readonly string[]): ReturnType<typeof parseMultipart> {
  const boundary = 'm95c-parity';
  return parseMultipart(
    bodyWith(dispositions, boundary),
    `multipart/form-data; boundary=${boundary}`,
  );
}

describe('multipart Content-Disposition — the §3.4 normative table', () => {
  it('R5: a nameless part is dropped beside a legitimate "unknown" field — one entry, by arithmetic', () => {
    // Platform (Deno): the nameless part is dropped, `unknown` keeps its
    // sibling's value. Node: the WHOLE body throws. Ours: drop, per §3.4 —
    // Node's throw destroys every legitimate field in the body.
    const parts = parse(['form-data; name="unknown"', 'form-data']);
    expect(parts.length).toBe(1);
    expect(parts[0].name).toBe('unknown');
    expect(parts[0].filename).toBeUndefined();
  });

  it('R6: an unquoted name=x is delivered under its real name, not lost', () => {
    // Platform (Deno): field x. Node: field x. The OLD parser answered
    // `unknown` here — the name was lost, not merely mislabelled, which is why
    // dropping nameless parts WITHOUT this acceptance first would delete data.
    const parts = parse(['form-data; name=x']);
    expect(parts.length).toBe(1);
    expect(parts[0].name).toBe('x');
  });

  it('R7: an unquoted filename delivers an upload, not a text field', () => {
    // Platform (Deno): a File. Node: a File. The OLD parser produced a plain
    // text field, so `getUploadedFile()` found nothing for an upload the
    // client did send.
    const parts = parse(['form-data; name="f"; filename=a.txt']);
    expect(parts.length).toBe(1);
    expect(parts[0].name).toBe('f');
    expect(parts[0].filename).toBe('a.txt');
  });

  it('R8: name="" is kept as a legitimate empty-named field', () => {
    // Platform (Deno): the part is dropped. Node: field '' (empty). Ours keep
    // it — Node's answer, and the side that loses no data: an empty name can
    // only collide with another empty name, which is the same field.
    const parts = parse(['form-data; name=""']);
    expect(parts.length).toBe(1);
    expect(parts[0].name).toBe('');
  });

  it('R18: an uppercase NAME=x is delivered — the parameter NAME is case-insensitive', () => {
    // Platform (Deno): the part is DROPPED. Node: field x. We follow RFC 2183
    // header-parameter semantics and Node: case-insensitive, which only ever
    // turns a dropped part into a delivered one.
    const parts = parse(['form-data; NAME=x']);
    expect(parts.length).toBe(1);
    expect(parts[0].name).toBe('x');
  });

  it('R9: an unquoted value runs to the next ";" or end of line and is then trimmed', () => {
    const parts = parse([
      'form-data; name=hello world',
      'form-data; name=x;',
      'form-data; name=y',
    ]);
    expect(parts.length).toBe(3);
    expect(parts[0].name).toBe('hello world');
    expect(parts[1].name).toBe('x');
    expect(parts[2].name).toBe('y');
  });

  it('an unparseable disposition drops its part without touching its siblings', () => {
    // Platform (Deno): the garbage part is dropped, the sibling delivered.
    // Node: the WHOLE body throws. Ours: drop, per §3.4.
    const parts = parse(['form-data; name="ok"', '!!!garbage']);
    expect(parts.length).toBe(1);
    expect(parts[0].name).toBe('ok');
  });

  it('a quoted value keeps its exact bytes, including semicolons', () => {
    const boundary = 'm95c-quoted';
    const body = bodyWith(['form-data; name="a;b"'], boundary);
    const parts = parseMultipart(body, `multipart/form-data; boundary=${boundary}`);
    expect(parts.length).toBe(1);
    expect(parts[0].name).toBe('a;b');
    expect(decoder.decode(parts[0].data)).toBe('DATA');
  });
});
