import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { detectRuntime } from '../../src/detector/runtime-detector.ts';
import type { GlobalScope } from '../../src/detector/runtime-detector.ts';

/**
 * The user agent a REAL Worker reports, probed against workerd:
 * `navigator.userAgent === 'Cloudflare-Workers'`.
 *
 * Load-bearing, not decorative. Every case below used to supply a lowercase
 * string the platform never sends (`'cloudflare-workers/v1'`, `'cloudflare'`),
 * so the suite passed while detection returned `'node'` on every real Worker.
 * Asserting through this constant is what ties the tests to the platform.
 */
const REAL_WORKER_USER_AGENT = 'Cloudflare-Workers';

describe('detectRuntime', () => {
  it('detects Deno when Deno global is present', () => {
    const globals: GlobalScope = { Deno: {} };
    expect(detectRuntime(globals)).toBe('deno');
  });

  it('detects Bun when Bun global is present (and no Deno)', () => {
    const globals: GlobalScope = { Bun: {} };
    expect(detectRuntime(globals)).toBe('bun');
  });

  it('detects Cloudflare Workers from the user agent a real Worker sends', () => {
    const globals: GlobalScope = {
      caches: {},
      navigator: { userAgent: REAL_WORKER_USER_AGENT },
    };
    expect(detectRuntime(globals)).toBe('cloudflare-workers');
  });

  it('matches the user agent case-insensitively', () => {
    // The capital 'C' in the real string is exactly what the old lowercase
    // `includes('cloudflare')` missed.
    for (const userAgent of ['Cloudflare-Workers', 'cloudflare-workers/v1', 'CLOUDFLARE']) {
      expect(detectRuntime({ caches: {}, navigator: { userAgent } })).toBe('cloudflare-workers');
    }
  });

  it('detects a Worker even though nodejs_compat defines process', () => {
    // Every Worker this CLI scaffolds sets `compatibility_flags =
    // ["nodejs_compat"]`, which defines `process` — so a process-based check
    // would report 'node' on the edge. Detection must not consult it.
    const globals: GlobalScope = {
      caches: {},
      navigator: { userAgent: REAL_WORKER_USER_AGENT },
    };
    (globals as { process?: unknown }).process = { versions: { node: '22.0.0' } };
    expect(detectRuntime(globals)).toBe('cloudflare-workers');
  });

  it('does not detect Cloudflare when caches is missing', () => {
    const globals: GlobalScope = {
      navigator: { userAgent: REAL_WORKER_USER_AGENT },
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
      navigator: { userAgent: REAL_WORKER_USER_AGENT },
    };
    expect(detectRuntime(globals)).toBe('bun');
  });

  it('uses real globalThis by default', () => {
    // On Deno CI, this should detect 'deno'
    const result = detectRuntime();
    expect(['deno', 'node', 'bun', 'cloudflare-workers']).toContain(result);
  });
});
