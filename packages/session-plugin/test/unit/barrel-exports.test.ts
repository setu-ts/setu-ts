/**
 * The published surface of `@setu-ts/session-plugin`, pinned by name.
 *
 * The M56 defect class: dropping an export from `src/index.ts` left 18 other
 * tests green there, because every one of them imported the concrete module
 * rather than the barrel. This package is where that matters most right now —
 * `CSRF_CONFIG_STATE_KEY` (M95c §4) is read by an application rendering its own
 * field markup, and every test that exercises it imports it from
 * `src/csrf/token.ts`. The README export table and `check:docs` catch a drop
 * too; this catches it in the suite, which is where a package's own surface
 * should be defended.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as exports from '../../src/index.ts';
import { CAPABILITIES, createCapabilityToken } from '@setu-ts/common';

/** Every value the barrel publishes, with the kind a consumer may rely on. */
const VALUE_EXPORTS: ReadonlyArray<readonly [string, 'function' | 'string']> = [
  ['SessionPlugin', 'function'],
  ['SessionService', 'function'],
  ['getSession', 'function'],
  ['csrfFormMiddleware', 'function'],
  ['csrfTokenField', 'function'],
  ['getCsrfToken', 'function'],
  ['verifyCsrfToken', 'function'],
  ['sessionMiddleware', 'function'],
  ['MemorySessionStore', 'function'],
  ['CacheSessionStore', 'function'],
  ['SessionSecretMissingError', 'function'],
  ['SessionMiddlewareMissingError', 'function'],
  ['CsrfTokenMismatchError', 'function'],
  ['SessionTooLargeError', 'function'],
  ['CSRF_SESSION_KEY', 'string'],
  ['CSRF_CONFIG_STATE_KEY', 'string'],
];

describe('barrel exports', () => {
  for (const [name, kind] of VALUE_EXPORTS) {
    it(`publishes ${name}`, () => {
      const value = (exports as Record<string, unknown>)[name];
      expect(value).toBeDefined();
      expect(typeof value).toBe(kind);
    });
  }

  it('publishes exactly these values and no more', () => {
    // A NEW export has to be added above with its kind, so surface growth is a
    // deliberate edit rather than something a reader discovers on jsr.io.
    expect(Object.keys(exports).sort()).toEqual(VALUE_EXPORTS.map(([n]) => n).sort());
  });

  it('erases its types at runtime', () => {
    const keys = Object.keys(exports);
    for (const type of ['SessionPluginOptions', 'CsrfFormOptions', 'SessionMode']) {
      expect(keys).not.toContain(type);
    }
  });

  it('keys the two published constants per the M71 state-key grammar', () => {
    expect(exports.CSRF_CONFIG_STATE_KEY).toBe('session-plugin:csrf-config');
    expect(exports.CSRF_SESSION_KEY).toBe('__csrf');
  });

  it('claims the SESSION capability token, which passes the committed grammar', () => {
    expect(CAPABILITIES.SESSION).toBe('session');
    expect(() => createCapabilityToken(CAPABILITIES.SESSION)).not.toThrow();
  });
});
