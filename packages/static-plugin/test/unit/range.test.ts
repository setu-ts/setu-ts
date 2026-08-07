import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { formatContentRange, parseRange, shouldHonourRange } from '../../src/http/range.ts';

describe('parseRange', () => {
  it('should parse bytes=0-99', () => {
    const result = parseRange('bytes=0-99', 1000);
    expect(result).toEqual({ start: 0, end: 99 });
  });

  it('should parse bytes=500-', () => {
    const result = parseRange('bytes=500-', 1000);
    expect(result).toEqual({ start: 500, end: 999 });
  });

  it('should parse bytes=-500', () => {
    const result = parseRange('bytes=-500', 1000);
    expect(result).toEqual({ start: 500, end: 999 });
  });

  it('should return null for invalid range', () => {
    const result = parseRange('bytes=2000-3000', 1000);
    expect(result).toBeNull();
  });

  it('should return null for empty range', () => {
    const result = parseRange('bytes=-', 1000);
    expect(result).toBeNull();
  });
});

describe('shouldHonourRange', () => {
  it('should return true when range is present', () => {
    const result = shouldHonourRange({
      size: 1000,
      rangeHeader: 'bytes=0-99',
    });
    expect(result).toBe(true);
  });

  it('should return false when range is absent', () => {
    const result = shouldHonourRange({
      size: 1000,
    });
    expect(result).toBe(false);
  });

  it('should return false when If-Range does not match ETag', () => {
    const result = shouldHonourRange({
      size: 1000,
      rangeHeader: 'bytes=0-99',
      ifRange: 'W/"different"',
      etag: 'W/"100"',
    });
    expect(result).toBe(false);
  });

  it('should return true when If-Range matches ETag', () => {
    const result = shouldHonourRange({
      size: 1000,
      rangeHeader: 'bytes=0-99',
      ifRange: 'W/"100"',
      etag: 'W/"100"',
    });
    expect(result).toBe(true);
  });
});

describe('formatContentRange', () => {
  it('should format range correctly', () => {
    const result = formatContentRange({ start: 0, end: 99 }, 1000);
    expect(result).toBe('bytes 0-99/1000');
  });
});

describe('parseRange — multi-range', () => {
  it('should return null for multi-range (comma)', () => {
    const result = parseRange('bytes=0-99, 100-199', 1000);
    expect(result).toBeNull();
  });
});

describe('shouldHonourRange — If-Range', () => {
  it('should return false when If-Range does not match ETag', () => {
    const result = shouldHonourRange({
      size: 1000,
      rangeHeader: 'bytes=0-99',
      ifRange: 'W/"different"',
      etag: 'W/"100"',
    });
    expect(result).toBe(false);
  });

  it('should return true when If-Range matches ETag', () => {
    const result = shouldHonourRange({
      size: 1000,
      rangeHeader: 'bytes=0-99',
      ifRange: 'W/"100"',
      etag: 'W/"100"',
    });
    expect(result).toBe(true);
  });

  it('should return true when If-Range is absent', () => {
    const result = shouldHonourRange({
      size: 1000,
      rangeHeader: 'bytes=0-99',
    });
    expect(result).toBe(true);
  });
});
