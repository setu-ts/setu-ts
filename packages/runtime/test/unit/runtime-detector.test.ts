import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { detectRuntime } from '../../src/detector/runtime-detector.ts';
import type { GlobalScope } from '../../src/detector/runtime-detector.ts';

describe('detectRuntime', () => {
  it('detects Deno when Deno global is present', () => {
    const globals: GlobalScope = { Deno: {} };
    expect(detectRuntime(globals)).toBe('deno');
  });

  it('detects Bun when Bun global is present (and no Deno)', () => {
    const globals: GlobalScope = { Bun: {} };
    expect(detectRuntime(globals)).toBe('bun');
  });

  it('detects Cloudflare Workers when caches and navigator.userAgent match', () => {
    const globals: GlobalScope = {
      caches: {},
      navigator: { userAgent: 'cloudflare-workers/v1' },
    };
    expect(detectRuntime(globals)).toBe('cloudflare-workers');
  });

  it('does not detect Cloudflare when caches is missing', () => {
    const globals: GlobalScope = {
      navigator: { userAgent: 'cloudflare' },
    };
    expect(detectRuntime(globals)).toBe('node');
  });

  it('does not detect Cloudflare when userAgent does not include cloudflare', () => {
    const globals: GlobalScope = {
      caches: {},
      navigator: { userAgent: 'Mozilla/5.0' },
    };
    expect(detectRuntime(globals)).toBe('node');
  });

  it('does not detect Cloudflare when navigator is missing', () => {
    const globals: GlobalScope = {
      caches: {},
    };
    expect(detectRuntime(globals)).toBe('node');
  });

  it('defaults to node when no runtime globals are present', () => {
    const globals: GlobalScope = {};
    expect(detectRuntime(globals)).toBe('node');
  });

  it('Deno takes precedence over Bun', () => {
    const globals: GlobalScope = { Deno: {}, Bun: {} };
    expect(detectRuntime(globals)).toBe('deno');
  });

  it('Bun takes precedence over Cloudflare', () => {
    const globals: GlobalScope = {
      Bun: {},
      caches: {},
      navigator: { userAgent: 'cloudflare' },
    };
    expect(detectRuntime(globals)).toBe('bun');
  });

  it('uses real globalThis by default', () => {
    // On Deno CI, this should detect 'deno'
    const result = detectRuntime();
    expect(['deno', 'node', 'bun', 'cloudflare-workers']).toContain(result);
  });
});
