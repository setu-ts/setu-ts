/**
 * `createPathMatcher` — the one path-exclusion matcher (M90a §3.1).
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createPathMatcher } from '../../src/path-matcher.ts';
import type { PathPattern } from '../../src/path-matcher.ts';

describe('createPathMatcher', () => {
  it('matches a literal by EXACT equality, never as a prefix', () => {
    const isExcluded = createPathMatcher(['/health']);
    expect(isExcluded('/health')).toBe(true);
    expect(isExcluded('/healthz')).toBe(false);
    expect(isExcluded('/health/live')).toBe(false);
    expect(isExcluded('health')).toBe(false);
  });

  it('matches every literal in the list', () => {
    const isExcluded = createPathMatcher(['/live', '/ready', '/metrics']);
    expect(isExcluded('/live')).toBe(true);
    expect(isExcluded('/ready')).toBe(true);
    expect(isExcluded('/metrics')).toBe(true);
    expect(isExcluded('/orders')).toBe(false);
  });

  it('tests a RegExp against the path', () => {
    const isExcluded = createPathMatcher([/^\/internal\//]);
    expect(isExcluded('/internal/debug')).toBe(true);
    expect(isExcluded('/public/internal/debug')).toBe(false);
  });

  it('matches a mixed list of literals and patterns', () => {
    const isExcluded = createPathMatcher(['/live', /^\/_ops\//]);
    expect(isExcluded('/live')).toBe(true);
    expect(isExcluded('/_ops/metrics')).toBe(true);
    expect(isExcluded('/orders')).toBe(false);
  });

  it('an empty list matches nothing', () => {
    const isExcluded = createPathMatcher([]);
    expect(isExcluded('/live')).toBe(false);
    expect(isExcluded('')).toBe(false);
    expect(isExcluded('/')).toBe(false);
  });

  // The trap this module exists to own. `RegExp.prototype.test` on a `g`- or
  // `y`-flagged pattern advances `lastIndex` and resumes from it, so a shared
  // pattern matched the first request, MISSED the second, matched the third.
  // Exactly one of the three hand-rolled copies handled this before M90a.
  it('a `g`-flagged RegExp matches on EVERY call, not every other one', () => {
    const isExcluded = createPathMatcher([/\/live/g]);
    expect(isExcluded('/live')).toBe(true);
    expect(isExcluded('/live')).toBe(true);
    expect(isExcluded('/live')).toBe(true);
  });

  it('a `y`-flagged RegExp matches on every call too', () => {
    const isExcluded = createPathMatcher([/\/ready/y]);
    expect(isExcluded('/ready')).toBe(true);
    expect(isExcluded('/ready')).toBe(true);
  });

  it('a `g`-flagged pattern that already advanced still matches', () => {
    // A caller may have used the pattern before handing it over.
    const pattern = /\/live/g;
    pattern.test('/live');
    expect(pattern.lastIndex).toBeGreaterThan(0);
    const isExcluded = createPathMatcher([pattern]);
    expect(isExcluded('/live')).toBe(true);
  });

  it('duplicate literals collapse without changing the answer', () => {
    const isExcluded = createPathMatcher(['/live', '/live']);
    expect(isExcluded('/live')).toBe(true);
    expect(isExcluded('/ready')).toBe(false);
  });

  it('accepts a readonly PathPattern list', () => {
    const patterns: readonly PathPattern[] = ['/live', /^\/x/];
    const isExcluded = createPathMatcher(patterns);
    expect(isExcluded('/live')).toBe(true);
    expect(isExcluded('/xyz')).toBe(true);
  });

  it('is partitioned once — a list mutated afterwards does not change matching', () => {
    // The predicate closes over its own partition, so a caller that keeps a
    // mutable array cannot silently change a registered middleware's policy.
    const patterns: PathPattern[] = ['/live'];
    const isExcluded = createPathMatcher(patterns);
    patterns.push('/ready');
    expect(isExcluded('/ready')).toBe(false);
  });
});
