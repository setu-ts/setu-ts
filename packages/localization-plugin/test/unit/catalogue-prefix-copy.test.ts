import { describe, expect, it } from 'vitest';
import { validateKeyPrefixes } from '../../src/routes/catalogue-route.ts';

describe('catalogue prefix snapshots', () => {
  it('refuses a sparse prefix array', () => {
    const sparse: string[] = [];
    sparse[1] = 'page.';
    expect(0 in sparse).toBe(false);
    expect(() => validateKeyPrefixes(sparse)).toThrow(TypeError);
  });
  it('validates and freezes its own dense copy', () => {
    const prefixes = ['page.'];
    const result = validateKeyPrefixes(prefixes);
    prefixes[0] = 'private.';
    expect(result).toEqual(['page.']);
    expect(Object.isFrozen(result)).toBe(true);
  });
});
