/**
 * Unit tests for {@linkcode normalizePageQuery}.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { normalizePageQuery, PageNormalizationError } from '../../src/query/query-builder.ts';
import type { NormalizedQuery } from '@setu-ts/common';

describe('normalizePageQuery', () => {
  it('returns defaults when no options provided', () => {
    const query = normalizePageQuery();
    expect(query).toEqual({
      where: {},
      orderBy: {},
      limit: -1,
      offset: 0,
      select: [],
    });
  });

  it('preserves all options when provided without offset+cursor conflict', () => {
    const query = normalizePageQuery({
      where: { active: true },
      orderBy: { name: 'asc' },
      limit: 10,
      offset: 0,
      select: ['id', 'name'],
    });
    expect(query).toEqual({
      where: { active: true },
      orderBy: { name: 'asc' },
      limit: 10,
      offset: 0,
      select: ['id', 'name'],
    });
  });

  it('preserves a cursor when offset is 0', () => {
    const query = normalizePageQuery({ cursor: 'abc123', limit: 5 });
    expect((query as NormalizedQuery & { cursor?: string }).cursor).toBe('abc123');
    expect((query as NormalizedQuery & { cursor?: string }).offset).toBe(0);
  });

  it('preserves a non-zero offset when cursor is absent', () => {
    const query = normalizePageQuery({ offset: 20, limit: 10 });
    expect((query as NormalizedQuery & { cursor?: string }).offset).toBe(20);
    expect((query as NormalizedQuery & { cursor?: string }).cursor).toBeUndefined();
  });

  it('refuses when both non-zero offset and cursor are present (§3.10)', () => {
    const result = normalizePageQuery({
      offset: 5,
      cursor: 'token',
    });
    expect(result).toBeInstanceOf(PageNormalizationError);
    expect((result as PageNormalizationError).message).toContain('cursor-pagination');
  });

  it('does NOT refuse when offset is 0 and cursor is absent', () => {
    const query = normalizePageQuery({});
    expect(query).not.toBeInstanceOf(PageNormalizationError);
    expect((query as NormalizedQuery & { cursor?: string }).offset).toBe(0);
    expect((query as NormalizedQuery & { cursor?: string }).cursor).toBeUndefined();
  });

  it('does NOT refuse when offset is 0 and cursor is present', () => {
    const query = normalizePageQuery({ cursor: 'token' });
    expect(query).not.toBeInstanceOf(PageNormalizationError);
    expect((query as NormalizedQuery & { cursor?: string }).offset).toBe(0);
    expect((query as NormalizedQuery & { cursor?: string }).cursor).toBe('token');
  });

  it('does NOT refuse when cursor is absent and offset is non-zero', () => {
    const query = normalizePageQuery({ offset: 10 });
    expect(query).not.toBeInstanceOf(PageNormalizationError);
    expect((query as NormalizedQuery & { cursor?: string }).offset).toBe(10);
    expect((query as NormalizedQuery & { cursor?: string }).cursor).toBeUndefined();
  });
});

describe('normalizePageQuery rejection pattern (§3.12)', () => {
  it('returns the error rather than throwing synchronously', () => {
    // The refusal is a returned value, not a throw
    const result = normalizePageQuery({ offset: 3, cursor: 'token' });
    expect(result).toBeInstanceOf(PageNormalizationError);
    // Not a throw — if this threw, the line below would not run
    expect(() => {
      const msg = (result as PageNormalizationError).message;
      expect(msg).toBeDefined();
    }).not.toThrow();
  });

  it('the returned error can be rejected through a Promise', async () => {
    // Simulate what findPage does: reject with the returned error
    const rejected = Promise.reject(normalizePageQuery({ offset: 3, cursor: 'token' }));
    await expect(rejected).rejects.toBeInstanceOf(PageNormalizationError);
  });
});
