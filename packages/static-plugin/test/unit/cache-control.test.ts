import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  DEFAULT_IMMUTABLE,
  DEFAULT_MUTABLE,
  IMMUTABLE_PATTERN,
  resolveCacheControl,
} from '../../src/http/cache-control.ts';

describe('resolveCacheControl', () => {
  it('should return immutable for hashed assets', () => {
    const result = resolveCacheControl('index-a1b2c3d4.js', {});
    expect(result).toBe('public, max-age=31536000, immutable');
  });

  it('should return mutable for non-hashed assets', () => {
    const result = resolveCacheControl('index.html', {});
    expect(result).toBe('public, max-age=0, must-revalidate');
  });

  it('should use string override verbatim', () => {
    const result = resolveCacheControl('index.html', { cacheControl: 'no-cache' });
    expect(result).toBe('no-cache');
  });

  it('should call function override with relative path', () => {
    const fn = (_path: string) => 'custom';
    const result = resolveCacheControl('test.js', { cacheControl: fn });
    expect(result).toBe('custom');
  });

  it('should detect hash pattern', () => {
    expect(IMMUTABLE_PATTERN.test('index-a1b2c3d4.js')).toBe(true);
    expect(IMMUTABLE_PATTERN.test('style.css')).toBe(false);
    expect(IMMUTABLE_PATTERN.test('app.12345678.js')).toBe(true);
  });

  it('should match measured real Vite base64url hashes (which contain digits)', () => {
    // Filenames measured from a real Vite build in apps/full-stack/build/client/assets/.
    const measured = [
      '/assets/entry.client-A9acsx54.js',
      '/assets/root-C1h4lHnQ.css',
      '/assets/AppLayout-C51-06PP.js',
      '/assets/products._index-DqY3YWl7.js',
    ];
    for (const path of measured) {
      expect(IMMUTABLE_PATTERN.test(path), path).toBe(true);
      expect(resolveCacheControl(path, {}), path).toBe(DEFAULT_IMMUTABLE);
    }
  });

  it('accepts under-matching a measured hash that carries no digit', () => {
    // Also measured from apps/full-stack/build/client/assets/: its hash
    // `DNGNsaLG` contains no digit, so the digit heuristic misses it. That is
    // the accepted trade-off — over-matching words would hand out an
    // unrecoverable one-year immutable cache.
    expect(IMMUTABLE_PATTERN.test('/assets/_index-DNGNsaLG.js')).toBe(false);
  });

  it('should still match hex hashes from esbuild/rollup-style builds', () => {
    expect(IMMUTABLE_PATTERN.test('/assets/manifest-b7075365.js')).toBe(true);
    expect(IMMUTABLE_PATTERN.test('/assets/index-a1b2c3d4.js')).toBe(true);
  });

  it('should NOT match ordinary words even with a separator', () => {
    // Over-matching is worse than under-matching: a one-year immutable entry
    // cannot be evicted from the browser.
    const words = [
      '/assets/styles-production.css',
      '/assets/app-controller.js',
      '/assets/index-abcdefgh.js', // letters only, no digit
    ];
    for (const path of words) {
      expect(IMMUTABLE_PATTERN.test(path), path).toBe(false);
      expect(resolveCacheControl(path, {}), path).toBe(DEFAULT_MUTABLE);
    }
  });
});

describe('IMMUTABLE_PATTERN date-stamped names (PR #183 review)', () => {
  it('keeps an ISO-date-suffixed filename mutable', () => {
    // Republished at the same URL; a one-year immutable cache is unrecoverable.
    expect(resolveCacheControl('/report-2024-01-15.pdf', {})).toBe(DEFAULT_MUTABLE);
  });

  it('still marks a real content hash immutable', () => {
    expect(resolveCacheControl('/assets/entry.client-A9acsx54.js', {})).toBe(DEFAULT_IMMUTABLE);
  });
});
