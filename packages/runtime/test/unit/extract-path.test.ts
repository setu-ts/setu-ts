/**
 * `extractPath` must equal `new URL(url).pathname` for every input, not
 * merely for common ones — it sits on the request path of every adapter, and
 * a divergence would silently route a request somewhere else (M87).
 *
 * The unnormalized cases are not hypothetical. `@hono/node-server` builds its
 * lightweight request URL from `incoming.url` verbatim, so a client sending
 * `GET /a/../b` reaches the mapping with the dot-segment intact — a real
 * `Request` would have normalized it away before the mapping ever saw it,
 * which is why these drive the function directly rather than through one.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { extractPath } from '../../src/adapters/shared/fetch-mapping.ts';

const CASES: readonly string[] = [
  'http://x/plaintext',
  'http://x/users/file.json',
  'http://x/users/abc?q=1',
  'http://x/users/abc#frag',
  'http://x',
  'http://x?q=1',
  'http://x#f',
  'http://x/',
  'http://x//a',
  'http://x/a%2Fb',
  'http://x/a%20b',
  'http://x/a/b/',
  'https://host:8080/deep/path/segment',
  // Dot-segments and backslashes: the ONLY inputs `URL` rewrites.
  'http://x/a/../b',
  'http://x/a/./b',
  'http://x/./',
  'http://x/..',
  'http://x/a/..',
  'http://x/a\\b',
  // Encoded dot-segment: trips the guard, answer unchanged.
  'http://x/a/..%2fb',
  // A slash INSIDE a query or fragment must not pose as the path. The corpus
  // already had `http://x?q=1`, which passes for the wrong reason — there is
  // no slash anywhere after the authority, so scanning for `/` finds nothing
  // and the no-path branch answers correctly. These are the cases that
  // discriminate, and their absence is why the authority scan shipped wrong.
  'http://x?next=/admin',
  'http://x#/admin',
  'http://x?a=1&b=/c/d',
  'http://x/p?next=/admin',
  'http://x/p#/frag/ment',
  // Percent-encoded dot segments. WHATWG resolves these as dot-segments, so
  // `URL` normalizes them away while a literal-`/.` guard does not see them.
  // Both hex cases, and the mixed literal/encoded forms.
  'http://x/%2e%2e/admin',
  'http://x/%2E%2E/admin',
  'http://x/a/%2e%2e/admin',
  'http://x/.%2e/admin',
  'http://x/%2e./admin',
  'http://x/%2e/admin',
  'http://x/%2E/admin',
  // A `%2e` that is NOT a dot-segment: the guard fires and `URL` agrees,
  // so this costs a wasted parse and never a wrong answer.
  'http://x/%2eb/admin',
];

describe('extractPath (M87)', () => {
  it('agrees with new URL().pathname on every case', () => {
    for (const url of CASES) {
      expect(`${url} -> ${extractPath(url)}`).toBe(`${url} -> ${new URL(url).pathname}`);
    }
  });

  it('resolves dot-segments exactly as URL does, so routing is unchanged', () => {
    expect(extractPath('http://x/foo/../admin')).toBe('/admin');
  });

  it('does not percent-decode', () => {
    expect(extractPath('http://x/a%2Fb')).toBe('/a%2Fb');
  });

  it('throws on a relative URL rather than mis-slicing it', () => {
    // Preserves the prior behaviour exactly: the mapping used to call
    // `new URL(request.url)` unconditionally, and the kernel turns that throw
    // into a 400. Slicing a scheme-less string would instead have produced a
    // plausible-looking wrong path.
    expect(() => extractPath('/no-scheme')).toThrow();
  });
});
