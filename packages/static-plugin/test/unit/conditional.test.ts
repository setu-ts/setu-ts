import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { computeETag, shouldReturn304 } from '../../src/http/conditional.ts';

describe('computeETag', () => {
  it('should include mtime when present', () => {
    const mtime = new Date('2024-01-01T00:00:00.000Z');
    const etag = computeETag({ isFile: true, isDirectory: false, size: 100, mtime });
    expect(etag).toBe('W/"100-1704067200000"');
  });

  it('should use only size when mtime is absent', () => {
    const etag = computeETag({ isFile: true, isDirectory: false, size: 100 });
    expect(etag).toBe('W/"100"');
  });
});

describe('shouldReturn304', () => {
  const stat = {
    isFile: true,
    isDirectory: false,
    size: 100,
    mtime: new Date('2024-01-01T00:00:00.000Z'),
  };

  it('should return true when ETag matches', () => {
    const result = shouldReturn304({
      stat,
      ifNoneMatch: 'W/"100-1704067200000"',
    });
    expect(result).toBe(true);
  });

  it('should return false when ETag does not match', () => {
    const result = shouldReturn304({
      stat,
      ifNoneMatch: 'W/"different"',
    });
    expect(result).toBe(false);
  });

  it('should return true for wildcard If-None-Match', () => {
    const result = shouldReturn304({
      stat,
      ifNoneMatch: '*',
    });
    expect(result).toBe(true);
  });

  it('should prefer If-None-Match over If-Modified-Since', () => {
    const result = shouldReturn304({
      stat,
      ifNoneMatch: 'W/"100-1704067200000"',
      ifModifiedSince: '2023-01-01T00:00:00.000Z',
    });
    expect(result).toBe(true);
  });

  it('should return true when If-Modified-Since is after mtime', () => {
    const result = shouldReturn304({
      stat,
      ifModifiedSince: '2024-06-01T00:00:00.000Z',
    });
    expect(result).toBe(true);
  });

  it('should return false when If-Modified-Since is before mtime', () => {
    const result = shouldReturn304({
      stat,
      ifModifiedSince: '2023-01-01T00:00:00.000Z',
    });
    expect(result).toBe(false);
  });

  it('should return false when etag is disabled and If-None-Match is present', () => {
    const result = shouldReturn304({
      stat,
      etag: false,
      ifNoneMatch: 'W/"100-1704067200000"',
    });
    expect(result).toBe(false);
  });

  it('should evaluate If-Modified-Since independently when etag is disabled', () => {
    const result = shouldReturn304({
      stat,
      etag: false,
      ifModifiedSince: '2024-06-01T00:00:00.000Z',
    });
    expect(result).toBe(true);
  });

  it('should use weak comparison for If-None-Match', () => {
    // Strong tag should match weak tag
    const result = shouldReturn304({
      stat,
      ifNoneMatch: '"100-1704067200000"',
    });
    expect(result).toBe(true);
  });

  it('should compare at whole-second precision', () => {
    const statWithMs = {
      isFile: true,
      isDirectory: false,
      size: 100,
      mtime: new Date('2024-01-01T00:00:00.999Z'),
    };
    // The .999 should be truncated to whole seconds for comparison
    const result = shouldReturn304({
      stat: statWithMs,
      ifModifiedSince: '2024-01-01T00:00:01.000Z',
    });
    expect(result).toBe(true);
  });
});
