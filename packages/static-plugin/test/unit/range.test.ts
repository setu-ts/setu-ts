import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  formatContentRange,
  isRangeUnsatisfiable,
  parseRange,
  shouldHonourRange,
} from '../../src/http/range.ts';

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

  it('should return null for suffix range of zero', () => {
    const result = parseRange('bytes=-0', 1000);
    expect(result).toBeNull();
  });

  it('should return null for non-numeric start', () => {
    const result = parseRange('bytes=abc-', 1000);
    expect(result).toBeNull();
  });

  it('should return null for non-numeric end', () => {
    const result = parseRange('bytes=0-abc', 1000);
    expect(result).toBeNull();
  });

  it('should return null when end is less than start', () => {
    const result = parseRange('bytes=500-100', 1000);
    expect(result).toBeNull();
  });

  it('should clamp end beyond EOF when start is satisfiable', () => {
    const result = parseRange('bytes=0-2000', 1000);
    expect(result).toEqual({ start: 0, end: 999 });
  });

  it('should return null when start equals size', () => {
    const result = parseRange('bytes=1000-2000', 1000);
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

  it('should return true when If-Range matches ETag (strong)', () => {
    const result = shouldHonourRange({
      size: 1000,
      rangeHeader: 'bytes=0-99',
      ifRange: '"100"',
      etag: '"100"',
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

  it('should return true when etag is absent', () => {
    const result = shouldHonourRange({
      size: 1000,
      rangeHeader: 'bytes=0-99',
      ifRange: 'W/"different"',
    });
    expect(result).toBe(true);
  });

  it('should reject weak If-Range tags (RFC 7233)', () => {
    const result = shouldHonourRange({
      size: 1000,
      rangeHeader: 'bytes=0-99',
      ifRange: 'W/"100"',
      etag: 'W/"100"',
    });
    // Weak tag in If-Range must NOT authorize partial content
    expect(result).toBe(false);
  });

  it('should accept strong If-Range tags against weak ETag', () => {
    const result = shouldHonourRange({
      size: 1000,
      rangeHeader: 'bytes=0-99',
      ifRange: '"100"',
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

  it('should format open-ended range correctly', () => {
    const result = formatContentRange({ start: 500, end: 999 }, 1000);
    expect(result).toBe('bytes 500-999/1000');
  });

  it('should format suffix range correctly', () => {
    const result = formatContentRange({ start: 500, end: 999 }, 1000);
    expect(result).toBe('bytes 500-999/1000');
  });
});

describe('parseRange — multi-range', () => {
  it('should return null for multi-range (comma)', () => {
    const result = parseRange('bytes=0-99, 100-199', 1000);
    expect(result).toBeNull();
  });
});

describe('isRangeUnsatisfiable', () => {
  it('should return false for multi-range (comma)', () => {
    const result = isRangeUnsatisfiable('bytes=0-99, 100-199', 1000);
    expect(result).toBe(false);
  });

  it('should return true for start beyond size', () => {
    const result = isRangeUnsatisfiable('bytes=2000-3000', 1000);
    expect(result).toBe(true);
  });

  it('should return false for valid range', () => {
    const result = isRangeUnsatisfiable('bytes=0-99', 1000);
    expect(result).toBe(false);
  });

  it('should return false for malformed header', () => {
    const result = isRangeUnsatisfiable('invalid', 1000);
    expect(result).toBe(false);
  });

  it('should return true for empty range (bytes=-)', () => {
    const result = isRangeUnsatisfiable('bytes=-', 1000);
    expect(result).toBe(true);
  });

  it('should return true for suffix range of zero', () => {
    const result = isRangeUnsatisfiable('bytes=-0', 1000);
    expect(result).toBe(true);
  });
});
