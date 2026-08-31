/**
 * Unit coverage for the per-dialect JSON path helpers.
 *
 * The adapters' end-to-end behaviour is proven against the REAL Drizzle
 * generator and a real SQLite engine in
 * `test/integration/real-drizzle-adapter.test.ts`; this file pins the pure
 * pieces those adapters compose, including the dialect-detection arms a real
 * instance cannot reach from a single test process.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  dialectFromDrizzleClassName,
  jsonPathString,
  postgresPathArray,
} from '../../src/query/json-path.ts';

describe('jsonPathString', () => {
  it('renders the $.a.b path MySQL and SQLite both take', () => {
    expect(jsonPathString(['city'])).toBe('$.city');
    expect(jsonPathString(['address', 'city'])).toBe('$.address.city');
    expect(jsonPathString(['a_1', 'B2', '_c'])).toBe('$.a_1.B2._c');
  });

  it('refuses an EMPTY path below the root column', () => {
    // `$.` addresses nothing and both SQLite and MySQL answer it with NULL
    // rather than an error, so an empty path would match nothing while
    // reporting success.
    expect(() => jsonPathString([])).toThrow(/path is empty/);
    // `postgresPathArray` validates through this function, so it inherits the
    // refusal rather than rendering `{}`.
    expect(() => postgresPathArray([])).toThrow(/path is empty/);
  });

  it('refuses a segment carrying a path metacharacter rather than escaping it', () => {
    // A wrong escape reads a DIFFERENT field instead of failing, which is the
    // silent-divergence class this package keeps closing — so every one of
    // these is refused by name.
    for (
      const bad of [
        'city"]. $.other',
        "it's",
        'a.b',
        'a[0]',
        '$root',
        'with space',
        '1leading',
        '',
      ]
    ) {
      expect(() => jsonPathString(['profile', bad]), bad).toThrow(
        /not a plain JSON key/,
      );
    }
  });
});

describe('postgresPathArray', () => {
  it('renders the {a,b} text-array path #>> takes', () => {
    expect(postgresPathArray(['city'])).toBe('{city}');
    expect(postgresPathArray(['address', 'city'])).toBe('{address,city}');
  });

  it('validates its segments before they can reach the array literal', () => {
    // A comma or a brace inside a segment would re-point the extraction at a
    // different field, so validation runs first rather than after.
    expect(() => postgresPathArray(['a,b'])).toThrow(/not a plain JSON key/);
    expect(() => postgresPathArray(['a}'])).toThrow(/not a plain JSON key/);
  });
});

describe('dialectFromDrizzleClassName', () => {
  it('maps every dialect class Drizzle 0.45 ships', () => {
    // The real names, taken from the shipped dialect classes — `PgDialect`,
    // `MySqlDialect`, `SQLiteAsyncDialect` and `SQLiteSyncDialect`.
    expect(dialectFromDrizzleClassName('PgDialect')).toBe('postgresql');
    expect(dialectFromDrizzleClassName('MySqlDialect')).toBe('mysql');
    expect(dialectFromDrizzleClassName('SQLiteAsyncDialect')).toBe('sqlite');
    expect(dialectFromDrizzleClassName('SQLiteSyncDialect')).toBe('sqlite');
  });

  it('answers undefined for an absent or unrecognised name', () => {
    // `undefined` rather than a guess: the caller refuses the query BY NAME
    // and points at the explicit `dialect` option, where guessing a syntax
    // would return wrong rows on the engine it guessed wrong about.
    expect(dialectFromDrizzleClassName(undefined)).toBeUndefined();
    expect(dialectFromDrizzleClassName('SingleStoreDialect')).toBeUndefined();
    expect(dialectFromDrizzleClassName('')).toBeUndefined();
    // A name merely CONTAINING a known prefix is not a match — the check is
    // anchored, so a future `CockroachPgDialect` does not silently pass.
    expect(dialectFromDrizzleClassName('CockroachPgDialect')).toBeUndefined();
  });
});
