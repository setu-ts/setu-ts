import { describe, expect, it } from 'vitest';
import { DATABASE_PROBLEM_TYPES, ERROR_TYPE_BASE } from '../../src/index.ts';

describe('database problem types', () => {
  it('contains all eleven unique slugs beneath the canonical literal base', () => {
    const base: 'https://setu-ts.dev/errors' = ERROR_TYPE_BASE;
    expect(base).toBe('https://setu-ts.dev/errors');
    expect(Object.keys(DATABASE_PROBLEM_TYPES).sort()).toEqual(
      [
        'write-conflict',
        'lock-timeout',
        'version-conflict',
        'duplicate-key',
        'foreign-key-violation',
        'not-null-violation',
        'invalid-field-value',
        'database-unavailable',
        'database-pool-saturated',
        'database-timeout',
        'database-connection-lost',
      ].sort(),
    );
    const uris = Object.values(DATABASE_PROBLEM_TYPES).map(({ type }) => type);
    expect(new Set(uris).size).toBe(11);
    for (const [slug, problem] of Object.entries(DATABASE_PROBLEM_TYPES)) {
      expect(problem.type).toBe(`${base}/${slug}`);
      expect(problem.title.length).toBeGreaterThan(0);
    }
  });
});
