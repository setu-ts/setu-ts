/**
 * Type-level pins for the form value shape (M94b §3.1): `FormFile` carries a
 * SYNCHRONOUS byte view — the whole reason the framework shape exists instead
 * of the web `File` — and a `FormValue` narrows exactly like the web
 * standard's entry values. `FormBody` is read-only.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { FormBody, FormFile, FormValue } from '../../src/form/form-body.ts';
import { parseFormBody } from '../../src/form/form-body.ts';

// Compile-time: `FormFile.data` is a plain `Uint8Array` — usable WITHOUT
// await, which is what the web `File` cannot offer (`await file.arrayBuffer()`
// copies). Assigning it where a synchronous `Uint8Array` is expected compiles.
const file: FormFile = {
  filename: 'a.txt',
  mimeType: 'text/plain',
  data: new Uint8Array([1]),
};
const bytes: Uint8Array = file.data;
const byteLength: number = file.data.byteLength;

// Compile-time + runtime: a `FormValue` narrows on the same test the web
// entry values answer to, and the narrowed branches keep their types.
function byteCountOf(value: FormValue): number {
  if (typeof value === 'string') {
    return value.length;
  }
  return value.data.byteLength;
}

// Compile-time: `FormBody` has no write members — a request body is a fact
// about the request, not a collection a handler edits.
const form: FormBody = parseFormBody(
  new TextEncoder().encode('a=1'),
  'application/x-www-form-urlencoded',
);
// @ts-expect-error — a form body is read-only: `set` does not exist on it.
// The directive is self-validating (an unused one is a compile error), and
// the probe is a property READ, so nothing invalid executes at runtime.
void form.set;

describe('FormBody type shape (M94b)', () => {
  it('pins the framework value shape at compile time and holds at runtime', () => {
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(byteLength).toBe(1);
    expect(byteCountOf('abc')).toBe(3);
    expect(byteCountOf(file)).toBe(1);
    expect(form.get('a')).toBe('1');
  });
});
